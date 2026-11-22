// SPDX-License-Identifier: AGPL-3.0-only
// The page only captures requests. JSON work and all optimized I/O live in worker.js.
const SAVE_PATHS = new Set(['/api/settings/save', '/api/chats/save', '/api/chats/group/save']);
// A worker lifecycle is shorter than the page's in-memory chat lifecycle.
// Recreating the worker must never turn a rejected old snapshot into a new base.
const RELOAD_REQUIRED = new WeakMap();
// Keep only hashes between worker lifecycles: the page may still hold the same
// old in-memory chat, even after its performance modules have been toggled.
const PAGE_BASELINES = new WeakMap();
const hashPattern = /^[a-f0-9]{64}$/;
const reloadError = () => new Error('清酌发现保存冲突或上次保存结果未确认；请先保留未保存的修改，再刷新页面并重新读取。');
function targetsSave(input, init, location) {
    try {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url, location.href);
        return url.origin === location.origin && SAVE_PATHS.has(url.pathname) && String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() === 'POST';
    } catch { return false; }
}
function ensureReloadGuard(host) {
    const blocked = RELOAD_REQUIRED.get(host);
    if (!blocked || host.fetch === blocked.guard) return;
    const previous = host.fetch;
    blocked.guard = function(input, init) {
        if (targetsSave(input, init, host.location)) return Promise.reject(reloadError());
        return previous.apply(this, arguments);
    };
    host.fetch = blocked.guard;
}

