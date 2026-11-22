// SPDX-License-Identifier: AGPL-3.0-only
// Official LittleWhiteBox builds: version and exact clear function must agree.
const fingerprints = new Map([
    ['3.2.5', [132, 0xca5a97ed]],           // 707e03f2 (host/plugin.js)
    ['3.2.6', [76, 0x0b2e3f33]],            // c508e5f5 (shared host bundle)
    ['3.2.7', [76, 0x0b2e3f33]],            // 731bab81 (same clear and Set probe)
]);

export function installEmptyClearGuard(host, context, getVersion, onStats = () => {}) {
    let original, wrapper, lastCandidate, version, disposed = false;
    let skipped = 0, delegated = 0, dirty = true;
    let reason = 'waiting-for-littlewhitebox';
    function refresh() {
        const candidate = host.clearTasksProcessedMessages;
        if (candidate === wrapper && wrapper) return;
        if (typeof candidate !== 'function') {
            reason = 'waiting-for-littlewhitebox';
            lastCandidate = undefined;
            return;
        }
        version ??= getVersion?.(); // The loader's manifest is immutable until reload.
        if (!version || candidate === lastCandidate) return;
        lastCandidate = candidate;
        const expected = fingerprints.get(version);
        if (!expected) { reason = 'littlewhitebox-version-mismatch'; return; }
        const source = Function.prototype.toString.call(candidate);
        let hash = 2166136261;
        for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619) >>> 0;
        if (source.length !== expected[0] || hash !== expected[1]) {
            reason = 'littlewhitebox-algorithm-changed';
            return;
        }
        original = candidate;
        const owned = function clearEmptyRecordsCompat(...args) {
            if (disposed || host.clearTasksProcessedMessages !== owned) return candidate.apply(this, args);
            try {
                // Native getStoredTaskSettings also repairs enabled/globalTasks.
                // Preserve those repairs even if there is nothing to clear.
                const tasks = context()?.extensionSettings?.LittleWhiteBox?.tasks;
                if (typeof tasks?.enabled === 'boolean' && Array.isArray(tasks.globalTasks)
                    && Array.isArray(tasks.processedMessages) && tasks.processedMessages.length === 0) {
                    const size = host.xbCacheRegistry?.getDetail?.('scheduledTasks')?.processedMessages;
                    reason = Number.isSafeInteger(size) && size >= 0 ? 'active' : 'littlewhitebox-probe-unavailable';
                    if (size === 0) { skipped++; dirty = true; return; }
                }
            } catch { reason = 'littlewhitebox-probe-unavailable'; }
            delegated++; dirty = true;
            return candidate.apply(this, args);
        };
        host.clearTasksProcessedMessages = wrapper = owned;
        reason = 'active';
    }
    function tick() {
        const previous = reason;
        try { refresh(); } catch { reason = 'littlewhitebox-probe-unavailable'; }
        if (dirty || reason !== previous) {
            dirty = false;
            try { onStats(); } catch { /* telemetry is optional */ }
        }
    }
    tick();
    const timer = setInterval(tick, 1000);
    return {
        status: () => ({
            reason: reason === 'active' && typeof host.xbCacheRegistry?.getDetail !== 'function' ? 'littlewhitebox-probe-unavailable' : reason,
            skipped, delegated,
        }),
        restore() {
            disposed = true;
            clearInterval(timer);
            if (wrapper && host.clearTasksProcessedMessages === wrapper) host.clearTasksProcessedMessages = original;
        },
    };
}
