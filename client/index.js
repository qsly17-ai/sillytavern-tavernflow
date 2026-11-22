// SPDX-License-Identifier: AGPL-3.0-only
import { installTransport } from './transport.js';
import { installRender } from './render.js';
import { installUIOptimizations } from './ui-optimizations.js';
import { installTokens } from './tokens.js';
import { installHelperGeneration } from './helper-generation.mjs';
import { installFastPaths } from './fast-paths.js';
import { mountPanel } from './panel.js';
import { installInteractions } from './interactions.js';
import { retireLegacyWorker } from './migration.js';
import { installStartupPreload } from './startup.mjs';
import { installSourceGuard } from './source-guard.js';
// Pinned to the installed 1.19.0 loader. Only its public manifest inventory and
// version are read; business modules still execute in the native order.
import { extensionNames, getExtensionManifest, modules as availableModules } from '../../../extensions.js';
import { CLIENT_VERSION } from '../../../../script.js';

const ID = 'tavern-flow';
const defaults = { enabled: true, transport: true, render: true, sourceGuard: true, startupPreload: false, helperGeneration: true, tokens: true, fastPaths: true, interactions: true, lightweightDrag: false, quickDrawers: true, disableSpellcheck: false };
let alive = false, waiting, panel, modules = {}, health = null, generation = 0;
const early = {};
let blockers = [], settings = {}, readyContext;
let transitions = Promise.resolve();
let shutdown = Promise.resolve(), lifecycle = 0;
let legacyWorker = null;
let priming = Promise.resolve();
let requiresReload = false;
const migration = retireLegacyWorker().then(result => { legacyWorker = result; update(); });
const getContext = () => globalThis.SillyTavern?.getContext?.();
const inactive = reason => ({ status: () => ({ enabled: false, reason }), dispose() {} });
const loaded = name => [...document.querySelectorAll('script[src]')].some(script => script.src.includes(`/extensions/third-party/${name}/`));
const overlaps = ['cocktail', 'cocktail-plus', 'ST-BaiBai-Tools', 'st-linear-parser'];
function earlyBlocked(context) {
    const disabled = context.extensionSettings?.disabledExtensions ?? [];
    return overlaps.some(name => loaded(name) || (extensionNames.includes(`third-party/${name}`) && !disabled.includes(`third-party/${name}`)));
}
function reconcileEarly({ initial = false } = {}) {
    const context = getContext();
    const options = { ...defaults, ...context?.extensionSettings?.[ID] };
    const enabled = alive && options.enabled && !earlyBlocked(context);
    globalThis.__tavernFlowBoot?.setEnabled(enabled);
    if (!enabled || !options.sourceGuard) { early.sourceGuard?.dispose(); delete early.sourceGuard; }
    else if (!early.sourceGuard) {
        // The native loader's getter deep-clones a manifest. Its version is
        // fixed for this page; only retry while early discovery is incomplete.
        let helperVersion;
        early.sourceGuard = installSourceGuard({ getContext,
            getVersions: () => ({ client: CLIENT_VERSION.split(':')[1],
                helper: helperVersion ??= getExtensionManifest('third-party/JS-Slash-Runner')?.version }), onStats: update });
    }
    if (!enabled || !options.startupPreload) { early.preload?.dispose(); delete early.preload; }
    else if (initial && !early.preload) early.preload = installStartupPreload({ context, extensionNames,
        getManifest: getExtensionManifest, availableModules, clientVersion: CLIENT_VERSION.split(':')[1], onStats: update });
}
export function getStatus() {
    requiresReload ||= modules.transport?.status().requiresReload === true;
    return { version: '0.5.0', enabled: alive && settings.enabled, backend: health, blockers: blockers.slice(),
        modules: Object.fromEntries(Object.entries({ sourceGuard: inactive('disabled'),
            preload: inactive(alive && settings.enabled && settings.startupPreload ? 'next-start' : 'disabled'),
            loading: globalThis.__tavernFlowBoot || inactive('bootstrap-not-installed'), ...early, ...modules }).map(([name, module]) => [name, module.status()])),
        requiresReload, legacyWorker, options: { ...settings } };
}
function update() { panel?.update(getStatus()); }
async function stopModules({ keepTransport = false } = {}) {
    const old = modules;
    requiresReload ||= old.transport?.status().requiresReload === true;
    modules = keepTransport && old.transport ? { transport: old.transport } : {};
    await Promise.all(Object.entries(old).filter(([name]) => !keepTransport || name !== 'transport').map(([, module]) => module.dispose()));
}
function startModules() {
    const epoch = ++generation;
    transitions = transitions.catch(() => {}).then(() => startModulesNow(epoch));
    return transitions;
}
async function startModulesNow(epoch) {
    if (epoch !== generation) return;
    // Display preferences must not discard the saving session's known hashes or
    // restart its Worker. Explicit transport/page shutdown still drains it.
    await stopModules({ keepTransport: alive && settings.enabled && settings.transport });
    if (!alive || epoch !== generation || !settings.enabled) { update(); return; }
    const context = getContext();
    blockers = overlaps.filter(loaded);
    // Overlapping fetch/prototype owners must be removed by a fresh page load.
    // This panel never disables another extension or edits its settings.
    const overlap = blockers.length > 0;
    modules.render = overlap ? inactive('overlapping-optimizer') : installRender({ context, onStats: update });
    modules.ui = installUIOptimizations({ context, options: { disableSpellcheck: settings.disableSpellcheck, quickDrawers: settings.quickDrawers && !overlap }, onStats: update });
    if (!settings.render) { modules.render.dispose(); modules.render = inactive('disabled'); }
    await priming;
    if (!alive || epoch !== generation) return;
    const nextHealth = health || await readBackendHealth(context);
    if (!alive || epoch !== generation) return;
    health = nextHealth;
    const backend = health?.ok === true;
    if (settings.transport && backend && !overlap) {
        const transportState = modules.transport?.status();
        if (!transportState?.enabled && transportState?.reason !== 'starting') {
            await modules.transport?.dispose();
            modules.transport = installTransport({ context, onStats: update });
        }
    } else {
        await modules.transport?.dispose();
        modules.transport = inactive(overlap ? 'overlapping-optimizer' : !settings.transport ? 'disabled' : 'backend-unavailable');
    }
    modules.tokens = settings.tokens && backend && !overlap && health?.capabilities?.tokenBatch
        ? installTokens({ context, onStats: update })
        : inactive(overlap ? 'overlapping-optimizer' : !settings.tokens ? 'disabled' : 'backend-unavailable');
    const fastPaths = settings.fastPaths && !loaded('st-linear-parser')
        ? await installFastPaths({ context, onStats: update, getBoxVersion: () => getExtensionManifest('third-party/LittleWhiteBox')?.version }) : inactive('disabled-or-existing-compat-patch');
    if (!alive || epoch !== generation) { fastPaths.dispose(); return; }
    modules.fastPaths = fastPaths;
    const helper = settings.helperGeneration && health?.helperGeneration?.active && !overlap
        ? await installHelperGeneration({ context })
        : inactive(overlap ? 'overlapping-optimizer' : !settings.helperGeneration ? 'disabled' : 'helper-build-unverified');
    if (!alive || epoch !== generation) { helper.dispose(); return; }
    modules.helperGeneration = helper;
    const interactions = (settings.interactions || settings.lightweightDrag) && !overlap
        ? await installInteractions({ context, options: { promptToggle: settings.interactions, lightweightDrag: settings.lightweightDrag }, onStats: update })
        : inactive(overlap ? 'overlapping-optimizer' : 'disabled');
    if (!alive || epoch !== generation) { interactions.dispose(); return; }
    modules.interactions = interactions;
    update();
}
async function readBackendHealth(context) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
        const response = await fetch('/api/plugins/tavern-flow/health', { cache: 'no-store', headers: context.getRequestHeaders(), signal: controller.signal });
        return response.ok ? await response.json() : null;
    } catch { return null; }
    finally { clearTimeout(timer); }
}
async function primeTransport(token) {
    const context = getContext();
    const options = { ...defaults, ...context?.extensionSettings?.[ID] };
    if (!options.enabled || !options.transport || earlyBlocked(context)) return;
    const candidate = await readBackendHealth(context);
    if (!alive || token !== lifecycle || !candidate?.ok) return;
    const current = { ...defaults, ...getContext()?.extensionSettings?.[ID] };
    if (!current.enabled || !current.transport || earlyBlocked(getContext())) return;
    health = candidate;
    modules.transport = installTransport({ context, onStats: update });
}
function start() {
    if (!alive || panel) return;
    const context = getContext();
    context.extensionSettings[ID] ??= {};
    settings = Object.assign(context.extensionSettings[ID], { ...defaults, ...context.extensionSettings[ID] });
    panel = mountPanel({ onChange: async (key, value) => {
        if (!Object.hasOwn(defaults, key)) return;
        settings[key] = value;
        reconcileEarly();
        // These are normal host settings; no independent copy of private settings.
        context.saveSettingsDebounced();
        await startModules();
    } });
    void startModules();
}
export async function enable() {
    if (alive) return;
    alive = true; const token = ++lifecycle;
    await shutdown;
    if (!alive || token !== lifecycle) return;
    readyContext = getContext();
    if (!readyContext?.eventSource || !readyContext.eventTypes?.APP_READY) { alive = false; return; }
    globalThis.addEventListener?.('tavernflow:loading', update);
    reconcileEarly({ initial: true });
    // Business extensions save settings during startup. Prime the same saving
    // session here, rather than uploading full snapshots until APP_READY.
    priming = primeTransport(token).catch(() => {});
    waiting = start;
    // ST 1.19 remembers APP_READY and immediately fires for late subscribers.
    readyContext.eventSource.on(readyContext.eventTypes.APP_READY, waiting);
}
export async function disable() {
    if (!alive) return shutdown;
    alive = false; generation++; lifecycle++;
    globalThis.removeEventListener?.('tavernflow:loading', update);
    globalThis.__tavernFlowBoot?.setEnabled(false);
    for (const module of Object.values(early)) module.dispose();
    for (const key of Object.keys(early)) delete early[key];
    if (waiting) readyContext?.eventSource?.removeListener(readyContext.eventTypes.APP_READY, waiting);
    waiting = null;
    shutdown = shutdown.then(async () => {
        await priming;
        await transitions.catch(() => {});
        await stopModules();
        panel?.dispose(); panel = null;
    });
    return shutdown;
}
void enable();
