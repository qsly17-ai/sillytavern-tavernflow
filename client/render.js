/**
 * Historical plain-text painting only. No message removal, innerHTML writes,
 * iframe operations, scrollTop writes, or host event interception.
 * Host DOM contract: SillyTavern 1.19.0 (7e8663cd9), public/script.js
 * addOneMessage; #chat > .mes and .mes_text in public/style.css.
 */
const TEXT_TAGS = new Set(('P BR STRONG EM B I U S DEL STRIKE Q BLOCKQUOTE UL OL LI HR PRE CODE SPAN FONT H1 H2 H3 H4 H5 H6 TABLE THEAD TBODY TFOOT TR TH TD CAPTION RT RP RUBY SUB SUP MARK TT SMALL BIG').split(' '));
const TEXT_ATTRIBUTES = new Set(('class title lang dir translate color face size colspan rowspan align scope start type reversed').split(' '));
const EMBEDDED = 'iframe,script,style,canvas,video,audio,object,embed,svg,math';
const EDITORS = 'textarea,input,select,[contenteditable]:not([contenteditable="false"])';
const HOST_MESSAGE_EDITORS = '#curEditTextarea,.edit_textarea,.reasoning_edit_textarea';
const KEEP_LIVE = '[data-tf-keep-live],.tf-keep-live,.tavern-flow-keep-live';
const OWN_STYLES = ['content-visibility', 'contain-intrinsic-block-size'];

/** Conservative allow-list; unknown/custom HTML is left to its owner. */
export function isSafeTextMarkup(element) {
    const tag = String(element.tagName).toUpperCase();
    if (!TEXT_TAGS.has(tag)) return false;
    const attrs = Array.from(element.attributes ?? []);
    // Immersive Reading's enhanceReadableBlock (installed index.js:770-778)
    // only adds reversible typography marks to existing safe <p> elements.
    // It neither replaces those nodes nor attaches paragraph-level behavior.
    const readerParagraph = tag === 'P' && attrs.some(({ name, value }) => name === 'class'
        && String(value).split(/\s+/).includes('stir-readable-block'));
    return attrs.every(({ name, value }) => TEXT_ATTRIBUTES.has(name)
        || (readerParagraph && name === 'data-stir-enhanced' && value === '1'));
}

/** Host chrome includes input.del_checkbox on every floor; it is not an editor. */
export function hasMessageEditor(message, content) {
    return !!(message.querySelector(HOST_MESSAGE_EDITORS) || content?.querySelector(EDITORS));
}

/** These guards are intentionally independent of DOM access for regression checks. */
export function canDeferText({ eligible, near, tail, editing, focused, selected, height, measuredVersion, layoutVersion }) {
    return eligible === true && near === false && tail === false && !editing && !focused && !selected
        && Number.isFinite(height) && height > 0 && measuredVersion === layoutVersion;
}

export function normalizeRenderOptions(options = {}) {
    const number = (value, fallback, min, max) => Number.isFinite(Number(value))
        ? Math.min(max, Math.max(min, Math.trunc(Number(value)))) : fallback;
    return {
        enabled: options.enabled !== false,
        tail: number(options.tail, 5, 3, 30),
        maxMessages: number(options.maxMessages, 1200, 100, 3000),
        margin: number(options.margin, 1200, 600, 4000),
    };
}

