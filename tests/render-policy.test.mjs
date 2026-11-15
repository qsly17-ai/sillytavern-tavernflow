import test from 'node:test';
import assert from 'node:assert/strict';
import { canDeferText, isSafeTextMarkup, hasMessageEditor, normalizeRenderOptions, installRender } from '../client/render.js';

const offscreenText = () => ({ eligible: true, near: false, tail: false, editing: false, focused: false,
    selected: false, height: 430.25, measuredVersion: 3, layoutVersion: 3 });

test('only measured offscreen non-tail plain text can be deferred', () => {
    assert.equal(canDeferText(offscreenText()), true);
    for (const [key, value] of Object.entries({ eligible: false, near: true, tail: true, editing: true,
        focused: true, selected: true, height: 0, measuredVersion: 2 })) {
        assert.equal(canDeferText({ ...offscreenText(), [key]: value }), false, key);
    }
    for (const height of [NaN, Infinity, -1, undefined]) {
        assert.equal(canDeferText({ ...offscreenText(), height }), false);
    }
});

test('embedded HTML, inline handlers, custom data hooks and unknown tags remain live', () => {
    const element = (tagName, names = []) => ({ tagName, attributes: names.map(name => ({ name })) });
    for (const tag of ['p', 'BR', 'EM', 'CODE', 'SPAN', 'FONT', 'TABLE', 'TD']) {
        assert.equal(isSafeTextMarkup(element(tag)), true, tag);
    }
    for (const tag of ['iframe', 'script', 'style', 'svg', 'canvas', 'input', 'button', 'details', 'a', 'mvu-panel', 'div']) {
        assert.equal(isSafeTextMarkup(element(tag)), false, tag);
    }
    for (const attr of ['onclick', 'style', 'id', 'data-mvu', 'contenteditable', 'tabindex', 'role']) {
        assert.equal(isSafeTextMarkup(element('SPAN', [attr])), false, attr);
    }
    assert.equal(isSafeTextMarkup(element('CODE', ['class', 'lang'])), true);
});

test('host deletion checkbox outside the body is not a message editor', () => {
    const checkbox = { tagName: 'INPUT', className: 'del_checkbox' };
    const message = { querySelector: selector => selector.split(',').includes('input') ? checkbox : null };
    const content = { querySelector: () => null };
    assert.equal(hasMessageEditor(message, content), false);
    assert.equal(hasMessageEditor(message, { querySelector: () => ({ tagName: 'INPUT' }) }), true);
    for (const marker of ['#curEditTextarea', '.edit_textarea', '.reasoning_edit_textarea']) {
        assert.equal(hasMessageEditor({ querySelector: selector => selector.split(',').includes(marker) ? {} : null }, content), true, marker);
    }
});

test('only the verified Immersive Reading paragraph mark is allowed', () => {
    const paragraph = (value = '1', tagName = 'P', classValue = 'stir-readable-block') => ({ tagName, attributes: [
        { name: 'class', value: classValue }, { name: 'data-stir-enhanced', value },
    ] });
    assert.equal(isSafeTextMarkup(paragraph()), true);
    assert.equal(isSafeTextMarkup(paragraph('1', 'P', 'stir-readable-block stir-readable-split-block')), true);
    assert.equal(isSafeTextMarkup(paragraph('2')), false);
    assert.equal(isSafeTextMarkup(paragraph('1', 'SPAN')), false);
    assert.equal(isSafeTextMarkup(paragraph('1', 'P', 'other-plugin')), false);
    const unknown = paragraph();
    unknown.attributes.push({ name: 'data-stir-unverified', value: '1' });
    assert.equal(isSafeTextMarkup(unknown), false);
    const otherPlugin = paragraph();
    otherPlugin.attributes.push({ name: 'data-mvu', value: '1' });
    assert.equal(isSafeTextMarkup(otherPlugin), false);
});

test('observer scope and live tail are bounded even for malformed saved options', () => {
    assert.deepEqual(normalizeRenderOptions(), { enabled: true, tail: 5, maxMessages: 1200, margin: 1200 });
    assert.deepEqual(normalizeRenderOptions({ enabled: false, tail: -20, maxMessages: 1e7, margin: 0 }),
        { enabled: false, tail: 3, maxMessages: 3000, margin: 600 });
    assert.equal(normalizeRenderOptions({ tail: 'invalid', maxMessages: Infinity }).tail, 5);
    assert.equal(normalizeRenderOptions({ maxMessages: Infinity }).maxMessages, 1200);
});

test('missing browser APIs fails open without DOM or timer access', () => {
    const instance = installRender();
    assert.equal(instance.status().enabled, false);
    assert.equal(instance.status().reason, 'browser-or-chat-unavailable');
    instance.dispose();
    instance.dispose();
    assert.equal(instance.status().reason, 'disposed');
});
