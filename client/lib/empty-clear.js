// LittleWhiteBox 707e03f: do not enqueue a save for a genuinely empty clear.
// Both the persisted array AND the module's private Set must be empty.
export function installEmptyClearGuard(host, context) {
    let original;
    let wrapper;
    let skipped = 0;
    let delegated = 0;
    let reason = 'waiting-for-littlewhitebox';
    function refresh() {
        const candidate = host.clearTasksProcessedMessages;
        if (candidate === wrapper || typeof candidate !== 'function') return;
        const source = Function.prototype.toString.call(candidate);
        let hash = 2166136261;
        for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619) >>> 0;
        if (source.length !== 132 || hash !== 0xca5a97ed) {
            reason = 'littlewhitebox-algorithm-changed';
            return;
        }
        original = candidate;
        wrapper = function clearEmptyRecordsCompat(...args) {
            const records = context().extensionSettings?.LittleWhiteBox?.tasks?.processedMessages;
            let detail;
            try { detail = host.xbCacheRegistry?.getDetail?.('scheduledTasks'); } catch { /* delegate */ }
            if (Array.isArray(records) && records.length === 0 && detail?.processedMessages === 0) {
                skipped++;
                return;
            }
            delegated++;
            return original.apply(this, args);
        };
        host.clearTasksProcessedMessages = wrapper;
        reason = 'active';
    }
    refresh();
    const timer = setInterval(refresh, 1000);
    return {
        status: () => ({ reason, skipped, delegated }),
        restore() {
            clearInterval(timer);
            if (wrapper && host.clearTasksProcessedMessages === wrapper) host.clearTasksProcessedMessages = original;
        },
    };
}
