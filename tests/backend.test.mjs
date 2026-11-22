import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHandlers } from '../server/index.mjs';
import { hashValue, diffValues } from '../shared/protocol.mjs';

async function fixture(t, overrides = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tavern-flow-test-'));
    const directories = { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'group chats'), backups: path.join(root, 'backups') };
    await Promise.all(Object.values(directories).map(directory => fs.mkdir(directory, { recursive: true })));
    const user = { profile: { handle: 'test-user' }, directories };
    const calls = [];
    async function write(value, resource) {
        calls.push({ kind: resource.kind, value: structuredClone(value) });
        await fs.mkdir(path.dirname(resource.filePath), { recursive: true });
        const temp = `${resource.filePath}.tmp`;
        await fs.writeFile(temp, resource.kind === 'settings' ? JSON.stringify(value, null, 4) : value.map(item => JSON.stringify(item)).join('\n'));
        await fs.rename(temp, resource.filePath);
    }
    const handlers = createHandlers({ persistence: { saveChat: write, saveSettings: write, ...overrides } });
    t.after(async () => { handlers.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const call = async (method, body, requestUser = user) => {
        const response = { code: 200, headers: {}, status(value) { this.code = value; return this; }, set(key, value) { this.headers[key] = value; return this; }, json(value) { this.body = value; return this; } };
        await handlers[method]({ user: requestUser, body }, response);
        return response;
    };
    return { root, directories, user, handlers, calls, call };
}
const chat = { kind: 'chat', identity: { avatar_url: 'test.png', file_name: 'test-chat', ch_name: 'Test' } };
async function saveBody(resource, before, next, mode = 'patch') {
    return { ...resource, mode, baseHash: await hashValue(before), nextHash: await hashValue(next),
        ...(mode === 'patch' ? { ops: diffValues(before, next) } : mode === 'full' ? { value: next } : {}) };
}

test('import works without a host and health contains only capabilities', async t => {
    const f = await fixture(t);
    const result = await f.call('health');
    assert.equal(result.code, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.capabilities.tokenBatch, false);
    assert.equal(result.body.coverage.nativeAndThirdPartyWritesSerialized, false);
    assert.equal(JSON.stringify(result.body).includes(f.root), false);
});

test('settings, single and group chat persist unknown fields and support full, patch, noop', async t => {
    const f = await fixture(t);
    for (const resource of [{ kind: 'settings', identity: {} }, chat, { kind: 'group', identity: { id: 1234 } }]) {
        const initial = resource.kind === 'settings' ? {} : [];
        const first = resource.kind === 'settings' ? { extension_settings: { mvu: { hp: 3 } }, unknown: 'abc' } : [{ chat_metadata: { integrity: 'one', custom: true } }, { mes: 'abc', swipes: ['abc', 'def'], extra: { stat_data: { hp: 3 } } }];
        const next = structuredClone(first);
        if (resource.kind === 'settings') next.unknown = 'xyz';
        else { next[1].mes = 'xyz'; next[1].extra.stat_data.hp = 2; next[1].swipes[1] = 'uvw'; }
        assert.deepEqual((await f.call('state', resource)).body.value, initial);
        const full = await f.call('save', await saveBody(resource, initial, first, 'full'));
        assert.equal(full.code, 200); assert.equal(full.body.mode, 'full');
        const patch = await f.call('save', await saveBody(resource, first, next));
        assert.equal(patch.code, 200); assert.equal(patch.body.mode, 'patch');
        assert.deepEqual((await f.call('state', resource)).body.value, next);
        const noopsBefore = f.calls.length;
        assert.equal((await f.call('save', await saveBody(resource, next, next, 'noop'))).code, 200);
        assert.equal(f.calls.length, noopsBefore);
    }
});

test('stale bases cannot overwrite via full, patch or noop', async t => {
    const f = await fixture(t);
    const current = [{ mes: 'new' }];
    await f.call('save', await saveBody(chat, [], current, 'full'));
    for (const mode of ['full', 'patch', 'noop']) {
        const result = await f.call('save', await saveBody(chat, [], mode === 'noop' ? [] : [{ mes: 'old' }], mode));
        assert.equal(result.code, 409);
        assert.equal(result.body.error, 'conflict');
        assert.equal(result.body.hash, await hashValue(current));
    }
    assert.equal(f.calls.length, 1);
});

test('relative native dataRoot directories resolve against the host cwd', async t => {
    const f = await fixture(t);
    const user = { ...f.user, directories: Object.fromEntries(Object.entries(f.directories).map(([key, value]) => [key, path.relative(process.cwd(), value)])) };
    for (const resource of [chat, { kind: 'group', identity: { id: 'relative-group' } }, { kind: 'settings', identity: {} }]) {
        const before = resource.kind === 'settings' ? {} : [];
        const next = resource.kind === 'settings' ? { custom: 'relative' } : [{ mes: 'relative' }];
        assert.equal((await f.call('save', await saveBody(resource, before, next, 'full'), user)).code, 200);
        assert.deepEqual((await f.call('state', resource, user)).body.value, next);
    }
});

test('same-resource simultaneous writers serialize and one conflicts', async t => {
    const f = await fixture(t);
    const [a, b] = await Promise.all([
        f.call('save', await saveBody(chat, [], [{ mes: 'A' }], 'full')),
        f.call('save', await saveBody(chat, [], [{ mes: 'B' }], 'full')),
    ]);
    assert.deepEqual([a.code, b.code].sort(), [200, 409]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.handlers.stats().activeResources, 0);
});

test('different resources run independently', async t => {
    let waiting, entered = 0;
    const gate = new Promise(resolve => { waiting = resolve; });
    const f = await fixture(t, { async saveChat(value, resource) {
        entered++;
        if (entered === 2) waiting();
        await gate;
        await fs.mkdir(path.dirname(resource.filePath), { recursive: true });
        await fs.writeFile(resource.filePath, value.map(item => JSON.stringify(item)).join('\n'));
    } });
    const a = chat, b = { ...chat, identity: { ...chat.identity, file_name: 'other' } };
    const results = await Promise.all([f.call('save', await saveBody(a, [], [{ mes: 'A' }], 'full')), f.call('save', await saveBody(b, [], [{ mes: 'B' }], 'full'))]);
    assert.deepEqual(results.map(result => result.code), [200, 200]);
});

test('native persistence failures do not report success', async t => {
    const f = await fixture(t, { async saveChat() { throw new Error('disk full'); } });
    const result = await f.call('save', await saveBody(chat, [], [{ mes: 'data' }], 'full'));
    assert.equal(result.code, 500); assert.equal(result.body.ok, false);
    assert.deepEqual((await f.call('state', chat)).body.value, []);
});

test('native integrity rejection preserves the distinct confirmation response', async t => {
    let calls = 0;
    const f = await fixture(t, { async saveChat() { calls++; const error = new Error('integrity'); error.code = 'integrity'; throw error; } });
    const result = await f.call('save', await saveBody(chat, [], [{ mes: 'data' }], 'full'));
    assert.equal(result.code, 400); assert.equal(result.body.error, 'integrity'); assert.equal(calls, 1);
});

test('a native adapter that silently fails cannot produce an acknowledgement', async t => {
    const f = await fixture(t, { async saveChat() {} });
    const result = await f.call('save', await saveBody(chat, [], [{ mes: 'data' }], 'full'));
    assert.equal(result.code, 409); assert.equal(result.body.error, 'verification_failed');
});

test('corrupt existing JSON is never treated as empty chat', async t => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.directories.chats, 'test'));
    await fs.writeFile(path.join(f.directories.chats, 'test/test-chat.jsonl'), '{broken');
    assert.equal((await f.call('state', chat)).code, 422);
    assert.equal((await f.call('save', await saveBody(chat, [], [], 'full'))).code, 422);
    assert.equal(f.calls.length, 0);
});

