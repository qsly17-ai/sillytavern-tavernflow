import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

// Authority: SillyTavern 1.19.0, commit 7e8663cd9, src/endpoints/settings.js.
// Both the source (including its private readers) and the installed handler must
// match. A same-version local patch therefore keeps its original implementation.
export const VERIFIED_SETTINGS_VERSION = '1.19.0';
export const VERIFIED_SETTINGS_SOURCE_SHA256 = 'bbc3d36ad758b1fc567f63f1e24eada063172791005c5b3baadc195b78726955';
export const VERIFIED_SETTINGS_HANDLER_SHA256 = '665f2560978a2b4ff69e19a43cbbc37b29fea6c3386c70288daf792f8db30b94';
const sha256 = value => createHash('sha256').update(value).digest('hex');

function createIoLimit(limit, counters) {
    const queue = [];
    let active = 0;
    const drain = () => {
        while (active < limit && queue.length) {
            const { operation, resolve, reject } = queue.shift();
            active++;
            counters.ioActive = active;
            counters.ioPeak = Math.max(counters.ioPeak, active);
            Promise.resolve().then(operation).then(resolve, reject).finally(() => {
                active--;
                counters.ioActive = active;
                drain();
            });
        }
    };
    return operation => new Promise((resolve, reject) => {
        queue.push({ operation, resolve, reject });
        drain();
    });
}

/**
 * Fresh, response-equivalent reads; there is no cross-request response cache.
 * getRuntimeConfig returns the native response's static configuration fields.
 * A shared I/O limit also bounds parallel reads across simultaneous requests.
 */
export function createFreshSettingsReader({ io = fs, getRuntimeConfig, concurrency = 8 } = {}) {
    if (typeof getRuntimeConfig !== 'function') throw new TypeError('Native settings configuration is required');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new RangeError('I/O concurrency must be between 1 and 8');
    const config = structuredClone(getRuntimeConfig());
    const counters = { requests: 0, failures: 0, fileReads: 0, invalidFilesSkipped: 0, ioActive: 0, ioPeak: 0, ioLimit: concurrency, totalMs: 0, maxMs: 0 };
    const limited = createIoLimit(concurrency, counters);
    const readdir = directory => limited(() => io.readdir(directory));
    const readFile = file => limited(async () => {
        counters.fileReads++;
        // Decode once, as readFileSync(..., 'utf8') does. Promise readFile's
        // incremental UTF-8 string assembly is costly for multi-megabyte presets.
        return (await io.readFile(file)).toString('utf8');
    });
    async function readPresets(directory) {
        const names = (await readdir(directory)).sort((a, b) => a.localeCompare(b))
            .filter(name => path.parse(name).ext === '.json');
        const items = await Promise.all(names.map(async name => {
            try {
                const raw = await readFile(path.join(directory, name));
                JSON.parse(raw); // Native validates JSON but sends its original string.
                return { name: name.replace(/\.[^/.]+$/, ''), raw };
            } catch {
                counters.invalidFilesSkipped++;
                return null;
            }
        }));
        return items.filter(Boolean);
    }
    async function readParsed(directory) {
        const names = (await readdir(directory)).filter(name => path.parse(name).ext === '.json').sort();
        const items = await Promise.all(names.map(async name => {
            try { return { value: JSON.parse(await readFile(path.join(directory, name))) }; }
            catch { counters.invalidFilesSkipped++; return null; }
        }));
        // JSON null/false/0 are valid native values and must not be filtered out.
        return items.filter(Boolean).map(item => item.value);
    }
    async function read(request) {
        const started = performance.now();
        counters.requests++;
        try {
            const directories = request.user.directories;
            let settings;
            try { settings = await readFile(path.join(directories.root, 'settings.json')); }
            catch (cause) { throw new Error('Settings file could not be read', { cause }); }
            const [novelai, openai, textgen, kobold, worldFiles, themes, movingUIPresets, quickReplyPresets, instruct, context, sysprompt, reasoning] = await Promise.all([
                readPresets(directories.novelAI_Settings),
                readPresets(directories.openAI_Settings),
                readPresets(directories.textGen_Settings),
                readPresets(directories.koboldAI_Settings),
                readdir(directories.worlds),
                readParsed(directories.themes),
                readParsed(directories.movingUI),
                readParsed(directories.quickreplies),
                readParsed(directories.instruct),
                readParsed(directories.context),
                readParsed(directories.sysprompt),
                readParsed(directories.reasoning),
            ]);
            const world_names = worldFiles.filter(name => path.extname(name).toLowerCase() === '.json')
                .sort((a, b) => a.localeCompare(b)).map(name => path.parse(name).name);
            return {
                settings,
                koboldai_settings: kobold.map(item => item.raw),
                koboldai_setting_names: kobold.map(item => item.name),
                world_names,
                novelai_settings: novelai.map(item => item.raw),
                novelai_setting_names: novelai.map(item => item.name),
                openai_settings: openai.map(item => item.raw),
                openai_setting_names: openai.map(item => item.name),
                textgenerationwebui_presets: textgen.map(item => item.raw),
                textgenerationwebui_preset_names: textgen.map(item => item.name),
                themes, movingUIPresets, quickReplyPresets, instruct, context, sysprompt, reasoning,
                ...structuredClone(config),
            };
        } catch (error) {
            counters.failures++;
            throw error;
        } finally {
            const elapsed = performance.now() - started;
            counters.totalMs += elapsed;
            counters.maxMs = Math.max(counters.maxMs, elapsed);
        }
    }
    return { read, stats: () => ({ ...counters }) };
}

