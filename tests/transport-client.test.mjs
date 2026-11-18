import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { installTransport } from '../client/transport.js';
import { hashValue, applyOps } from '../shared/protocol.mjs';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'tf-client-'));
await mkdir(path.join(fixture, 'lib'));
await copyFile(new URL('../client/worker.js', import.meta.url), path.join(fixture, 'worker.mjs'));
await copyFile(new URL('../shared/protocol.mjs', import.meta.url), path.join(fixture, 'lib/protocol.mjs'));
const { createTransportRuntime } = await import(pathToFileURL(path.join(fixture, 'worker.mjs')));
const bootSource = await readFile(new URL('../client/boot.js', import.meta.url), 'utf8');
after(() => rm(fixture, { recursive: true, force: true }));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const waitFor = async (condition) => {
    for (let n = 0; n < 500; n++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
    assert.fail('condition timed out');
};
function setup({ gate, unhealthy = false, onSave, bootstrap = false, backgroundChat } = {}) {
    let value = { username: '天子大人', data: 'x'.repeat(10000) };
    const calls = [];
    const workers = [];
    const native = function(input, init) {
        calls.push({ native: true, input, init, receiver: this });
        const url = new URL(input instanceof Request ? input.url : input, 'https://st.test/');
        if (url.pathname === '/api/settings/get') return Promise.resolve(json({ settings: JSON.stringify(value) }));
        if (url.pathname === '/api/chats/get' && backgroundChat) return Promise.resolve(backgroundChat);
        return Promise.resolve(json({ native: true }));
    };
    async function workerFetch(url, init = {}) {
        const route = new URL(url).pathname.split('/').at(-1);
        if (route === 'health') return json({ ok: !unhealthy, protocol: 1, capabilities: { deltaSave: true, kinds: ['settings', 'chat', 'group'], requestGzip: true } });
        const body = new Headers(init.headers).get('content-encoding') === 'gzip'
            ? await new Response(new Blob([init.body]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
            : await new Blob([init.body]).text();
        const payload = JSON.parse(body);
        calls.push({ native: false, route, payload, init });
        if (route === 'state') return json({ ok: true, value, hash: await hashValue(value) });
        if (gate) await gate;
        if (init.signal?.aborted) throw init.signal.reason;
        const overridden = await onSave?.({ payload, init, getValue: () => value, setValue: (next) => { value = next; } });
        if (overridden) return overridden;
        if (payload.baseHash !== await hashValue(value)) return json({ ok: false, error: 'conflict', hash: await hashValue(value) }, 409);
        value = payload.mode === 'full' ? payload.value : payload.mode === 'patch' ? applyOps(value, payload.ops) : value;
        return json({ ok: true, hash: await hashValue(value), mode: payload.mode });
    }
    class FakeWorker {
        terminated = false;
        messages = [];
        events = [];
        constructor() {
            workers.push(this);
            this.runtime = createTransportRuntime({ fetch: workerFetch, postMessage: (data) => { this.events.push(data); if (!this.terminated) setImmediate(() => this.onmessage?.({ data })); } });
        }
        postMessage(message, transfer = []) {
            this.messages.push({ type: message.type, bodyType: typeof message.body, body: typeof message.body === 'string' ? message.body : undefined, headers: message.headers, credentials: message.credentials, baselines: message.baselines, transferCount: transfer.length });
            const data = structuredClone(message, { transfer });
            setImmediate(() => { if (!this.terminated) this.runtime.handleMessage(data).catch(() => this.onerror?.()); });
        }
        terminate() { this.terminated = true; }
    }
    const host = { location: { href: 'https://st.test/', origin: 'https://st.test' }, fetch: native, Worker: FakeWorker, crypto: globalThis.crypto, DecompressionStream: globalThis.DecompressionStream };
    if (bootstrap) {
        Object.assign(host, { top: host, AbortController, ReadableStream, Headers, URL, Blob, Response, setTimeout, clearTimeout, structuredClone });
        vm.runInNewContext(bootSource, host);
    }
    return { host, calls, workers, native, getValue: () => value, setValue: (next) => { value = next; } };
}
async function withHost(h, operation) {
    const previous = globalThis.window;
    globalThis.window = h.host;
    try { await operation(); } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
}
const headers = { 'content-type': 'application/json', 'x-csrf-token': 'test' };
const save = (value, extra = {}) => ({ method: 'POST', headers, body: JSON.stringify(value), ...extra });
async function adoptSettings(host) {
    const boot = host.__tavernFlowBoot;
    const response = await boot.nativeRead('/api/settings/get', save({}));
    const { settings } = await response.json();
    const pageSettings = JSON.parse(settings);
    boot.adoptRead(response, settings);
    return pageSettings;
}

test('client accepts Request/init and native gzip without consuming the original Request', async () => {
    const h = setup();
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const next = { username: '凌宇', data: 'y'.repeat(10000) };
        const compressed = await new Response(new Blob([JSON.stringify(next)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
        const request = new Request('https://st.test/api/settings/save', { method: 'POST', headers: { ...headers, 'content-encoding': 'gzip' }, body: compressed });
        const result = await h.host.fetch(request, { cache: 'no-cache' });
        assert.equal(result.status, 200);
        assert.equal(request.bodyUsed, false);
        assert.deepEqual(h.getValue(), next);
        assert.equal(h.calls.filter((call) => call.native).length, 0);
        assert.equal(controller.status().completed, 1);
        assert.equal(controller.status().sourceBytes, compressed.byteLength);
        assert.ok(controller.status().originalBytes > controller.status().sourceBytes);
        controller.dispose();
        assert.equal(h.host.fetch, h.native);
        assert.equal(h.workers[0].terminated, true);
    });
});

test('adopted native settings seed the Worker before an immediate save, without a state round trip', async () => {
    const h = setup({ bootstrap: true });
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const next = await adoptSettings(h.host); next.username = '苏苏子';
        assert.equal((await h.host.fetch('/api/settings/save', save(next))).status, 200);
        assert.equal(h.calls.filter((call) => call.route === 'state').length, 0);
        assert.equal(h.calls.filter((call) => call.route === 'save').length, 1);
        controller.dispose();
    });
});

test('an unread background chat body cannot delay an unrelated settings save', { timeout: 2000 }, async () => {
    let stream;
    const backgroundChat = new Response(new ReadableStream({ start(controller) { stream = controller; } }));
    const h = setup({ bootstrap: true, backgroundChat });
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        try {
            await waitFor(() => controller.status().enabled);
            const next = await adoptSettings(h.host); next.username = 'saved while response is open';
            const response = await h.host.fetch('/api/chats/get', save({ avatar_url: 'test.png', file_name: 'archive' }));
            assert.equal(response, backgroundChat);
            assert.equal((await h.host.fetch('/api/settings/save', save(next))).status, 200);
            assert.deepEqual(h.getValue(), next);
            assert.equal(response.bodyUsed, false);
        } finally { stream.close(); await controller.dispose(); }
    });
});

