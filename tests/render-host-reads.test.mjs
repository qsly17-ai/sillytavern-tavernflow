import test from 'node:test';
import assert from 'node:assert/strict';
import { installRender } from '../client/render.js';

function harness({ embedded = false } = {}) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const tasks = new Map(), events = new Map(), hostEvents = new Map();
    let nextTask = 0, selectionReads = 0, styleReads = 0;
    let lastReport;
    let selectedContent = null, focusedContent = null;
    let signature = 'initial';
    const observers = {};
    const noOp = () => {};
    const observer = name => class {
        constructor(callback) { observers[name] = callback; }
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    const chat = { children: [], querySelector: () => null, addEventListener: noOp, removeEventListener: noOp };
    const messages = Array.from({ length: 8 }, () => {
        const values = new Map();
        const message = { nodeType: 1, parentElement: chat,
            classList: { contains: name => name === 'mes' }, matches: () => false };
        const content = { nodeType: 1, parentElement: message,
            classList: { contains: name => name === 'mes_text' }, closest: () => message,
            querySelector: () => null, querySelectorAll: () => [{ tagName: 'P', attributes: [] }],
            contains: element => focusedContent === content && element === document.activeElement,
            style: {
                getPropertyValue: name => values.get(name) ?? '', getPropertyPriority: () => '',
                setProperty: (name, value) => values.set(name, value), removeProperty: name => values.delete(name),
            },
        };
        message.querySelector = selector => selector === '.mes_text' ? content
            : embedded && selector.startsWith('iframe,') ? {} : null;
        message.content = content;
        return message;
    });
    chat.children = messages;
    chat.lastElementChild = messages.at(-1);
    messages.forEach((message, index) => { message.previousElementSibling = messages[index - 1] ?? null; });
    const view = {
        CSS: { supports: () => true }, IntersectionObserver: observer('intersection'),
        ResizeObserver: observer('sizes'), MutationObserver: observer('mutations'),
        requestIdleCallback(callback) { const id = ++nextTask; tasks.set(id, callback); return id; },
        cancelIdleCallback: id => tasks.delete(id), cancelAnimationFrame: noOp,
        performance: { now: () => 0 },
        getSelection() {
            selectionReads++;
            return { isCollapsed: !selectedContent, anchorNode: selectedContent, focusNode: selectedContent,
                containsNode: content => selectedContent === content };
        },
        getComputedStyle(sample) {
            styleReads++;
            assert.equal(sample, messages[0].content, 'font sample comes from classified plain text');
            return { font: signature, lineHeight: '20px', letterSpacing: '0px', paddingTop: '5px', paddingBottom: '5px' };
        },
    };
    const document = { defaultView: view, activeElement: {}, getElementById: () => chat,
        addEventListener: (name, callback) => events.set(name, callback),
        removeEventListener: name => events.delete(name) };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
    const instance = installRender({ context: { event_types: { SETTINGS_UPDATED: 'settings' }, eventSource: {
        on: (name, callback) => hostEvents.set(name, callback), removeListener: name => hostEvents.delete(name),
    } }, onStats: status => { lastReport = status; } });
    return {
        instance, messages, observers, events, hostEvents,
        lastReport: () => lastReport,
        reads: () => ({ selection: selectionReads, style: styleReads }),
        select: content => { selectedContent = content; },
        focus: content => { focusedContent = content; },
        font: value => { signature = value; },
        measure: (index, height = 200) => observers.sizes([{ target: messages[index].content, contentRect: { height } }]),
        near: (index, isIntersecting) => observers.intersection([{ target: messages[index].content, isIntersecting }]),
        replaceChildren(indices) {
            const next = indices.map(index => messages[index]);
            const addedNodes = next.filter(message => !chat.children.includes(message));
            const removedNodes = chat.children.filter(message => !next.includes(message));
            for (const message of removedNodes) message.parentElement = null;
            next.forEach((message, index) => {
                message.parentElement = chat;
                message.previousElementSibling = next[index - 1] ?? null;
            });
            chat.children = next;
            chat.lastElementChild = next.at(-1) ?? null;
            observers.mutations([{ target: chat, type: 'childList', addedNodes, removedNodes }]);
        },
        drain() {
            let turns = 0;
            while (tasks.size && turns++ < 30) {
                const [id, callback] = tasks.entries().next().value;
                tasks.delete(id);
                callback({ timeRemaining: () => 50 });
            }
            assert.ok(turns < 30, 'classification queue drains');
        },
        close() {
            instance.dispose();
            if (previous) Object.defineProperty(globalThis, 'document', previous);
            else delete globalThis.document;
        },
    };
}

