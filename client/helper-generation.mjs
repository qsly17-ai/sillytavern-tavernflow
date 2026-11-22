// SPDX-License-Identifier: AGPL-3.0-only
import { hasVerifiedRegexProvider } from './lib/meta-anchor.js';

// Only the exact verified Helper call sites invoke this bridge. Never change the
// chat array, arguments to the generation event, model payload, or user regexes.
const bridgeKey = Symbol.for('tavernflow.helperGeneration.bridge.v1');
const marker = Symbol.for('tavernflow.helperGeneration.abi');
const ignore = Symbol.for('ignore');
const ownValue = (object, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return !descriptor || Object.hasOwn(descriptor, 'value');
};
function plain(object) {
    if (!object || typeof object !== 'object') return false;
    const prototype = Object.getPrototypeOf(object);
    return prototype === null || prototype === Object.prototype;
}
function ordinaryRow(row) {
    if (!plain(row)) return false;
    // Helper spreads the whole message. Unknown own fields stay native when
    // reading them could run an extension getter.
    for (const key of Reflect.ownKeys(row)) if (!ownValue(row, key)) return false;
    if (typeof row.mes !== 'string' || !['undefined', 'string'].includes(typeof row.name)) return false;
    const extra = row.extra;
    if (extra == null) return true;
    if (!plain(extra)) return false;
    for (const key of ['media', 'media_index', 'media_display', 'api', 'model', 'type', 'tool_invocations',
        'reasoning', 'reasoning_signature', ignore]) if (!ownValue(extra, key)) return false;
    if ((extra.media != null && !Array.isArray(extra.media)) ||
        (extra.reasoning != null && typeof extra.reasoning !== 'string') ||
        (extra.media_index != null && !['number', 'string'].includes(typeof extra.media_index))) return false;
    // Foreign tool records can have validation, cloning or throwing getters in
    // the native formatter, even when that message will be discarded later.
    return extra.tool_invocations == null;
}

function ordinaryRule(rule) {
    if (!plain(rule)) return false;
    for (const key of Reflect.ownKeys(rule)) if (!ownValue(rule, key)) return false;
    for (const key of ['promptOnly', 'markdownOnly', 'disabled', 'scriptName', 'minDepth', 'maxDepth', 'substituteRegex', 'findRegex', 'replaceString']) {
        const value = rule[key];
        if (value != null && !['boolean', 'number', 'string'].includes(typeof value)) return false;
    }
    const placement = rule.placement;
    if (!Array.isArray(placement) || Object.getPrototypeOf(placement) !== Array.prototype ||
        Object.hasOwn(placement, 'includes')) return false;
    for (let i = 0; i < placement.length; i++) {
        if (typeof Object.getOwnPropertyDescriptor(placement, i)?.value !== 'number') return false;
    }
    return true;
}

// An empty replacement with no find substitution returns '' before ST evaluates
// any macro (even macros in the card's character fields). For other literal
// find rules, a non-match also runs no macro. Test only on the proper input,
// including the effect of preceding deletion rules. A possible match retains
// all native work, preserving random, variable, and third-party macro effects.
function discardedIsPassive(row, depth, scripts, patterns, compile) {
    const placement = row.is_user ? 1 : 2;
    const applicable = scripts.filter(rule => rule.placement.includes(placement) &&
        !(rule.minDepth != null && rule.minDepth >= -1 && depth < rule.minDepth) &&
        !(rule.maxDepth != null && rule.maxDepth >= 0 && depth > rule.maxDepth));
    const lastUncertain = applicable.findLastIndex(rule => Number(rule.substituteRegex) !== 0 || rule.replaceString !== '');
    if (lastUncertain < 0 || row.mes === '') return true;
    let text = row.mes;
    for (let i = 0; i <= lastUncertain && text; i++) {
        const rule = applicable[i];
        if (Number(rule.substituteRegex) !== 0) return false;
        if (!patterns.has(rule)) {
            const original = compile(rule.findRegex);
            // Own the RegExp cursor; the native provider resets its own lastIndex.
            if (original && Object.getPrototypeOf(original) !== RegExp.prototype) return false;
            // Probe only bounded literal patterns. A complex user regex could
            // already be expensive once; never run it speculatively and again
            // on the native fallback path.
            if (original && Reflect.ownKeys(original).some(key => key !== 'lastIndex')) return false;
            if (original && (original.source.length > 160 ||
                !/^[\p{L}\p{N} _:-]+$/u.test(original.source) ||
                !/^[giu]*$/.test(original.flags))) return false;
            patterns.set(rule, original ? new RegExp(original.source, original.flags) : null);
        }
        const pattern = patterns.get(rule);
        if (!pattern) continue;
        pattern.lastIndex = 0;
        if (rule.replaceString === '') text = text.replace(pattern, '');
        else if (pattern.test(text)) return false;
    }
    return true;
}

