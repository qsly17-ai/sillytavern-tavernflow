import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashValue, applyOps, canonical, diffValues, chatFileName } from '../shared/protocol.mjs';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'tf-worker-'));
await mkdir(path.join(fixture, 'lib'));
await copyFile(new URL('../client/worker.js', import.meta.url), path.join(fixture, 'worker.mjs'));
await copyFile(new URL('../shared/protocol.mjs', import.meta.url), path.join(fixture, 'lib/protocol.mjs'));
const { createTransportRuntime } = await import(pathToFileURL(path.join(fixture, 'worker.mjs')));
after(() => rm(fixture, { recursive: true, force: true }));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function decodeRequest(init) {
    if (new Headers(init.headers).get('content-encoding') === 'gzip') return JSON.parse(await new Response(new Blob([init.body]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
    return JSON.parse(await new Blob([init.body]).text());
}
const key = (kind, identity) => `${kind}:${canonical(kind === 'chat' ? [identity.avatar_url.replace('.png', ''), chatFileName(identity.file_name)] :
    kind === 'group' ? [chatFileName(String(identity.id))] : identity)}`;
function harness(values = new Map(), intercept, networkTimeoutMs) {
    const events = [];
    const calls = [];
    const runtime = createTransportRuntime({ networkTimeoutMs, postMessage: (message) => events.push(message), fetch: async (url, init = {}) => {
        const route = new URL(url).pathname.split('/').at(-1);
        if (route === 'health') return json({ ok: true, protocol: 1, capabilities: { deltaSave: true, kinds: ['settings', 'chat', 'group'], requestGzip: true, checkedIntegrityOverwrite: true } });
        const payload = await decodeRequest(init);
        calls.push({ route, payload, init });
        const special = await intercept?.({ route, payload, init, values });
        if (special) return special;
        const resource = key(payload.kind, payload.identity);
        const value = values.get(resource) ?? (payload.kind === 'settings' ? {} : []);
        const hash = await hashValue(value);
        if (route === 'state') return json({ ok: true, value, hash });
        if (payload.baseHash !== hash) return json({ ok: false, error: 'conflict', hash }, 409);
        const next = payload.mode === 'full' ? payload.value : payload.mode === 'patch' ? applyOps(value, payload.ops) : value;
        assert.equal(await hashValue(next), payload.nextHash);
        values.set(resource, next);
        return json({ ok: true, hash: payload.nextHash, mode: payload.mode });
    } });
    return { runtime, events, calls, values, async init(baselines) { await runtime.handleMessage({ type: 'init', baseUrl: 'https://st.test/api/plugins/tavern-flow', origin: 'https://st.test', headers: [['x-csrf-token', 'test']], baselines }); }, async save(id, kind, value, identity = {}, force = false) {
        const body = JSON.stringify(kind === 'settings' ? value : { ...identity, chat: value, force });
        await runtime.handleMessage({ type: 'save', id, path: kind === 'settings' ? '/api/settings/save' : kind === 'chat' ? '/api/chats/save' : '/api/chats/group/save', body, headers: [['content-type', 'application/json'], ['x-csrf-token', 'test']] });
        return events.find((event) => event.id === id);
    }, async seed(kind, value, identity = {}) {
        await runtime.handleMessage({ type: 'seed', path: kind === 'settings' ? '/api/settings/get' : kind === 'chat' ? '/api/chats/get' : '/api/chats/group/get',
            identity, snapshot: kind === 'settings' ? JSON.stringify(value) : new Blob([JSON.stringify(value)]) });
    } };
}

test('settings state is verified, small edits use patches, identical saves check the server', async () => {
    const initial = { extension_settings: { mvu: { value: '旧值' }, padding: 'a'.repeat(100000) }, username: '凌宇' };
    const h = harness(new Map([[key('settings', {}), initial]]));
    await h.init();
    const next = structuredClone(initial);
    next.extension_settings.mvu.value = '新值';
    const response = await h.save(1, 'settings', next);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { result: 'ok' });
    assert.equal(response.stats.mode, 'patch');
    assert.ok(response.stats.sentBytes < 1000);
    assert.deepEqual(h.values.get(key('settings', {})), next);
    const noop = await h.save(2, 'settings', next);
    assert.equal(noop.stats.mode, 'noop');
    assert.deepEqual(JSON.parse(noop.body), { result: 'ok' });
    assert.deepEqual(h.calls.map((call) => call.route), ['state', 'save', 'save']);
    assert.equal(h.calls[1].init.headers.get('x-csrf-token'), 'test');
});

test('real loaded chat baseline preserves equal-length text, swipes, unknown fields and MVU', async () => {
    const identity = { avatar_url: '角色.png', file_name: 'conversation', ch_name: '角色' };
    const initial = [{ chat_metadata: { integrity: 'same' } }, { mes: '旧文', swipes: ['一', '二'], extra: { mvu: { gold: 1 } }, unknown_plugin: { enabled: true } }];
    const h = harness(new Map([[key('chat', identity), initial]]));
    await h.init();
    await h.seed('chat', initial, identity);
    const next = structuredClone(initial);
    next[1].mes = '新文'; next[1].swipes[1] = '三'; next[1].extra.mvu.gold = 2; next[1].unknown_plugin.enabled = false;
    const response = await h.save(3, 'chat', next, identity);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true });
    assert.deepEqual(h.values.get(key('chat', identity)), next);
    assert.equal(h.calls.filter((call) => call.route === 'state').length, 0);
});