test('non-target, anonymous, keepalive, cross-origin and unsupported encodings preserve fetch arguments', async () => {
    const h = setup();
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const inputs = [
            ['/api/backends/chat-completions/generate', save({ text: 'prompt' })],
            ['/api/settings/save', save({}, { credentials: 'omit' })],
            ['/api/settings/save', save({}, { keepalive: true })],
            ['https://elsewhere.test/api/settings/save', save({})],
            ['/api/settings/save', save({}, { headers: { ...headers, 'content-encoding': 'br' } })],
            ['/api/settings/save', { method: 'GET' }],
        ];
        for (const [input, init] of inputs) {
            await h.host.fetch(input, init);
            const call = h.calls.at(-1);
            assert.equal(call.native, true); assert.equal(call.input, input); assert.equal(call.init, init); assert.equal(call.receiver, h.host);
        }
        assert.equal(h.calls.length, inputs.length);
        controller.dispose();
    });
});

test('dispose restores only its owned fetch and drains already accepted saves', async () => {
    let release;
    const h = setup({ gate: new Promise((resolve) => { release = resolve; }) });
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const pending = h.host.fetch('/api/settings/save', save({ username: '保存中' }));
        await waitFor(() => h.calls.some((call) => call.route === 'save'));
        const wrapper = h.host.fetch;
        const laterWrapper = function(...args) { return wrapper.apply(this, args); };
        h.host.fetch = laterWrapper;
        controller.dispose();
        assert.equal(h.host.fetch, laterWrapper);
        assert.equal(h.workers[0].terminated, false);
        assert.equal(controller.status().pending, 1);
        release();
        assert.equal((await pending).status, 200);
        await waitFor(() => h.workers[0].terminated);
        assert.equal(controller.status().pending, 0);
        assert.equal(controller.status().reason, 'disposed');
    });
});