test('embedded-only chat never reads selection or computed typography', () => {
    const h = harness({ embedded: true });
    try {
        h.drain();
        assert.equal(h.instance.status().eligible, 0);
        h.events.get('selectionchange')();
        h.hostEvents.get('settings')();
        assert.deepEqual(h.reads(), { selection: 0, style: 0 });
    } finally { h.close(); }
});

test('deleting newer floors immediately reveals a former historical floor without idle work', () => {
    const h = harness();
    try {
        h.drain(); h.measure(0); h.near(0, false); h.drain();
        const content = h.messages[0].content;
        assert.equal(content.style.getPropertyValue('content-visibility'), 'auto');
        assert.equal(h.lastReport().deferred, 1);
        h.replaceChildren([0, 1, 2, 3, 7]);
        assert.equal(content.style.getPropertyValue('content-visibility'), '');
        assert.equal(h.instance.status().pending, 0);
        assert.equal(h.lastReport().deferred, 0, 'report the reveal even when no classification is queued');
        h.replaceChildren([0, 1, 2, 3, 4, 5, 6, 7]);
        h.drain(); h.near(0, false); h.drain();
        assert.equal(content.style.getPropertyValue('content-visibility'), '', 'geometry from before the transition is stale');
        h.measure(0); h.drain();
        assert.equal(content.style.getPropertyValue('content-visibility'), 'auto');
    } finally { h.close(); }
});

test('selection reads wait for measured offscreen text outside the live tail', () => {
    const h = harness();
    try {
        h.drain();
        h.events.get('selectionchange')();
        h.near(0, false); // Still unmeasured.
        h.measure(1); // Still near the viewport.
        h.measure(7); h.near(7, false); // Last message remains live.
        h.measure(2, 0); h.near(2, false); // No usable measurement.
        h.drain();
        assert.equal(h.reads().selection, 0);
        h.measure(0);
        h.select(h.messages[0].content);
        h.drain();
        assert.equal(h.reads().selection, 1);
        assert.equal(h.instance.status().deferred, 0, 'selected candidate stays live');
        h.select(null); h.measure(0); h.drain();
        assert.equal(h.instance.status().deferred, 1);
    } finally { h.close(); }
});

test('selection reveals deferred text synchronously and prevents deferring it again', () => {
    const h = harness();
    try {
        h.drain(); h.measure(0); h.near(0, false); h.drain();
        const content = h.messages[0].content;
        assert.equal(content.style.getPropertyValue('content-visibility'), 'auto');
        h.select(content);
        h.events.get('selectionchange')();
        assert.equal(h.instance.status().deferred, 0, 'selection restores before another queued frame');
        assert.equal(content.style.getPropertyValue('content-visibility'), '');
        h.drain();
        assert.equal(h.instance.status().deferred, 0, 'active selection still blocks candidate');
        const reads = h.reads().selection;
        h.select(null); h.events.get('selectionchange')();
        assert.equal(h.reads().selection, reads, 'with all text live, selection listener is inert');
        h.measure(0); h.drain();
        assert.equal(h.instance.status().deferred, 1, 'later candidate checks the fresh collapsed selection');
    } finally { h.close(); }
});

test('first safe font check and later changes reveal text until it is remeasured', () => {
    const h = harness();
    try {
        h.drain(); h.measure(0); h.near(0, false); h.drain();
        assert.equal(h.instance.status().deferred, 1);
        h.hostEvents.get('settings')();
        assert.equal(h.instance.status().deferred, 0);
        h.drain();
        assert.equal(h.instance.status().deferred, 0, 'first font event invalidates earlier size despite absent initial sample');
        h.measure(0); h.drain();
        assert.equal(h.instance.status().deferred, 1);
        h.hostEvents.get('settings')();
        assert.equal(h.instance.status().deferred, 1, 'same typography retains current measurement');
        h.font('changed'); h.hostEvents.get('settings')(); h.drain();
        assert.equal(h.instance.status().deferred, 0, 'changed font restores old intrinsic size');
        h.measure(0); h.drain();
        assert.equal(h.instance.status().deferred, 1, 'fresh measurement permits deferring again');
    } finally { h.close(); }
});