test('same resource saves queue, different resources progress independently', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness(undefined, async ({ route, payload }) => { if (route === 'save' && payload.kind === 'settings' && payload.value?.number === 1) await gate; });
    await h.init();
    const first = h.save(1, 'settings', { number: 1 });
    const second = h.save(2, 'settings', { number: 2 });
    const independent = await h.save(3, 'group', [{ mes: '群聊' }], { id: 'group-id' });
    assert.equal(independent.status, 200);
    assert.deepEqual(JSON.parse(independent.body), { ok: true });
    assert.equal(h.events.some((event) => event.id === 2), false);
    release();
    await Promise.all([first, second]);
    assert.equal(h.values.get(key('settings', {})).number, 2);
    assert.deepEqual(h.events.filter((event) => event.id === 1 || event.id === 2).map((event) => event.id), [1, 2]);
});

test('conflict blocks queued stale snapshots, a real load can re-establish the baseline', async () => {
    const h = harness(new Map([[key('settings', {}), { number: 1 }]]));
    await h.init(); await h.seed('settings', { number: 0 });
    assert.equal((await h.save(1, 'settings', { number: 2 })).status, 409);
    assert.equal((await h.save(2, 'settings', { number: 3 })).stats.mode, 'blocked');
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.values.get(key('settings', {})), { number: 1 });
    await h.seed('settings', { number: 1 });
    assert.equal((await h.save(3, 'settings', { number: 4 })).status, 200);
});

test('a network error after commit never retries and blocks subsequent writes', async () => {
    let commits = 0;
    const h = harness(undefined, ({ route, payload, values }) => {
        if (route !== 'save') return;
        commits++;
        values.set(key(payload.kind, payload.identity), payload.value);
        throw new TypeError('connection lost after server commit');
    });
    await h.init();
    assert.equal((await h.save(1, 'settings', { number: 1 })).error.code, 'request-failed');
    assert.equal((await h.save(2, 'settings', { number: 2 })).status, 409);
    assert.equal(commits, 1);
    assert.deepEqual(h.calls.map((call) => call.route), ['state', 'save']);
});

test('corrupted state and fake success responses are rejected', async () => {
    const badState = harness(undefined, ({ route }) => route === 'state' ? json({ ok: true, hash: 'a'.repeat(64), value: {} }) : undefined);
    await badState.init();
    assert.ok((await badState.save(1, 'settings', {})).error);
    assert.equal(badState.calls.length, 1);
    const fake = harness(undefined, ({ route }) => route === 'save' ? json({ ok: true, mode: 'full', hash: 'b'.repeat(64) }) : undefined);
    await fake.init();
    assert.equal((await fake.save(1, 'settings', { n: 1 })).status, 502);
    assert.equal((await fake.save(2, 'settings', { n: 2 })).status, 409);
    assert.equal(fake.calls.length, 2);
});

