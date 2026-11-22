// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ST 1.19.0 + Tavern Helper 4.12.1/4.12.2. Avoid laying out huge inert source
 * blocks before Helper replaces them with its own live message iframes.
 * No source/iframe removal, rendering, chat writes, or sanitizer bypass.
 */
const registrations = new WeakMap();
const ATTRIBUTE = 'data-tf-source-guard';
const SELECTOR = `pre[${ATTRIBUTE}]`;
const STYLE = 'content-visibility:hidden;contain-intrinsic-size:0px 160px';
const CLOSE = '</code></pre>';
const MIN_BODY = 32 * 1024;
const TIMEOUT = 1500;
const MAX_ACTIVE = 64;
const MAX_EXPIRED = 128;
const OVERLAPS = ['cocktail', 'cocktail-plus', 'ST-BaiBai-Tools', 'st-linear-parser'];

/** Strict Showdown blocks only; each search advances beyond the current block. */
export function findFrontendSourceStarts(html) {
    if (typeof html !== 'string' || html.length < MIN_BODY) return [];
    const starts = [];
    let cursor = 0;
    while (cursor < html.length) {
        const start = html.indexOf('<pre><code', cursor);
        if (start < 0) break;
        let body = start + '<pre><code'.length;
        if (html[body] !== '>') {
            if (!html.startsWith(' class="', body)) { cursor = body; continue; }
            body += ' class="'.length;
            // Showdown's sole optional class attribute; bounded scanning also
            // rejects malformed tags without repeatedly scanning a long suffix.
            const limit = Math.min(html.length, body + 256);
            while (body < limit && html[body] !== '"' && html[body] !== '<' && html[body] !== '>') body++;
            if (html[body] !== '"' || html[body + 1] !== '>') { cursor = body + 1; continue; }
            body++;
        }
        body++;
        const end = html.indexOf(CLOSE, body);
        if (end < 0) break;
        cursor = end + CLOSE.length;
        if (end - body < MIN_BODY) continue;
        // The body must be encoded text, never active HTML nested in <code>.
        const rawTag = html.indexOf('<', body);
        if (rawTag >= 0 && rawTag < end) continue;
        const source = html.slice(body, end);
        if (['html&gt;', '&lt;head&gt;', '&lt;body'].some(marker => source.includes(marker))) starts.push(start);
    }
    return starts;
}

function markSources(html, starts, token) {
    const parts = [];
    let cursor = 0;
    for (const start of starts) {
        parts.push(html.slice(cursor, start + 4), ` ${ATTRIBUTE}="${token}"`);
        cursor = start + 4;
    }
    parts.push(html.slice(cursor));
    return parts.join('');
}