test('aborted Request rejects, the worker settles without retry or false success', async () => {
    let release;
    const h = setup({ gate: new Promise((resolve) => { release = resolve; }) });
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const abort = new AbortController();
        const pending = h.host.fetch(new Request('https://st.test/api/settings/save', save({ username: '取消' }, { signal: abort.signal })));
        const rejected = assert.rejects(pending, { name: 'AbortError' });
        await waitFor(() => h.calls.some((call) => call.route === 'save'));
        abort.abort();
        await rejected;
        release();
        await waitFor(() => controller.status().pending === 0);
        assert.equal(controller.status().completed, 0);
        assert.equal(h.calls.filter((call) => call.route === 'save').length, 1);
        controller.dispose();
    });
});

test('unavailable backend and missing worker capabilities keep native saving available', async () => {
    const h = setup({ unhealthy: true });
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().reason === 'backend-unavailable');
        assert.equal(h.host.fetch, h.native);
        await h.host.fetch('/api/settings/save', save({ n: 1 }));
        assert.equal(h.calls[0].native, true);
        controller.dispose();
        delete h.host.Worker;
        const unsupported = installTransport({ getHeaders: () => headers });
        assert.equal(unsupported.status().enabled, false);
        assert.equal(unsupported.status().reason, 'worker-capability-unavailable');
        assert.equal(h.host.fetch, h.native);
    });
});

test('new native saves wait until dispose has drained accepted worker saves', async () => {
    let release;
    const h = setup({ gate: new Promise((resolve) => { release = resolve; }) });
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const pending = h.host.fetch('/api/settings/save', save({ username: 'Worker保存' }));
        await waitFor(() => h.calls.some((call) => call.route === 'save'));
        const disposed = controller.dispose();
        const next = h.host.fetch('/api/settings/save', save({ username: '原生保存' }));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(h.calls.filter((call) => call.native).length, 0);
        assert.equal(h.workers[0].terminated, false);
        release();
        assert.equal((await pending).status, 200);
        await disposed;
        assert.equal((await next).status, 200);
        assert.equal(h.calls.filter((call) => call.native).length, 1);
        assert.equal(h.host.fetch, h.native);
        assert.equal(h.workers[0].terminated, true);
    });
});

test('worker crash after admission requires reload instead of letting stale data bypass via native save', async () => {
    let release;
    const h = setup({ gate: new Promise((resolve) => { release = resolve; }) });
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const pending = h.host.fetch('/api/settings/save', save({ username: '结果未知' }));
        const rejected = assert.rejects(pending, /结果未确认/);
        await waitFor(() => h.calls.some((call) => call.route === 'save'));
        h.workers[0].onerror();
        await rejected;
        assert.equal(controller.status().requiresReload, true);
        await assert.rejects(h.host.fetch('/api/settings/save', save({ username: '禁止重试' })), /刷新页面/);
        assert.equal(h.calls.filter((call) => call.native).length, 0);
        assert.equal((await h.host.fetch('/api/settings/get', save({}))).status, 200);
        await controller.dispose();
        await assert.rejects(h.host.fetch('/api/settings/save', save({ username: '仍需刷新' })), /刷新页面/);
        release();
    });
});

test('large plain JSON strings avoid main-thread body encoding and transfer as strings with headers and credentials', async () => {
    const h = setup();
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const NativeRequest = globalThis.Request;
        const observed = [];
        class CountingRequest extends NativeRequest {
            constructor(input, init) { super(input, init); observed.push({ body: init?.body, url: this.url }); }
        }
        globalThis.Request = CountingRequest;
        try {
            const value = { username: '天子大人', data: '中文😀'.repeat(300000) };
            const body = JSON.stringify(value);
            assert.equal((await h.host.fetch(new URL('https://st.test/api/settings/save'), { method: 'post', headers: { ...headers, 'x-custom': 'preserve' }, credentials: 'include', body })).status, 200);
            assert.equal(observed.length, 1);
            assert.equal(observed[0].body, undefined, 'the Request constructor must not encode the large body');
            const message = h.workers[0].messages.find((entry) => entry.type === 'save');
            assert.equal(message.bodyType, 'string');
            assert.equal(message.body, body);
            assert.equal(message.transferCount, 0);
            assert.equal(message.credentials, 'include');
            assert.equal(new Headers(message.headers).get('x-custom'), 'preserve');
            assert.equal(h.calls.find((entry) => entry.route === 'save').init.credentials, 'include');
            assert.deepEqual(h.getValue(), value);
            assert.equal(controller.status().sourceBytes, new TextEncoder().encode(body).byteLength);
        } finally { globalThis.Request = NativeRequest; await controller.dispose(); }
    });
});

