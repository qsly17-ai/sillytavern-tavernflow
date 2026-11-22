// Optional Chromium performance gate. Point TAVERNFLOW_BASELINE_BOOT at 0.4.1's
// client/boot.js, and TAVERNFLOW_HOST_ROOT at the clean 1.19.0 source checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TAVERNFLOW_PLAYWRIGHT_PATH ?? 'playwright');
const hostRoot = process.env.TAVERNFLOW_HOST_ROOT;
if (!hostRoot || !process.env.TAVERNFLOW_BASELINE_BOOT) throw new Error('Set TAVERNFLOW_HOST_ROOT and TAVERNFLOW_BASELINE_BOOT.');
const compressor = await fs.readFile(path.join(hostRoot, 'public/scripts/request-compression.js'), 'utf8');
const fflate = await fs.readFile(path.join(hostRoot, 'node_modules/fflate/esm/browser.js'), 'utf8');
const versions = {
    old: await fs.readFile(process.env.TAVERNFLOW_BASELINE_BOOT, 'utf8'),
    current: await fs.readFile(new URL('../client/boot.js', import.meta.url), 'utf8'),
};
const transport = await fs.readFile(new URL('../client/transport.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.TAVERNFLOW_CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    await context.route('https://tf.test/**', route => route.fulfill(route.request().url().endsWith('/lib.js')
        ? { contentType: 'text/javascript', body: fflate }
        : { contentType: 'text/html', body: '<!doctype html><body></body>' }));
    const pages = {}, readings = { settings: { old: [], current: [] }, chat: { old: [], current: [] }, save: { old: [], current: [] } };
    if (process.env.TAVERNFLOW_TEST_GZIP) readings.saveGzipWindow = { old: [], current: [] };
    const sizes = {}, blocking = { old: [], current: [] };
    for (const [version, source] of Object.entries(versions)) {
        const page = pages[version] = await context.newPage();
        await page.goto('https://tf.test/');
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await page.evaluate(() => {
            const lines = Array.from({ length: 500 }, (_, i) => ({
                name: 'Synthetic', mes: '正文a'.repeat(2400), extra: { index: i, variables: { value: i } },
                swipes: ['历史b'.repeat(1600)], unknown: { enabled: true },
            }));
            const settings = { extension_settings: { synthetic: Array.from({ length: 1200 }, (_, i) => ({
                id: i, content: '配置c'.repeat(2400), unknown: '"\\',
            })) } };
            window.fixtureBlobs = {
                chat: new Blob([JSON.stringify(lines)]),
                settings: new Blob([JSON.stringify({ settings: JSON.stringify(settings), presets: ['example'] })]),
            };
            window.fixtureSave = { ch_name: 'Synthetic', file_name: 'long', chat: lines, avatar_url: 'test.png', force: false };
            window.fixtureSaveMedium = { ...window.fixtureSave, chat: lines.slice(0, 200) };
            window.fetch = async path => new Response(window.fixtureBlobs[path === '/api/settings/get' ? 'settings' : 'chat']);
            // Only readiness is simulated. Measurement ends before transport to the
            // Worker. The native preparation and new delegation are production code.
            const NativeWorker = window.Worker;
            window.Worker = class {
                constructor(url, options) {
                    if (options?.name !== 'tavern-flow-save') return new NativeWorker(url, options);
                }
                postMessage(message) {
                    if (message.type === 'init') setTimeout(() => this.onmessage({ data: { type: 'ready' } }), 0);
                }
                terminate() {}
            };
        });
        await page.addScriptTag({ content: source });
        await page.addScriptTag({ type: 'module', content: compressor + '\nwindow.compressor = compressRequest; setRequestCompressionConfig({ enabled: true, minPayloadSize: 262144, maxPayloadSize: 8388608, timeout: 30000 });' });
        await page.addScriptTag({ type: 'module', content: transport + '\nwindow.transportTest = installTransport({ getHeaders: () => ({}) });' });
        await page.waitForFunction(() => window.transportTest?.status().enabled && window.compressor);
    }
    // Discard one warm-up and alternate order to reduce drift.
    for (let round = -1; round < 5; round++) {
        for (const version of round % 2 ? ['old', 'current'] : ['current', 'old']) {
            for (const kind of Object.keys(readings)) {
                const sample = await pages[version].evaluate(async kind => {
                    const boot = window.__tavernFlowBoot;
                    const start = performance.now();
                    if (kind.startsWith('save')) {
                        const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(kind === 'save' ? window.fixtureSave : window.fixtureSaveMedium) };
                        const pending = (boot.nativeSavePreparer?.('/api/chats/save', window.compressor) ?? window.compressor)(init);
                        const blockingMs = performance.now() - start;
                        const prepared = await pending;
                        const ms = performance.now() - start;
                        if (new Headers(prepared.headers).get('content-encoding') === 'gzip') {
                            const decoded = await new Response(new Blob([prepared.body]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
                            if (decoded !== init.body) throw new Error('Compressed snapshot changed');
                        } else if (prepared.body !== init.body || (kind === 'saveGzipWindow' && !boot.nativeSavePreparer)) throw new Error('Snapshot changed or native gzip did not run');
                        return { ms, blockingMs, bytes: new Blob([init.body]).size };
                    }
                    const response = await boot.nativeRead(kind === 'chat' ? '/api/chats/get' : '/api/settings/get', {
                        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
                    });
                    const data = await response.json();
                    const settings = kind === 'settings' ? (boot.parseNativeSettings?.(response, data.settings) ?? JSON.parse(data.settings)) : undefined;
                    const ms = performance.now() - start;
                    if (settings ? settings.extension_settings.synthetic[1199].id !== 1199 : data[499].extra.index !== 499) throw new Error('Wrong output');
                    return { ms, bytes: window.fixtureBlobs[kind].size };
                }, kind);
                sizes[kind] = sample.bytes;
                if (round >= 0) {
                    readings[kind][version].push(Math.round(sample.ms));
                    if (kind === 'saveGzipWindow') blocking[version].push(Math.round(sample.blockingMs));
                }
            }
        }
    }
    assert.equal(await pages.current.evaluate(() => window.transportTest.status().nativePrecompressSkipped), readings.saveGzipWindow ? 12 : 6);
    const results = Object.fromEntries(Object.entries(readings).map(([kind, samples]) => [kind, {
        bytes: sizes[kind], samplesMs: samples,
        medianMs: Object.fromEntries(Object.entries(samples).map(([version, series]) => [version, [...series].sort((a, b) => a - b)[2]])),
    }]));
    if (results.saveGzipWindow) results.saveGzipWindow.synchronousMs = blocking;
    console.log(JSON.stringify({ cpuSlowdown: 4, viewport: [390, 844], chromium: browser.version(), results }, null, 2));
} finally { await browser.close(); }
