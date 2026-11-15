import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { installFreshSettingsRoute } from '../server/startup-settings.mjs';

// This harness never starts server.js or reads a host account. The real native
// router and Express dependency receive a wholly synthetic request.user instead.
const script = fileURLToPath(import.meta.url);
const project = fileURLToPath(new URL('../', import.meta.url));
const DIRECTORY_KEYS = ['novelAI_Settings', 'openAI_Settings', 'textGen_Settings', 'koboldAI_Settings', 'worlds', 'themes', 'movingUI', 'quickreplies', 'instruct', 'context', 'sysprompt', 'reasoning'];
const LAYOUT = [
    ['novelAI_Settings', 24, 13587], ['openAI_Settings', 15, 15443795],
    ['textGen_Settings', 6, 15395], ['koboldAI_Settings', 6, 2481],
    ['themes', 21, 3975953], ['movingUI', 1, 50], ['quickreplies', 2, 9644],
    ['instruct', 38, 29567], ['context', 34, 24318], ['sysprompt', 13, 3664], ['reasoning', 5, 590],
];
const SETTINGS_BYTES = 10086479;
const ROUNDS = 8;
const WARMUPS = 2;
const CONFIG = 'enableUserAccounts: true\nextensions:\n  enabled: true\n  autoUpdate: false\nperformance:\n  requestCompression:\n    enabled: true\n    minPayloadSize: 256kb\n    maxPayloadSize: 8mb\n    timeout: 4000\n';

async function makeFixture(root) {
    const directories = { root: path.join(root, 'fixture') };
    await fs.mkdir(directories.root);
    for (const key of DIRECTORY_KEYS) {
        directories[key] = path.join(directories.root, key);
        await fs.mkdir(directories[key]);
    }
    const payload = length => '{"text":"' + 'x'.repeat(length - 11) + '"}';
    await fs.writeFile(path.join(directories.root, 'settings.json'), payload(SETTINGS_BYTES));
    for (const [key, count, bytes] of LAYOUT) {
        for (let index = 0; index < count; index++) {
            const size = Math.floor(bytes / count) + Number(index < bytes % count);
            await fs.writeFile(path.join(directories[key], `preset-${String(index).padStart(3, '0')}.json`), payload(size));
        }
    }
    for (let index = 0; index < 75; index++) await fs.writeFile(path.join(directories.worlds, `world-${index}.json`), '');
    return directories;
}

async function serverChild() {
    const root = process.env.TF_HTTP_BENCH_ROOT;
    const host = process.env.TF_HTTP_BENCH_HOST;
    assert(root && host);
    process.chdir(host);
    globalThis.DATA_ROOT = path.join(root, 'unused-data');
    const { setConfigFilePath } = await import(pathToFileURL(path.join(host, 'src/util.js')));
    setConfigFilePath(path.join(root, 'config.yaml'));
    const { router } = await import(pathToFileURL(path.join(host, 'src/endpoints/settings.js')));
    const express = createRequire(path.join(host, 'package.json'))('express');
    const directories = JSON.parse(await fs.readFile(path.join(root, 'directories.json'), 'utf8'));
    const app = express();
    app.use(express.json());
    app.get('/light', (_request, response) => response.send('ok'));
    app.use('/api/settings', (request, _response, next) => {
        request.user = { directories };
        next();
    }, router);
    app.use((_error, _request, response, _next) => response.sendStatus(500));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let adapter;
    let timer;
    let gaps = [];
    process.on('message', async message => {
        try {
            let result;
            if (message.operation === 'mode') {
                adapter?.dispose();
                adapter = undefined;
                if (message.mode === 'fresh') {
                    adapter = await installFreshSettingsRoute({ hostRoot: host, enabled: true, settingsRouter: router });
                    assert.equal(adapter.status().active, true, JSON.stringify(adapter.status()));
                }
                result = { mode: message.mode, active: adapter?.status().active || false };
            } else if (message.operation === 'begin') {
                gaps = [];
                let last = performance.now();
                timer = setInterval(() => {
                    const now = performance.now();
                    gaps.push(now - last);
                    last = now;
                }, 1);
                result = {};
            } else if (message.operation === 'end') {
                // Include the next timer turn, so a final synchronous send is
                // represented even if the IPC message was dispatched first.
                await new Promise(resolve => setTimeout(resolve, 2));
                clearInterval(timer);
                timer = undefined;
                result = { gaps, reader: adapter?.status().reader };
            } else if (message.operation === 'close') {
                clearInterval(timer);
                adapter?.dispose();
                server.closeAllConnections();
                server.close(() => process.exit(0));
                return;
            } else throw new Error('Unknown benchmark operation');
            process.send({ id: message.id, result });
        } catch (error) { process.send({ id: message.id, error: error.message }); }
    });
    process.send({ ready: true, port: server.address().port });
}