export function installTransport({ context, getHeaders = context?.getRequestHeaders?.bind(context), onStats, baseUrl = '/api/plugins/tavern-flow', workerUrl = new URL('./worker.js', import.meta.url) } = {}) {
    const host = globalThis.window ?? globalThis;
    const original = host.fetch;
    const here = host.location;
    const state = { enabled: false, reason: 'starting', pending: 0, completed: 0, failures: 0, canceled: 0, bypassed: 0, nativePrecompressSkipped: 0, requiresReload: false, originalBytes: 0, sourceBytes: 0, sentBytes: 0, recent: [] };
    const snapshot = () => ({ ...state, recent: state.recent.slice() });
    const emit = (event) => { try { onStats?.({ module: 'transport', ...event }); } catch { /* telemetry cannot break a save */ } };
    const inactive = (reason) => { state.reason = reason; emit({ event: 'status', ...snapshot() }); return { status: snapshot, dispose() {} }; };
    if (RELOAD_REQUIRED.has(host)) {
        state.requiresReload = true;
        ensureReloadGuard(host);
        return inactive('reload-required');
    }
    if (!here || typeof original !== 'function' || !host.Worker || !host.crypto?.subtle || !host.DecompressionStream) return inactive('worker-capability-unavailable');
    let endpoint;
    try {
        endpoint = new URL(baseUrl, here.href);
        if (endpoint.origin !== here.origin) return inactive('cross-origin-backend-rejected');
    } catch { return inactive('invalid-backend-url'); }
    let worker;
    try { worker = new host.Worker(workerUrl, { type: 'module', name: 'tavern-flow-save' }); }
    catch { return inactive('worker-start-failed'); }
    let pageBaselines = PAGE_BASELINES.get(host);
    if (!pageBaselines) { pageBaselines = new Map(); PAGE_BASELINES.set(host, pageBaselines); }
    let stopped = false;
    let failed = false;
    let terminated = false;
    let serial = 0;
    let disconnectAdoptions, disconnectSavePreparer;
    const dispatches = new Map();
    const deferredCompression = new WeakMap();
    const boot = host.__tavernFlowBoot;
    const pending = new Map();
    const idleWaiters = [];
    const waitForIdle = () => pending.size ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve();
    const startupTimer = setTimeout(() => fail('worker-start-timeout'), 15000);
    function terminate() {
        if (terminated) return;
        terminated = true;
        disconnectAdoptions?.();
        disconnectSavePreparer?.();
        worker.terminate();
    }
    function dispatch(path, operation) {
        const tail = (dispatches.get(path) ?? Promise.resolve()).then(operation);
        dispatches.set(path, tail);
        void tail.then(() => { if (dispatches.get(path) === tail) dispatches.delete(path); });
    }
    function drain() {
        state.pending = pending.size;
        if (pending.size) return;
        for (const resolve of idleWaiters.splice(0)) resolve();
        if (stopped) {
            if (!state.requiresReload && host.fetch === wrappedFetch) host.fetch = original;
            terminate();
        }
    }
    function cleanup(entry) { entry.signal?.removeEventListener('abort', entry.abort); }
    function requireReload(reason) {
        state.requiresReload = true;
        state.enabled = false;
        state.reason = 'reload-required';
        if (!RELOAD_REQUIRED.has(host)) RELOAD_REQUIRED.set(host, { reason });
        ensureReloadGuard(host);
        emit({ event: 'status', ...snapshot() });
    }
    function fail(reason) {
        if (failed) return;
        failed = true;
        state.enabled = false;
        state.reason = reason;
        clearTimeout(startupTimer);
        if ([...pending.values()].some((entry) => entry.posted)) requireReload(reason);
        if (!state.requiresReload && host.fetch === wrappedFetch) host.fetch = original;
        for (const entry of pending.values()) {
            cleanup(entry);
            entry.reject(new Error('清酌保存后台已停止；本次结果未确认，请重新读取聊天后再保存。'));
        }
        state.failures += pending.size;
        pending.clear();
        state.pending = 0;
        drain();
        terminate();
        emit({ event: 'status', ...snapshot() });
    }
    worker.onerror = () => fail('worker-failed');
    worker.onmessageerror = () => fail('worker-message-failed');
    worker.onmessage = ({ data }) => {
        if (data.type === 'baseline') {
            if (typeof data.key === 'string' && hashPattern.test(data.hash || '')) {
                pageBaselines.set(data.key, { hash: data.hash, ...(typeof data.blocked === 'string' ? { blocked: data.blocked } : {}) });
            }
            return;
        }
        if (data.type === 'ready') {
            clearTimeout(startupTimer);
            if (stopped || failed) { drain(); return; }
            disconnectAdoptions = boot?.connectAdoptions?.((message) => {
                // Adoption is synchronous with using the native data. Queue
                // only the already received snapshot, never a network read.
                dispatch(message.path.replace(/\/get$/, '/save'), () => {
                    try { if (!terminated) worker.postMessage(message); }
                    catch { fail('worker-message-failed'); }
                });
            });
            disconnectSavePreparer = boot?.connectSavePreparer?.((path, nativeCompress) => {
                // If a later wrapper owns fetch, it must see the same request
                // representation as in the host. Do not bypass its preprocessing.
                if (!SAVE_PATHS.has(path) || host.fetch !== wrappedFetch) return nativeCompress;
                return request => {
                    if (stopped || failed || !state.enabled || host.fetch !== wrappedFetch || typeof request?.body !== 'string') return nativeCompress(request);
                    const headers = new Headers(request.headers);
                    if (request.method !== 'POST' || request.keepalive || request.credentials === 'omit' || headers.has('content-encoding') ||
                        !headers.get('content-type')?.toLowerCase().includes('application/json')) return nativeCompress(request);
                    deferredCompression.set(request, nativeCompress);
                    state.nativePrecompressSkipped++;
                    return request;
                };
            });
            state.enabled = true;
            state.reason = 'active';
            emit({ event: 'status', ...snapshot() });
            return;
        }
        if (data.type === 'unavailable') { fail(data.reason || 'backend-unavailable'); return; }
        if (data.type === 'seed-status') {
            boot?.settleAdoption?.(data.adoptionKey, data.adoptionId);
            emit({ event: 'seed', kind: data.kind, accepted: data.accepted, reason: data.reason });
            return;
        }
        const entry = pending.get(data.id);
        if (!entry) return;
        pending.delete(data.id);
        cleanup(entry);
        if (data.type === 'passthrough') {
            state.bypassed++;
            // The worker has not dispatched a save. Preserve the original request and its fetch chain.
            if (!entry.aborted) {
                if (RELOAD_REQUIRED.has(host)) entry.reject(reloadError());
                else entry.resolve(passThrough(entry.receiver, entry.args));
            }
        } else if (data.error) {
            state.failures++;
            requireReload(data.error.code || 'unconfirmed-save');
            if (!entry.aborted) entry.reject(new DOMException(data.error.message || '清酌保存失败', data.error.name || 'Error'));
            emit({ event: 'error', reason: data.error.code || 'request-failed', kind: data.kind });
        } else {
            try {
                const response = new Response(data.body, { status: data.status, statusText: data.statusText, headers: data.headers });
                if (response.status === 409 || response.status >= 500) requireReload(response.status === 409 ? 'save-conflict' : 'unconfirmed-server-error');
                if (!entry.aborted) { if (response.ok) state.completed++; else state.failures++; }
                if (data.stats) {
                    state.originalBytes += data.stats.originalBytes || 0;
                    state.sourceBytes += data.stats.sourceBytes || 0;
                    state.sentBytes += data.stats.sentBytes || 0;
                    const stats = { ...data.stats, aborted: entry.aborted };
                    state.recent.push(stats);
                    if (state.recent.length > 30) state.recent.shift();
                    emit({ event: 'save', ...stats });
                }
                if (!entry.aborted) entry.resolve(response);
            } catch { requireReload('invalid-worker-response'); if (!entry.aborted) entry.reject(reloadError()); }
        }
        drain();
    };
    function qualify(input, init) {
        let url;
        try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url, here.href); } catch { return; }
        if (url.origin !== here.origin || !SAVE_PATHS.has(url.pathname)) return;
        const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (method !== 'POST') return;
        // Unload requests and anonymous requests retain their native semantics.
        if ((init?.keepalive ?? input?.keepalive) || (init?.credentials ?? input?.credentials) === 'omit') return;
        try {
            // A native JSON string must not be UTF-8 encoded into a Request and then
            // copied back out on the page. Validate only its small request metadata.
            if (!(input instanceof Request) && typeof init?.body === 'string') {
                const headers = new Headers(init.headers);
                const encoding = (headers.get('content-encoding') || '').toLowerCase().trim();
                if (!encoding && (headers.get('content-type') || '').toLowerCase().includes('application/json')) {
                    const request = new Request(url.href, { ...init, body: undefined, headers });
                    return { request, path: url.pathname, encoding, stringBody: init.body };
                }
            }
            const request = new Request(input instanceof Request ? input.clone() : url.href, init);
            const encoding = (request.headers.get('content-encoding') || '').toLowerCase().trim();
            if (encoding && encoding !== 'gzip') return;
            const contentType = (request.headers.get('content-type') || '').toLowerCase();
            if (!contentType.includes('application/json')) return;
            return { request, path: url.pathname, encoding };
        } catch { return; }
    }
    function isNativeSave(input, init) {
        return targetsSave(input, init, here);
    }
    function passThrough(receiver, args) {
        const request = args[1];
        const compress = deferredCompression.get(request);
        if (!compress) return original.apply(receiver, args);
        deferredCompression.delete(request);
        // The worker has not written anything. Restore the host's exact
        // preprocessing before a native fallback, including later wrappers.
        return Promise.resolve().then(() => compress(request)).then(prepared => {
            if (RELOAD_REQUIRED.has(host)) throw reloadError();
            return original.call(receiver, args[0], prepared);
        });
    }
    function wrappedFetch(input, init) {
        if (state.requiresReload && isNativeSave(input, init)) return Promise.reject(reloadError());
        if (stopped && pending.size && isNativeSave(input, init)) {
            const receiver = this;
            const args = [...arguments];
            return waitForIdle().then(() => {
                if (state.requiresReload) throw reloadError();
                return passThrough(receiver, args);
            });
        }
        if (!state.enabled || stopped || failed) return passThrough(this, arguments);
        const target = qualify(input, init);
        if (!target) return passThrough(this, arguments);
        const { request, path } = target;
        if (request.signal.aborted) return Promise.reject(request.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        const id = ++serial;
        const args = [...arguments];
        const receiver = this;
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, signal: request.signal, args, receiver, posted: false, aborted: false };
            entry.abort = () => {
                if (entry.aborted) return;
                entry.aborted = true;
                state.canceled++;
                reject(request.signal.reason ?? new DOMException('Aborted', 'AbortError'));
                if (entry.posted) {
                    try { worker.postMessage({ type: 'abort', id }); } catch { fail('worker-message-failed'); }
                } else {
                    pending.delete(id);
                    cleanup(entry);
                    drain();
                }
            };
            pending.set(id, entry);
            state.pending = pending.size;
            request.signal.addEventListener('abort', entry.abort, { once: true });
            const body = target.stringBody !== undefined ? Promise.resolve(target.stringBody) : request.arrayBuffer();
            void body.catch(() => {});
            // Strings are cloned directly; binary and pre-gzipped bodies transfer their buffers.
            dispatch(path, async () => {
                try {
                    const bytes = await body;
                    if (!pending.has(id) || failed) return;
                    // Native JSON.stringify and structured-clone copying would
                    // otherwise share one task. Let input/paint run between them
                    // for large strings; the admitted request keeps its ordering.
                    if (typeof bytes === 'string' && bytes.length > 262144) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                        if (!pending.has(id) || failed) return;
                    }
                    if (request.signal.aborted) { entry.abort(); return; }
                    if (RELOAD_REQUIRED.has(host)) {
                        pending.delete(id); cleanup(entry); reject(reloadError()); drain(); return;
                    }
                    worker.postMessage({ type: 'save', id, path, body: bytes, headers: [...request.headers], credentials: request.credentials }, typeof bytes === 'string' ? [] : [bytes]);
                    entry.posted = true;
                } catch (error) {
                    if (pending.delete(id)) { cleanup(entry); reject(error); drain(); }
                }
            });
        });
    }
    host.fetch = wrappedFetch;
    try { worker.postMessage({ type: 'init', baseUrl: endpoint.href.replace(/\/$/, ''), origin: here.origin, headers: [...new Headers(getHeaders?.() ?? {})], baselines: [...pageBaselines] }); }
    catch { fail('worker-init-failed'); }
    return {
        status: snapshot,
        dispose() {
            if (stopped) return waitForIdle();
            stopped = true;
            disconnectAdoptions?.();
            state.enabled = false;
            state.reason = state.requiresReload ? 'reload-required' : 'disposed';
            clearTimeout(startupTimer);
            // Keep save requests behind the admitted worker queue until it drains.
            drain();
            emit({ event: 'status', ...snapshot() });
            return waitForIdle();
        },
    };
}