test('plain-string fast path preserves abort and native passthrough arguments', async () => {
    const h = setup();
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const aborted = new AbortController(); aborted.abort();
        await assert.rejects(h.host.fetch('/api/settings/save', save({ n: 1 }, { signal: aborted.signal })), { name: 'AbortError' });
        assert.equal(h.workers[0].messages.some((entry) => entry.type === 'save'), false);
        const input = '/api/chats/group/save';
        const init = save({ id: 'group', chat: [], futureOption: true });
        const response = await h.host.fetch(input, init);
        assert.equal(response.status, 200);
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0].native, true);
        assert.equal(h.calls[0].input, input);
        assert.equal(h.calls[0].init, init);
        assert.equal(h.workers[0].messages.find((entry) => entry.type === 'save').bodyType, 'string');
        await controller.dispose();
    });
});

test('plain-string fast path matches fetch UTF-8 replacement for unpaired surrogates', async () => {
    const h = setup();
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const body = '{"username":"' + '\ud800' + '","data":"valid"}';
        assert.equal((await h.host.fetch('/api/settings/save', { method: 'POST', headers, body })).status, 200);
        assert.equal(h.getValue().username, '\ufffd');
        await controller.dispose();
    });
});

test('settings adopted before the Worker starts survive background reads and conflict across reinstall', async () => {
    const h = setup({ bootstrap: true });
    await withHost(h, async () => {
        const old = await adoptSettings(h.host);
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const remote = { ...old, username: '另一个页面的新版本' };
        h.setValue(remote);
        assert.deepEqual(JSON.parse((await (await h.host.fetch('/api/settings/get', save({}))).json()).settings), remote);
        assert.equal((await h.host.fetch('/api/settings/save', save({ ...old, username: '旧页面修改' }))).status, 409);
        assert.equal(h.calls.some(call => call.route === 'state'), false);
        await controller.dispose();
        // Even a later wrapper restoration/capability failure cannot erase the sentinel.
        h.host.fetch = h.native;
        delete h.host.Worker;
        const replacement = installTransport({ getHeaders: () => headers });
        assert.equal(replacement.status().requiresReload, true);
        assert.equal(replacement.status().reason, 'reload-required');
        for (const [input, init] of [
            ['/api/settings/save', save(old)],
            ['/api/settings/save', save(old, { keepalive: true, credentials: 'omit' })],
            [new Request('https://st.test/api/chats/save', save({ avatar_url: 'a.png', file_name: 'chat', chat: [] }))],
            ['/api/chats/group/save', save({ id: 'group', chat: [], force: true })],
        ]) await assert.rejects(h.host.fetch(input, init), /刷新页面/);
        assert.equal((await h.host.fetch('/api/settings/get', save({}))).status, 200);
        assert.equal(h.workers.length, 1, 'reinstall must not create a fresh worker baseline');
        assert.equal(h.calls.filter((call) => call.route === 'save').length, 1);
        assert.equal(h.calls.filter((call) => call.native && String(call.input).includes('/save')).length, 0);
        assert.deepEqual(h.getValue(), remote);
        await replacement.dispose();
        await assert.rejects(h.host.fetch('/api/settings/save', save(old)), /刷新页面/);
    });
});

test('crash with an admitted save keeps the page locked across dispose and reinstall', async () => {
    let release;
    const h = setup({ gate: new Promise((resolve) => { release = resolve; }) });
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const old = structuredClone(h.getValue());
        const pending = h.host.fetch('/api/settings/save', save({ ...old, username: '发出后崩溃' }));
        const rejected = assert.rejects(pending, /结果未确认/);
        await waitFor(() => h.calls.some((call) => call.route === 'save'));
        h.workers[0].onerror();
        await rejected; await controller.dispose();
        const remote = { ...old, username: '服务端保留的新版本' }; h.setValue(remote);
        const replacement = installTransport({ getHeaders: () => headers });
        await assert.rejects(h.host.fetch('/api/settings/save', save(old)), /刷新页面/);
        assert.equal((await h.host.fetch('/api/settings/get', save({}))).status, 200);
        assert.equal(h.workers.length, 1);
        assert.equal(h.calls.filter((call) => call.route === 'save').length, 1);
        assert.deepEqual(h.getValue(), remote);
        await replacement.dispose(); release();
    });
});

