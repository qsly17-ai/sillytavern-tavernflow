import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createFreshSettingsReader, installFreshSettingsRoute } from '../server/startup-settings.mjs';

const DIRECTORY_KEYS = ['novelAI_Settings', 'openAI_Settings', 'textGen_Settings', 'koboldAI_Settings', 'worlds', 'themes', 'movingUI', 'quickreplies', 'instruct', 'context', 'sysprompt', 'reasoning'];
const config = { enable_extensions: true, enable_extensions_auto_update: false, enable_accounts: true, request_compression: { enabled: true, minPayloadSize: 262144, maxPayloadSize: 8388608, timeout: 4000 } };
const immediate = () => new Promise(resolve => setImmediate(resolve));
async function makeFixture(root) {
    const directories = { root };
    await fs.mkdir(root, { recursive: true });
    for (const key of DIRECTORY_KEYS) {
        directories[key] = path.join(root, key);
        await fs.mkdir(directories[key]);
    }
    await fs.writeFile(path.join(root, 'settings.json'), '{ "extension_settings": {"mvu": true}, "spacing": "preserved" }\n');
    return { user: { directories } };
}
async function smallFixture(root) {
    const request = await makeFixture(root);
    const directories = request.user.directories;
    for (const key of DIRECTORY_KEYS.filter(key => key !== 'worlds')) {
        for (const [name, content] of [['中文.json', '{"id":"中文"}'], ['10.json', 'null'], ['2.json', 'false'], ['A.json', '0'], ['z.json', '[1,2]'], ['bad.json', '{broken'], ['skip.JSON', '{"skip":true}'], ['skip.txt', '{}']]) {
            await fs.writeFile(path.join(directories[key], name), content);
        }
        await fs.mkdir(path.join(directories[key], 'directory.json'));
    }
    for (const name of ['中文.json', '10.JSON', '2.Json', 'A.json', 'ignore.txt']) await fs.writeFile(path.join(directories.worlds, name), 'not read');
    return request;
}
function response() {
    return { code: 200, send(value) { this.body = value; return this; }, sendStatus(code) { this.code = code; return this; } };
}
async function callNative(handler, request) {
    const result = response();
    await handler(request, result, error => { throw error; });
    return result;
}

async function checkNative() {
    const root = process.env.TAVERNFLOW_SETTINGS_TEST_ROOT;
    const host = process.env.TAVERNFLOW_HOST_ROOT;
    // Never load the running host's config, account list, settings or chats.
    process.chdir(host);
    globalThis.DATA_ROOT = path.join(root, 'unused-data');
    const { setConfigFilePath } = await import(pathToFileURL(path.join(host, 'src/util.js')));
    setConfigFilePath(path.join(root, 'config.yaml'));
    const native = await import(pathToFileURL(path.join(host, 'src/endpoints/settings.js')));
    const layer = native.router.stack.find(layer => layer.route?.path === '/get').route.stack[0];
    const original = layer.handle;
    const request = await smallFixture(path.join(root, 'fixture'));
    const expected = (await callNative(original, request)).body;
    const reader = createFreshSettingsReader({ getRuntimeConfig: () => config });
    assert.deepEqual(await reader.read(request), expected);
    const relative = { user: { directories: Object.fromEntries(Object.entries(request.user.directories).map(([key, value]) => [key, path.relative(host, value)])) } };
    assert.deepEqual(await reader.read(relative), expected);
    // Every request sees replacements, equal-size edits, deletions and additions.
    await fs.writeFile(path.join(request.user.directories.root, 'settings.json'), '{"v":"AAA"}');
    await reader.read(request);
    await fs.writeFile(path.join(request.user.directories.root, 'settings.json'), '{"v":"BBB"}');
    await fs.rm(path.join(request.user.directories.openAI_Settings, 'A.json'));
    await fs.rename(path.join(request.user.directories.openAI_Settings, '2.json'), path.join(request.user.directories.openAI_Settings, '3.json'));
    await fs.writeFile(path.join(request.user.directories.themes, 'new.json'), '{"new":true}');
    await fs.writeFile(path.join(request.user.directories.worlds, 'new.JSON'), 'ignored body');
    assert.deepEqual(await reader.read(request), (await callNative(original, request)).body);
    assert.equal((await reader.read(request)).settings, '{"v":"BBB"}');

    const badShape = await installFreshSettingsRoute({ hostRoot: host, enabled: true, settingsRouter: {
        stack: [{ route: { path: '/get', methods: { post: true, get: true }, stack: [layer] } }],
    } });
    assert.equal(badShape.status().reason, 'unverified_route_shape');
    assert.equal(layer.handle, original);
    const installed = await installFreshSettingsRoute({ hostRoot: host, enabled: true, settingsRouter: native.router });
    assert.equal(installed.status().active, true, JSON.stringify(installed.status()));
    assert.deepEqual((await callNative(layer.handle, request)).body, (await callNative(original, request)).body);
    await fs.rm(path.join(request.user.directories.root, 'settings.json'));
    assert.equal((await callNative(layer.handle, request)).code, 500);
    await fs.writeFile(path.join(request.user.directories.root, 'settings.json'), '{}');
    await fs.rm(request.user.directories.themes, { recursive: true });
    let errorFromNext;
    await layer.handle(request, response(), error => { errorFromNext = error; });
    assert.equal(errorFromNext?.code, 'ENOENT');
    assert.throws(() => original(request, response()), { code: 'ENOENT' });
    await fs.mkdir(request.user.directories.themes);
    installed.dispose();
    assert.equal(layer.handle, original);
    assert.equal(installed.status().active, false);

    const second = await installFreshSettingsRoute({ hostRoot: host, enabled: true, settingsRouter: native.router });
    const thirdParty = () => {};
    layer.handle = thirdParty;
    assert.equal(second.status().reason, 'ownership_lost');
    second.dispose();
    assert.equal(layer.handle, thirdParty, 'dispose must not remove a later owner');
    const conflict = await installFreshSettingsRoute({ hostRoot: host, enabled: true, settingsRouter: native.router });
    assert.equal(conflict.status().reason, 'unverified_settings_handler');
    layer.handle = original;
    const report = { parity: 'passed', nativeVersion: '1.19.0', fixture: 'synthetic-only', installAndDispose: 'passed' };
    if (process.env.TAVERNFLOW_SETTINGS_BENCH === '1') report.benchmark = await benchmark(root, original);
    console.log('TAVERNFLOW_SETTINGS_RESULT=' + JSON.stringify(report));
}

