import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionModuleUrl, planStartupPreloads, installStartupPreload } from '../client/startup.mjs';

const origin = 'https://example.test';
const ownName = 'third-party/tavern-flow';
function fixture() {
    const manifests = {
        prior: { display_name: 'Prior', loading_order: -200, js: 'old.js' },
        [ownName]: { display_name: 'Flow', loading_order: -100, js: 'index.js' },
        a: { display_name: 'A', loading_order: 1, js: 'index.js?ver=1.2.0' },
        b: { display_name: 'B', loading_order: 2, js: 'dist/entry.mjs' },
        c: { display_name: 'C', loading_order: 3, js: 'index.js' },
        d: { display_name: 'D', loading_order: 4, js: 'index.js' },
    };
    const handlers = new Map(), events = new Map(), nodes = [];
    const context = { extensionSettings: { disabledExtensions: [] }, eventTypes: { APP_READY: 'ready', CHAT_CHANGED: 'chat' }, eventSource: {
        on(type, fn) { events.set(type, fn); },
        removeListener(type, fn) { if (events.get(type) === fn) events.delete(type); },
    } };
    const document = { scripts: [], visibilityState: 'visible', head: { appendChild(node) { nodes.push(node); } },
        createElement(tag) { assert.equal(tag, 'link'); return { relList: { supports: rel => rel === 'modulepreload' }, dataset: {}, remove() { this.removed = true; } }; },
        addEventListener(type, fn) { handlers.set(type, fn); },
        removeEventListener(type, fn) { if (handlers.get(type) === fn) handlers.delete(type); },
    };
    const options = { context, document, navigator: {}, location: { origin }, clientVersion: '1.19.0',
        extensionNames: Object.keys(manifests), getManifest: name => manifests[name] };
    const nativeLoad = name => handlers.get('load')?.({ target: { tagName: 'SCRIPT', src: extensionModuleUrl(name, manifests[name].js, origin) } });
    return { options, manifests, context, document, handlers, events, nodes, nativeLoad };
}

test('URLs preserve native version query and reject foreign, escaping or encoded paths', () => {
    assert.equal(extensionModuleUrl('third-party/Plugin', 'dist/index.js?ver=1.2.0', origin), origin + '/scripts/extensions/third-party/Plugin/dist/index.js?ver=1.2.0');
    assert.equal(extensionModuleUrl('插件', 'index.mjs', origin), origin + '/scripts/extensions/%E6%8F%92%E4%BB%B6/index.mjs');
    for (const asset of ['https://evil.test/x.js', '//evil.test/x.js', '/outside.js', '../x.js', 'dist/../../x.js', 'dist/%2e%2e/x.js', 'dist\\x.js', 'index.js#fragment', 'index.css', 'index.js\n']) {
        assert.equal(extensionModuleUrl('third-party/p', asset, origin), null, asset);
    }
    for (const name of ['../p', 'third-party/../p', 'third-party/p/q', 'p%2fq', 'p?x', 'p\\q']) {
        assert.equal(extensionModuleUrl(name, 'index.js', origin), null, name);
    }
});

test('plan follows native order and skips disabled, incompatible and unmet dependencies', () => {
    const f = fixture();
    f.manifests.b.dependencies = ['a'];
    f.manifests.c.requires = ['extras'];
    f.manifests.d.minimum_client_version = '1.20.0';
    assert.deepEqual(planStartupPreloads({ ...f.options, origin, disabled: ['a'] }).map(x => x.name), []);
    assert.deepEqual(planStartupPreloads({ ...f.options, origin, availableModules: ['extras'] }).map(x => x.name), ['a', 'b', 'c']);
    assert.deepEqual(planStartupPreloads({ ...f.options, origin, clientVersion: '1.20.0' }), []);
    assert.deepEqual(planStartupPreloads({ ...f.options, origin, disabled: [ownName] }), []);
});

test('lookahead advances only on native entry load and keeps normal module URLs', () => {
    const f = fixture();
    const module = installStartupPreload(f.options);
    assert.equal(f.nodes.length, 2);
    for (const link of f.nodes) { assert.equal(link.rel, 'modulepreload'); assert.equal(link.fetchPriority, 'low'); }
    f.nodes[0].onload();
    f.nodes[1].onload();
    assert.equal(f.nodes.length, 2, 'hint completion never queues the entire extension list');
    f.handlers.get('load')({ target: { tagName: 'IFRAME', src: f.nodes[0].href } });
    assert.equal(f.nodes.length, 2);
    f.nativeLoad('a');
    assert.equal(f.nodes.length, 3);
    assert.equal(f.nodes[0].removed, true);
    f.nativeLoad('b');
    assert.equal(f.nodes.length, 4);
    f.nativeLoad('c');
    f.nativeLoad('d');
    assert.equal(module.status().reason, 'native-entries-complete');
    assert.equal(module.status().scheduled, 4);
    assert.equal(f.handlers.size, 0);
    assert.equal(f.events.size, 0);
    assert.ok(f.nodes.every(node => node.removed));
});

test('current disabled state is checked again before each hint and dispose owns only its nodes', () => {
    const f = fixture();
    const foreign = { removed: false, remove() { this.removed = true; } };
    f.nodes.push(foreign);
    const module = installStartupPreload(f.options);
    f.context.extensionSettings.disabledExtensions.push('c');
    f.nativeLoad('a');
    assert.equal(module.status().scheduled, 2);
    f.nativeLoad('b');
    assert.equal(module.status().scheduled, 3);
    module.dispose();
    assert.equal(foreign.removed, false);
    assert.equal(f.handlers.size, 0);
    assert.equal(f.events.size, 0);
});

test('ready replay, chat switch and background stop hints without reloading or fetching', () => {
    const late = fixture();
    late.context.eventSource.on = (_type, callback) => callback();
    assert.equal(installStartupPreload(late.options).status().reason, 'app-ready');
    assert.equal(late.nodes.length, 0);
    assert.equal(late.handlers.size, 0);
    for (const event of ['ready', 'chat']) {
        const f = fixture(); const module = installStartupPreload(f.options);
        f.events.get(event)();
        assert.equal(module.status().enabled, false);
        assert.ok(f.nodes.every(node => node.removed));
        assert.equal(f.events.size, 0);
    }
    const f = fixture(); const module = installStartupPreload(f.options);
    f.document.visibilityState = 'hidden'; f.handlers.get('visibilitychange')();
    assert.equal(module.status().reason, 'background-page');
});

test('connection saving, disabled or unverified hosts emit no hints', () => {
    for (const override of [{ enabled: false }, { clientVersion: '1.20.0' }, { navigator: { connection: { saveData: true } } }, { navigator: { connection: { effectiveType: '2g' } } }]) {
        const f = fixture(); const module = installStartupPreload({ ...f.options, ...override });
        assert.equal(module.status().scheduled, 0); assert.equal(f.nodes.length, 0); assert.equal(f.handlers.size, 0);
    }
    const f = fixture(); f.document.createElement = () => ({ relList: { supports: () => false } });
    assert.equal(installStartupPreload(f.options).status().reason, 'capability-unavailable');
});