test('native gzip input is decoded in the worker and large full payloads are gzipped', async () => {
    const h = harness(); await h.init();
    const value = { data: '大型中文变量'.repeat(20000) };
    const gzip = await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    await h.runtime.handleMessage({ type: 'save', id: 20, path: '/api/settings/save', body: gzip, headers: [['content-type', 'application/json'], ['content-encoding', 'gzip']] });
    const response = h.events.find((event) => event.id === 20);
    assert.equal(response.status, 200);
    assert.equal(response.stats.compressed, true);
    assert.ok(response.stats.sentBytes < response.stats.originalBytes / 100);
    assert.deepEqual(h.values.get(key('settings', {})), value);
});

test('future or unsupported envelope fields pass through without an optimized write', async () => {
    const h = harness(); await h.init();
    for (const [id, extra] of [[1, { force: 'nonstandard' }], [2, { futureOption: true }]]) {
        await h.runtime.handleMessage({ type: 'save', id, path: '/api/chats/group/save', body: JSON.stringify({ id: 'x', chat: [], ...extra }), headers: [] });
        assert.equal(h.events.find((event) => event.id === id).type, 'passthrough');
    }
    assert.equal(h.calls.length, 0);
});

test('different names for the same native file share the adopted baseline and save queue', async () => {
    const loadedAs = { avatar_url: 'test.png', file_name: '侦探: 林' };
    const savedAs = { ...loadedAs, file_name: '侦探 林' };
    const old = [{ mes: 'old' }], first = [{ mes: 'first' }], second = [{ mes: 'second' }];
    const h = harness(new Map([[key('chat', loadedAs), old]]));
    await h.init();
    const seed = h.seed('chat', old, loadedAs);
    const firstSave = h.save(1, 'chat', first, savedAs);
    const secondSave = h.save(2, 'chat', second, loadedAs);
    const [, a, b] = await Promise.all([seed, firstSave, secondSave]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.deepEqual(h.calls.map(call => call.route), ['save', 'save']);
    assert.deepEqual(h.values.get(key('chat', savedAs)), second);
});

test('a stalled acknowledgement body times out without retry and blocks another save of that resource', async () => {
    const resource = key('settings', {});
    const initial = { version: 'loaded' }, committed = { version: 'committed' };
    let seenSignal;
    const h = harness(new Map([[resource, initial]]), ({ route, init, values }) => {
        if (route !== 'save') return;
        seenSignal = init.signal;
        values.set(resource, committed);
        return new Response(new ReadableStream({ start(body) {
            body.enqueue(new TextEncoder().encode('{"ok":'));
            init.signal.addEventListener('abort', () => body.error(init.signal.reason), { once: true });
        } }));
    }, 30);
    await h.init();
    await h.seed('settings', initial);
    assert.equal((await h.save(1, 'settings', committed)).error.code, 'save-timeout');
    assert.equal(seenSignal.aborted, true);
    assert.equal((await h.save(2, 'settings', initial)).status, 409);
    assert.deepEqual(h.calls.map(call => call.route), ['save']);
    assert.deepEqual(h.values.get(resource), committed);
});

test('integrity confirmation is bound to the rejected version, even after a newer save in the same tab', async () => {
    const identity = { id: 'integrity-retry' };
    const resource = key('group', identity);
    const initial = [{ mes: 'loaded' }], rejected = [{ mes: 'needs confirmation' }], newer = [{ mes: 'newer' }];
    const h = harness(new Map([[resource, initial]]), ({ route, payload }) => {
        if (route === 'save' && !payload.force && payload.nextHash === expectedHash) return json({ ok: false, error: 'integrity' }, 400);
    });
    const expectedHash = await hashValue(rejected);
    await h.init();
    await h.seed('group', initial, identity);
    assert.equal((await h.save(1, 'group', rejected, identity)).status, 400);
    assert.equal((await h.save(2, 'group', newer, identity)).status, 200);
    assert.equal((await h.save(3, 'group', rejected, identity, true)).status, 409);
    assert.deepEqual(h.calls.map(call => call.route), ['save', 'save']);
    assert.deepEqual(h.values.get(resource), newer);
});

test('abort reaches an in-flight request, then the resource stays blocked', async () => {
    let dispatch;
    const dispatched = new Promise((resolve) => { dispatch = resolve; });
    const h = harness(undefined, async ({ route, init }) => {
        if (route !== 'save') return;
        dispatch();
        await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    });
    await h.init();
    const saving = h.save(1, 'settings', { n: 1 });
    await dispatched;
    await h.runtime.handleMessage({ type: 'abort', id: 1 });
    assert.equal((await saving).error.name, 'AbortError');
    assert.equal((await h.save(2, 'settings', { n: 2 })).status, 409);
});

test('bounded full snapshots keep old hashes, eviction cannot silently rebase an old tab', async () => {
    const h = harness(); await h.init();
    for (let n = 0; n < 9; n++) assert.equal((await h.save(n, 'group', [{ mes: '旧快照' }], { id: `group-${n}` })).status, 200);
    h.values.set(key('group', { id: 'group-0' }), [{ mes: '另一个页面的新内容' }]);
    const stateRequests = h.calls.filter((call) => call.route === 'state').length;
    const stale = await h.save(100, 'group', [{ mes: '过期页面修改' }], { id: 'group-0' });
    assert.equal(stale.status, 409);
    assert.equal(h.calls.filter((call) => call.route === 'state').length, stateRequests);
    assert.deepEqual(h.values.get(key('group', { id: 'group-0' })), [{ mes: '另一个页面的新内容' }]);
});

test('health ok without the frozen protocol and capabilities never activates transport', async () => {
    const events = [];
    const runtime = createTransportRuntime({ postMessage: (message) => events.push(message), fetch: async () => json({ ok: true, protocol: 2 }) });
    await runtime.handleMessage({ type: 'init', baseUrl: 'https://st.test/api/plugins/tavern-flow', origin: 'https://st.test', headers: [] });
    assert.equal(events[0].type, 'unavailable');
    assert.equal(events.some((event) => event.type === 'ready'), false);
});

test('inherited hashes check the original base without fetching or retaining supplied full values', async () => {
    const old = { number: 1, private: 'snapshot stays off main thread' };
    const remote = { ...old, number: 2 };
    const h = harness(new Map([[key('settings', {}), remote]]));
    await h.init([[key('settings', {}), { hash: await hashValue(old), value: remote }]]);
    const stale = await h.save(1, 'settings', { ...old, number: 3 });
    assert.equal(stale.status, 409);
    assert.deepEqual(h.calls.map((call) => call.route), ['save']);
    assert.equal(h.calls[0].payload.mode, 'full', 'only the hash is restored, never the supplied value');
    assert.deepEqual(h.values.get(key('settings', {})), remote);
    const metadata = h.events.filter((event) => event.type === 'baseline');
    assert.deepEqual(metadata[0], { type: 'baseline', key: key('settings', {}), hash: await hashValue(old) });
    assert.equal(metadata.at(-1).blocked, 'conflict');
    for (const event of metadata) assert.ok(Object.keys(event).every((name) => ['type', 'key', 'hash', 'blocked'].includes(name)));
});

test('blocked inherited hashes remain local conflicts and invalid metadata is ignored', async () => {
    const h = harness();
    const hash = await hashValue({ old: true });
    await h.init([
        [key('settings', {}), { hash, blocked: 'unconfirmed-network-result' }],
        [key('group', { id: 'ignored' }), { hash: 'invalid', blocked: 'invalid' }],
        ['bad-shape'], null,
    ]);
    const blocked = await h.save(1, 'settings', { old: false });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.stats.mode, 'blocked');
    assert.equal(h.calls.length, 0);
    assert.equal((await h.save(2, 'group', [{ mes: 'new' }], { id: 'ignored' })).status, 200);
    assert.deepEqual(h.calls.map((call) => call.route), ['state', 'save']);
});