function percentile(values, proportion) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)] || 0;
}
function distribution(values) {
    return { samples: values.length, median: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values, 0) };
}

async function main() {
    const host = path.resolve(process.argv[2] || path.join(project, 'private/host-flow'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tf-startup-http-'));
    const pending = new Map();
    let child;
    let agent;
    let nextId = 0;
    try {
        await fs.writeFile(path.join(root, 'config.yaml'), CONFIG);
        await fs.writeFile(path.join(root, 'directories.json'), JSON.stringify(await makeFixture(root)));
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SILLYTAVERN_')));
        child = fork(script, ['--child'], {
            env: { ...env, TF_HTTP_BENCH_ROOT: root, TF_HTTP_BENCH_HOST: host, UV_THREADPOOL_SIZE: '1' },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        // Dependency startup messages are discarded; never include host paths or
        // module logs in the public report. Failures disclose only the exit code.
        child.stdout.resume();
        child.stderr.resume();
        const ready = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Isolated router startup timeout')), 20000);
            child.on('message', message => {
                if (message.ready) { clearTimeout(timeout); resolve(message); }
                else if (pending.has(message.id)) {
                    const { resolve: done, reject: fail } = pending.get(message.id);
                    pending.delete(message.id);
                    if (message.error) fail(new Error(message.error)); else done(message.result);
                }
            });
            child.once('exit', code => {
                clearTimeout(timeout);
                reject(new Error(`Isolated router exited (${code})`));
                for (const waiter of pending.values()) waiter.reject(new Error(`Isolated router exited (${code})`));
                pending.clear();
            });
        });
        const control = (operation, extra = {}) => new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            child.send({ operation, id, ...extra });
        });
        agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
        const request = (route, hashBody = true) => new Promise((resolve, reject) => {
            const started = performance.now();
            const hash = hashBody ? createHash('sha256') : undefined;
            let bytes = 0;
            const req = http.request({ hostname: '127.0.0.1', port: ready.port, path: route, method: route === '/light' ? 'GET' : 'POST', agent, headers: route === '/light' ? {} : { 'Content-Type': 'application/json', 'Content-Length': '2' } }, response => {
                response.on('data', chunk => { bytes += chunk.length; hash?.update(chunk); });
                response.once('end', () => {
                    if (response.statusCode !== 200) return reject(new Error(`Synthetic HTTP request failed (${response.statusCode})`));
                    resolve({ ms: performance.now() - started, bytes, sha256: hash?.digest('hex') });
                });
                response.once('error', reject);
            });
            req.setTimeout(20000, () => req.destroy(new Error('Synthetic HTTP request timeout')));
            req.once('error', reject);
            req.end(route === '/light' ? undefined : '{}');
        });
        await control('mode', { mode: 'native' });
        const nativeBody = await request('/api/settings/get');
        await control('mode', { mode: 'fresh' });
        const freshBody = await request('/api/settings/get');
        assert.equal(freshBody.bytes, nativeBody.bytes);
        assert.equal(freshBody.sha256, nativeBody.sha256, 'Full HTTP response bytes must match');
        const samples = { 1: { native: [], fresh: [] }, 4: { native: [], fresh: [] } };
        async function runBatch(mode, concurrency) {
            await control('mode', { mode });
            await control('begin');
            const probes = [];
            let probing = true;
            const probeLoop = (async () => {
                await new Promise(resolve => setTimeout(resolve, 5));
                while (probing) {
                    probes.push((await request('/light', false)).ms);
                    if (probing) await new Promise(resolve => setTimeout(resolve, 5));
                }
            })();
            const started = performance.now();
            const requests = await Promise.all(Array.from({ length: concurrency }, () => request('/api/settings/get')));
            const wallMs = performance.now() - started;
            probing = false;
            await probeLoop;
            const measurement = await control('end');
            for (const item of requests) {
                assert.equal(item.bytes, nativeBody.bytes);
                assert.equal(item.sha256, nativeBody.sha256);
            }
            return { wallMs, requestMs: requests.map(item => item.ms), lightRequestMs: probes, timerGapsMs: measurement.gaps, maxTimerGapMs: Math.max(...measurement.gaps, 0) };
        }
        for (const concurrency of [1, 4]) {
            for (let round = 0; round < WARMUPS; round++) for (const mode of ['native', 'fresh']) await runBatch(mode, concurrency);
            for (let round = 0; round < ROUNDS; round++) {
                const order = round % 2 ? ['fresh', 'native'] : ['native', 'fresh'];
                for (const mode of order) samples[concurrency][mode].push(await runBatch(mode, concurrency));
            }
        }
        const summarize = (rows, concurrency) => {
            const wallMs = rows.reduce((sum, row) => sum + row.wallMs, 0);
            return {
                batches: rows.length, requests: rows.length * concurrency,
                latencyMs: distribution(rows.flatMap(row => row.requestMs)),
                batchWallMs: distribution(rows.map(row => row.wallMs)),
                requestsPerSecond: rows.length * concurrency / wallMs * 1000,
                responseMiBPerSecond: rows.length * concurrency * nativeBody.bytes / 1048576 / wallMs * 1000,
                lightRequestLatencyMs: distribution(rows.flatMap(row => row.lightRequestMs)),
                perBatchMaxLightRequestLatencyMs: distribution(rows.map(row => Math.max(...row.lightRequestMs, 0))),
                eventLoopHeartbeatGapMs: distribution(rows.flatMap(row => row.timerGapsMs)),
                perBatchMaxHeartbeatGapMs: distribution(rows.map(row => row.maxTimerGapMs)),
            };
        };
        const report = {
            generatedAt: new Date().toISOString(), node: process.version, architecture: process.arch,
            fixture: { source: 'synthetic-only; no host config/settings/accounts/secrets/chats read', presetJsonFiles: 165, settingsJsonFiles: 1, worldNames: 75, inputBytes: SETTINGS_BYTES + LAYOUT.reduce((sum, [, , bytes]) => sum + bytes, 0), responseBytes: nativeBody.bytes, responseSha256: nativeBody.sha256 },
            method: { native: 'Actual SillyTavern 1.19.0 settings.router mounted on actual Express dependency', fresh: 'installFreshSettingsRoute with native configuration and fingerprint guards', bind: '127.0.0.1, OS-assigned port; independent temporary process', client: 'Separate process, consumes full HTTP response and checks SHA-256 on every request', httpCompression: false, nativeExpressResponseSend: true, serverHeartbeatMs: 1, concurrentLightRequestDelayMs: 5, warmupBatchesPerModePerConcurrency: WARMUPS, alternatingWarmBatchesPerModePerConcurrency: ROUNDS, uvThreadpoolSize: 1, v8PoolSize: 1, cache: 'OS page cache retained; not a cold-disk benchmark', includes: ['Native reads and validation', 'Express response.send JSON serialization and ETag', 'Loopback full HTTP transfer', 'Client streaming SHA-256'], excludes: ['Authentication/CSRF/proxy middleware', 'st-sync/Nginx/public network', 'Browser parse/initialization', 'Real phone hardware'] },
            parity: { status: 'passed', comparison: 'Full response length and SHA-256 for native/fresh and every measured request' },
            results: Object.fromEntries([1, 4].map(concurrency => [concurrency, Object.fromEntries(['native', 'fresh'].map(mode => [mode, summarize(samples[concurrency][mode], concurrency)]))])),
            samples,
        };
        await fs.writeFile(path.join(project, 'reports/startup-http-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ parity: report.parity, fixture: report.fixture, results: report.results }, null, 2));
        child.send({ operation: 'close', id: ++nextId });
        await new Promise(resolve => child.once('exit', resolve));
        child = undefined;
    } finally {
        agent?.destroy();
        if (child) child.kill('SIGTERM');
        await fs.rm(root, { recursive: true, force: true });
    }
}

if (process.argv[2] === '--child') await serverChild();
else await main();