test('unauthenticated requests, traversal and symlink escape are rejected', async t => {
    const f = await fixture(t);
    assert.equal((await f.call('state', chat, null)).code, 401);
    for (const identity of [
        { avatar_url: '../other.png', file_name: 'x' }, { avatar_url: 'test.png', file_name: '../x' },
        { avatar_url: 'test.png', file_name: 'x\u0000' }, { avatar_url: 'test.png', file_name: '..' },
    ]) assert.equal((await f.call('state', { kind: 'chat', identity })).code, 400);
    assert.equal((await f.call('state', { kind: 'group', identity: { id: '../x' } })).code, 400);
    await fs.symlink(os.tmpdir(), path.join(f.directories.chats, 'test'));
    assert.equal((await f.call('state', chat)).code, 400);
});

test('cache invalidates after a native outside write, including equal byte length', async t => {
    const f = await fixture(t);
    const first = [{ mes: 'abc' }], next = [{ mes: 'xyz' }];
    await f.call('save', await saveBody(chat, [], first, 'full'));
    await f.call('state', chat);
    const file = path.join(f.directories.chats, 'test/test-chat.jsonl');
    await fs.writeFile(file, JSON.stringify(next[0]));
    const result = await f.call('state', chat);
    assert.deepEqual(result.body.value, next);
    assert.equal(result.body.hash, await hashValue(next));
});

test('hash mismatches and invalid ops fail before persistence', async t => {
    const f = await fixture(t);
    const request = await saveBody(chat, [], [{ mes: 'data' }], 'full');
    request.nextHash = await hashValue([{ mes: 'wrong' }]);
    assert.equal((await f.call('save', request)).code, 400);
    const patch = { ...await saveBody(chat, [], [{ mes: 'data' }]), ops: [{ op: 'set', path: [50], value: {} }] };
    assert.equal((await f.call('save', patch)).code, 400);
    assert.equal(f.calls.length, 0);
});

test('token batch preserves native response objects and caches identical inputs', async t => {
    let countCalls = 0;
    const f = await fixture(t, { async countTokens({ model, messages }) { countCalls++; return { token_count: model.length + messages.length, custom: 'native' }; } });
    const item = { model: 'gpt-4o', messages: [{ role: 'user', content: '中文' }] };
    const first = await f.call('tokens', { requests: [item, item] });
    assert.equal(first.code, 200);
    assert.deepEqual(first.body.results, [{ token_count: 7, custom: 'native' }, { token_count: 7, custom: 'native' }]);
    assert.equal(countCalls, 1);
    assert.equal((await f.call('tokens', { requests: [item] })).code, 200);
    assert.equal(countCalls, 1);
    assert.equal((await f.call('tokens', { requests: [{ ...item, messages: 'bad' }] })).code, 400);
});

test('unavailable or invalid tokenizers fail explicitly', async t => {
    const unavailable = await fixture(t);
    const request = { requests: [{ model: 'gpt-4o', messages: [] }] };
    assert.equal((await unavailable.call('tokens', request)).code, 503);
    const invalid = await fixture(t, { async countTokens() { return { token_count: NaN }; } });
    assert.equal((await invalid.call('tokens', request)).code, 502);
});

test('noop rejects a claimed next digest that differs from the verified file', async t => {
    const f = await fixture(t);
    const result = await f.call('save', await saveBody(chat, [], [{ mes: 'changed' }], 'noop'));
    assert.equal(result.code, 400);
    assert.equal(result.body.error, 'next_hash_mismatch');
    assert.equal(f.calls.length, 0);
    assert.equal(f.handlers.stats().noops, 0);
});