test('small patches and noops avoid materializing a full multi-megabyte envelope', async () => {
    const initial = { extension_settings: { mvu: { hp: 1 }, padding: '中文状态'.repeat(400000) }, username: '凌宇' };
    const h = harness(new Map([[key('settings', {}), initial]]));
    await h.init(); await h.seed('settings', initial);
    const next = structuredClone(initial);
    next.extension_settings.mvu.hp = 2;
    const stringify = JSON.stringify;
    let fullEnvelopes = 0;
    JSON.stringify = function(value, ...args) {
        if (value?.kind === 'settings' && value.mode === 'full' && Object.hasOwn(value, 'value')) fullEnvelopes++;
        return stringify(value, ...args);
    };
    try {
        const patch = await h.save(1, 'settings', next);
        const noop = await h.save(2, 'settings', next);
        assert.equal(patch.stats.mode, 'patch');
        assert.equal(noop.stats.mode, 'noop');
        assert.equal(fullEnvelopes, 0);
        assert.deepEqual(h.values.get(key('settings', {})), next);
        assert.deepEqual(JSON.parse(patch.body), { result: 'ok' });
    } finally { JSON.stringify = stringify; }
});

test('near-cutoff escaped JSON gets the exact comparison and full fallback is serialized once', async () => {
    const scenarios = [
        { base: { padding: '\u0000'.repeat(20), hp: 1 }, next: { padding: '\u0000'.repeat(20), hp: 2 }, expected: 'patch' },
        { base: { hp: 1 }, next: { hp: 2 }, expected: 'full' },
        // This fixture is exactly 255 patch characters / 300 full characters.
        { base: { pad: 'a'.repeat(65), xxxxxxxx: 1 }, next: { pad: 'a'.repeat(65), xxxxxxxx: 2 }, expected: 'full' },
    ];
    for (const [index, { base, next, expected }] of scenarios.entries()) {
        const h = harness(new Map([[key('settings', {}), base]]));
        await h.init(); await h.seed('settings', base);
        const stringify = JSON.stringify;
        let fullEnvelopes = 0;
        JSON.stringify = function(value, ...args) {
            if (value?.kind === 'settings' && value.mode === 'full' && Object.hasOwn(value, 'value')) fullEnvelopes++;
            return stringify(value, ...args);
        };
        try {
            const result = await h.save(index, 'settings', next);
            assert.equal(result.stats.mode, expected);
            assert.equal(fullEnvelopes, 1);
            assert.deepEqual(h.values.get(key('settings', {})), next);
        } finally { JSON.stringify = stringify; }
    }
});

