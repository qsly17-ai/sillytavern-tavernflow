// Explicitly opt in to read a host's source. All writes and configuration use a new
// temporary DATA_ROOT; the host's live config, accounts and chats are never loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('verified 1.19 native settings/chat/group persistence, integrity, backup and token equivalence', { skip: !process.env.TAVERNFLOW_HOST_ROOT, timeout: 30000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tavern-flow-native-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'config.yaml'), 'enableUserAccounts: false\nbackups:\n  chat:\n    enabled: true\n    throttleInterval: 0\n    checkIntegrity: true\n');
    const serverPath = fileURLToPath(new URL('../server/index.mjs', import.meta.url));
    const protocolPath = fileURLToPath(new URL('../shared/protocol.mjs', import.meta.url));
    const source = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import path from 'node:path';
        import { createRequire } from 'node:module';
        import { pathToFileURL } from 'node:url';
        const host = process.env.TAVERNFLOW_HOST_ROOT;
        const root = process.env.TAVERNFLOW_NATIVE_TEST_ROOT;
        process.chdir(host);
        globalThis.DATA_ROOT = path.relative(host, path.join(root, 'data'));
        const util = await import(pathToFileURL(path.join(host, 'src/util.js')));
        util.setConfigFilePath(path.join(root, 'config.yaml'));
        const { loadNativePersistence, createHandlers } = await import(pathToFileURL(process.env.TAVERNFLOW_SERVER_MODULE));
        const { hashValue, chatFileName } = await import(pathToFileURL(process.env.TAVERNFLOW_PROTOCOL_MODULE));
        const sanitize = createRequire(path.join(host, 'package.json'))('sanitize-filename');
        for (const name of ['侦探: 林', '档案/二?', '开场. ', 'COM1', '你'.repeat(100), 'a'.repeat(254) + '😀', '😀'.repeat(70)]) {
            assert.equal(chatFileName(name) || '', sanitize(name + '.jsonl'));
        }
        const native = await loadNativePersistence(host);
        const users = await import(pathToFileURL(path.join(host, 'src/users.js')));
        const user = { profile: { handle: 'flow-test' }, directories: users.getUserDirectories('flow-test') };
        await Promise.all(['root', 'chats', 'groupChats', 'backups'].map(key => fs.mkdir(user.directories[key], { recursive: true })));
        const handlers = createHandlers({ persistence: native, validateUser: native.validateUser });
        const call = async (method, body) => {
            const response = { code: 200, status(value) { this.code = value; return this; }, set() { return this; }, json(value) { this.body = value; return this; } };
            await handlers[method]({ user, body }, response);
            return response;
        };
        const chat = { kind: 'chat', identity: { avatar_url: 'test.png', file_name: '侦探: 林' } };
        const group = { kind: 'group', identity: { id: 'group-native:test' } };
        const original = [{ chat_metadata: { integrity: 'known', extra: { hp: 3 } } }, { mes: 'abc', swipes: ['abc', 'def'] }];
        for (const resource of [chat, group]) {
            const result = await call('save', { ...resource, mode: 'full', baseHash: await hashValue([]), nextHash: await hashValue(original), value: original });
            assert.equal(result.code, 200);
            assert.deepEqual((await call('state', resource)).body.value, original);
            const corrupt = structuredClone(original); corrupt[0].chat_metadata.integrity = 'stale';
            const conflict = await call('save', { ...resource, mode: 'full', baseHash: await hashValue(original), nextHash: await hashValue(corrupt), value: corrupt });
            assert.equal(conflict.code, 400); assert.equal(conflict.body.error, 'integrity');
            const overwrite = { ...resource, mode: 'full', baseHash: await hashValue(original), nextHash: await hashValue(corrupt), value: corrupt, force: true };
            assert.equal((await call('save', overwrite)).code, 200);
            assert.deepEqual((await call('state', resource)).body.value, corrupt);
            const staleForce = await call('save', overwrite);
            assert.equal(staleForce.code, 409); assert.equal(staleForce.body.error, 'conflict');
        }
        assert.deepEqual((await call('state', { ...chat, identity: { ...chat.identity, file_name: '侦探 林' } })).body.value[1], original[1]);
        const settings = { extension_settings: { mvu: { custom: true } }, custom: 'preserve' };
        const settingsSave = await call('save', { kind: 'settings', identity: {}, mode: 'full', baseHash: await hashValue({}), nextHash: await hashValue(settings), value: settings });
        assert.equal(settingsSave.code, 200);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(user.directories.root, 'settings.json'), 'utf8')), settings);
        const backups = await fs.readdir(user.directories.backups);
        assert(backups.some(name => name.startsWith('settings_flow-test_')));
        assert(backups.some(name => name.startsWith('chat_test_')));
        assert(backups.some(name => name.startsWith('chat_group_nativetest_')));
        const request = { model: 'gpt-4o', messages: [{ role: 'user', content: '中文与 Emoji 😀' }] };
        const tokenBatch = await call('tokens', { requests: [request, request] });
        assert.equal(tokenBatch.code, 200);
        const tokenizers = await import(pathToFileURL(path.join(host, 'src/endpoints/tokenizers.js')));
        const nativeCount = tokenizers.router.stack.find(layer => layer.route?.path === '/openai/count').route.stack[0].handle;
        let count;
        await nativeCount({ body: request.messages, query: { model: request.model } }, { send(value) { count = value; } });
        assert.deepEqual(tokenBatch.body.results, [count, count]);
        const excluded = await call('tokens', { requests: [{ ...request, model: 'qwen2' }] });
        assert.equal(excluded.code, 503);
        const impostor = { ...user, directories: { ...user.directories, chats: '/tmp' } };
        assert.equal(native.validateUser(impostor), false);
        // The native settings route returns an Error object at HTTP 200 when its
        // atomic rename fails. The adapter must reject that apparent success.
        const settingsPath = path.join(user.directories.root, 'settings.json');
        await fs.rm(settingsPath);
        await fs.mkdir(settingsPath);
        await assert.rejects(() => native.saveSettings(settings, { user }, { user }), /Native settings persistence failed/);
        handlers.dispose();
        console.log('TAVERNFLOW_NATIVE_OK');
        process.exit(0); // Native settings throttles keep a ten-minute timer alive.
    `;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, TAVERNFLOW_NATIVE_TEST_ROOT: root, TAVERNFLOW_SERVER_MODULE: serverPath, TAVERNFLOW_PROTOCOL_MODULE: protocolPath },
        timeout: 25000, maxBuffer: 1024 * 1024,
    });
    assert.match(result.stdout, /TAVERNFLOW_NATIVE_OK/);
});
