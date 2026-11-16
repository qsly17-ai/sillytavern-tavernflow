import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const hostRoot = process.env.TAVERNFLOW_HOST_ROOT;
const installer = new URL('../scripts/install.py', import.meta.url).pathname;
const hostFiles = ['public/script.js', 'public/scripts/group-chats.js', 'public/index.html'];
const ownDirectories = ['public/scripts/extensions/third-party/tavern-flow', 'plugins/tavern-flow'];
const hash = data => createHash('sha256').update(data).digest('hex');
async function createHost() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tavernflow-install-review-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.19.0' }));
    for (const relative of ['public/script.js', 'public/scripts/events.js', 'public/scripts/group-chats.js', 'src/endpoints/settings.js']) {
        await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
        await fs.copyFile(path.join(hostRoot, relative), path.join(root, relative));
    }
    await fs.writeFile(path.join(root, 'public/index.html'), '<html><head></head><body>Unrelated bytes</body></html>\r\n');
    return root;
}
const runInstaller = (root, ...args) => spawnSync('python3', [installer, '--host', root, ...args], { encoding: 'utf8' });
async function snapshot(root, paths) {
    const files = {};
    async function walk(relative) {
        let stat;
        try { stat = await fs.stat(path.join(root, relative)); }
        catch (error) { if (error.code === 'ENOENT') { files[relative] = null; return; } throw error; }
        if (stat.isDirectory()) {
            files[relative + '/'] = 'directory';
            for (const name of (await fs.readdir(path.join(root, relative))).sort()) await walk(path.join(relative, name));
        } else files[relative] = { sha256: hash(await fs.readFile(path.join(root, relative))), mode: stat.mode & 0o777 };
    }
    for (const relative of paths) await walk(relative);
    return files;
}
const failureHarness = `
import runpy,sys
module=runpy.run_path(sys.argv[1])
fail_at=int(sys.argv[2]);persistent=sys.argv[3]=='persistent'
sys.argv=[sys.argv[1],*sys.argv[4:]]
original=module['atomic_write'];calls=0
def fail_write(file,data):
 global calls
 calls+=1
 if calls==fail_at or (persistent and calls>=fail_at):raise OSError('injected atomic write failure')
 return original(file,data)
module['main'].__globals__['atomic_write']=fail_write
module['main']()
`;
const failInstaller = (root, failAt, persistent, ...args) => spawnSync('python3', ['-c', failureHarness, installer, String(failAt), persistent ? 'persistent' : 'once', '--host', root, ...args], { encoding: 'utf8' });
async function assertRecovery(root, prefix, before, result) {
    const candidates = (await fs.readdir(root)).filter(name => name.startsWith(prefix));
    assert.equal(candidates.length, 1);
    const staging = path.join(root, candidates[0]);
    assert(result.stderr.includes(staging), 'Failed compensation must disclose the preserved recovery directory');
    const records = JSON.parse(await fs.readFile(path.join(staging, 'recovery.json'), 'utf8'));
    assert.equal(records.length, hostFiles.length);
    for (const record of records) {
        const relative = path.relative(root, record.target);
        assert(hostFiles.includes(relative), 'Recovery is limited to the three owned host changes');
        assert.equal(hash(await fs.readFile(record.backup)), record.sha256);
        assert.equal(record.sha256, before[relative].sha256);
    }
}