async function benchmark(root, original) {
    const request = await makeFixture(path.join(root, 'large-fixture'));
    const d = request.user.directories;
    // Match only public aggregate sizes/counts. No private file is copied.
    const layout = [
        ['novelAI_Settings', 24, 13587], ['openAI_Settings', 15, 15443795],
        ['textGen_Settings', 6, 15395], ['koboldAI_Settings', 6, 2481],
        ['themes', 21, 3975953], ['movingUI', 1, 50], ['quickreplies', 2, 9644],
        ['instruct', 38, 29567], ['context', 34, 24318], ['sysprompt', 13, 3664], ['reasoning', 5, 590],
    ];
    const payload = length => '{"text":"' + 'x'.repeat(length - 11) + '"}';
    await fs.writeFile(path.join(d.root, 'settings.json'), payload(10086479));
    for (const [key, count, bytes] of layout) {
        for (let index = 0; index < count; index++) {
            const size = Math.floor(bytes / count) + (index < bytes % count ? 1 : 0);
            await fs.writeFile(path.join(d[key], `preset-${String(index).padStart(3, '0')}.json`), payload(size));
        }
    }
    for (let index = 0; index < 75; index++) await fs.writeFile(path.join(d.worlds, `world-${index}.json`), '');
    const reader = createFreshSettingsReader({ getRuntimeConfig: () => config });
    assert.deepEqual(await reader.read(request), (await callNative(original, request)).body);
    const native = () => callNative(original, request);
    const fresh = () => reader.read(request);
    const measure = async operation => {
        // An independent 1 ms heartbeat reveals how long this request prevents
        // unrelated work. Include the next timer tick after synchronous handlers.
        await immediate();
        const timerGaps = [];
        let lastTick = performance.now();
        const timer = setInterval(() => { const now = performance.now(); timerGaps.push(now - lastTick); lastTick = now; }, 1);
        const rssBefore = process.memoryUsage().rss;
        const started = performance.now();
        await operation();
        const wallMs = performance.now() - started;
        await new Promise(resolve => setTimeout(resolve, 2));
        clearInterval(timer);
        return { wallMs, maxTimerGapMs: Math.max(...timerGaps, 0), rssDeltaBytes: process.memoryUsage().rss - rssBefore };
    };
    const rows = { native: [], fresh: [] };
    // True OS cold-cache eviction would affect the live host. Do not drop caches.
    // The first call and 20 interleaved warm rounds are honestly labelled here.
    const first = { native: await measure(native), fresh: await measure(fresh) };
    for (let index = 0; index < 20; index++) {
        if (index % 2) { rows.fresh.push(await measure(fresh)); rows.native.push(await measure(native)); }
        else { rows.native.push(await measure(native)); rows.fresh.push(await measure(fresh)); }
    }
    const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
    const summarize = values => Object.fromEntries(['wallMs', 'maxTimerGapMs', 'rssDeltaBytes'].map(key => [key, {
        median: percentile(values.map(row => row[key]), 0.5), p95: percentile(values.map(row => row[key]), 0.95), max: Math.max(...values.map(row => row[key])),
    }]));
    return {
        presetFiles: 165, worldNames: 75,
        inputBytes: 10086479 + layout.reduce((sum, [, , size]) => sum + size, 0),
        outputBytes: Buffer.byteLength(JSON.stringify((await callNative(original, request)).body)),
        rounds: 20, cacheConditions: 'OS page cache retained; not a cold-disk benchmark',
        firstMeasured: first, warm: { native: summarize(rows.native), fresh: summarize(rows.fresh) },
        readerStats: reader.stats(), includesResponseSerialization: false, includesNetwork: false,
    };
}

