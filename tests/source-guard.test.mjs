import test from 'node:test';
import assert from 'node:assert/strict';
import { findFrontendSourceStarts, installSourceGuard } from '../client/source-guard.js';

const SOURCE = `&lt;body&gt;${'source &amp; text\n'.repeat(2400)}&lt;/body&gt;`;
const BLOCK = `<pre><code class="html language-html">${SOURCE}</code></pre>`;
const MARKER = 'data-tf-source-guard';

function fixture({ empty = false } = {}) {
    const timers = new Map(), hooks = [], observers = [], pres = [], scripts = [], styles = [];
    const faults = { insert: false, delete: false, context: false, supports: false };
    let serial = 0, timerSerial = 0, editor = false;
    let versions = { client: '1.19.0', helper: '4.12.1' };
    const formatter = { stage: { AFTER_MARKDOWN: 'afterMarkdown' }, order: { LATEST: 100 },
        addHook(fn, options) { hooks.push(fn); assert.equal(options.stage, 'afterMarkdown'); } };
    const renderSettings = { enabled: true, allow_streaming: false, depth: 0, depth_ignore_hidden: false };
    let context = { messageFormatter: formatter, chatId: 'chat-a', characterId: 1,
        chat: Array.from({ length: 10 }, () => ({})),
        extensionSettings: { tavern_helper: { render: renderSettings }, disabledExtensions: [] } };
    const message = { getAttribute: () => '0', querySelector: selector => selector === '.mes_text'
        ? { querySelector: () => editor ? {} : null } : editor ? {} : null };
    const chat = { querySelector: selector => selector === ':scope > .mes' ? empty ? null : message : message,
        querySelectorAll: () => pres.filter(pre => pre.getAttribute(MARKER)) };
    const document = { body: { dataset: {} }, getElementById: () => chat,
        querySelectorAll: selector => selector === 'script[src]' ? scripts : pres.filter(pre => pre.getAttribute(MARKER)),
        head: { appendChild: node => { styles.push(node); node.connected = true; } },
        createElement(tag) {
            assert.equal(tag, 'style');
            const sheet = { cssRules: [], disabled: false,
                insertRule(css, index) { if (faults.insert) throw new Error('insert failed'); this.cssRules.splice(index, 0, { cssText: css }); },
                deleteRule(index) { if (faults.delete) throw new Error('delete failed'); this.cssRules.splice(index, 1); },
            };
            return { sheet, connected: false, remove() { this.connected = false; } };
        },
    };
    document.defaultView = {
        CSS: { supports: () => !faults.supports },
        crypto: { randomUUID: () => `00000000-0000-0000-0000-${String(++serial).padStart(12, '0')}` },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
            observe() { this.connected = true; }
            disconnect() { this.connected = false; }
        },
        setTimeout(callback, ms) { assert.equal(ms, 1500); const id = ++timerSerial; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    const install = () => installSourceGuard({ document, getContext: () => {
        if (faults.context) throw new Error('context failed'); return context;
    }, getVersions: () => versions });
    const instance = install();
    function node(token, hidden, mounted) {
        const attrs = new Map([[MARKER, token]]);
        const styles = new Map();
        const classes = new Set(hidden ? ['hidden!'] : []);
        const pre = { nodeType: 1, tagName: 'PRE', isConnected: true,
            classList: { contains: value => classes.has(value), add: value => classes.add(value) },
            getAttribute: name => name === 'style' ? [...styles].map(([key, value]) => `${key}:${value}`).join(';')
                : attrs.get(name) ?? null,
            removeAttribute: name => attrs.delete(name),
            matches: () => attrs.has(MARKER), querySelectorAll: () => [],
            style: { getPropertyValue: name => styles.get(name) ?? '', getPropertyPriority: () => '',
                removeProperty: name => styles.delete(name), setProperty: (name, value) => styles.set(name, value) },
        };
        const wrapper = { nodeType: 1, children: [pre], classList: { contains: name => name === 'TH-render' },
            querySelectorAll: () => attrs.has(MARKER) ? [pre] : [], matches: () => false };
        pre.parentElement = wrapper;
        if (mounted) wrapper.children.push({ tagName: 'IFRAME', id: 'TH-message--7--0' });
        pres.push(pre);
        return pre;
    }
    return { instance, install, hooks, timers, pres, scripts, observers, renderSettings, document, faults, styles,
        rules: () => styles.filter(node => node.connected && !node.sheet.disabled).flatMap(node => node.sheet.cssRules),
        shielded(pre) {
            const token = pre.getAttribute(MARKER);
            return !!token && this.rules().some(rule => rule.cssText.includes(`="${token}"]`));
        },
        context: () => context,
        replaceContext: value => { context = value; },
        versions: value => { versions = value; }, edit: value => { editor = value; },
        render: (html = BLOCK, metadata = { messageId: 7, isReasoning: false }) => hooks.reduce((s, fn) => fn(s, metadata), html),
        insert(html, { hidden = false, mounted = false } = {}) {
            const nodes = [...html.matchAll(/data-tf-source-guard="([^"]+)"/g)].map(match => node(match[1], hidden, mounted));
            this.fire([{ type: 'childList', target: chat, addedNodes: nodes, removedNodes: [] }]);
            return nodes;
        },
        fire(entries) { for (const observer of observers) if (observer.connected) observer.callback(entries); },
        timeout() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    };
}

test('strict source scan accepts only large encoded standard Showdown blocks', () => {
    assert.deepEqual(findFrontendSourceStarts(BLOCK), [0]);
    assert.deepEqual(findFrontendSourceStarts(`<p>before</p>${BLOCK}<p>after</p>`), [13]);
    assert.deepEqual(findFrontendSourceStarts(`<pre><code>${SOURCE}</code></pre>`), [0]);
    for (const html of [
        BLOCK.replace('<pre>', '<pre style="color:red">'),
        BLOCK.replace('<pre>', '<pre class="owned">'),
        BLOCK.replace('<code class="html language-html">', '<code id="owned">'),
        BLOCK.replace('&lt;body&gt;', '&amp;lt;body&amp;gt;'),
        BLOCK.replace(SOURCE, '&lt;body&gt;small'),
        BLOCK.replace(SOURCE, `${SOURCE}<span>active markup</span>`),
        BLOCK.replace('</code></pre>', ''),
    ]) assert.deepEqual(findFrontendSourceStarts(html), []);
    const malformed = '<pre><code class="'.repeat(8000);
    assert.deepEqual(findFrontendSourceStarts(malformed), [], 'malformed prefixes do not rescan a long suffix');
    assert.equal(findFrontendSourceStarts(Array(80).fill(BLOCK).join('')).length, 80);
});

test('annotation preserves every original byte and handles the detached initial chat batch', () => {
    const h = fixture({ empty: true });
    try {
        const html = `<p>before &amp; \"quotes\"</p>${BLOCK}${BLOCK}<p>after</p>`;
        const result = h.render(html);
        assert.equal(result.replace(/ data-tf-source-guard="[^"]+"/g, ''), html);
        assert.ok(!result.includes('style='), 'no inline hiding survives installation disposal');
        assert.equal([...result.matchAll(/data-tf-source-guard=/g)].length, 2);
        assert.equal(h.timers.size, 1, 'all source blocks on this floor share one timer');
        assert.equal(h.rules().length, 1);
        assert.ok(h.rules()[0].cssText.startsWith('pre['), 'temporary source mounts outside #chat share the random-token rule');
        assert.equal(h.instance.status().pending, 2);
    } finally { h.instance.dispose(); }
});

test('helper must hide source and mount its direct iframe before guard releases', () => {
    const h = fixture();
    try {
        const [pre] = h.insert(h.render());
        assert.ok(pre.getAttribute(MARKER));
        assert.equal(h.shielded(pre), true);
        pre.style.setProperty('content-visibility', 'auto');
        pre.classList.add('hidden!');
        h.fire([{ type: 'attributes', target: pre }]);
        assert.ok(pre.getAttribute(MARKER), 'hidden code alone is insufficient');
        const iframe = { tagName: 'IFRAME', id: 'TH-message--7--0' };
        pre.parentElement.children.push(iframe);
        h.fire([{ type: 'childList', target: pre.parentElement, addedNodes: [iframe], removedNodes: [] }]);
        assert.equal(pre.getAttribute(MARKER), null);
        assert.equal(pre.style.getPropertyValue('content-visibility'), 'auto', 'unrelated inline style is untouched');
        assert.equal(h.shielded(pre), false);
        assert.equal(h.rules().length, 1, 'settling this node does not retire its shared clone rule');
        assert.equal(h.instance.status().released, 1);
        assert.equal(h.instance.status().pending, 0);
        assert.equal(h.timers.size, 1);
        assert.ok(pre.classList.contains('hidden!'), 'Helper still owns its visibility');
        h.timeout();
        assert.equal(h.rules().length, 0);
        assert.equal(h.timers.size, 0);
        assert.equal(h.instance.status().timedOut, 0, 'successful Helper handoff does not consume timeout budget');
        assert.notEqual(h.render(), BLOCK, 'a settled floor may protect a later native redraw');
    } finally { h.instance.dispose(); }
});

test('timeout fails open and repeated formatting cannot extend the batch deadline', () => {
    const h = fixture();
    try {
        const first = h.render(), second = h.render();
        assert.equal(first, second, 'pending rerenders reuse the same random token');
        assert.equal(h.timers.size, 1);
        assert.equal(h.rules().length, 1);
        const [pre] = h.insert(second);
        pre.style.setProperty('color', 'red');
        h.timeout();
        assert.equal(pre.getAttribute(MARKER), null);
        assert.equal(pre.style.getPropertyValue('content-visibility'), '');
        assert.equal(h.rules().length, 0);
        assert.equal(pre.style.getPropertyValue('color'), 'red');
        assert.equal(h.instance.status().pending, 0);
        assert.ok(h.instance.status().timedOut > 0);
        assert.equal(h.render(), BLOCK, 'expired floor is not hidden again by later redraws');
        const [lateClone] = h.insert(first);
        assert.ok(lateClone.getAttribute(MARKER), 'an expired token has no stylesheet rule or observer');
        assert.equal(h.shielded(lateClone), false);
    } finally { h.instance.dispose(); }
});

test('later clones remain protected after Helper settles the original until the same deadline', () => {
    const h = fixture();
    try {
        const html = h.render();
        h.insert(html, { hidden: true, mounted: true });
        const [clone] = h.insert(html);
        assert.ok(clone.getAttribute(MARKER));
        assert.equal(clone.style.getPropertyValue('contain-intrinsic-size'), '');
        assert.equal(h.shielded(clone), true);
        assert.equal(h.timers.size, 1);
        assert.equal(h.instance.status().released, 1);
        h.insert(html, { hidden: true, mounted: true });
        assert.equal(h.shielded(clone), true, 'additional settled clones do not delete the shared rule');
        assert.equal(h.instance.status().released, 1, 'clones cannot over-count formatter items');
        h.timeout();
        assert.equal(h.shielded(clone), false);
        assert.equal(clone.getAttribute(MARKER), null);
        assert.equal(h.timers.size, 0);
        assert.equal(h.render(), BLOCK, 'an unresolved clone at deadline still expires this floor despite a zero item counter');
        assert.ok(h.instance.status().timedOut > 0);
    } finally { h.instance.dispose(); }
});

test('detached source keeps its marker so an asynchronous move back stays guarded', () => {
    const h = fixture();
    try {
        const html = h.render();
        const [pre] = h.insert(html);
        pre.isConnected = false;
        h.fire([{ type: 'childList', target: h.document.getElementById('chat'), addedNodes: [], removedNodes: [pre] }]);
        assert.ok(pre.getAttribute(MARKER));
        assert.equal(h.rules().length, 1);
        assert.equal(h.instance.status().pending, 1, 'a transient removal is not Helper completion');
        assert.equal(h.instance.status().released, 0);
        pre.isConnected = true;
        h.fire([{ type: 'childList', target: h.document.getElementById('chat'), addedNodes: [pre], removedNodes: [] }]);
        assert.equal(h.shielded(pre), true);
        h.timeout();
        assert.equal(h.shielded(pre), false);
        assert.equal(pre.getAttribute(MARKER), null);
    } finally { h.instance.dispose(); }
});

test('dispose removes its stylesheet, covers late append, and keeps the formatter hook inert', () => {
    const h = fixture();
    const html = h.render();
    const [pre] = h.insert(html);
    pre.style.setProperty('content-visibility', 'auto');
    h.instance.dispose(); h.instance.dispose();
    assert.equal(pre.getAttribute(MARKER), null);
    assert.equal(pre.style.getPropertyValue('content-visibility'), 'auto', 'later owner is preserved');
    assert.equal(pre.style.getPropertyValue('contain-intrinsic-size'), '');
    assert.equal(h.styles.filter(node => node.connected).length, 0);
    const [late] = h.insert(html);
    assert.equal(h.shielded(late), false, 'dispose needs no observer to reveal late appended HTML');
    assert.equal(h.timers.size, 0);
    assert.ok(h.observers.every(observer => !observer.connected));
    assert.equal(h.render(), BLOCK);
    const again = h.install();
    try {
        assert.equal(h.hooks.length, 1, 'reenable reuses the one native hook');
        assert.notEqual(h.render(), BLOCK);
        const replacement = h.install();
        try {
            assert.equal(again.status().reason, 'disposed', 'new owner closes previous installation');
            assert.equal(h.hooks.length, 1);
            assert.notEqual(h.render(), BLOCK);
            again.dispose();
            assert.notEqual(h.render(), BLOCK, 'old dispose cannot detach a newer owner');
            assert.equal(h.styles.filter(node => node.connected).length, 1);
        } finally { replacement.dispose(); }
    } finally { again.dispose(); }
    assert.equal(h.styles.filter(node => node.connected).length, 0);
});

test('exact helper, host, render, streaming, editor and overlap boundaries fail open', () => {
    const changes = [
        h => h.versions({ client: '1.19.1', helper: '4.12.1' }),
        h => h.versions({ client: '1.19.0', helper: '4.12.3' }),
        h => { h.renderSettings.enabled = false; },
        h => { h.renderSettings.allow_streaming = true; },
        h => { h.context().extensionSettings.disabledExtensions.push('third-party/JS-Slash-Runner'); },
        h => { h.context().streamingProcessor = { isFinished: false, isStopped: false }; },
        h => { h.document.body.dataset.generating = 'true'; },
        h => h.edit(true),
        h => h.scripts.push({ src: 'https://host/scripts/extensions/third-party/cocktail/index.js' }),
    ];
    for (const change of changes) {
        const h = fixture();
        try { change(h); assert.equal(h.render(), BLOCK); assert.equal(h.timers.size, 0); }
        finally { h.instance.dispose(); }
    }
    const h = fixture();
    try {
        for (const messageId of [-1, 0.5, 10, undefined]) assert.equal(h.render(BLOCK, { messageId }), BLOCK);
        assert.equal(h.render(BLOCK, { messageId: 7, isReasoning: true }), BLOCK);
    } finally { h.instance.dispose(); }
});

test('depth follows current chat and counts hidden floors exactly as Helper does', () => {
    const h = fixture();
    try {
        h.renderSettings.depth = 1;
        assert.equal(h.render(), BLOCK, 'floor 7 is outside the last visible floor');
        h.context().chat[8].is_system = true;
        h.context().chat[9].is_system = true;
        h.renderSettings.depth_ignore_hidden = true;
        assert.notEqual(h.render(), BLOCK, 'ignoring hidden floors includes floor 7');
        assert.equal(h.render(BLOCK, { messageId: 6 }), BLOCK);
        h.replaceContext({ ...h.context(), chat: [...h.context().chat, {}] });
        assert.equal(h.render(), BLOCK, 'latest context, not an installation-time chat snapshot');
    } finally { h.instance.dispose(); }
});

test('formatter exceptions preserve the original unmodified HTML', () => {
    const h = fixture();
    try {
        h.replaceContext(new Proxy(h.context(), { get() { throw new Error('unavailable'); } }));
        assert.equal(h.render(), BLOCK);
        assert.equal(h.timers.size, 0);
    } finally { h.instance.dispose(); }
});

test('switching chats removes old rules and timers before the next native formatting result', () => {
    const h = fixture();
    try {
        const old = h.render();
        const [pre] = h.insert(old);
        assert.equal(h.shielded(pre), true);
        h.replaceContext({ ...h.context(), chatId: 'chat-b' });
        assert.equal(h.render('plain text'), 'plain text');
        assert.equal(h.rules().length, 0);
        assert.equal(h.timers.size, 0);
        assert.equal(h.shielded(pre), false);
        const [clone] = h.insert(old);
        assert.equal(h.shielded(clone), false);
        assert.notEqual(h.render(), BLOCK, 'the new conversation has its own fresh deadline');
    } finally { h.instance.dispose(); }
});

test('disabling Helper releases already pending sources on the next host event', () => {
    const h = fixture();
    try {
        const html = h.render();
        const [pre] = h.insert(html);
        h.renderSettings.enabled = false;
        h.fire([{ type: 'attributes', target: pre }]);
        assert.equal(h.rules().length, 0);
        assert.equal(h.timers.size, 0);
        assert.equal(h.shielded(pre), false);
        assert.equal(h.render(), BLOCK);
    } finally { h.instance.dispose(); }
});

test('late native redraw cannot renew a deadline even before the delayed timer runs', t => {
    const h = fixture();
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    try {
        const first = h.render();
        now += 1499;
        assert.equal(h.render(), first);
        assert.equal(h.timers.size, 1);
        now++;
        assert.equal(h.render(), BLOCK);
        assert.equal(h.rules().length, 0);
        assert.equal(h.timers.size, 0);
    } finally { h.instance.dispose(); }
});

test('active rules and timers are bounded, with excess floors left visible', () => {
    const h = fixture();
    try {
        h.context().chat = Array.from({ length: 200 }, () => ({}));
        for (let id = 0; id < 64; id++) assert.notEqual(h.render(BLOCK, { messageId: id }), BLOCK);
        assert.equal(h.rules().length, 64);
        assert.equal(h.timers.size, 64);
        assert.equal(h.render(BLOCK, { messageId: 64 }), BLOCK);
        assert.equal(h.rules().length, 64);
        h.timeout();
        assert.equal(h.rules().length, 0);
        assert.equal(h.timers.size, 0);
        assert.equal(h.render(BLOCK, { messageId: 0 }), BLOCK, 'a timed-out floor stays open');
        assert.notEqual(h.render(BLOCK, { messageId: 64 }), BLOCK, 'a previously unguarded floor may use freed capacity');
    } finally { h.instance.dispose(); }
});

test('expired-floor capacity fails open for the entire current chat instead of forgetting old deadlines', () => {
    const h = fixture();
    try {
        h.context().chat = Array.from({ length: 200 }, () => ({}));
        for (let id = 0; id < 129; id++) {
            assert.notEqual(h.render(BLOCK, { messageId: id }), BLOCK);
            h.timeout();
        }
        assert.equal(h.instance.status().reason, 'chat-timeout-budget-exhausted');
        assert.equal(h.rules().length, 0);
        assert.equal(h.timers.size, 0);
        assert.equal(h.render(BLOCK, { messageId: 190 }), BLOCK);
        assert.equal(h.render(BLOCK, { messageId: 0 }), BLOCK);
        h.replaceContext({ ...h.context(), chatId: 'chat-b' });
        assert.notEqual(h.render(BLOCK, { messageId: 0 }), BLOCK);
        assert.equal(h.instance.status().reason, 'active');
    } finally { h.instance.dispose(); }
});

test('CSS insertion failure returns original bytes and withdraws every previously active rule', () => {
    const h = fixture();
    try {
        const [pre] = h.insert(h.render());
        h.faults.insert = true;
        assert.equal(h.render(BLOCK, { messageId: 8 }), BLOCK);
        assert.equal(h.rules().length, 0);
        assert.equal(h.styles.filter(node => node.connected).length, 0);
        assert.equal(h.shielded(pre), false);
        assert.equal(h.timers.size, 0);
        assert.equal(h.instance.status().pending, 0);
        assert.equal(h.render(), BLOCK, 'failed installation stays open');
    } finally { h.instance.dispose(); }
});

test('CSS deletion failure disables and removes the complete stylesheet', () => {
    const h = fixture();
    try {
        const html = h.render();
        const [pre] = h.insert(html);
        h.faults.delete = true;
        h.timeout();
        assert.equal(h.rules().length, 0);
        assert.equal(h.styles[0].sheet.disabled, true);
        assert.equal(h.styles[0].connected, false);
        assert.equal(h.shielded(pre), false);
        assert.equal(h.timers.size, 0);
        const [late] = h.insert(html);
        assert.equal(h.shielded(late), false);
        assert.equal(h.render(), BLOCK);
    } finally { h.instance.dispose(); }
});

test('context failure while sources are pending removes the stylesheet and preserves original output', () => {
    const h = fixture();
    try {
        const [pre] = h.insert(h.render());
        h.faults.context = true;
        assert.equal(h.render(), BLOCK);
        assert.equal(h.shielded(pre), false);
        assert.equal(h.timers.size, 0);
        assert.equal(h.instance.status().pending, 0);
    } finally { h.instance.dispose(); }
});

test('missing CSS containment support leaves the native hook inert and creates no stylesheet', () => {
    const h = fixture();
    h.instance.dispose();
    h.faults.supports = true;
    const unsupported = h.install();
    try {
        assert.equal(unsupported.status().reason, 'host-capability-unavailable');
        assert.equal(h.render(), BLOCK);
        assert.equal(h.styles.filter(node => node.connected).length, 0);
    } finally { unsupported.dispose(); }
});

test('a late 4.12.2 manifest enables the same iframe handoff; only pending rules observe chat', () => {
    const h = fixture();
    try {
        for (const helper of [undefined, '9.0.0']) {
            h.versions({ client: '1.19.0', helper });
            assert.equal(h.render(), BLOCK);
            assert.equal(h.observers.length, 0);
        }
        h.versions({ client: '1.19.0', helper: '4.12.2' });
        h.render('plain text');
        assert.equal(h.observers.length, 0);
        const [pre] = h.insert(h.render(), { hidden: true, mounted: true });
        assert.equal(h.observers.filter(o => o.connected).length, 1);
        assert.equal(pre.getAttribute(MARKER), null);
        h.timeout();
        assert.equal(h.observers.filter(o => o.connected).length, 0);
        h.renderSettings.enabled = false;
        assert.equal(h.instance.status().reason, 'helper-render-disabled');
        assert.equal(h.render(), BLOCK);
        assert.equal(h.observers.filter(o => o.connected).length, 0);
    } finally { h.instance.dispose(); }
});
