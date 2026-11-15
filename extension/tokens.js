// SPDX-License-Identifier: AGPL-3.0-only
// Async local counting only. jQuery's converter, callbacks and jqXHR remain owned by jQuery.
const DISPATCHER = Symbol.for('tavern-flow.jquery-token-dispatcher');
const REMOTE = /qwen|command-r|command-a|nemo|deepseek/i;
const encoder = new TextEncoder();
const MAX_BATCH_BYTES = 4 * 1024 * 1024 - 1024;
export function installTokens({ context, onStats = () => {}, baseUrl = '/api/plugins/tavern-flow' } = {}) {
    const $ = globalThis.jQuery;
    const state = { enabled: false, reason: 'jquery-unavailable', requests: 0, batches: 0, canceled: 0, failures: 0 };
    const status = () => ({ ...state });
    const report = () => { try { onStats(status()); } catch { /* telemetry is optional */ } };
    if (!$?.ajaxTransport) return { status, dispose() {} };
    // jQuery has no unregister API. Register one inert dispatcher for the page,
    // then replace its owner; disable clears the owner and retains native transport.
    if (!$[DISPATCHER]) {
        $[DISPATCHER] = { owner: null };
        $.ajaxTransport('+*', (options, original, xhr) => $[DISPATCHER].owner?.transport(options, original, xhr));
    }
    if ($[DISPATCHER].owner) { state.reason = 'token-batcher-already-installed'; return { status, dispose() {} }; }
    const queued = new Set(), pending = new Set();
    let timer, stopped = false;
    const owner = { transport(options, original = {}) {
        if (stopped || options.async === false || String(options.type).toUpperCase() !== 'POST' || typeof options.data !== 'string') return;
        if (options.username || options.password || options.xhrFields || options.mimeType || Object.hasOwn(original, 'xhr')) return;
        let url, messages;
        try {
            url = new URL(options.url, location.href);
            if (url.origin !== location.origin || url.pathname !== '/api/tokenizers/openai/count' || REMOTE.test(url.searchParams.get('model') || '')) return;
            if (!String(options.contentType).includes('application/json') || options.data.length > 1048576) return;
            messages = JSON.parse(options.data);
            if (!Array.isArray(messages) || messages.some(message => !message || typeof message !== 'object' || Array.isArray(message))) return;
        } catch { return; }
        const item = { model: url.searchParams.get('model') || '', messages, options, aborted: false };
        item.bytes = encoder.encode(JSON.stringify({ model: item.model, messages })).length + 1;
        if (item.bytes > MAX_BATCH_BYTES) return;
        return { send(headers, complete) {
            item.headers = headers; item.complete = complete;
            queued.add(item); pending.add(item); state.requests++;
            timer ??= setTimeout(flush, 4);
        }, abort() {
            if (item.aborted) return;
            item.aborted = true; queued.delete(item); pending.delete(item); state.canceled++; report();
        } };
    } };
    function complete(item, ...args) {
        if (item.aborted || item.completed) return;
        item.completed = true; pending.delete(item);
        try { item.complete(...args); }
        catch (error) { setTimeout(() => { throw error; }, 0); }
    }
    async function flush() {
        timer = undefined;
        const batch = []; let size = 32;
        for (const item of queued) {
            if (item.aborted) continue;
            if (batch.length >= 32 || size + item.bytes > MAX_BATCH_BYTES) break;
            batch.push(item); size += item.bytes;
        }
        for (const item of batch) queued.delete(item);
        if (queued.size) timer = setTimeout(flush, 0);
        if (!batch.length) return;
        state.batches++;
        let results;
        try {
            const headers = new Headers(context?.getRequestHeaders?.() || batch[0].headers);
            headers.set('Content-Type', 'application/json');
            const response = await fetch(`${baseUrl}/tokens`, { method: 'POST', headers,
                body: JSON.stringify({ requests: batch.map(({ model, messages }) => ({ model, messages })) }) });
            const result = await response.json();
            if (!response.ok || result.ok !== true || result.results?.length !== batch.length) throw new Error('token-batch-failed');
            results = result.results;
        } catch {
            // Counts are read-only. Returning to the exact original endpoint is safe.
            state.failures++;
            await Promise.all(batch.map(async item => {
                try {
                    if (item.aborted) return;
                    const response = await fetch(item.options.url, { method: 'POST', headers: item.headers, body: item.options.data });
                    const text = await response.text();
                    complete(item, response.status, response.statusText, { text }, 'Content-Type: application/json\r\n');
                } catch { complete(item, 0, 'error'); }
                finally { pending.delete(item); }
            }));
        }
        // Callback exceptions must never be interpreted as a failed tokenizer request.
        if (results) batch.forEach((item, i) => complete(item, 200, 'success', { text: JSON.stringify(results[i]) }, 'Content-Type: application/json\r\n'));
        report();
    }
    $[DISPATCHER].owner = owner; state.enabled = true; state.reason = 'active'; report();
    return { status, dispose() {
        if (stopped) return;
        stopped = true; state.enabled = false; state.reason = 'disposed';
        if ($[DISPATCHER].owner === owner) $[DISPATCHER].owner = null;
        // Already accepted requests still complete; later calls use native jQuery.
        if (queued.size && !timer) timer = setTimeout(flush, 0);
        report();
    } };
}
