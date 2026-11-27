import test from 'node:test';
import assert from 'node:assert/strict';
import { installRender } from '../client/render.js';

test('disconnected old-chat queue cannot stall current-chat classification', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const tasks = new Map();
    const mutations = [];
    let nextTask = 0;
    let clock = 0;
    const noOp = () => {};
    class PassiveObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    }
    const chat = { children: [], lastElementChild: null, querySelector: () => null,
        addEventListener: noOp, removeEventListener: noOp };
    const message = () => ({ nodeType: 1, parentElement: chat, previousElementSibling: null,
        classList: { contains: name => name === 'mes' }, querySelector: () => null, matches: () => false });
    const setChildren = children => {
        chat.children = children;
        chat.lastElementChild = children.at(-1) ?? null;
        children.forEach((node, i) => { node.parentElement = chat; node.previousElementSibling = children[i - 1] ?? null; });
    };
    const view = {
        CSS: { supports: () => true }, IntersectionObserver: PassiveObserver, ResizeObserver: PassiveObserver,
        MutationObserver: class extends PassiveObserver { constructor(callback) { super(); mutations.push(callback); } },
        requestIdleCallback(callback) { const id = ++nextTask; tasks.set(id, callback); return id; },
        cancelIdleCallback(id) { tasks.delete(id); }, cancelAnimationFrame: noOp,
        performance: { now: () => ++clock },
    };
    const document = { defaultView: view, getElementById: () => chat, addEventListener: noOp, removeEventListener: noOp };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
    const runNext = () => {
        const [id, task] = tasks.entries().next().value;
        tasks.delete(id);
        task({ timeRemaining: () => 10 });
    };
    let instance;
    try {
        const oldMessages = Array.from({ length: 80 }, message);
        setChildren(oldMessages);
        instance = installRender();
        assert.equal(instance.status().pending, 75, 'the newest five floors stay outside the queue');
        // Model the subtle ordering: a chunk runs after DOM replacement but
        // before the removal mutation is delivered. Its next node is stale.
        for (const node of oldMessages) node.parentElement = null;
        const newMessages = Array.from({ length: 7 }, message);
        setChildren(newMessages);
        runNext();
        assert.ok(tasks.size > 0, 'a stale first pending node still schedules another chunk');
        mutations[0]([{ target: chat, type: 'childList', removedNodes: oldMessages, addedNodes: newMessages }]);
        assert.equal(instance.status().pending, 2, 'removal purges old nodes; only new historical floors are queued');
        let turns = 0;
        while (tasks.size && turns++ < 30) runNext();
        assert.ok(turns < 30, 'queue drains without polling');
        assert.equal(instance.status().pending, 0);
        assert.equal(instance.status().tracked, 2);
        instance.dispose();
        assert.equal(tasks.size, 0);
    } finally {
        instance?.dispose();
        if (previous) Object.defineProperty(globalThis, 'document', previous);
        else delete globalThis.document;
    }
});