test('installer previews, preserves unrelated index bytes, rejects tampering and rolls back its own block', { skip: !hostRoot && 'Set TAVERNFLOW_HOST_ROOT to the pinned SillyTavern' }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tavernflow-install-'));
    try {
        await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.19.0' }));
        for (const relative of ['public/script.js', 'public/scripts/events.js', 'public/scripts/group-chats.js', 'src/endpoints/settings.js']) {
            await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
            await fs.copyFile(path.join(hostRoot, relative), path.join(root, relative));
        }
        const index = path.join(root, 'public/index.html');
        const initial = '<!doctype html>\r\n<html><head><title>Personal title</title></head><body>用户原有改动</body></html>\r\n';
        await fs.writeFile(index, initial); await fs.chmod(index, 0o640);
        const run = (...args) => spawnSync('python3', [installer, '--host', root, ...args], { encoding: 'utf8' });
        assert.equal(run().status, 0); assert.equal(await fs.readFile(index, 'utf8'), initial);
        assert.equal(run('--apply').status, 0); const installed = await fs.readFile(index, 'utf8');
        assert(installed.includes('id="tavern-flow-boot"')); assert.equal((await fs.stat(index)).mode & 0o777, 0o640);
        assert.notEqual(run('--apply').status, 0); assert.equal(await fs.readFile(index, 'utf8'), installed);
        await fs.writeFile(index, installed.replace('const idleMs = 30000', 'const idleMs = 99999'));
        assert.notEqual(run('--rollback', '--apply').status, 0); assert((await fs.readFile(index, 'utf8')).includes('99999'));
        const later = installed.replace('用户原有改动', '用户安装后继续改动'); await fs.writeFile(index, later);
        await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.19.1' }));
        assert.equal(run('--rollback').status, 0); assert.equal(await fs.readFile(index, 'utf8'), later);
        assert.equal(run('--rollback', '--apply').status, 0); assert.equal(await fs.readFile(index, 'utf8'), initial.replace('用户原有改动', '用户安装后继续改动'));
        assert.equal(run('--rollback', '--apply').status, 0);
        assert.notEqual(run('--apply').status, 0);
        await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.19.0' }));
        await fs.appendFile(path.join(root, 'public/script.js'), '\n// Changed host');
        assert.notEqual(run('--apply').status, 0); assert.equal(await fs.readFile(index, 'utf8'), initial.replace('用户原有改动', '用户安装后继续改动'));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('native hooks preserve later unrelated core edits and reject hook tampering before any mutation', { skip: !hostRoot && 'Set TAVERNFLOW_HOST_ROOT to the pinned SillyTavern' }, async () => {
    const root = await createHost();
    try {
        const original = new Map(await Promise.all(hostFiles.map(async relative => [relative, await fs.readFile(path.join(root, relative))])));
        const installed = runInstaller(root, '--apply'); assert.equal(installed.status, 0, installed.stderr);
        for (const relative of hostFiles.slice(0, 2)) {
            const file = path.join(root, relative);
            assert.match(await fs.readFile(file, 'utf8'), /TAVERNFLOW NATIVE READ/);
            await fs.appendFile(file, '\n// User edit after installation\r\n');
        }
        const script = path.join(root, hostFiles[0]);
        const intact = await fs.readFile(script, 'utf8');
        await fs.writeFile(script, intact.replace('TAVERNFLOW NATIVE READ', 'TAVERNFLOW CHANGED READ'));
        const tampered = await snapshot(root, [...hostFiles, ...ownDirectories]);
        assert.notEqual(runInstaller(root, '--rollback', '--apply').status, 0);
        assert.deepEqual(await snapshot(root, [...hostFiles, ...ownDirectories]), tampered);
        await fs.writeFile(script, intact);
        const rollback = runInstaller(root, '--rollback', '--apply'); assert.equal(rollback.status, 0, rollback.stderr);
        for (const relative of hostFiles) {
            const expected = relative.endsWith('index.html') ? original.get(relative) : Buffer.concat([original.get(relative), Buffer.from('\n// User edit after installation\r\n')]);
            assert.equal(hash(await fs.readFile(path.join(root, relative))), hash(expected), relative);
        }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a one-shot failure at each of the three host writes restores install and uninstall exactly', { skip: !hostRoot && 'Set TAVERNFLOW_HOST_ROOT to the pinned SillyTavern' }, async () => {
    const root = await createHost();
    try {
        await fs.chmod(path.join(root, 'public/script.js'), 0o640);
        const before = await snapshot(root, [...hostFiles, ...ownDirectories]);
        for (let failAt = 1; failAt <= 3; failAt++) {
            assert.notEqual(failInstaller(root, failAt, false, '--apply').status, 0);
            assert.deepEqual(await snapshot(root, [...hostFiles, ...ownDirectories]), before, `install write ${failAt}`);
        }
        const installed = runInstaller(root, '--apply'); assert.equal(installed.status, 0, installed.stderr);
        const after = await snapshot(root, [...hostFiles, ...ownDirectories]);
        for (let failAt = 1; failAt <= 3; failAt++) {
            assert.notEqual(failInstaller(root, failAt, false, '--rollback', '--apply').status, 0);
            assert.deepEqual(await snapshot(root, [...hostFiles, ...ownDirectories]), after, `uninstall write ${failAt}`);
        }
        assert.equal(runInstaller(root, '--rollback', '--apply').status, 0);
        assert.deepEqual(await snapshot(root, [...hostFiles, ...ownDirectories]), before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a persistent compensation write failure never discards moved plugin directories', { skip: !hostRoot && 'Set TAVERNFLOW_HOST_ROOT to the pinned SillyTavern' }, async () => {
    const root = await createHost();
    try {
        const installed = runInstaller(root, '--apply'); assert.equal(installed.status, 0, installed.stderr);
        const directories = await snapshot(root, ownDirectories);
        const before = await snapshot(root, hostFiles);
        const failed = failInstaller(root, 2, true, '--rollback', '--apply'); assert.notEqual(failed.status, 0);
        assert.deepEqual(await snapshot(root, ownDirectories), directories);
        await assertRecovery(root, '.tavern-flow-uninstall-', before, failed);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a persistent install compensation failure preserves original host bytes and installed receipts', { skip: !hostRoot && 'Set TAVERNFLOW_HOST_ROOT to the pinned SillyTavern' }, async () => {
    const root = await createHost();
    try {
        const before = await snapshot(root, hostFiles);
        const failed = failInstaller(root, 2, true, '--apply'); assert.notEqual(failed.status, 0);
        await assertRecovery(root, '.tavern-flow-install-', before, failed);
        for (const relative of ownDirectories) {
            assert((await fs.stat(path.join(root, relative))).isDirectory());
            const receipt = JSON.parse(await fs.readFile(path.join(root, relative, '.tavern-flow-install.json'), 'utf8'));
            assert(Object.keys(receipt).length > 0);
        }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
