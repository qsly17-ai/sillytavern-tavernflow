import test from 'node:test';
import assert from 'node:assert/strict';
import { installEmptyClearGuard } from '../client/lib/empty-clear.js';

function fixture(version = '3.2.7') {
    const tasks = { enabled: true, globalTasks: [], processedMessages: [] };
    const H = { processedMessagesSet: new Set() };
    let saves = 0;
    const B0 = () => tasks, mx = () => { saves++; };
    // Keep the spelling of the 3.2.6/3.2.7 bundle function: its exact source is the guard.
    function qt(){B0().processedMessages=[],H.processedMessagesSet.clear(),mx()}
    const host = { clearTasksProcessedMessages: qt, xbCacheRegistry: { getDetail(id) {
        assert.equal(id, 'scheduledTasks'); return { processedMessages: H.processedMessagesSet.size };
    } } };
    const handle = installEmptyClearGuard(host, () => ({ extensionSettings: { LittleWhiteBox: { tasks } } }), () => version);
    return { host, handle, qt, tasks, set: H.processedMessagesSet, saves: () => saves };
}

test('versioned empty-clear skips only when both stores are empty and already normalized', () => {
    const f = fixture();
    try {
        f.host.clearTasksProcessedMessages();
        assert.equal(f.saves(), 0);
        f.set.add('memory only');
        f.host.clearTasksProcessedMessages();
        assert.equal(f.set.size, 0);
        f.tasks.processedMessages.push('disk only');
        f.host.clearTasksProcessedMessages();
        assert.deepEqual(f.tasks.processedMessages, []);
        f.tasks.globalTasks = undefined;
        f.host.clearTasksProcessedMessages();
        f.tasks.globalTasks = [];
        delete f.host.xbCacheRegistry;
        f.host.clearTasksProcessedMessages();
        assert.equal(f.saves(), 4);
        assert.deepEqual(f.handle.status(), { reason: 'littlewhitebox-probe-unavailable', skipped: 1, delegated: 4 });
    } finally { f.handle.restore(); }
    assert.equal(f.host.clearTasksProcessedMessages, f.qt);
});

test('unknown version keeps the identical-looking native function; cleanup preserves a later owner', () => {
    const f = fixture('3.3.0');
    try {
        assert.equal(f.host.clearTasksProcessedMessages, f.qt);
        assert.equal(f.handle.status().reason, 'littlewhitebox-version-mismatch');
    } finally { f.handle.restore(); }
    const good = fixture();
    const borrowed = good.host.clearTasksProcessedMessages;
    const other = () => {};
    good.host.clearTasksProcessedMessages = other;
    good.handle.restore();
    assert.equal(good.host.clearTasksProcessedMessages, other);
    borrowed();
    assert.equal(good.saves(), 1, 'a cached wrapper delegates after disposal');
});
