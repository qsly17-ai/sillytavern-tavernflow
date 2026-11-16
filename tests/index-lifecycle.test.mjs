import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../client/index.js', import.meta.url), 'utf8');
// Run the actual lifecycle coordinator. Its browser imports are replaced by
// controlled owners; individual transport/renderer behavior has separate tests.
const coordinator = source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\n;globalThis.lifecycle = { getStatus, enable, disable };';
assert.doesNotMatch(coordinator, /^(?:import|export) /m);
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function untilAbort(promise, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}
function fixture({ settings = {}, plans = [], starting = false, scripts = [], extensionNames = [] } = {}) {
    const timers = new Map(), listeners = new Map(), sessions = [], owners = [], panels = [], healthReads = [];
    const health = { ok: true, capabilities: { tokenBatch: true } };
    const bootChanges = [];
    let nextTimer = 0, ready = false, savedSettings = 0;
    const context = {
        extensionSettings: { disabledExtensions: [], 'tavern-flow': { ...settings } },
        eventTypes: { APP_READY: 'ready', CHAT_CHANGED: 'chat' },
        eventSource: {
            on(type, callback) {
                if (!listeners.has(type)) listeners.set(type, new Set());
                listeners.get(type).add(callback);
                if (type === 'ready' && ready) callback(); // 1.19 replays APP_READY.
            },
            removeListener(type, callback) { listeners.get(type)?.delete(callback); },
        },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        saveSettingsDebounced() { savedSettings++; },
    };
    function owner(kind) {
        const instance = { kind, disposed: false, disposeCalls: 0,
            status: () => ({ enabled: !instance.disposed, reason: instance.disposed ? 'disposed' : 'active' }),
            dispose() { instance.disposeCalls++; instance.disposed = true; },
        };
        owners.push(instance);
        return instance;
    }
    const nativeFetch = async (input, init) => {
        const path = new URL(input, 'https://fixture.test/').pathname;
        if (path !== '/api/plugins/tavern-flow/health') return new Response('{"native":true}');
        const plan = plans.shift();
        const entry = { signal: init.signal, phase: 'headers' };
        healthReads.push(entry);
        if (plan === 'stall-headers') return untilAbort(new Promise(() => {}), init.signal);
        if (plan?.promise) await untilAbort(plan.promise, init.signal);
        entry.phase = 'body';
        return { ok: true, json: () => plan === 'stall-body'
            ? untilAbort(new Promise(() => {}), init.signal) : Promise.resolve(health) };
    };
    const host = {
        AbortController, Headers, Response,
        document: { querySelectorAll: () => scripts },
        SillyTavern: { getContext: () => context },
        CLIENT_VERSION: 'SillyTavern:1.19.0:fixture', extensionNames, availableModules: [],
        getExtensionManifest: () => ({ version: '4.12.1' }),
        fetch: nativeFetch,
        setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
        __tavernFlowBoot: { status: () => ({ enabled: bootChanges.at(-1) }), setEnabled: value => bootChanges.push(value) },
        retireLegacyWorker: async () => ({ retired: 0 }),
        installSourceGuard: () => owner('sourceGuard'),
        installStartupPreload: () => owner('preload'),
        installRender: () => owner('render'),
        installUIOptimizations: () => owner('ui'),
        installTokens: () => owner('tokens'),
        installFastPaths: async () => owner('fastPaths'),
        installInteractions: async () => owner('interactions'),
        mountPanel(options) {
            const panel = { ...options, disposed: false, updates: [], update(value) { this.updates.push(value); }, dispose() { this.disposed = true; } };
            panels.push(panel);
            return panel;
        },
        installTransport() {
            const previous = host.fetch;
            const session = { id: sessions.length + 1, enabled: !starting, disposed: false, disposeCalls: 0, saves: [], drain: null,
                status: () => ({ session: session.id, enabled: session.enabled && !session.disposed,
                    reason: session.disposed ? 'disposed' : session.enabled ? 'active' : 'starting' }),
                async dispose() {
                    session.disposeCalls++; session.disposed = true;
                    if (session.drain) await session.drain.promise;
                    if (host.fetch === wrapped) host.fetch = previous;
                },
            };
            function wrapped(input, init) {
                if (input === '/api/settings/save' && !session.disposed) {
                    session.saves.push(init.body);
                    return Promise.resolve(new Response(JSON.stringify({ session: session.id })));
                }
                return previous.call(this, input, init);
            }
            sessions.push(session); host.fetch = wrapped;
            return session;
        },
    };
    vm.runInNewContext(coordinator, host, { filename: 'client/index.js' });
    return {
        host, api: host.lifecycle, context, sessions, owners, panels, healthReads, timers, bootChanges, nativeFetch,
        savedSettings: () => savedSettings,
        async appReady() {
            ready = true;
            for (const callback of [...(listeners.get('ready') ?? [])]) await callback();
            await settle();
        },
        change: (key, value) => panels.at(-1).onChange(key, value),
        readyListeners: () => listeners.get('ready')?.size ?? 0,
        expireHealth() {
            for (const [id, timer] of [...timers]) if (timer.ms === 6000) { timers.delete(id); timer.callback(); }
        },
        async close() {
            const stopping = host.lifecycle.disable();
            for (const session of sessions) session.drain?.resolve();
            for (let i = 0; i < 3; i++) { this.expireHealth(); await settle(); }
            await stopping;
        },
    };
}
function noLeaks(h) {
    assert.equal(h.readyListeners(), 0, 'APP_READY subscription is removed');
    assert.equal(h.timers.size, 0, 'health deadline timers are cleared');
    assert.equal(h.host.fetch, h.nativeFetch, 'the transport returns fetch ownership');
    assert.ok(h.sessions.every(session => session.disposed && session.disposeCalls === 1), 'every saving session is disposed exactly once');
    assert.ok(h.owners.every(instance => instance.disposed), 'front-end owners are cleaned up');
    assert.ok(h.panels.every(panel => panel.disposed), 'panels are cleaned up');
}