if (process.env.TAVERNFLOW_SETTINGS_CHILD === '1') {
    await checkNative();
} else {
    test('fresh settings preserves raw strings, JSON primitive values and distinct native sort rules', async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-settings-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        const request = await smallFixture(root);
        const reader = createFreshSettingsReader({ getRuntimeConfig: () => config });
        const value = await reader.read(request);
        assert.equal(value.settings, '{ "extension_settings": {"mvu": true}, "spacing": "preserved" }\n');
        assert.deepEqual(value.openai_setting_names, ['10', '2', 'A', 'z', '中文'].sort((a, b) => a.localeCompare(b)));
        assert.deepEqual(value.themes, [null, false, 0, [1, 2], { id: '中文' }]);
        assert.deepEqual(value.world_names, ['中文', '10', '2', 'A'].sort((a, b) => (a + '.json').localeCompare(b + '.json')));
        assert.deepEqual(value.request_compression, config.request_compression);
        value.request_compression.enabled = false;
        await fs.writeFile(path.join(root, 'settings.json'), 'same-size-A');
        assert.equal((await reader.read(request)).settings, 'same-size-A');
        await fs.writeFile(path.join(root, 'settings.json'), 'same-size-B');
        const next = await reader.read(request);
        assert.equal(next.settings, 'same-size-B');
        assert.equal(next.request_compression.enabled, true);
        assert.equal(reader.stats().requests, 3);
    });

    test('I/O is globally bounded across requests, and failures do not poison later fresh reads', async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-settings-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        const request = await smallFixture(root);
        let inFlight = 0, peak = 0;
        const io = Object.fromEntries(['readFile', 'readdir'].map(key => [key, async (...args) => {
            inFlight++; peak = Math.max(peak, inFlight);
            try { await immediate(); return await fs[key](...args); }
            finally { inFlight--; }
        }]));
        const reader = createFreshSettingsReader({ io, getRuntimeConfig: () => config });
        await Promise.all([reader.read(request), reader.read(request), reader.read(request)]);
        assert.equal(peak, 8);
        assert.equal(reader.stats().ioPeak, 8);
        await fs.rm(path.join(root, 'settings.json'));
        await assert.rejects(reader.read(request), /Settings file could not be read/);
        await fs.writeFile(path.join(root, 'settings.json'), '{}');
        assert.equal((await reader.read(request)).settings, '{}');
        assert.equal(reader.stats().failures, 1);
        assert.throws(() => createFreshSettingsReader({ getRuntimeConfig: () => config, concurrency: 9 }), RangeError);
    });

    test('route replacement is opt-in and rejects unknown versions and source fingerprints', async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-settings-install-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        assert.equal((await installFreshSettingsRoute({ hostRoot: root })).status().reason, 'disabled');
        await fs.mkdir(path.join(root, 'src/endpoints'), { recursive: true });
        await fs.writeFile(path.join(root, 'src/endpoints/settings.js'), 'modified source');
        await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.20.0' }));
        assert.equal((await installFreshSettingsRoute({ hostRoot: root, enabled: true })).status().reason, 'unverified_host_version');
        await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.19.0' }));
        assert.equal((await installFreshSettingsRoute({ hostRoot: root, enabled: true })).status().reason, 'unverified_settings_source');
    });

    test('actual 1.19 settings/get parity, freshness, route ownership and optional synthetic benchmark', { skip: !process.env.TAVERNFLOW_HOST_ROOT, timeout: 60000 }, async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-settings-native-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        await fs.writeFile(path.join(root, 'config.yaml'), 'enableUserAccounts: true\nextensions:\n  enabled: true\n  autoUpdate: false\nperformance:\n  requestCompression:\n    enabled: true\n    minPayloadSize: 256kb\n    maxPayloadSize: 8mb\n    timeout: 4000\n');
        // Prevent inherited overrides from silently changing the isolated config.
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SILLYTAVERN_')));
        const result = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url)], {
            env: { ...env, TAVERNFLOW_SETTINGS_CHILD: '1', TAVERNFLOW_SETTINGS_TEST_ROOT: root },
            timeout: 55000, maxBuffer: 2 * 1024 * 1024,
        });
        const receipt = result.stdout.split('\n').find(line => line.startsWith('TAVERNFLOW_SETTINGS_RESULT='));
        assert(receipt, result.stdout);
        const report = JSON.parse(receipt.slice('TAVERNFLOW_SETTINGS_RESULT='.length));
        assert.equal(report.parity, 'passed');
        if (report.benchmark) console.log('TAVERNFLOW_SETTINGS_BENCHMARK=' + JSON.stringify(report.benchmark));
    });
}
