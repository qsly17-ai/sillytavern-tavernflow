// SPDX-License-Identifier: AGPL-3.0-only
import { canonical, hashValue, diffValues, chatFileName } from './lib/protocol.mjs';

const PATHS = {
    '/api/settings/save': 'settings', '/api/settings/get': 'settings',
    '/api/chats/save': 'chat', '/api/chats/get': 'chat',
    '/api/chats/group/save': 'group', '/api/chats/group/get': 'group',
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hashPattern = /^[a-f0-9]{64}$/;
const responseHeaders = (response) => [...response.headers].filter(([key]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(key));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A lower bound suffices to accept a small patch. String lengths never exceed
// their JSON representations, so escaping can only make this test conservative.
// Stop once sufficient room is proved; do not serialize the unchanged snapshot.
function patchFitsWithoutFull(value, patchLength, envelopeLength) {
    let minimum = envelopeLength;
    const fits = () => patchLength < minimum * 0.85;
    function visit(item) {
        if (fits()) return;
        if (typeof item === 'string') minimum += item.length + 2;
        else if (item === null) minimum += 4;
        else if (typeof item === 'boolean') minimum += item ? 4 : 5;
        else if (typeof item === 'number') minimum += String(item).length;
        else if (Array.isArray(item)) {
            minimum += 2 + Math.max(0, item.length - 1);
            for (const child of item) { visit(child); if (fits()) break; }
        } else {
            const keys = Object.keys(item);
            minimum += 2 + Math.max(0, keys.length - 1);
            for (const key of keys) {
                minimum += key.length + 3; // quotes and colon; escapes only add characters
                visit(item[key]);
                if (fits()) break;
            }
        }
    }
    visit(value);
    return fits();
}

// Exported for isolated protocol/transport tests; a browser worker starts it below.
export function createTransportRuntime({ fetch: requestFetch = globalThis.fetch.bind(globalThis), postMessage = (message) => globalThis.postMessage(message), networkTimeoutMs = 90000 } = {}) {
    let config;
    const preparations = new Map();
    const queues = new Map();
    const baselines = new Map();
    const integrityRejections = new Map();
    const controllers = new Map();
    function remember(key, baseline) {
        baselines.delete(key);
        if (baseline.blocked) baseline = { hash: baseline.hash, blocked: baseline.blocked };
        baselines.set(key, baseline);
        // Keep only six complete snapshots. Hash-only entries still detect stale saves.
        let retained = 0;
        for (const [resource, entry] of [...baselines].reverse()) {
            if (entry.value !== undefined && ++retained > 6) baselines.set(resource, { hash: entry.hash });
        }
        // The page retains only concurrency metadata, never a full snapshot.
        // A later worker must check this same base instead of fetching a newer
        // server state and accepting the page's older content as a fresh save.
        emit({ type: 'baseline', key, hash: baseline.hash, ...(baseline.blocked ? { blocked: baseline.blocked } : {}) });
    }
    const emit = (message) => postMessage(message);
    const throwIfAborted = (signal) => { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); };
    async function decodeBody(body, headers) {
        const encoding = (new Headers(headers).get('content-encoding') || '').toLowerCase().trim();
        if (encoding && encoding !== 'gzip') throw new TypeError('Unsupported request encoding');
        if (encoding === 'gzip') return new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
        // fetch converts a string body to a well-formed UTF-8 string. Keep that
        // behavior when the page transfers its original string without encoding it.
        return typeof body === 'string' ? (body.toWellFormed?.() ?? decoder.decode(encoder.encode(body))) : decoder.decode(body);
    }
    function identify(kind, payload) {
        if (!isObject(payload)) return;
        if (kind === 'settings') return {};
        if (kind === 'group' && (typeof payload.id === 'string' || typeof payload.id === 'number') && String(payload.id).length) return { id: String(payload.id) };
        if (kind === 'chat' && typeof payload.avatar_url === 'string' && payload.avatar_url && typeof payload.file_name === 'string' && payload.file_name) {
            return { avatar_url: payload.avatar_url, file_name: payload.file_name, ch_name: typeof payload.ch_name === 'string' ? payload.ch_name : '' };
        }
    }
    function resourceKey(kind, identity) {
        // Compare exactly the filenames native persistence uses, even if two
        // different request names sanitize to the same name on disk.
        const storage = kind === 'chat' ? [identity.avatar_url.replace('.png', ''), chatFileName(identity.file_name) ?? identity.file_name]
            : kind === 'group' ? [chatFileName(identity.id) ?? identity.id] : identity;
        return `${kind}:${canonical(storage)}`;
    }
    function enqueue(tails, key, operation) {
        const tail = (tails.get(key) ?? Promise.resolve()).then(operation);
        const settled = tail.catch(() => {});
        tails.set(key, settled);
        settled.then(() => { if (tails.get(key) === settled) tails.delete(key); });
        return tail;
    }
    async function encodeRequest(text, headers, allowCompression = true) {
        const outgoing = new Headers(headers);
        outgoing.delete('content-encoding');
        outgoing.delete('content-length');
        outgoing.set('content-type', 'application/json');
        const bytes = encoder.encode(text);
        if (allowCompression && config.gzip && typeof CompressionStream === 'function' && bytes.byteLength >= 32768) {
            const compressed = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
            if (compressed.byteLength < bytes.byteLength * 0.95) {
                outgoing.set('content-encoding', 'gzip');
                return { headers: outgoing, body: compressed, bytes: compressed.byteLength, uncompressedBytes: bytes.byteLength, compressed: true };
            }
        }
        return { headers: outgoing, body: bytes, bytes: bytes.byteLength, uncompressedBytes: bytes.byteLength, compressed: false };
    }
    async function requestJson(path, encoded, signal, credentials = 'same-origin') {
        throwIfAborted(signal);
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(new DOMException('Save response timed out', 'TimeoutError')), networkTimeoutMs);
        const aborted = new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        });
        try {
            return await Promise.race([aborted, (async () => {
                const response = await requestFetch(config.baseUrl + path, {
                    method: 'POST', headers: encoded.headers, body: encoded.body, signal: controller.signal, credentials, cache: 'no-store',
                });
                return { response, body: await response.text() };
            })()]);
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        }
    }
    async function loadBaseline(kind, identity, key, headers, signal, credentials) {
        const encoded = await encodeRequest(JSON.stringify({ kind, identity }), headers, false);
        const { response, body } = await requestJson('/state', encoded, signal, credentials);
        if (!response.ok) return { response, body };
        const data = JSON.parse(body);
        if (data.ok !== true || !hashPattern.test(data.hash || '') || (kind === 'settings' ? !isObject(data.value) : !Array.isArray(data.value))) throw new Error('Invalid state response');
        const hash = await hashValue(data.value);
        if (hash !== data.hash) throw new Error('State hash mismatch');
        const baseline = { value: data.value, hash };
        remember(key, baseline);
        return { baseline };
    }
    function relay(response, body, stats) {
        return { type: 'response', status: response.status, statusText: response.statusText, headers: responseHeaders(response), body, stats: { ...stats, status: response.status } };
    }
    function localConflict(kind, reason, stats) {
        return { type: 'response', status: 409, statusText: 'Conflict', headers: [['content-type', 'application/json']], body: JSON.stringify({ ok: false, error: 'conflict', reason, message: '保存基线已过期或上次结果未确认；请重新读取后再保存。' }), stats: { ...stats, kind, mode: 'blocked', status: 409 } };
    }
    async function save(message, prepared, signal) {
        const started = performance.now();
        const { kind, identity, key, value, text, force } = prepared;
        const originalBytes = encoder.encode(text).byteLength;
        const stats = { kind, originalBytes, sourceBytes: typeof message.body === 'string' ? originalBytes : message.body.byteLength, sentBytes: 0, stateFetched: false };
        let dispatched = false;
        let baseline;
        try {
            throwIfAborted(signal);
            baseline = baselines.get(key);
            if (baseline?.blocked) return localConflict(kind, baseline.blocked, { ...stats, ms: performance.now() - started });
            if (force && (!config.checkedIntegrityOverwrite || !baseline || baseline.hash !== integrityRejections.get(key))) {
                return localConflict(kind, 'integrity-confirmation-outdated', stats);
            }
            if (!baseline) {
                stats.stateFetched = true;
                const loaded = await loadBaseline(kind, identity, key, message.headers, signal, message.credentials);
                if (loaded.response) return relay(loaded.response, loaded.body, { ...stats, mode: 'state-failed', ms: performance.now() - started });
                baseline = loaded.baseline;
            }
            const nextHash = await hashValue(value);
            throwIfAborted(signal);
            const resource = { kind, identity, ...(force ? { force: true } : {}) };
            let payload;
            let textPayload;
            if (nextHash === baseline.hash) {
                payload = { ...resource, mode: 'noop', baseHash: baseline.hash, nextHash };
                textPayload = JSON.stringify(payload);
            } else {
                const full = { ...resource, mode: 'full', baseHash: baseline.hash, nextHash };
                if (baseline.value !== undefined) {
                    try {
                        const ops = diffValues(baseline.value, value);
                        if (ops.length && ops.length <= 2000) {
                            const patch = { ...resource, mode: 'patch', baseHash: baseline.hash, nextHash, ops };
                            const patchText = JSON.stringify(patch);
                            const overhead = JSON.stringify(full).length + ',"value":'.length;
                            if (patchFitsWithoutFull(value, patchText.length, overhead)) {
                                payload = patch;
                                textPayload = patchText;
                            } else {
                                // Near the cutoff, retain the exact original comparison.
                                const fullText = JSON.stringify({ ...full, value });
                                if (patchText.length < fullText.length * 0.85) { payload = patch; textPayload = patchText; }
                                else { payload = full; textPayload = fullText; }
                            }
                        }
                    } catch { /* Unsupported diff shapes can use a checked full payload. */ }
                }
                if (!payload) { payload = full; textPayload = JSON.stringify({ ...full, value }); }
            }
            const encoded = await encodeRequest(textPayload, message.headers);
            stats.mode = payload.mode;
            stats.sentBytes = encoded.bytes;
            stats.payloadBytes = encoded.uncompressedBytes;
            stats.compressed = encoded.compressed;
            stats.computeMs = performance.now() - started;
            throwIfAborted(signal);
            const networkStart = performance.now();
            dispatched = true;
            let { response, body } = await requestJson('/save', encoded, signal, message.credentials);
            stats.networkMs = performance.now() - networkStart;
            stats.ms = performance.now() - started;
            stats.status = response.status;
            if (response.ok) {
                let acknowledgement;
                try { acknowledgement = JSON.parse(body); } catch { /* handled as a protocol error below */ }
                if (acknowledgement?.ok !== true || acknowledgement.hash !== nextHash || acknowledgement.mode !== payload.mode) {
                    remember(key, { ...baseline, blocked: 'unconfirmed-acknowledgement' });
                    return { type: 'response', status: 502, statusText: 'Bad Gateway', headers: [['content-type', 'application/json']], body: JSON.stringify({ ok: false, error: 'unconfirmed-save', message: '服务器未返回可核验的保存确认；请重新读取后再保存。' }), stats: { ...stats, status: 502 } };
                }
                remember(key, { value, hash: nextHash });
                if (force) integrityRejections.delete(key);
                // Keep native fetch consumers' success contract; our checked
                // hash acknowledgement belongs only to the worker protocol.
                body = JSON.stringify(kind === 'settings' ? { result: 'ok' } : { ok: true });
            } else if (response.status === 409 || response.status >= 500) {
                // Retaining a blocked baseline prevents a later queued stale snapshot from becoming a full overwrite.
                remember(key, { ...baseline, blocked: response.status === 409 ? 'conflict' : 'unconfirmed-server-error' });
            } else if (kind !== 'settings' && response.status === 400) {
                try {
                    if (JSON.parse(body)?.error === 'integrity') integrityRejections.set(key, baseline.hash);
                } catch { /* A different refusal cannot authorize an overwrite. */ }
            }
            return relay(response, body, stats);
        } catch (error) {
            if (dispatched) remember(key, { ...baseline, blocked: signal.aborted ? 'unconfirmed-aborted-save' : 'unconfirmed-network-result' });
            throw error;
        }
    }
    function seedStatus(message, kind, accepted) {
        emit({ type: 'seed-status', kind, accepted, ...(accepted ? {} : { reason: 'invalid-baseline' }),
            adoptionKey: message.adoptionKey, adoptionId: message.adoptionId });
    }
    async function seed(message, { kind, key }) {
        try {
            const snapshot = message.snapshot;
            let value = kind === 'settings' ? JSON.parse(snapshot) : snapshot instanceof Blob ? JSON.parse(await snapshot.text()) : snapshot;
            // Native single-chat reads can also return {} for a new, empty
            // directory. The server still checks the actual file before saving.
            if (kind === 'chat' && isObject(value) && Object.keys(value).length === 0) value = [];
            if (kind === 'settings' ? !isObject(value) : !Array.isArray(value)) throw new Error('Invalid native baseline');
            remember(key, { value, hash: await hashValue(value) });
            seedStatus(message, kind, true);
        } catch {
            // An adopted snapshot that could not be retained must never be
            // replaced with a fresh server hash for the old page contents.
            remember(key, { hash: baselines.get(key)?.hash ?? '0'.repeat(64), blocked: 'missing-adopted-baseline' });
            seedStatus(message, kind, false);
        }
    }
    async function prepare(message) {
        const kind = PATHS[message.path];
        if (!kind) return;
        const text = message.type === 'save' ? await decodeBody(message.body, message.headers) : undefined;
        const payload = text === undefined ? message.identity : JSON.parse(text);
        const identity = identify(kind, payload);
        if (!identity) return;
        if (message.type === 'save' && kind !== 'settings') {
            // Unknown native envelope extensions remain the host's responsibility.
            const known = kind === 'chat' ? ['avatar_url', 'file_name', 'ch_name', 'chat', 'force'] : ['id', 'chat', 'force'];
            if (payload.force !== undefined && typeof payload.force !== 'boolean' ||
                Object.keys(payload).some((key) => !known.includes(key)) || !Array.isArray(payload.chat)) return;
        }
        return { kind, identity, key: resourceKey(kind, identity), value: kind === 'settings' ? payload : payload.chat, text, force: kind !== 'settings' && payload.force === true };
    }
    async function initialize(message) {
        try {
            const url = new URL(message.baseUrl);
            if (url.origin !== message.origin) throw new Error('Cross-origin backend');
            const response = await requestFetch(url.href.replace(/\/$/, '') + '/health', { headers: new Headers(message.headers), credentials: 'same-origin', cache: 'no-store' });
            const health = await response.json();
            if (!response.ok || health.ok !== true || health.protocol !== 1 || health.capabilities?.deltaSave !== true ||
                !['settings', 'chat', 'group'].every((kind) => health.capabilities?.kinds?.includes(kind))) throw new Error('Backend protocol unavailable');
            config = { baseUrl: url.href.replace(/\/$/, ''), gzip: health.requestGzip === true || health.capabilities?.requestGzip === true,
                checkedIntegrityOverwrite: health.capabilities?.checkedIntegrityOverwrite === true };
            if (Array.isArray(message.baselines)) for (const entry of message.baselines) {
                if (!Array.isArray(entry) || entry.length !== 2) continue;
                const [key, baseline] = entry;
                if (typeof key !== 'string' || !isObject(baseline) || !hashPattern.test(baseline.hash || '')) continue;
                remember(key, { hash: baseline.hash, ...(typeof baseline.blocked === 'string' ? { blocked: baseline.blocked } : {}) });
            }
            emit({ type: 'ready', capabilities: { worker: true, gzip: config.gzip } });
        } catch { emit({ type: 'unavailable', reason: 'backend-unavailable' }); }
    }
    function handleMessage(message) {
        if (message.type === 'init') return initialize(message);
        if (message.type === 'abort') { controllers.get(message.id)?.abort(); return Promise.resolve(); }
        if (message.type !== 'save' && message.type !== 'seed') return Promise.resolve();
        if (!config) { emit({ id: message.id, error: { name: 'Error', code: 'not-ready', message: '清酌保存后台尚未就绪。' } }); return Promise.resolve(); }
        const controller = message.type === 'save' ? new AbortController() : null;
        if (controller) controllers.set(message.id, controller);
        const kind = PATHS[message.path];
        const prepared = enqueue(preparations, kind, async () => {
            try { return await prepare(message); } catch { return undefined; }
        });
        return prepared.then(async (data) => {
            if (!data) {
                if (message.type === 'save') emit({ type: 'passthrough', id: message.id });
                else seedStatus(message, kind, false);
                return;
            }
            return enqueue(queues, data.key, async () => {
                if (message.type === 'seed') return seed(message, data);
                const result = await save(message, data, controller.signal);
                emit({ id: message.id, ...result });
            });
        }).catch((error) => {
            if (message.type === 'seed') seedStatus(message, kind, false);
            else emit({ id: message.id, kind, error: { name: error.name || 'Error', code: controller?.signal.aborted ? 'aborted' : error.name === 'TimeoutError' ? 'save-timeout' : 'request-failed', message: controller?.signal.aborted ? '保存请求已取消；若已发出，请重新读取后确认结果。' : '保存失败或结果未确认；请保留未保存的修改，再刷新重新读取。' } });
        }).finally(() => { if (controller) controllers.delete(message.id); });
    }
    return { handleMessage };
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
    const runtime = createTransportRuntime();
    globalThis.onmessage = ({ data }) => { void runtime.handleMessage(data); };
}
