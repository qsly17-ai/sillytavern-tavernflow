import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { canonical, hashValue, applyOps } from '../shared/protocol.mjs';
import { installFreshSettingsRoute } from './startup-settings.mjs';

export const info = {
    id: 'tavern-flow',
    name: '清酌 TavernFlow',
    description: 'Independent background delta saves and native-equivalent token batching for SillyTavern 1.19.',
};
const VERSION = '0.4.0';
const HASH = /^[a-f0-9]{64}$/;
const KINDS = new Set(['settings', 'chat', 'group']);
const REMOTE_TOKENIZERS = new Set(['qwen2', 'command-r', 'command-a', 'nemo', 'deepseek']);
class FlowError extends Error {
    constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const bad = code => { throw new FlowError(400, code); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const under = (parent, target) => target === parent || (path.relative(parent, target) !== '..' && !path.relative(parent, target).startsWith(`..${path.sep}`) && !path.isAbsolute(path.relative(parent, target)));

function fileComponent(value) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 240 ||
        /[\/\\\x00-\x1f<>:"|?*]/.test(value) || value === '.' || value === '..' || /[. ]$/.test(value)) bad('invalid_identity');
    return value;
}

async function noSymlinkEscape(root, target) {
    if (!under(root, target) || target === root) bad('invalid_path');
    // All directory values originate in request.user, never in the submitted body.
    // Reject symlinks below that root so a path cannot escape its authenticated user.
    const relative = path.relative(root, target).split(path.sep);
    let cursor = root;
    for (const component of relative) {
        cursor = path.join(cursor, component);
        try {
            if ((await fs.lstat(cursor)).isSymbolicLink()) bad('symlink_not_supported');
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
    }
}

async function resourceFor(request, body, validateUser) {
    const user = request.user;
    if (!user?.profile || typeof user.profile.handle !== 'string' || !user.profile.handle || !isObject(user.directories)) {
        throw new FlowError(401, 'authentication_required');
    }
    if (validateUser && !await validateUser(user)) throw new FlowError(403, 'invalid_user');
    if (!isObject(body) || !KINDS.has(body.kind) || !isObject(body.identity)) bad('invalid_resource');
    const { kind, identity } = body;
    const directories = user.directories;
    // Core preserves a relative dataRoot in getUserDirectories(). Resolve against
    // the same cwd as its persistence functions instead of rejecting valid hosts.
    if (typeof directories.root !== 'string' || !directories.root) bad('invalid_user_directory');
    const root = path.resolve(directories.root);
    let filePath, cardName;
    if (kind === 'settings') {
        if (Object.keys(identity).length) bad('invalid_identity');
        filePath = path.join(root, 'settings.json');
    } else if (kind === 'chat') {
        const avatar = fileComponent(identity.avatar_url);
        const fileName = fileComponent(identity.file_name);
        if (!avatar.endsWith('.png')) bad('invalid_identity');
        // The installed core uses replace('.png', ''), rather than path.parse().name.
        cardName = fileComponent(avatar.replace('.png', ''));
        if (typeof directories.chats !== 'string') bad('invalid_user_directory');
        filePath = path.resolve(directories.chats, cardName, `${fileName}.jsonl`);
    } else {
        const id = typeof identity.id === 'number' && Number.isSafeInteger(identity.id) ? String(identity.id) : identity.id;
        cardName = fileComponent(id);
        if (typeof directories.groupChats !== 'string') bad('invalid_user_directory');
        filePath = path.resolve(directories.groupChats, `${cardName}.jsonl`);
    }
    if (typeof directories.backups !== 'string' || !under(root, path.resolve(directories.backups))) bad('invalid_user_directory');
    await noSymlinkEscape(root, filePath);
    await noSymlinkEscape(root, path.resolve(directories.backups));
    return { kind, filePath, cardName, user, key: filePath };
}

function fingerprint(stat) {
    return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : 'missing';
}
async function fileStat(filePath) {
    try { return await fs.stat(filePath, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Injectable persistence keeps unit tests independent of any installed host. */
export function createHandlers({ persistence, validateUser, maxFileBytes = 128 * 1024 * 1024, maxCacheBytes = 64 * 1024 * 1024, maxResources = 32, getStartupStatus } = {}) {
    if (!persistence || typeof persistence.saveChat !== 'function' || typeof persistence.saveSettings !== 'function') {
        throw new TypeError('Native persistence adapters are required');
    }
    const locks = new Map();
    const cache = new Map();
    const tokenCache = new Map();
    let cachedBytes = 0;
    const counters = { states: 0, saves: 0, patches: 0, noops: 0, conflicts: 0, failures: 0, tokenBatches: 0, cacheHits: 0 };
    function forget(key) {
        const entry = cache.get(key);
        if (entry) cachedBytes -= entry.bytes;
        cache.delete(key);
    }
    function remember(key, entry) {
        forget(key);
        if (entry.bytes > maxCacheBytes) return;
        cache.set(key, entry);
        cachedBytes += entry.bytes;
        while (cache.size > maxResources || cachedBytes > maxCacheBytes) forget(cache.keys().next().value);
    }
    async function serial(key, operation) {
        const previous = locks.get(key) || Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        locks.set(key, next);
        try { return await next; }
        finally { if (locks.get(key) === next) locks.delete(key); }
    }
    async function read(resource) {
        const stat = await fileStat(resource.filePath);
        if (stat && (!stat.isFile() || stat.size > BigInt(maxFileBytes))) throw new FlowError(413, 'resource_too_large');
        const known = cache.get(resource.key);
        // A read racing another writer is retried once; corrupted JSON never becomes [].
        for (let attempt = 0; attempt < 2; attempt++) {
            const before = attempt === 0 ? stat : await fileStat(resource.filePath);
            let value, rawBytes = Buffer.alloc(0);
            if (!before) value = resource.kind === 'settings' ? {} : [];
            else {
                if (before.size > BigInt(maxFileBytes)) throw new FlowError(413, 'resource_too_large');
                try { rawBytes = await fs.readFile(resource.filePath); }
                catch (error) { if (error.code === 'ENOENT') continue; throw error; }
                if (rawBytes.byteLength > maxFileBytes) throw new FlowError(413, 'resource_too_large');
            }
            const after = await fileStat(resource.filePath);
            if (fingerprint(before) !== fingerprint(after)) continue;
            // Atomic native writes change the inode, but outside writers may edit
            // in place within one filesystem timestamp tick. Compare raw bytes by
            // SHA before reusing parsed data, including equal-length replacements.
            const rawHash = createHash('sha256').update(rawBytes).digest('hex');
            if (known?.signature === fingerprint(after) && known.rawHash === rawHash) {
                counters.cacheHits++;
                cache.delete(resource.key); cache.set(resource.key, known);
                return known;
            }
            if (before) {
                const raw = rawBytes.toString('utf8');
                try {
                    value = resource.kind === 'settings' ? JSON.parse(raw) : raw.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
                } catch { throw new FlowError(422, 'invalid_existing_json'); }
            }
            if ((resource.kind === 'settings' && !isObject(value)) || (resource.kind !== 'settings' && !Array.isArray(value))) {
                throw new FlowError(422, 'invalid_existing_shape');
            }
            const entry = { value, hash: await hashValue(value), signature: fingerprint(after), rawHash, bytes: rawBytes.byteLength };
            remember(resource.key, entry);
            return entry;
        }
        throw new FlowError(409, 'resource_changed_during_read');
    }
    function respondError(response, error) {
        counters.failures++;
        const status = error instanceof FlowError ? error.status : 500;
        return response.status(status).json({ ok: false, error: error instanceof FlowError ? error.code : 'persistence_failed' });
    }
    async function state(request, response) {
        try {
            const resource = await resourceFor(request, request.body, validateUser);
            const current = await serial(resource.key, () => read(resource));
            counters.states++;
            response.set?.('Cache-Control', 'no-store');
            return response.json({ ok: true, hash: current.hash, value: current.value });
        } catch (error) { return respondError(response, error); }
    }
    async function save(request, response) {
        const started = performance.now();
        try {
            const body = request.body;
            const resource = await resourceFor(request, body, validateUser);
            if (!['full', 'patch', 'noop'].includes(body.mode) || !HASH.test(body.baseHash) || !HASH.test(body.nextHash)) bad('invalid_save');
            const result = await serial(resource.key, async () => {
                const current = await read(resource);
                if (current.hash !== body.baseHash) {
                    counters.conflicts++;
                    return { status: 409, value: { ok: false, error: 'conflict', hash: current.hash } };
                }
                let next;
                try {
                    next = body.mode === 'noop' ? current.value : body.mode === 'patch' ? applyOps(current.value, body.ops) : body.value;
                    if (resource.kind === 'settings' ? !isObject(next) : !Array.isArray(next)) bad('invalid_value_shape');
                    const serialized = canonical(next);
                    if (Buffer.byteLength(serialized) > maxFileBytes) throw new FlowError(413, 'resource_too_large');
                    if (createHash('sha256').update(serialized).digest('hex') !== body.nextHash) bad('next_hash_mismatch');
                } catch (error) {
                    if (error instanceof FlowError) throw error;
                    bad('invalid_delta');
                }
                if (current.hash !== body.nextHash) {
                    // Check actual contents again after hashing: timestamps alone
                    // cannot detect every same-size in-place third-party write.
                    const changed = await read(resource);
                    if (changed.hash !== current.hash) {
                        counters.conflicts++;
                        return { status: 409, value: { ok: false, error: 'conflict', hash: changed.hash } };
                    }
                    try {
                        if (resource.kind === 'settings') await persistence.saveSettings(next, resource, request);
                        else await persistence.saveChat(next, resource, request);
                    } catch (error) {
                        forget(resource.key);
                        if (error?.constructor?.name === 'IntegrityMismatchError' || error?.code === 'integrity') {
                            throw new FlowError(409, 'integrity');
                        }
                        throw error;
                    }
                    forget(resource.key);
                    const persisted = await read(resource);
                    if (persisted.hash !== body.nextHash) throw new FlowError(409, 'verification_failed');
                    counters.saves++;
                    if (body.mode === 'patch') counters.patches++;
                } else counters.noops++;
                return { status: 200, value: { ok: true, hash: body.nextHash, mode: body.mode } };
            });
            response.set?.('Server-Timing', `tf-save;dur=${(performance.now() - started).toFixed(1)}`);
            response.set?.('Cache-Control', 'no-store');
            return response.status(result.status).json(result.value);
        } catch (error) { return respondError(response, error); }
    }
    async function tokens(request, response) {
        try {
            if (!request.user?.profile?.handle) throw new FlowError(401, 'authentication_required');
            if (validateUser && !await validateUser(request.user)) throw new FlowError(403, 'invalid_user');
            if (typeof persistence.countTokens !== 'function') throw new FlowError(503, 'token_batch_unavailable');
            const { requests } = request.body || {};
            if (!Array.isArray(requests) || requests.length < 1 || requests.length > 64 || requests.some(item =>
                !isObject(item) || typeof item.model !== 'string' || item.model.length > 256 || !Array.isArray(item.messages) ||
                item.messages.some(message => !isObject(message))) || Buffer.byteLength(canonical(requests)) > 4 * 1024 * 1024) bad('invalid_token_batch');
            const results = [];
            for (const item of requests) {
                const key = await hashValue(item);
                let result = tokenCache.get(key);
                if (result === undefined) {
                    result = await persistence.countTokens(item, request);
                    if (!isObject(result) || !Number.isSafeInteger(result.token_count) || result.token_count < 0) throw new FlowError(502, 'native_tokenizer_failed');
                    tokenCache.set(key, result);
                    if (tokenCache.size > 2048) tokenCache.delete(tokenCache.keys().next().value);
                } else { tokenCache.delete(key); tokenCache.set(key, result); }
                results.push(result);
            }
            counters.tokenBatches++;
            return response.json({ ok: true, results, nativeEquivalent: true });
        } catch (error) { return respondError(response, error); }
    }
    function health(_request, response) {
        response.set?.('Cache-Control', 'no-store');
        return response.json({
            ok: true, version: VERSION, protocol: 1, startup: getStartupStatus?.(), hostVersion: persistence.hostVersion || 'injected',
            capabilities: { deltaSave: true, kinds: [...KINDS], nativePersistence: true, requestGzip: persistence.requestGzip === true,
                tokenBatch: typeof persistence.countTokens === 'function', nativeEquivalentTokens: true,
                tokenEndpoint: '/openai/count', excludedTokenizers: [...REMOTE_TOKENIZERS] },
            limits: { maxFileBytes, tokenBatch: 64, tokenTextBytes: 4 * 1024 * 1024 },
            coverage: { pluginRequestsSerialized: true, nativeAndThirdPartyWritesSerialized: false },
        });
    }
    return { state, save, health, tokens, stats: () => ({ ...counters, cachedResources: cache.size, cachedBytes, activeResources: locks.size }),
        dispose() { cache.clear(); tokenCache.clear(); cachedBytes = 0; } };
}

function routeHandler(router, routePath) {
    const route = router?.stack?.find(layer => layer.route?.path === routePath && layer.route.methods?.post)?.route;
    const handlers = route?.stack?.map(layer => layer.handle);
    if (!handlers || handlers.length !== 1 || typeof handlers[0] !== 'function') throw new Error('Unsupported native route shape');
    return handlers[0];
}

async function invokeNative(handler, request, body, query = {}) {
    let status = 200, sent = false, payload;
    const response = {
        status(value) { status = value; return this; },
        send(value) { sent = true; payload = value; return this; },
        json(value) { return this.send(value); },
        sendStatus(value) { status = value; return this.send(undefined); },
    };
    await handler({ ...request, body, query }, response);
    if (!sent || status < 200 || status >= 300) throw new Error('Native handler rejected request');
    return payload;
}

/** Resolve the actual host from cwd; no guessed localhost port or internal HTTP request. */
export async function loadNativePersistence(hostRoot = process.cwd()) {
    const hostPath = path.resolve(hostRoot);
    const packageInfo = JSON.parse(await fs.readFile(path.join(hostPath, 'package.json'), 'utf8'));
    if (packageInfo.name !== 'sillytavern' || packageInfo.version !== '1.19.0') throw new Error('TavernFlow 0.2 requires verified SillyTavern 1.19.0');
    const hostImport = file => import(pathToFileURL(path.join(hostPath, file)).href);
    const [chats, settings, users] = await Promise.all([
        hostImport('src/endpoints/chats.js'), hostImport('src/endpoints/settings.js'), hostImport('src/users.js'),
    ]);
    if (typeof chats.trySaveChat !== 'function' || typeof users.getUserDirectories !== 'function') throw new Error('Native persistence API unavailable');
    const saveSettings = routeHandler(settings.router, '/save');
    let tokenizers;
    return {
        hostVersion: packageInfo.version,
        requestGzip: true,
        validateUser(user) {
            if (typeof user?.profile?.handle !== 'string') return false;
            const expected = users.getUserDirectories(user.profile.handle);
            return ['root', 'chats', 'groupChats', 'backups'].every(key => typeof user.directories?.[key] === 'string' &&
                path.resolve(user.directories[key]) === path.resolve(expected[key]));
        },
        async saveChat(value, resource) {
            await chats.trySaveChat(value, resource.filePath, false, resource.user.profile.handle, resource.cardName, resource.user.directories.backups);
        },
        async saveSettings(value, resource, request) {
            const result = await invokeNative(saveSettings, { ...request, user: resource.user }, value);
            // 1.19.0 settings/save sends Error with HTTP 200 on failure; never translate it to success.
            if (result?.result !== 'ok') throw new Error('Native settings persistence failed');
        },
        async countTokens({ model, messages }, request) {
            tokenizers ||= hostImport('src/endpoints/tokenizers.js');
            const module = await tokenizers;
            if (REMOTE_TOKENIZERS.has(module.getTokenizerModel(model))) throw new FlowError(503, 'remote_tokenizer_not_batched');
            return invokeNative(routeHandler(module.router, '/openai/count'), request, messages, { model });
        },
    };
}

let activeHandlers, startup;
export async function init(router) {
    const persistence = await loadNativePersistence();
    startup = await installFreshSettingsRoute({ enabled: true });
    activeHandlers = createHandlers({ persistence, validateUser: persistence.validateUser, getStartupStatus: () => startup.status() });
    router.get('/health', activeHandlers.health);
    router.post('/state', activeHandlers.state);
    router.post('/save', activeHandlers.save);
    router.post('/tokens', activeHandlers.tokens);
    console.info('[TavernFlow] native persistence adapter ready (SillyTavern 1.19.0)');
}
export async function exit() { startup?.dispose(); activeHandlers?.dispose(); }
