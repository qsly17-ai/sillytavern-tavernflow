import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptManagerFixture } from './fixtures/prompt-manager-1.19.0.mjs';
import { installInteractionFeatures, promptToggleCapability, hasActiveSortEditor,
    createLightweightSortHelper } from '../client/interactions.js';
const VERSION = 'SillyTavern:1.19.0:Cohee#1207';
const classList = () => {
    const classes = new Set();
    return { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); } };
};
function environment() {
    const listeners = new Map();
    const document = { activeElement: null,
        addEventListener(type, fn, capture) { listeners.set(`${type}:${!!capture}`, fn); },
        removeEventListener(type, fn, capture) { if (listeners.get(`${type}:${!!capture}`) === fn) listeners.delete(`${type}:${!!capture}`); },
        getElementById() { return null; }, defaultView: { getComputedStyle: () => ({ fontFamily: 'sans-serif', fontSize: '16px' }) },
        createElement: tag => ({ tagName: tag, className: '', style: {}, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }),
    };
    const row = { isConnected: true, parentElement: { id: 'completion_prompt_manager_list' },
        dataset: { pmIdentifier: 'main' }, classList: classList(),
        contains: () => false, querySelector: () => null, offsetWidth: 400, offsetHeight: 80, tagName: 'LI' };
    const icon = { classList: classList(), closest: () => row };
    const target = { closest: selector => selector === '.prompt-manager-toggle-action' ? icon : row };
    const event = { target };
    return { document, listeners, row, icon, event };
}

test('prompt gate accepts the pinned authority and rejects changed or wrapped handlers', () => {
    const manager = new PromptManagerFixture();
    assert.equal(promptToggleCapability(manager), true);
    const native = manager.handleToggle;
    manager.handleToggle = event => native(event);
    assert.equal(promptToggleCapability(manager), false);
    manager.handleToggle = native;
    manager.configuration.prefix = 'custom_';
    assert.equal(promptToggleCapability(manager), false);
    assert.equal(promptToggleCapability(null), false);
});

test('visual feedback follows native state immediately and preserves every native render/save', () => {
    const env = environment(), manager = new PromptManagerFixture();
    const instance = installInteractionFeatures({ document: env.document, clientVersion: VERSION,
        getPromptManager: () => manager, options: { lightweightDrag: false } });
    assert.equal(instance.status().promptToggle, true);
    for (let i = 0; i < 4; i++) {
        manager.handleToggle(env.event);
        env.listeners.get('click:false')(env.event);
        const disabled = !manager.entries[0].enabled;
        assert.equal(env.row.classList.contains('completion_prompt_manager_prompt_disabled'), disabled);
        assert.equal(env.icon.classList.contains('fa-toggle-off'), disabled);
        assert.equal(env.icon.classList.contains('fa-toggle-on'), !disabled);
        assert.equal(manager.saveCalls, i + 1);
        assert.equal(manager.renderCalls, i + 1);
        assert.equal(manager.counts.main, null);
    }
    assert.equal(instance.status().promptSyncs, 4);
    const before = JSON.stringify(manager.entries);
    env.row.dataset.pmIdentifier = 'missing';
    env.listeners.get('click:false')(env.event);
    assert.equal(instance.status().promptSyncs, 4);
    assert.equal(JSON.stringify(manager.entries), before);
    instance.dispose(); instance.dispose();
    assert.equal(env.listeners.size, 0);
    assert.equal(instance.status().promptToggle, false);
    assert.equal(manager.saveCalls, 4);
});

test('capability or version mismatch leaves host state and event path alone', () => {
    const env = environment(), manager = new PromptManagerFixture();
    const mismatch = installInteractionFeatures({ document: env.document, clientVersion: 'SillyTavern:1.20.0:Cohee#1207',
        getPromptManager: () => manager });
    assert.equal(env.listeners.size, 0);
    assert.equal(mismatch.status().enabled, false);
    mismatch.dispose();
    const instance = installInteractionFeatures({ document: env.document, clientVersion: VERSION, getPromptManager: () => manager });
    manager.isPromptDisabledForActiveCharacter = () => true;
    env.listeners.get('click:false')(env.event);
    assert.equal(instance.status().promptSyncs, 0);
    assert.equal(manager.entries[0].enabled, true);
    instance.dispose();
});

test('lightweight helper is plain text with fixed geometry, without business nodes', () => {
    const env = environment();
    env.row.querySelector = () => ({ textContent: '<img onerror="bad()">' });
    const helper = createLightweightSortHelper(env.row, env.document);
    assert.equal(helper.textContent, '☰ <img onerror="bad()">');
    assert.equal(helper.style.width, '400px');
    assert.equal(helper.style.height, '80px');
    assert.equal(helper.attributes['aria-hidden'], 'true');
    assert.equal(helper.id, undefined);
    env.row.offsetHeight = 0;
    assert.equal(createLightweightSortHelper(env.row, env.document), null);
});

test('iframe, explicit editors and the focused editing control keep the original drag node', () => {
    const env = environment();
    assert.equal(hasActiveSortEditor(env.row, env.document), false);
    env.row.querySelector = () => ({ tagName: 'IFRAME' });
    assert.equal(hasActiveSortEditor(env.row, env.document), true);
    env.row.querySelector = () => null;
    env.document.activeElement = { matches: () => true };
    env.row.contains = () => true;
    assert.equal(hasActiveSortEditor(env.row, env.document), true);
});

test('sortable keeps callbacks and custom helpers, restores only its own helper', () => {
    const env = environment();
    const nativeStop = () => {}, nativeUpdate = () => {};
    let widget = { options: { helper: 'original', stop: nativeStop, update: nativeUpdate },
        option(key, value) { this.options[key] = value; } };
    const element = { id: 'world_popup_entries_list', isConnected: true };
    env.document.getElementById = id => id === element.id ? element : null;
    const jquery = () => ({ sortable: () => widget });
    jquery.fn = { jquery: '3.5.1', sortable() {} };
    jquery.ui = { sortable: { prototype: { version: '1.13.2' } } };
    const instance = installInteractionFeatures({ document: env.document, jQuery: jquery, clientVersion: VERSION });
    const ownedHelper = widget.options.helper;
    assert.equal(typeof ownedHelper, 'function');
    assert.equal(widget.options.stop, nativeStop);
    assert.equal(widget.options.update, nativeUpdate);
    const item = [env.row];
    assert.notEqual(ownedHelper(null, item), item);
    env.row.querySelector = () => ({ tagName: 'IFRAME' });
    assert.equal(ownedHelper(null, item), item);
    const laterHelper = () => 'later';
    widget.options.helper = laterHelper;
    instance.dispose();
    assert.equal(widget.options.helper, laterHelper);
    assert.equal(ownedHelper(null, item), item);
    widget.options.helper = 'original';
    const second = installInteractionFeatures({ document: env.document, jQuery: jquery, clientVersion: VERSION });
    element.isConnected = false;
    assert.equal(second.status().managedLists, 0);
    assert.equal(widget.options.helper, 'original');
    element.isConnected = true;
    second.dispose();
    assert.equal(widget.options.helper, 'original');
    widget.options.helper = laterHelper;
    const third = installInteractionFeatures({ document: env.document, jQuery: jquery, clientVersion: VERSION });
    assert.equal(widget.options.helper, laterHelper);
    assert.equal(third.status().customHelpersSkipped, 1);
    third.dispose();
});