test('startup saves and APP_READY share one transport session across display preference changes', async t => {
    const h = fixture(); t.after(() => h.close());
    await settle();
    assert.equal(h.panels.length, 0, 'priming does not wait for or mount the APP_READY panel');
    assert.equal(h.sessions.length, 1);
    await h.host.fetch('/api/settings/save', { body: 'startup snapshot' });
    await h.api.enable(); await h.appReady(); await h.appReady();
    await h.change('quickDrawers', false); await h.change('quickDrawers', true);
    await h.host.fetch('/api/settings/save', { body: 'ready snapshot' });
    assert.equal(h.sessions.length, 1, 'APP_READY and UI toggles do not discard saving lineage');
    assert.deepEqual(h.sessions[0].saves, ['startup snapshot', 'ready snapshot']);
    assert.equal(h.healthReads.length, 1, 'a successful early health result is reused');
    assert.equal(h.panels.length, 1); assert.equal(h.readyListeners(), 1);
    await h.api.disable(); noLeaks(h);
});

test('APP_READY arriving during prime health retains a worker that is still starting', async t => {
    const gate = deferred(), h = fixture({ plans: [gate], starting: true }); t.after(() => h.close());
    await settle(); await h.appReady();
    assert.equal(h.sessions.length, 0);
    gate.resolve(); await settle();
    assert.equal(h.sessions.length, 1, 'a starting early session is not replaced at APP_READY');
    assert.equal(h.sessions[0].disposeCalls, 0);
    assert.equal(h.api.getStatus().modules.transport.reason, 'starting');
    h.sessions[0].enabled = true;
    await h.change('render', false);
    assert.equal(h.sessions.length, 1);
    assert.equal(h.api.getStatus().modules.transport.session, 1);
    await h.api.disable(); noLeaks(h);
});

test('disable before APP_READY rejects late prime ownership and a new lifecycle primes once', async t => {
    const gate = deferred(), h = fixture({ plans: [gate] }); t.after(() => h.close());
    await settle();
    const stopping = h.api.disable();
    assert.equal(h.readyListeners(), 0);
    gate.resolve(); await stopping; await settle();
    assert.equal(h.sessions.length, 0, 'late successful health cannot install after disable');
    noLeaks(h);
    await h.api.enable(); await settle();
    assert.equal(h.sessions.length, 1); assert.equal(h.readyListeners(), 1);
    await h.appReady(); assert.equal(h.sessions.length, 1);
    await h.api.disable(); noLeaks(h);
});

for (const phase of ['headers', 'body']) test(`disabling during stalled early health ${phase} waits only for its existing deadline`, async t => {
    const h = fixture({ plans: [`stall-${phase}`] }); t.after(() => h.close());
    await settle(); await h.appReady();
    assert.equal(h.healthReads.length, 1); assert.equal(h.healthReads[0].phase, phase);
    let stopped = false;
    const stopping = h.api.disable().then(() => { stopped = true; });
    await settle(); assert.equal(stopped, false, 'existing read remains owned until its deadline');
    h.expireHealth(); await settle();
    assert.equal(h.healthReads.length, 1, 'a disabled APP_READY continuation must not start another health query');
    assert.equal(stopped, true);
    await stopping; assert.equal(h.sessions.length, 0); noLeaks(h);
});

for (const key of ['enabled', 'transport']) test(`turning ${key} off while early health is pending prevents a stale install`, async t => {
    const gate = deferred(), h = fixture({ plans: [gate] }); t.after(() => h.close());
    await settle(); await h.appReady();
    const changing = h.change(key, false);
    gate.resolve(); await changing; await settle();
    assert.equal(h.sessions.length, 0, 'priming rechecks current user options after health resolves');
    await h.change(key, true); await settle();
    assert.equal(h.sessions.length, 1);
    await h.change('quickDrawers', false);
    assert.equal(h.sessions.length, 1, 'unrelated toggles retain the current session');
    await h.change(key, false); assert.equal(h.sessions[0].disposeCalls, 1);
    await h.api.disable(); noLeaks(h);
});

test('an optimizer appearing while prime health is pending prevents early transport takeover', async t => {
    const gate = deferred(), scripts = [], h = fixture({ plans: [gate], scripts }); t.after(() => h.close());
    await settle();
    scripts.push({ src: 'https://fixture.test/scripts/extensions/third-party/cocktail/index.js' });
    gate.resolve(); await settle();
    assert.equal(h.sessions.length, 0);
    await h.appReady(); assert.equal(h.sessions.length, 0);
    assert.equal(h.api.getStatus().modules.transport.reason, 'overlapping-optimizer');
    await h.api.disable(); noLeaks(h);
});

test('disable and re-enable wait for the old transport drain before installing another session', async t => {
    const h = fixture(); t.after(() => h.close());
    await settle(); await h.appReady();
    const old = h.sessions[0]; old.drain = deferred();
    const stopping = h.api.disable(); await settle();
    assert.equal(old.disposeCalls, 1);
    const enabling = h.api.enable(); await settle();
    assert.equal(h.sessions.length, 1, 're-enable cannot overtake an unfinished shutdown');
    old.drain.resolve(); await stopping; await enabling; await settle();
    assert.equal(h.sessions.length, 2); assert.equal(h.readyListeners(), 1);
    assert.equal(h.sessions.filter(session => !session.disposed).length, 1);
    assert.equal((await (await h.host.fetch('/api/settings/save', { body: 'new lifecycle' })).json()).session, 2);
    await h.api.disable(); noLeaks(h);
});