function nativeRuntimeConfig(getConfigValue, parseBytes) {
    return {
        enable_extensions: !!getConfigValue('extensions.enabled', true, 'boolean'),
        enable_extensions_auto_update: !!getConfigValue('extensions.autoUpdate', true, 'boolean'),
        enable_accounts: !!getConfigValue('enableUserAccounts', false, 'boolean'),
        request_compression: {
            enabled: !!getConfigValue('performance.requestCompression.enabled', false, 'boolean'),
            minPayloadSize: parseBytes(getConfigValue('performance.requestCompression.minPayloadSize', '256kb')) || 0,
            maxPayloadSize: parseBytes(getConfigValue('performance.requestCompression.maxPayloadSize', '8mb')) || 0,
            timeout: Number(getConfigValue('performance.requestCompression.timeout', 3000, 'number')) || 0,
        },
    };
}

/**
 * Replaces only the verified native /get callback in memory, before the first
 * browser request. Express 4's private router stack is deliberately version-bound.
 * No source file, startup event, extension ordering, or response cache is changed.
 */
export async function installFreshSettingsRoute({ hostRoot = process.cwd(), enabled = false, settingsRouter, reader } = {}) {
    let active = false;
    let reason = 'disabled';
    let layer, original, replacement;
    const status = () => ({ active: active && layer?.handle === replacement, reason: active && layer?.handle !== replacement ? 'ownership_lost' : reason, version: VERIFIED_SETTINGS_VERSION, reader: reader?.stats?.() });
    const dispose = () => {
        if (active && layer?.handle === replacement) layer.handle = original;
        active = false;
        reason = 'disposed';
    };
    const result = { status, dispose };
    if (!enabled) return result;
    try {
        const root = path.resolve(hostRoot);
        const [packageSource, settingsSource] = await Promise.all([
            fs.readFile(path.join(root, 'package.json'), 'utf8'),
            fs.readFile(path.join(root, 'src/endpoints/settings.js'), 'utf8'),
        ]);
        const packageInfo = JSON.parse(packageSource);
        if (packageInfo.name !== 'sillytavern' || packageInfo.version !== VERIFIED_SETTINGS_VERSION) {
            reason = 'unverified_host_version';
            return result;
        }
        if (sha256(settingsSource) !== VERIFIED_SETTINGS_SOURCE_SHA256) {
            reason = 'unverified_settings_source';
            return result;
        }
        if (!settingsRouter) settingsRouter = (await import(pathToFileURL(path.join(root, 'src/endpoints/settings.js')).href)).router;
        const routes = settingsRouter?.stack?.filter(item => item.route?.path === '/get');
        if (routes?.length !== 1 || routes[0].route.methods?.post !== true ||
            Object.keys(routes[0].route.methods).length !== 1 || routes[0].route.stack?.length !== 1 ||
            routes[0].route.stack[0].method !== 'post') {
            reason = 'unverified_route_shape';
            return result;
        }
        layer = routes[0].route.stack[0];
        original = layer.handle;
        if (typeof original !== 'function' || sha256(Function.prototype.toString.call(original)) !== VERIFIED_SETTINGS_HANDLER_SHA256) {
            reason = 'unverified_settings_handler';
            return result;
        }
        if (!reader) {
            const { getConfigValue } = await import(pathToFileURL(path.join(root, 'src/util.js')).href);
            const bytes = createRequire(path.join(root, 'package.json'))('bytes');
            reader = createFreshSettingsReader({ getRuntimeConfig: () => nativeRuntimeConfig(getConfigValue, bytes.parse) });
        }
        if (typeof reader.read !== 'function') throw new TypeError('Fresh settings reader is required');
        replacement = function tavernFlowFreshSettings(request, response, next) {
            // Return the promise for direct tests; Express 4 receives all failures
            // through next(), rather than an unhandled async handler rejection.
            return reader.read(request).then(value => response.send(value), error => {
                if (error.message === 'Settings file could not be read') return response.sendStatus(500);
                return next(error);
            });
        };
        // Imports above can yield: do not overwrite another plugin's later patch.
        if (layer.handle !== original) {
            reason = 'ownership_lost';
            return result;
        }
        layer.handle = replacement;
        active = true;
        reason = 'active';
    } catch {
        reason = 'adapter_unavailable';
    }
    return result;
}
