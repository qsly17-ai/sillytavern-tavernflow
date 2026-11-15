/**
 * 1.19.0 already uses CSS field-sizing for supported browsers:
 * public/scripts/RossAscends-mods.js:860-906. Do not add a second autosize
 * listener or intercept jQuery queues (callbacks/timing belong to the host).
 * PresetManager.getSelectedPreset/getSelectedPresetName (preset-manager.js:396,
 * :404) query option:selected. Sizzle 3.5.1 checks selectedIndex once per option;
 * HTMLSelectElement.selectedOptions is a live native collection.
 */
// Compatibility fingerprints of the two unmodified functions in the pinned
// host's jquery-3.5.1.min.js; this does not copy/redistribute the library.
function functionFingerprint(fn) {
    if (typeof fn !== 'function') return '';
    const source = Function.prototype.toString.call(fn);
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
    return `${source.length}:${(hash >>> 0).toString(16)}`;
}

/** Exact-selector optimization; other selectors still use the original engine. */
export function createSelectedOptionFind({ jQuery, original, selectedPseudo, minOptions = 64, counters, active = () => true }) {
    return function find(selector) {
        if (selector !== 'option:selected' || !active()) return Reflect.apply(original, this, arguments);
        counters.candidates++;
        const select = this.length === 1 ? this[0] : null;
        if (jQuery.expr?.pseudos?.selected !== selectedPseudo || !select
            || select.tagName !== 'SELECT' || select.namespaceURI !== 'http://www.w3.org/1999/xhtml'
            || typeof this.pushStack !== 'function' || !select.options || !select.selectedOptions
            || select.options.length < minOptions
            // Invalid nested selects have different descendant semantics; fall
            // back synchronously rather than caching a structural assumption.
            || select.options.length !== select.getElementsByTagName('option').length) {
            counters.fallbacks++;
            return Reflect.apply(original, this, arguments);
        }
        counters.hits++;
        // Snapshot the live collection, just as .find returns a snapshot. No
        // cached selection, option clones, DOM mutation, or scheduled work.
        return this.pushStack(Array.from(select.selectedOptions));
    };
}

export function installUIOptimizations({ context: _context, options = {}, onStats = () => {} } = {}) {
    const document = globalThis.document;
    const view = document?.defaultView;
    const input = document?.getElementById('send_textarea');
    const enabled = options.enabled !== false;
    // Explicit opt-in: default spelling assistance is preserved.
    const quietSpelling = enabled && options.disableSpellcheck === true && !!input;
    const original = input?.getAttribute('spellcheck');
    const quickDrawers = enabled && options.quickDrawers !== false && !!document?.body;
    const hadDrawerClass = document?.body?.classList.contains('tf-quick-drawers');
    if (quickDrawers) document.body.classList.add('tf-quick-drawers');
    let disposed = false;
    let selectedFind = null;
    let oldFind = null;
    const jQuery = view?.jQuery ?? globalThis.jQuery;
    const counters = { candidates: 0, hits: 0, fallbacks: 0 };
    const selectedOptionsRequested = enabled && options.selectedOptions !== false;
    const minOptions = Number.isFinite(Number(options.selectMinOptions))
        ? Math.max(16, Math.min(1000, Math.trunc(Number(options.selectMinOptions)))) : 64;
    const selectedPseudo = jQuery?.expr?.pseudos?.selected;
    const standardJQuery = jQuery?.fn?.jquery === '3.5.1'
        && Object.getOwnPropertyDescriptor(jQuery.fn, 'find')?.writable === true
        && functionFingerprint(jQuery.fn.find) === '244:7ccf41ee'
        && functionFingerprint(selectedPseudo) === '76:9a34a4a0';
    if (selectedOptionsRequested && standardJQuery) {
        oldFind = jQuery.fn.find;
        selectedFind = createSelectedOptionFind({ jQuery, original: oldFind, selectedPseudo, minOptions, counters, active: () => !disposed });
        jQuery.fn.find = selectedFind;
    }
    if (quietSpelling) input.setAttribute('spellcheck', 'false');
    const status = () => ({
        enabled: enabled && !disposed,
        inputFound: !!input,
        nativeInputSizing: !!view?.CSS?.supports('field-sizing', 'content'),
        spellcheckDisabled: quietSpelling && !disposed && input.getAttribute('spellcheck') === 'false',
        selectedOptionsFastPath: !disposed && selectedFind !== null && jQuery.fn.find === selectedFind,
        selectedOptionsReason: disposed ? 'disposed' : !selectedOptionsRequested ? 'disabled'
            : !standardJQuery ? 'jquery-capability-mismatch' : jQuery.fn.find !== selectedFind ? 'replaced-by-another-owner' : 'active',
        selectMinOptions: minOptions,
        selectedOptionCandidates: counters.candidates,
        selectedOptionHits: counters.hits,
        selectedOptionFallbacks: counters.fallbacks,
        animationQueuePatched: false,
        quickDrawers: quickDrawers && !disposed,
        reason: disposed ? 'disposed' : !enabled ? 'disabled' : selectedFind ? 'native-selected-options-fast-path'
            : quietSpelling ? 'optional-spellcheck-disabled' : 'native-input-sizing-preserved',
    });
    const report = () => { try { onStats(status()); } catch { /* Diagnostics are optional. */ } };
    report();
    return {
        status,
        dispose() {
            if (disposed) return;
            disposed = true;
            if (quickDrawers && !hadDrawerClass) document.body.classList.remove('tf-quick-drawers');
            // A later extension's wrapper remains its owner's property.
            if (selectedFind && jQuery.fn.find === selectedFind) {
                try { jQuery.fn.find = oldFind; } catch { /* If later frozen, our disposed wrapper is inert. */ }
            }
            if (quietSpelling && input.getAttribute('spellcheck') === 'false') {
                if (original === null) input.removeAttribute('spellcheck');
                else input.setAttribute('spellcheck', original);
            }
            report();
        },
    };
}