export function installRender({ context = {}, options = {}, onStats = () => {} } = {}) {
    const config = normalizeRenderOptions(options);
    const document = globalThis.document;
    const view = document?.defaultView;
    const chat = document?.getElementById('chat');
    const supported = !!(chat && view?.IntersectionObserver && view?.ResizeObserver && view?.MutationObserver
        && view?.CSS?.supports('content-visibility', 'auto')
        && view.CSS.supports('contain-intrinsic-block-size', 'auto 100px'));
    let disposed = false;
    let frame = null;
    let idle = null;
    let layoutVersion = 0;
    let chatWidth = null;
    let fontSignature = '';
    let tail = new Set();
    let selectionEndpoints = new Set();
    let deferred = 0;
    let eligible = 0;
    let totalClassified = 0;
    let totalDeferred = 0;
    const records = new Map();
    const byContent = new WeakMap();
    const pending = new Set();
    const cleanups = [];
    const active = config.enabled && supported;

    const status = () => ({
        enabled: active && !disposed,
        supported,
        reason: disposed ? 'disposed' : !config.enabled ? 'disabled' : !supported ? 'browser-or-chat-unavailable' : 'active',
        tracked: records.size,
        eligible,
        deferred,
        pending: pending.size,
        totalClassified,
        totalDeferred,
        limit: config.maxMessages,
        tail: config.tail,
        strategy: 'plain-text-content-visibility',
    });
    const report = () => { try { onStats(status()); } catch { /* A panel must not break chat. */ } };
    if (!active) { report(); return { status, dispose() { disposed = true; } }; }

    const isMessage = element => element?.nodeType === 1 && element.parentElement === chat && element.classList.contains('mes');
    const messageOf = node => {
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        const message = element?.closest?.('.mes');
        return isMessage(message) ? message : null;
    };
    const restore = record => {
        if (!record.deferred) return;
        for (const [name, value, priority] of record.originalStyles) {
            // Preserve a later owner that explicitly replaced one of our properties.
            if (record.content.style.getPropertyValue(name) !== record.appliedStyles[name]) continue;
            if (value) record.content.style.setProperty(name, value, priority);
            else record.content.style.removeProperty(name);
        }
        record.deferred = false;
        record.originalStyles = null;
        record.appliedStyles = null;
        deferred--;
    };
    const unobserve = record => {
        if (!record.content) return;
        intersection.unobserve(record.content);
        sizes.unobserve(record.content);
        byContent.delete(record.content);
    };
    const forget = message => {
        pending.delete(message);
        const record = records.get(message);
        if (!record) return;
        restore(record);
        unobserve(record);
        eligible -= Number(record.eligible);
        records.delete(message);
    };
    function scheduleFlush() {
        if (disposed || !pending.size) return;
        if (frame === null && idle === null) {
            // Classification is chunked; there is never a history-wide geometry loop.
            if (view.requestIdleCallback) idle = view.requestIdleCallback(flush, { timeout: 150 });
            else frame = view.requestAnimationFrame(flush);
        }
    }
    function schedule(message) {
        if (disposed || !isMessage(message)) return;
        pending.add(message);
        scheduleFlush();
    }
    const getSelection = () => {
        try { return view.getSelection(); } catch { return null; }
    };
    const selected = content => {
        const selection = getSelection();
        if (!selection || selection.isCollapsed) return false;
        try { return selection.containsNode(content, true); } catch { return true; }
    };
    const plain = (message, content) => {
        if (!content || message.matches(KEEP_LIVE) || message.querySelector(KEEP_LIVE)
            || message.querySelector(EMBEDDED) || hasMessageEditor(message, content)) return false;
        if (content.querySelector('[hidden],a,button,details,summary,[role],[tabindex]')) return false;
        return Array.from(content.querySelectorAll('*')).every(isSafeTextMarkup);
    };
    function evaluate(message) {
        if (!isMessage(message)) { forget(message); return; }
        let record = records.get(message);
        if (!record) {
            while (records.size >= config.maxMessages) forget(records.keys().next().value);
            record = { message, content: null, eligible: false, near: true, height: 0, measuredVersion: -1, deferred: false, dirty: true };
            records.set(message, record);
        }
        const content = message.querySelector('.mes_text');
        const reclassify = record.dirty || content !== record.content;
        const isPlain = reclassify ? plain(message, content) : record.eligible;
        if (reclassify) totalClassified++;
        record.dirty = false;
        if (content !== record.content || isPlain !== record.eligible) {
            restore(record);
            unobserve(record);
            eligible -= Number(record.eligible);
            Object.assign(record, { content, eligible: isPlain, near: true, height: 0, measuredVersion: -1 });
            eligible += Number(isPlain);
            if (isPlain) {
                byContent.set(content, record);
                intersection.observe(content);
                sizes.observe(content);
            }
        }
        if (!isPlain) return;
        // Selection reads can synchronously settle a dirty host document. Only
        // ask about selection when every other condition permits deferral.
        const candidate = canDeferText({
            eligible: true,
            near: record.near,
            tail: tail.has(message),
            editing: hasMessageEditor(message, content),
            focused: content.contains(document.activeElement),
            selected: false,
            height: record.height,
            measuredVersion: record.measuredVersion,
            layoutVersion,
        });
        const defer = candidate && !selected(content);
        if (defer && !record.deferred) {
            // ResizeObserver supplies content-box dimensions. Padding/borders are
            // not included twice, and native scroll anchoring remains in charge.
            record.originalStyles = OWN_STYLES.map(name => [name, content.style.getPropertyValue(name), content.style.getPropertyPriority(name)]);
            record.appliedStyles = { 'content-visibility': 'auto', 'contain-intrinsic-block-size': `auto ${record.height}px` };
            sizes.unobserve(content);
            for (const [name, value] of Object.entries(record.appliedStyles)) content.style.setProperty(name, value);
            record.deferred = true;
            deferred++;
            totalDeferred++;
        } else if (!defer) {
            restore(record);
            sizes.observe(content);
        }
    }
    function flush(deadline) {
        frame = idle = null;
        if (disposed) return;
        let count = 0;
        const start = view.performance.now();
        while (pending.size && count < 24) {
            if (count && (view.performance.now() - start > 5 || (deadline?.timeRemaining && deadline.timeRemaining() < 1))) break;
            const message = pending.values().next().value;
            pending.delete(message);
            evaluate(message);
            count++;
        }
        report();
        // The first queued node may belong to a chat that has since been
        // replaced. Flush scheduling must not depend on that node's lifetime.
        scheduleFlush();
    }
    function updateTail() {
        const next = new Set();
        let node = chat.lastElementChild;
        while (node && next.size < config.tail) {
            if (isMessage(node)) next.add(node);
            node = node.previousElementSibling;
        }
        for (const message of tail) if (!next.has(message)) schedule(message);
        for (const message of next) {
            // A newly generated/edited last message must never wait for idle time.
            const record = records.get(message);
            if (record) restore(record);
            schedule(message);
        }
        tail = next;
    }
    const invalidateMeasurements = () => {
        layoutVersion++;
        for (const record of records.values()) {
            restore(record);
            record.measuredVersion = -1;
            if (record.eligible) { sizes.unobserve(record.content); sizes.observe(record.content); }
            schedule(record.message);
        }
    };
    const checkFonts = () => {
        // Embedded pages have no typography measurements owned by this module.
        // Do not flush their pending layout just to read an unrelated sample.
        let sample;
        for (const record of records.values()) {
            if (record.eligible && !record.dirty && isMessage(record.message)) { sample = record.content; break; }
        }
        if (!sample) return;
        const style = view.getComputedStyle(sample);
        const next = [style.font, style.lineHeight, style.letterSpacing, style.paddingTop, style.paddingBottom].join('|');
        // Initial classification may precede our first safe font sample. That
        // first settings/font event must still invalidate earlier measurements.
        if (next !== fontSignature) invalidateMeasurements();
        fontSignature = next;
    };
    const intersection = new view.IntersectionObserver(entries => {
        if (disposed) return;
        for (const entry of entries) {
            const record = byContent.get(entry.target);
            if (!record) continue;
            record.near = entry.isIntersecting;
            // Reveal before the next paint rather than after an idle callback.
            if (record.near) { restore(record); sizes.observe(record.content); }
            schedule(record.message);
        }
    }, { root: chat, rootMargin: `${config.margin}px 0px`, threshold: 0 });
    const sizes = new view.ResizeObserver(entries => {
        if (disposed) return;
        for (const entry of entries) {
            if (entry.target === chat) {
                const width = entry.contentRect.width;
                if (chatWidth !== null && Math.abs(chatWidth - width) > 1) invalidateMeasurements();
                chatWidth = width;
                continue;
            }
            const record = byContent.get(entry.target);
            if (!record || record.deferred) continue;
            record.height = entry.contentRect.height;
            record.measuredVersion = layoutVersion;
            schedule(record.message);
        }
    });
    const mutations = new view.MutationObserver(entries => {
        if (disposed) return;
        let changedChildren = false;
        for (const entry of entries) {
            if (entry.target === chat) {
                if (entry.type === 'attributes') invalidateMeasurements();
                if (entry.type !== 'childList') continue;
                changedChildren = true;
                for (const node of entry.removedNodes) if (node.parentElement !== chat) forget(node);
                for (const node of entry.addedNodes) if (isMessage(node)) schedule(node);
                continue;
            }
            const message = messageOf(entry.target);
            if (!message) continue;
            const record = records.get(message);
            // Inline styles on our .mes_text are our own writes. A descendant
            // style/markup mutation invalidates the pure-text eligibility check.
            if (entry.type === 'attributes' && entry.attributeName === 'style' && entry.target.classList.contains('mes_text')) continue;
            if (record) {
                restore(record);
                record.dirty = true;
                record.measuredVersion = -1;
                // Re-observe also delivers an initial size when an edit preserves
                // the same height. Otherwise that message would stay live forever.
                if (record.eligible) { sizes.unobserve(record.content); sizes.observe(record.content); }
            }
            schedule(message);
        }
        if (changedChildren) updateTail();
    });
    mutations.observe(chat, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'contenteditable', 'role', 'tabindex', 'data-tf-keep-live', 'data-stir-enhanced'] });
    sizes.observe(chat);
    // A bounded initial registration, no full-history DOM rectangle measurements.
    for (let i = Math.max(0, chat.children.length - config.maxMessages); i < chat.children.length; i++) schedule(chat.children[i]);
    updateTail();
    checkFonts();
    const onSelection = () => {
        // With no deferred content there is nothing to reveal. A future
        // candidate still checks the current selection before being deferred.
        if (!deferred) { selectionEndpoints.clear(); return; }
        const selection = getSelection();
        const next = new Set([messageOf(selection?.anchorNode), messageOf(selection?.focusNode)].filter(Boolean));
        for (const message of [...selectionEndpoints, ...next]) {
            const record = records.get(message);
            if (record) restore(record);
            schedule(message);
        }
        selectionEndpoints = next;
    };
    const onFocus = event => {
        const message = messageOf(event.target);
        const record = records.get(message);
        if (record) restore(record);
        if (message) schedule(message);
    };
    document.addEventListener('selectionchange', onSelection);
    chat.addEventListener('focusin', onFocus);
    chat.addEventListener('focusout', onFocus);
    cleanups.push(() => document.removeEventListener('selectionchange', onSelection),
        () => chat.removeEventListener('focusin', onFocus), () => chat.removeEventListener('focusout', onFocus));
    if (document.fonts?.addEventListener) {
        document.fonts.addEventListener('loadingdone', checkFonts);
        cleanups.push(() => document.fonts.removeEventListener('loadingdone', checkFonts));
    }
    // Verified public context keys at public/scripts/st-context.js:223 and
    // event value SETTINGS_UPDATED at public/scripts/events.js (1.19.0).
    const settingsEvent = context.event_types?.SETTINGS_UPDATED ?? context.eventTypes?.SETTINGS_UPDATED;
    const source = context.eventSource;
    const off = source?.removeListener ?? source?.off;
    if (settingsEvent && source?.on && typeof off === 'function') {
        source.on(settingsEvent, checkFonts);
        cleanups.push(() => off.call(source, settingsEvent, checkFonts));
    }
    report();
    return {
        status,
        dispose() {
            if (disposed) return;
            disposed = true;
            if (frame !== null) view.cancelAnimationFrame(frame);
            if (idle !== null) view.cancelIdleCallback(idle);
            mutations.disconnect();
            intersection.disconnect();
            sizes.disconnect();
            for (const record of records.values()) { restore(record); if (record.content) byContent.delete(record.content); }
            for (const cleanup of cleanups) cleanup();
            records.clear();
            pending.clear();
            tail.clear();
            selectionEndpoints.clear();
            eligible = 0;
            report();
        },
    };
}