export function createHelperGeneration({ getRules, compile, ownsProvider = () => true, nativeRender, window = globalThis }) {
    const counts = { narrowed: 0, skippedFloors: 0, native: 0, coalescedRenders: 0 };
    const managers = new WeakMap();
    const history = (chat, limit) => {
        if (!Array.isArray(chat) || !Number.isSafeInteger(limit) || limit < 0 || chat.length <= limit) return chat;
        try {
            if (!ownsProvider()) return chat;
            const core = [];
            for (const row of chat) {
                if (!ordinaryRow(row)) return chat;
                if (!row.is_system) core.push(row);
            }
            const omitted = core.length - limit;
            if (omitted <= 0) return chat;
            const tail = core.slice(omitted);
            // An ignored item can create sparse arrays of different length in
            // setOpenAIMessages. Let the real formatter handle the whole case.
            if (tail.some(row => row.extra?.[ignore])) return chat;
            const rules = getRules();
            if (!rules.every(ordinaryRule)) return chat;
            const scripts = rules.filter(rule => rule.promptOnly && !rule.disabled && rule.findRegex);
            const patterns = new Map();
            for (let i = 0; i < omitted; i++) {
                if (!discardedIsPassive(core[i], core.length - i - 1, scripts, patterns, compile)) {
                    counts.native++;
                    return chat;
                }
            }
            counts.narrowed++;
            counts.skippedFloors += omitted;
            return tail;
        } catch { return chat; }
    };
    // b is the Helper's unique loop array. Concurrent auxiliary requests never
    // share an entry. Re-evaluate the live manager and render method for every
    // call so a UI/plugin replacement immediately returns to native behavior.
    const manager = (pool, current, setup, settings) => {
        if (current && current.render === nativeRender && managers.get(pool)?.instance === current) {
            managers.get(pool).dirty = true;
            counts.coalescedRenders++;
            return current;
        }
        const result = setup(settings);
        if (result && result.render === nativeRender) managers.set(pool, { instance: result, dirty: false });
        else managers.delete(pool);
        return result;
    };
    const finish = (pool, current) => {
        const record = managers.get(pool);
        managers.delete(pool);
        // The first render can already have painted while token accounting was
        // awaiting. Flush current state once when the last call was coalesced.
        if (record?.dirty && current === record.instance && current.render === nativeRender) current.render(false);
    };
    const bridge = { history, manager, finish };
    const previous = window[bridgeKey];
    if (!previous) window[bridgeKey] = bridge;
    return {
        status() {
            const active = window[bridgeKey] === bridge;
            const verified = window[marker] === 1;
            return { enabled: active && verified, reason: active ? verified ? 'active' : 'helper-build-unverified' : 'inactive', ...counts };
        },
        dispose() { if (window[bridgeKey] === bridge) delete window[bridgeKey]; },
    };
}

export async function installHelperGeneration({ context } = {}) {
    try {
        const [engine, { PromptManager }] = await Promise.all([
            import('/scripts/extensions/regex/engine.js'), import('/scripts/PromptManager.js'),
        ]);
        // A later replacement of render by a plugin invalidates the per-loop
        // optimization, even if it was already active when this module loaded.
        const candidate = PromptManager.prototype.render;
        const source = Function.prototype.toString.call(candidate);
        let hash = 2166136261;
        for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
        return createHelperGeneration({
            getRules: () => context.extensionSettings.disabledExtensions.includes('regex') ? [] : engine.getRegexScripts({ allowedOnly: true }),
            ownsProvider: () => hasVerifiedRegexProvider(engine.RegexProvider),
            compile: rule => engine.RegexProvider.instance.get(rule),
            nativeRender: source.length === 1589 && (hash >>> 0) === 0x7ec6ff3d ? candidate : null,
        });
    } catch { return { status: () => ({ enabled: false, reason: 'host-capability-unavailable' }), dispose() {} }; }
}
