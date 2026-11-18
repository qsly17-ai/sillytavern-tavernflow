import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const source = await fs.readFile(new URL('../client/boot.js', import.meta.url), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(fetch) {
    const nodes = [];
    const document = { body: { append(node) { nodes.push(node); } }, createElement(tag) {
        const listeners = {};
        return { tag, style: {}, listeners, children: [], open: false,
            setAttribute() {}, addEventListener(type, fn) { listeners[type] = fn; },
            append(...args) { this.children.push(...args); },
            showModal() { this.open = true; }, close() { this.open = false; } };
    } };
    const host = { fetch, document, location: { href: 'https://example.test/', origin: 'https://example.test' },
        Headers, URL, Blob, Response, AbortController, ReadableStream, structuredClone,
        setTimeout(fn, delay) { return setTimeout(fn, delay === 30000 || delay === 60000 ? 40 : delay === 750 ? 0 : delay); }, clearTimeout };
    host.top = host; vm.runInNewContext(source, host);
    const call = (path = '/api/chats/get', overrides = {}) => {
        const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"file_name":"same-chat"}', ...overrides };
        return path === '/api/settings/get' || path.startsWith('/api/chats/') ? host.__tavernFlowBoot.nativeRead(path, init) : host.fetch(path, init);
    };
    return { host, call, nodes };
}
function stalled(signal, withBody = false) {
    if (!withBody) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('[{"partial":'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
}

test('returns exact complete JSON, native clone/body consumption and response metadata', async () => {
    const text = '[{"unknown":false,"n":0,"mes":"正文"}]';
    const { call, host } = fixture(async () => {
        const r = new Response(text, { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br', 'Content-Length': '10', ETag: 'abc' } });
        Object.defineProperty(r, 'url', { value: 'https://example.test/api/chats/get' }); return r;
    });
    const r = await call(); assert.equal(r.url, 'https://example.test/api/chats/get');
    assert.equal(r.headers.get('etag'), 'abc'); assert.equal(r.headers.get('content-encoding'), null);
    assert.equal(await r.clone().text(), text); assert.equal(r.bodyUsed, false);
    assert.deepEqual(await r.json(), JSON.parse(text)); assert.equal(r.bodyUsed, true);
    assert.equal(host.__tavernFlowBoot.status().active, 0);
});
for (const body of [false, true]) test(`stalled ${body ? 'body' : 'headers'} retries same read and never resolves an empty result`, async () => {
    const calls = [];
    const { call, host, nodes } = fixture(async (url, init) => {
        calls.push({ url, body: init.body }); return calls.length === 1 ? stalled(init.signal, body) : new Response('[{"mes":"original"}]');
    });
    const r = await call(); assert.equal((await r.json())[0].mes, 'original');
    assert.equal(calls.length, 2); assert.equal(calls[0].body, calls[1].body);
    assert.equal(host.__tavernFlowBoot.status().recovered, 1); assert.equal(nodes[0].open, false);
});
test('a slow but progressing body may exceed the idle deadline without re-downloading', async () => {
    let calls = 0;
    const { call } = fixture(async () => {
        calls++; return new Response(new ReadableStream({ async start(controller) {
            for (const s of ['[', '1', ',', '2', ',', '3', ']']) { controller.enqueue(new TextEncoder().encode(s)); await sleep(15); }
            controller.close();
        } }));
    });
    assert.deepEqual(await (await call()).json(), [1,2,3]); assert.equal(calls, 1);
});
test('proxy HTML or truncated JSON is recovered before native JSON consumers see an error', async () => {
    let calls = 0; const { call } = fixture(async () => new Response(++calls === 1 ? '<html>gateway</html>' : '[1]'));
    assert.deepEqual(await (await call()).json(), [1]); assert.equal(calls, 2);
});
test('authorization failure stays pending until manual retry; disabled new reads do not abandon it', async () => {
    let calls = 0, settled = false;
    const { call, host, nodes } = fixture(async () => ++calls === 1 ? new Response('denied', { status: 403 }) : new Response('[1]'));
    const pending = call().then(r => { settled = true; return r; }); await sleep(12);
    assert.equal(settled, false); assert.equal(calls, 1); assert.equal(nodes[0].open, true);
    const cancel = { prevented: false, preventDefault() { this.prevented = true; } }; nodes[0].listeners.cancel(cancel); assert(cancel.prevented);
    host.__tavernFlowBoot.setEnabled(false); nodes[0].children[2].listeners.click();
    assert.deepEqual(await (await pending).json(), [1]); assert.equal(calls, 2); assert.equal(nodes[0].open, false);
});
test('two failed reads stop automatic retries and recover after a real user action', async () => {
    let calls = 0;
    const { call, nodes, host } = fixture(async () => ++calls < 3 ? new Response('bad', { status: 503 }) : new Response('[2]'));
    const pending = call(); await sleep(20); assert.equal(calls, 2); assert.equal(host.__tavernFlowBoot.status().waiting, 1);
    nodes[0].children[2].listeners.click(); assert.deepEqual(await (await pending).json(), [2]);
});
test('writes, foreign URLs, query variants, Requests and caller cancellation pass through unchanged', async () => {
    const seen = []; const response = new Response('ok');
    const { call, host } = fixture(async (...args) => { seen.push(args); return response; });
    for (const path of ['/api/chats/save', '/api/settings/save', 'https://other.test/api/chats/get', '/api/chats/get?x=1']) assert.equal(await call(path), response);
    assert.equal(await call('/api/chats/get', { signal: new AbortController().signal }), response);
    const request = new Request('https://example.test/api/chats/get', { method: 'POST' });
    assert.equal(await host.fetch(request), response); assert.equal(seen.length, 6);
});
test('disabled extension/profile is detected from the full fresh settings and new reads keep native behaviour', async () => {
    let calls = 0;
    const { call, host } = fixture(async () => new Response(JSON.stringify(++calls === 1 ? { settings: JSON.stringify({ extension_settings: { disabledExtensions: ['third-party/tavern-flow'] } }) } : [1])));
    await call('/api/settings/get'); assert.equal(host.__tavernFlowBoot.status().enabled, false);
    await call(); assert.equal(host.__tavernFlowBoot.status().reads, 1);
});

test('host dialog exceptions cannot reject a recovering native chat read', async () => {
    let calls = 0; const { call, nodes } = fixture(async () => ++calls === 1 ? new Response('bad', { status: 503 }) : new Response('[1]'));
    const pending = call(); await sleep(0);
    if (nodes[0]) nodes[0].showModal = () => { throw new Error('host dialog unavailable'); };
    assert.deepEqual(await (await pending).json(), [1]);
});
test('valid JSON with invalid settings schema is retried before returning to native startup', async () => {
    let calls = 0; const { call } = fixture(async () => new Response(++calls === 1 ? '{"settings":"null"}' : '{"settings":"{}"}'));
    assert.equal((await (await call('/api/settings/get')).json()).settings, '{}'); assert.equal(calls, 2);
});
test('a background settings read cannot change whether this page uses recovery', async () => {
    const body = { settings: JSON.stringify({ extension_settings: { 'tavern-flow': { enabled: false } } }) };
    const response = Response.json(body);
    const { host } = fixture(async () => response);
    assert.equal(await host.fetch('/api/settings/get', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), response);
    assert.equal(host.__tavernFlowBoot.status().enabled, true);
    assert.equal(host.__tavernFlowBoot.status().reads, 0);
});
test('the native first-use empty directory object is valid and causes no retries', async () => {
    const { call, host } = fixture(async () => new Response('{}'));
    assert.deepEqual(await (await call()).json(), {}); assert.equal(host.__tavernFlowBoot.status().retries, 0);
});
test('the native missing-character response completes without a recovery dialog', { timeout: 1000 }, async () => {
    const missing = new Response('Not Found', { status: 404 });
    const { call, host, nodes } = fixture(async () => missing);
    assert.equal(await call('/api/characters/get'), missing);
    assert.equal(host.__tavernFlowBoot.status().waiting, 0);
    assert.deepEqual(nodes, []);
});
test('Quick Reply reads only its small payload and keeps the native settings fallback', async () => {
    for (const usable of [true, false]) {
        const sent = [];
        const body = { quickReplyPresets: [{ name: 'example' }] };
        const { host } = fixture(async (url, init) => {
            sent.push(url);
            assert.equal(new Headers(init.headers).get('x-csrf-token'), 'test');
            if (url === '/api/settings/get') return Response.json({ settings: '{}', ...body });
            return usable ? Response.json(body) : new Response('<html>proxy fallback</html>');
        });
        const response = await host.__tavernFlowBoot.quickReplyRead('/api/settings/get', {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'test' }, body: '{}',
        });
        assert.deepEqual((await response.json()).quickReplyPresets, body.quickReplyPresets);
        assert.deepEqual(sent, ['/api/plugins/tavern-flow/quick-reply-presets', ...(usable ? [] : ['/api/settings/get'])]);
    }
});
test('a late response cannot be delivered into a different selected chat', async () => {
    let release; const { call, host, nodes } = fixture(() => new Promise(resolve => { release = resolve; }));
    let chatId = 'A'; host.SillyTavern = { getContext: () => ({ characterId: 0, groupId: null, chatId, characters: [{ avatar: 'a.png' }] }) };
    let settled = false; void call('/api/chats/get', { body: '{"file_name":"A","avatar_url":"a.png"}' }).then(() => { settled = true; }, () => { settled = true; });
    await sleep(0); chatId = 'B'; release(new Response('[{"mes":"A"}]')); await sleep(10);
    assert.equal(settled, false); assert.equal(nodes[0].children[2].textContent, '重新加载酒馆');
    let reloads = 0; host.location.reload = () => reloads++; host.__tavernFlowBoot.retry(); assert.equal(reloads, 1);
});
test('helper reads of historical files can complete after the selected chat changes', async () => {
    let release; const { call, host } = fixture(() => new Promise(resolve => { release = resolve; }));
    let chatId = 'A'; host.SillyTavern = { getContext: () => ({ characterId: 0, groupId: null, chatId, characters: [{ avatar: 'a.png' }] }) };
    const pending = call('/api/chats/get', { body: '{"file_name":"history","avatar_url":"a.png"}' });
    chatId = 'B'; release(new Response('[1]'));
    assert.deepEqual(await (await pending).json(), [1]); assert.equal(host.__tavernFlowBoot.status().waiting, 0);
});
test('a helper read of the current file keeps its native successful response when selection changes', async () => {
    let release; const { host } = fixture(() => new Promise(resolve => { release = resolve; }));
    let chatId = 'A'; host.SillyTavern = { getContext: () => ({ characterId: 0, groupId: null, chatId, characters: [{ avatar: 'a.png' }] }) };
    const pending = host.fetch('/api/chats/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"file_name":"A","avatar_url":"a.png"}' });
    chatId = 'B'; const original = new Response('[1]'); release(original);
    assert.equal(await pending, original); assert.equal(host.__tavernFlowBoot.status().reads, 0);
});
test('the native hook retains later business fetch wrappers and their helper background calls', async () => {
    const { host, call } = fixture(async () => new Response('[1]'));
    let wrapped = 0, helper = 0;
    const old = host.fetch;
    host.fetch = async function businessFetch(input, init) {
        wrapped++;
        const result = await old(input, init);
        if (!helper++) assert.deepEqual(await (await old('/api/chats/get', { ...init, signal: undefined })).json(), [1]);
        return result;
    };
    assert.deepEqual(await (await call()).json(), [1]);
    assert.equal(wrapped, 1); assert.equal(host.__tavernFlowBoot.status().reads, 1);
});
test('disabled new reads, writes and ordinary GET preserve original fetch results', async () => {
    const original = new Response('[1]'); const { host, call } = fixture(async () => original);
    host.__tavernFlowBoot.setEnabled(false);
    for (const path of ['/api/chats/get', '/api/worldinfo/get', '/api/settings/save', '/api/chats/save']) assert.equal(await call(path), original);
    assert.equal(await host.fetch('/ordinary'), original); assert.equal(host.__tavernFlowBoot.status().reads, 0);
});
test('recovery exposes the unsent draft and allows selection when clipboard permission fails', async () => {
    const { host, call, nodes } = fixture(async () => new Response('denied', { status: 403 }));
    host.document.getElementById = () => ({ value: '未发送的完整草稿😀' });
    host.navigator = { clipboard: { writeText: async () => { throw new Error('denied'); } } };
    let reloaded = false; host.location.reload = () => { reloaded = true; }; host.confirm = () => false;
    void call(); await sleep(0);
    const draft = nodes[0].children[4], button = nodes[0].children[5];
    assert.equal(draft.value, '未发送的完整草稿😀'); assert.equal(draft.hidden, false); assert.equal(draft.readOnly, true);
    let selected = false; draft.select = () => { selected = true; };
    await button.listeners.click(); assert(selected); assert.match(button.textContent, /选择/);
    nodes[0].children[3].listeners.click(); assert.equal(reloaded, false); assert.equal(draft.value, '未发送的完整草稿😀');
});