export function installSourceGuard({
    document = globalThis.document,
    getContext = () => globalThis.SillyTavern?.getContext?.(),
    getVersions = () => ({ client: globalThis.TavernHelper?.getTavernVersion?.(),
        helper: globalThis.TavernHelper?.getTavernHelperVersion?.() }),
    onStats = () => {},
} = {}) {
    const view = document?.defaultView;
    const chat = document?.getElementById('chat');
    let extensionSettings;
    const formatter = (() => {
        try { const context = getContext(); extensionSettings = context?.extensionSettings; return context?.messageFormatter; }
        catch { return null; }
    })();
    const infrastructure = (() => { try { return !!(chat && document.head && typeof document.createElement === 'function'
        && view?.MutationObserver && typeof view.setTimeout === 'function'
        && typeof view.clearTimeout === 'function' && view.crypto?.randomUUID
        && view.CSS?.supports?.('content-visibility', 'hidden')
        && view.CSS.supports('contain-intrinsic-size', '0px 160px')
        && formatter?.stage?.AFTER_MARKDOWN && typeof formatter.addHook === 'function'); } catch { return false; } })();
    const batches = new Map(), tokens = new Map(), expired = new Set();
    const counts = { shielded: 0, released: 0, timedOut: 0 };
    let disposed = false, observer, registration, styleNode, sheet, prefix;
    let serial = 0, identity, fused = false, failure;
    function capability() {
        if (!infrastructure) return 'host-capability-unavailable';
        try {
            const versions = getVersions();
            if (!versions?.client || !versions?.helper) return 'version-unavailable';
            if (versions.client !== '1.19.0') return 'host-version-mismatch';
            if (!['4.12.1', '4.12.2'].includes(versions.helper)) return 'helper-version-mismatch';
            return 'active';
        } catch { return 'version-unavailable'; }
    }
    const status = () => {
        const hostReason = capability();
        const reason = disposed ? 'disposed' : failure ?? (hostReason !== 'active' ? hostReason
            : fused ? 'chat-timeout-budget-exhausted' : renderReason(extensionSettings));
        return { enabled: reason === 'active', supported: !failure && hostReason === 'active', reason, ...counts,
            pending: [...batches.values()].reduce((sum, batch) => sum + batch.remaining, 0) };
    };
    const report = () => { try { onStats(status()); } catch { /* telemetry is optional */ } };

    function restore(pre, batch) {
        if (batch && pre.getAttribute(ATTRIBUTE) !== batch.token) return;
        pre.removeAttribute(ATTRIBUTE);
        if (!batch) return;
        batch.nodes.delete(pre);
        // Native formatting/sanitizing may clone the same annotated output.
        // These counters describe formatter items, not every transient clone.
        if (batch.remaining > 0) { batch.remaining--; counts.released++; }
    }
    function removeStyle() {
        const node = styleNode, oldSheet = sheet;
        styleNode = sheet = undefined;
        // Disable first: even a failed DOM removal cannot leave live rules.
        try { if (oldSheet) oldSheet.disabled = true; } catch { /* continue removal */ }
        try { if (node) node.disabled = true; } catch { /* continue removal */ }
        try { node?.remove(); } catch {
            try { node?.parentNode?.removeChild(node); } catch { /* already disabled */ }
        }
    }
    function failOpen(reason) {
        failure = reason;
        observer?.disconnect();
        removeStyle();
        for (const batch of batches.values()) {
            batch.active = false;
            view.clearTimeout(batch.timer);
            for (const pre of batch.nodes) {
                try { restore(pre, batch); } catch { /* no live rule remains */ }
            }
        }
        batches.clear(); tokens.clear();
    }
    function removeRule(batch) {
        if (!sheet) return;
        const index = Array.from(sheet.cssRules).indexOf(batch.rule);
        if (index >= 0) sheet.deleteRule(index);
    }
    function hasPending(batch) {
        // A clone can remain unresolved after the formatter-item counter has
        // reached zero. Only a marker-free live document proves handoff.
        return batch.remaining > 0 || Array.from(document.querySelectorAll(SELECTOR))
            .some(pre => pre.getAttribute(ATTRIBUTE) === batch.token);
    }
    function finish(batch, timeout = false) {
        if (!batch.active) return;
        // The rule must disappear before node cleanup; detached/late copies
        // then become visible without a permanent token ledger or observer.
        try { removeRule(batch); } catch { failOpen('stylesheet-failed'); return; }
        batch.active = false;
        view.clearTimeout(batch.timer);
        batches.delete(batch.key);
        tokens.delete(batch.token);
        if (!batches.size) { observer?.disconnect(); observer = undefined; }
        let tripFuse = false;
        if (timeout) {
            counts.timedOut += Math.max(1, batch.remaining);
            if (expired.size < MAX_EXPIRED) expired.add(batch.key);
            else { fused = true; tripFuse = true; }
        }
        for (const pre of chat.querySelectorAll(SELECTOR)) {
            if (pre.getAttribute(ATTRIBUTE) === batch.token) batch.nodes.add(pre);
        }
        for (const pre of [...batch.nodes]) restore(pre, batch);
        batch.remaining = 0;
        if (tripFuse) for (const other of [...batches.values()]) finish(other);
    }
    function consider(pre) {
        const token = pre.getAttribute(ATTRIBUTE);
        if (!token?.startsWith(prefix)) return;
        const batch = tokens.get(token);
        if (!batch) { restore(pre); return; }
        batch.nodes.add(pre);
        const wrapper = pre.parentElement;
        const helperMounted = wrapper?.classList.contains('TH-render')
            && Array.from(wrapper.children).some(node => node.tagName === 'IFRAME'
                && node.id?.startsWith('TH-message--'));
        // Detached source nodes may be moved back in a later task. Preserve
        // their marker and the batch rule until the original deadline.
        if (!batch.active || (pre.isConnected !== false && pre.classList.contains('hidden!') && helperMounted)) {
            restore(pre, batch);
            // Settled originals do not prove that all sanitizer/template
            // clones have reached #chat. Keep this bounded rule until its
            // original deadline so later copies receive the same protection.
        }
    }
    function inspect(node) {
        if (node?.nodeType !== 1) return;
        if (node.matches?.(SELECTOR)) consider(node);
        for (const pre of node.querySelectorAll?.(SELECTOR) ?? []) consider(pre);
    }
    function renderReason(settings) {
        const render = settings?.tavern_helper?.render;
        if (render?.enabled !== true || settings?.disabledExtensions?.some(name => String(name).split('/').at(-1) === 'JS-Slash-Runner')) {
            return 'helper-render-disabled';
        }
        if (render.allow_streaming !== false) return 'helper-streaming-mode';
        if (!Number.isInteger(render.depth) || render.depth < 0 || typeof render.depth_ignore_hidden !== 'boolean') {
            return 'helper-render-settings-unavailable';
        }
        return 'active';
    }
    function contextEnabled(context) {
        extensionSettings = context?.extensionSettings;
        if (disposed || failure || renderReason(extensionSettings) !== 'active') return false;
        if (!Array.isArray(context.chat) || !context.chatId) return false;
        const stream = context.streamingProcessor;
        if (stream && !stream.isFinished && !stream.isStopped) return false;
        if (document.body?.dataset?.generating) return false;
        for (const script of document.querySelectorAll('script[src]')) {
            if (OVERLAPS.some(name => script.src?.includes(`/extensions/third-party/${name}/`))) return false;
        }
        return true;
    }
    function synchronize(context) {
        const next = JSON.stringify([context?.groupId ?? null, context?.characterId ?? null, context?.chatId ?? null]);
        if (next !== identity) {
            for (const batch of [...batches.values()]) finish(batch);
            identity = next; expired.clear(); fused = false;
        }
        const enabled = capability() === 'active' && contextEnabled(context);
        if (!enabled) for (const batch of [...batches.values()]) finish(batch);
        return enabled && !fused;
    }
    function eligible(context, metadata) {
        if (metadata?.isReasoning || !Number.isInteger(metadata?.messageId) || metadata.messageId < 0
            || metadata.messageId >= context.chat.length) return false;
        const render = context.extensionSettings.tavern_helper.render;
        const depth = render.depth;
        const first = chat.querySelector(':scope > .mes');
        // Native redisplayChat formats all new floors while detached, then
        // appends them together. An empty #chat therefore has no first floor
        // yet; zero is the conservative lower bound for that initial batch.
        const minimum = first ? Number(first.getAttribute('mesid')) : 0;
        if (!Number.isInteger(minimum) || metadata.messageId < minimum) return false;
        if (render.depth_ignore_hidden) {
            let remaining = depth || context.chat.length;
            let included = false;
            for (let id = context.chat.length - 1; id >= minimum && remaining > 0; id--) {
                if (context.chat[id]?.is_system) continue;
                remaining--;
                if (id === metadata.messageId) { included = true; break; }
            }
            if (!included) return false;
        } else if (depth && metadata.messageId < Math.max(minimum, context.chat.length - depth)) return false;
        const message = chat.querySelector(`:scope > .mes[mesid="${metadata.messageId}"]`);
        const content = message?.querySelector('.mes_text');
        if (message?.querySelector('#curEditTextarea,.edit_textarea,.reasoning_edit_textarea,.mes_streaming')
            || content?.querySelector('textarea,input,select,[contenteditable]:not([contenteditable="false"])')) return false;
        return true;
    }
    function observeHandoff() {
        if (observer) return;
        observer = new view.MutationObserver(entries => {
            try {
                const previousReleased = counts.released;
                if (!batches.size) return;
                if (!synchronize(getContext())) { report(); return; }
                for (const entry of entries) {
                    if (entry.type === 'attributes') inspect(entry.target);
                    else {
                        for (const node of entry.addedNodes) inspect(node);
                        for (const node of entry.removedNodes) inspect(node);
                        // The iframe may be added after its source was seen.
                        if (entry.target?.classList?.contains('TH-render')) inspect(entry.target);
                    }
                }
                if (counts.released !== previousReleased) report();
            } catch {
                failOpen('runtime-failed');
                report();
            }
        });
        observer.observe(chat, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    }
    function transform(html, metadata) {
        // Most floors never contain a large frontend. Outstanding rules still
        // need to see a chat switch even if its first new floor is plain text.
        const large = typeof html === 'string' && html.length >= MIN_BODY;
        if (disposed || failure || (!batches.size && (!large || capability() !== 'active'))) return html;
        const context = getContext();
        if (!synchronize(context) || !large || !eligible(context, metadata)) return html;
        const key = metadata.messageId;
        if (expired.has(key)) return html;
        let batch = batches.get(key);
        if (batch && Date.now() >= batch.deadline) { finish(batch, hasPending(batch)); report(); return html; }
        const starts = findFrontendSourceStarts(html);
        if (!starts.length) return html;
        if (!batch && batches.size >= MAX_ACTIVE) return html;
        const token = batch?.token ?? `${prefix}${++serial}`;
        if (!batch) {
            observeHandoff();
            batch = { key, token, active: true, remaining: 0, nodes: new Set(), deadline: Date.now() + TIMEOUT, timer: null };
            const index = sheet.cssRules.length;
            sheet.insertRule(`pre[${ATTRIBUTE}="${token}"]{${STYLE}}`, index);
            batch.rule = sheet.cssRules[index];
            if (!batch.rule) throw new Error('Source guard stylesheet unavailable');
            batches.set(key, batch); tokens.set(token, batch);
            // One deadline per outstanding chat/message batch. Repeated native
            // formatting cannot extend a source block's hidden lifetime.
            batch.timer = view.setTimeout(() => {
                try { finish(batch, hasPending(batch)); } catch { failOpen('runtime-failed'); }
                report();
            }, TIMEOUT);
        }
        const result = markSources(html, starts, token);
        batch.remaining += starts.length;
        counts.shielded += starts.length;
        report();
        return result;
    }
    function dispose() {
        if (disposed) return;
        disposed = true;
        if (registration?.owner?.dispose === dispose) registration.owner = null;
        observer?.disconnect();
        // Remove the entire stylesheet first, covering HTML returned by the
        // hook that only reaches the document after this installation closes.
        removeStyle();
        for (const batch of [...batches.values()]) finish(batch);
        for (const pre of document?.querySelectorAll?.(SELECTOR) ?? []) {
            if (pre.getAttribute(ATTRIBUTE)?.startsWith(prefix)) restore(pre);
        }
        tokens.clear(); expired.clear();
        report();
    }
    if (infrastructure) {
        try {
            const uuid = view.crypto.randomUUID();
            if (!/^[a-f0-9-]{36}$/i.test(uuid)) throw new Error('Source guard token unavailable');
            prefix = `tf-${uuid}-`;
            styleNode = document.createElement('style');
            document.head.appendChild(styleNode);
            sheet = styleNode.sheet;
            if (!sheet || typeof sheet.insertRule !== 'function' || typeof sheet.deleteRule !== 'function') throw new Error('Source guard stylesheet unavailable');
            registration = registrations.get(formatter);
            if (!registration) {
                registration = { owner: null };
                formatter.addHook((html, metadata) => {
                    try { return registration.owner?.transform(html, metadata) ?? html; }
                    catch { registration.owner?.failOpen('runtime-failed'); return html; }
                }, { stage: formatter.stage.AFTER_MARKDOWN, order: formatter.order?.LATEST ?? 100 });
                registrations.set(formatter, registration);
            }
            registration.owner?.dispose();
            registration.owner = { transform, dispose, failOpen };
        } catch { failOpen('stylesheet-failed'); dispose(); }
    }
    report();
    return { status, dispose };
}