test('lazy selection matches the original exact 85 percent rule for mixed JSON changes', async () => {
    let randomState = 0x51a39f;
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 2 ** 32; };
    const alphabet = ['abc', '中文😀', '\u0000\n\t"\\', '\ud800', ''];
    for (let n = 0; n < 120; n++) {
        const base = JSON.parse('{"__proto__":{"unknown":"retained"},"constructor":"preserved"}');
        base.padding = alphabet[Math.floor(random() * alphabet.length)].repeat(Math.floor(random() * 120));
        base.extension_settings = { hp: n, flags: [true, false, null, -0, 0.125, 1e30], nested: [{ a: 'old' }] };
        const next = structuredClone(base);
        if (n % 7 !== 0) next.extension_settings.hp++;
        if (n % 3 === 0) next.extension_settings.nested.push({ a: alphabet[n % alphabet.length].repeat(n * 2) });
        if (n % 5 === 0) next.padding = 'x'.repeat(n);
        if (n % 11 === 0) delete next.constructor;
        const baseHash = await hashValue(base), nextHash = await hashValue(next);
        const full = { kind: 'settings', identity: {}, mode: 'full', baseHash, nextHash, value: next };
        const patch = { kind: 'settings', identity: {}, mode: 'patch', baseHash, nextHash, ops: diffValues(base, next) };
        const expected = baseHash === nextHash ? 'noop' : JSON.stringify(patch).length < JSON.stringify(full).length * 0.85 ? 'patch' : 'full';
        const h = harness(new Map([[key('settings', {}), base]]));
        await h.init(); await h.seed('settings', base);
        const result = await h.save(n, 'settings', next);
        assert.equal(result.status, 200, `save ${n}`);
        assert.equal(result.stats.mode, expected, `mode ${n}`);
        assert.equal(canonical(h.values.get(key('settings', {}))), canonical(next), `value ${n}`);
    }
});
