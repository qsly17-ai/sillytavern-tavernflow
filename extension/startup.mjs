// SPDX-License-Identifier: AGPL-3.0-only
// Authority: SillyTavern 1.19.0 extensions.js, getExtensionManifest,
// sortManifestsByOrder, activateExtensions and addExtensionScript. Only browser
// resource hints are added; native activation and module evaluation own readiness.

export function extensionModuleUrl(name, asset, origin) {
    if (typeof name !== 'string' || typeof asset !== 'string') return null;
    const parts = name.split('/');
    if (!(parts.length === 1 || (parts.length === 2 && parts[0] === 'third-party'))
        || parts.some(part => !part || part === '.' || part === '..' || /[\\%:#?\s\x00-\x1f]/u.test(part))) return null;
    const pathname = asset.split('?')[0];
    if (!/\.m?js$/i.test(pathname) || /[\\%:#\s\x00-\x1f]/u.test(pathname)
        || pathname.split('/').some(part => !part || part === '.' || part === '..') || asset.includes('#')) return null;
    try {
        const root = new URL(`/scripts/extensions/${name}/`, origin);
        const url = new URL(`/scripts/extensions/${name}/${asset}`, origin);
        return url.origin === origin && url.pathname.startsWith(root.pathname) ? url.href : null;
    } catch { return null; }
}

function eligible(name, manifest, names, disabled, availableModules, clientVersion) {
    return !disabled.includes(name)
        && (!Array.isArray(manifest.requires) || manifest.requires.every(item => availableModules.includes(item)))
        && (!Array.isArray(manifest.dependencies) || manifest.dependencies.every(item => names.includes(item) && !disabled.includes(item)))
        && (manifest.minimum_client_version == null || clientVersion.localeCompare(manifest.minimum_client_version, undefined, { numeric: true, sensitivity: 'base' }) >= 0);
}

/** Pure plan. URLs retain the native entry's query string, including ?ver=. */
export function planStartupPreloads({ extensionNames = [], getManifest, disabled = [], availableModules = [],
    clientVersion = '', ownName = 'third-party/tavern-flow', origin } = {}) {
    if (typeof getManifest !== 'function' || clientVersion !== '1.19.0') return [];
    const rows = [];
    for (const name of extensionNames) {
        try {
            const manifest = getManifest(name);
            if (manifest && typeof manifest === 'object') rows.push({ name, manifest });
        } catch { /* One inaccessible manifest must not affect native startup. */ }
    }
    // Match the installed host, including its loading_order tie-breaker.
    rows.sort((a, b) => parseInt(a.manifest.loading_order) - parseInt(b.manifest.loading_order)
        || String(a.manifest.display_name).localeCompare(String(b.manifest.display_name)));
    const ownIndex = rows.findIndex(row => row.name === ownName);
    if (ownIndex < 0 || disabled.includes(ownName)) return [];
    return rows.slice(ownIndex + 1).flatMap(({ name, manifest }) => {
        if (!eligible(name, manifest, extensionNames, disabled, availableModules, clientVersion)) return [];
        const href = extensionModuleUrl(name, manifest.js, origin);
        return href ? [{ name, manifest, href }] : [];
    });
}

/**
 * Install synchronously during the extension entry, before APP_READY. Pass the
 * already loaded host exports: extensionNames, getExtensionManifest as getManifest,
 * modules as availableModules, and CLIENT_VERSION.split(':')[1]. Never import a
 * target extension here: modulepreload fetches/compiles without evaluating it.
 */
export function installStartupPreload({ context, extensionNames, getManifest, availableModules = [], clientVersion,
    ownName = 'third-party/tavern-flow', enabled = true, ahead = 2, timeoutMs = 30000,
    document = globalThis.document, location = globalThis.location, navigator = globalThis.navigator,
    onStats = () => {} } = {}) {
    const stats = { scheduled: 0, loaded: 0, failed: 0, nativeScripts: 0 };
    let active = false, reason = 'disabled', timer, cursor = -1;
    const links = new Map();
    const subscriptions = [];
    const notify = () => { try { onStats(); } catch { /* Diagnostics are optional. */ } };
    const status = () => ({ enabled: active, reason, ...stats, pendingHints: links.size });
    function dispose(why = 'disposed') {
        active = false;
        reason = why;
        clearTimeout(timer);
        document?.removeEventListener?.('load', advance, true);
        document?.removeEventListener?.('error', advance, true);
        document?.removeEventListener?.('visibilitychange', visibility);
        for (const [type, callback] of subscriptions) context.eventSource.removeListener(type, callback);
        subscriptions.length = 0;
        for (const link of links.values()) link.remove();
        links.clear();
        notify();
    }
    const result = { status, dispose };
    if (!enabled) return result;
    if (clientVersion !== '1.19.0') { reason = 'unverified-host-version'; return result; }
    if (navigator?.connection?.saveData || /^(?:slow-)?2g$/.test(navigator?.connection?.effectiveType || '')) {
        reason = 'connection-saving'; return result;
    }
    if (document?.visibilityState === 'hidden') { reason = 'background-page'; return result; }
    try {
        if (!document?.head || !document?.addEventListener || !document.createElement('link').relList?.supports('modulepreload')
            || !context?.eventSource?.on || !context.eventSource.removeListener || !context.eventTypes?.APP_READY) {
            reason = 'capability-unavailable'; return result;
        }
    } catch { reason = 'capability-unavailable'; return result; }
    const disabled = () => context.extensionSettings?.disabledExtensions || [];
    const plan = planStartupPreloads({ extensionNames, getManifest, disabled: disabled(), availableModules, clientVersion, ownName, origin: location?.origin });
    if (!plan.length) { reason = 'no-later-entries'; return result; }
    const indices = new Map(plan.map((row, index) => [row.href, index]));
    const scheduled = new Set();
    const width = Math.max(1, Math.min(3, Math.trunc(Number(ahead)) || 2));
    function pump() {
        for (let i = cursor + 1; i < Math.min(plan.length, cursor + 1 + width); i++) {
            const row = plan[i];
            if (scheduled.has(i) || !eligible(row.name, row.manifest, extensionNames, disabled(), availableModules, clientVersion)) continue;
            // A native entry may already exist when enabling after page startup.
            if ([...document.scripts].some(script => script.src === row.href)) continue;
            scheduled.add(i);
            const link = document.createElement('link');
            link.rel = 'modulepreload';
            link.href = row.href;
            link.fetchPriority = 'low';
            link.dataset.tavernFlowStartup = '1';
            link.onload = () => { if (active) { stats.loaded++; notify(); } };
            link.onerror = () => { if (active) { stats.failed++; notify(); } };
            links.set(i, link);
            stats.scheduled++;
            document.head.appendChild(link);
        }
        notify();
    }
    function advance(event) {
        if (!active || event.target?.tagName !== 'SCRIPT') return;
        const index = indices.get(event.target.src);
        if (index === undefined || index <= cursor) return;
        cursor = index;
        stats.nativeScripts++;
        for (const [key, link] of links) if (key <= cursor) { link.remove(); links.delete(key); }
        if (cursor === plan.length - 1) dispose('native-entries-complete');
        else pump();
    }
    function visibility() { if (document.visibilityState === 'hidden') dispose('background-page'); }
    active = true;
    reason = 'preloading';
    document.addEventListener('load', advance, true);
    document.addEventListener('error', advance, true);
    document.addEventListener('visibilitychange', visibility);
    for (const type of [context.eventTypes.APP_READY, context.eventTypes.CHAT_CHANGED].filter(Boolean)) {
        const callback = () => dispose(type === context.eventTypes.APP_READY ? 'app-ready' : 'chat-opened');
        subscriptions.push([type, callback]);
        context.eventSource.on(type, callback);
        // 1.19 replays APP_READY to late subscribers. Never resume afterwards.
        if (!active) return result;
    }
    timer = setTimeout(() => dispose('time-limit'), Math.max(1000, Math.min(30000, Number(timeoutMs) || 30000)));
    timer.unref?.();
    pump();
    return result;
}