test('5xx and committed-but-disconnected saves stay locked after reinstall', async (t) => {
    for (const mode of ['server-error', 'network-after-commit']) await t.test(mode, async () => {
        const h = setup({ onSave({ payload, getValue, setValue }) {
            const next = payload.mode === 'full' ? payload.value : payload.mode === 'patch' ? applyOps(getValue(), payload.ops) : getValue();
            setValue(next);
            if (mode === 'network-after-commit') throw new TypeError('connection dropped after commit');
            return json({ ok: false, error: 'unconfirmed' }, 500);
        } });
        await withHost(h, async () => {
            const controller = installTransport({ getHeaders: () => headers });
            await waitFor(() => controller.status().enabled);
            const committed = { username: '服务端已经保存' };
            const pending = h.host.fetch('/api/settings/save', save(committed));
            if (mode === 'server-error') assert.equal((await pending).status, 500);
            else await assert.rejects(pending, /保存失败|结果未确认/);
            await controller.dispose();
            const replacement = installTransport({ getHeaders: () => headers });
            await assert.rejects(h.host.fetch('/api/settings/save', save({ username: '旧页面重试' })), /刷新页面/);
            assert.equal(h.workers.length, 1);
            assert.equal(h.calls.filter((call) => call.route === 'save').length, 1);
            assert.deepEqual(h.getValue(), committed);
            await replacement.dispose();
        });
    });
});

test('normal disable and reinstall retain old hashes, so another page cannot be overwritten by a stale snapshot', async () => {
    const h = setup();
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const old = { ...h.getValue(), username: '本页已确认保存' };
        assert.equal((await h.host.fetch('/api/settings/save', save(old))).status, 200);
        await controller.dispose();
        const remote = { ...old, username: '停用期间另页保存' };
        h.setValue(remote);
        const stateCalls = h.calls.filter((call) => call.route === 'state').length;
        const replacement = installTransport({ getHeaders: () => headers });
        await waitFor(() => replacement.status().enabled);
        const inherited = h.workers[1].messages.find((entry) => entry.type === 'init').baselines;
        assert.deepEqual(inherited, [['settings:{}', { hash: await hashValue(old) }]]);
        assert.equal((await h.host.fetch('/api/settings/save', save({ ...old, username: '旧页面后续编辑' }))).status, 409);
        assert.equal(h.calls.filter((call) => call.route === 'state').length, stateCalls, 'a new worker must not rebase an old page via /state');
        assert.deepEqual(h.getValue(), remote);
        assert.equal(replacement.status().requiresReload, true);
        for (const event of h.workers.flatMap((worker) => worker.events).filter((event) => event.type === 'baseline')) {
            assert.equal(Object.hasOwn(event, 'value'), false);
            assert.ok(Object.keys(event).every((key) => ['type', 'key', 'hash', 'blocked'].includes(key)));
        }
        await replacement.dispose();
    });
});

test('a normal reinstall without remote changes saves from a hash-only baseline and resumes patching', async () => {
    const h = setup();
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const first = { ...h.getValue(), username: '正常第一次保存' };
        assert.equal((await h.host.fetch('/api/settings/save', save(first))).status, 200);
        await controller.dispose();
        const stateCalls = h.calls.filter((call) => call.route === 'state').length;
        const replacement = installTransport({ getHeaders: () => headers });
        await waitFor(() => replacement.status().enabled);
        const second = { ...first, username: '重启后保存' };
        assert.equal((await h.host.fetch('/api/settings/save', save(second))).status, 200);
        assert.equal(h.calls.filter((call) => call.route === 'state').length, stateCalls);
        assert.equal(h.calls.filter((call) => call.route === 'save').at(-1).payload.mode, 'full');
        assert.equal((await h.host.fetch('/api/settings/save', save({ ...second, username: '继续小改' }))).status, 200);
        assert.equal(h.calls.filter((call) => call.route === 'save').at(-1).payload.mode, 'patch');
        assert.equal(replacement.status().requiresReload, false);
        await replacement.dispose();
    });
});

test('adopted hashes survive a Worker reinstall before the first save', async () => {
    const h = setup({ bootstrap: true });
    await withHost(h, async () => {
        const controller = installTransport({ getHeaders: () => headers });
        await waitFor(() => controller.status().enabled);
        const old = await adoptSettings(h.host);
        await waitFor(() => h.workers[0].events.some((event) => event.type === 'baseline'));
        // Wait until the emitted metadata has actually reached the main thread.
        await new Promise((resolve) => setImmediate(resolve));
        await controller.dispose();
        const remote = { ...old, username: '另页已变更' }; h.setValue(remote);
        const replacement = installTransport({ getHeaders: () => headers });
        await waitFor(() => replacement.status().enabled);
        assert.equal((await h.host.fetch('/api/settings/save', save(old))).status, 409);
        assert.equal(h.calls.some((call) => call.route === 'state'), false);
        assert.deepEqual(h.getValue(), remote);
        await replacement.dispose();
    });
});
