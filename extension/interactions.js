// SPDX-License-Identifier: AGPL-3.0-only
// Host authority: SillyTavern 1.19.0, 7e8663cd9c184a550b37238218bdd32c6efc68e9.
// PromptManager.js: handleToggle / isPromptDisabledForActiveCharacter / makeDraggable.
// world-info.js and extensions/regex/index.js: native jQuery UI sortable callbacks.
const LISTS = [
    ['completion_prompt_manager_list', '.completion_prompt_manager_prompt_draggable'],
    ['world_popup_entries_list', '.world_entry'],
    ['saved_regex_scripts', '.regex-script-label'],
    ['saved_scoped_scripts', '.regex-script-label'],
    ['saved_preset_scripts', '.regex-script-label'],
];
const LIST_SELECTOR = LISTS.map(([id]) => `#${id}`).join(',');
const fingerprints = new WeakMap();
function fingerprint(fn) {
    if (typeof fn !== 'function') return '';
    if (fingerprints.has(fn)) return fingerprints.get(fn);
    const text = Function.prototype.toString.call(fn);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    const result = `${text.length}:${(hash >>> 0).toString(16)}`;
    fingerprints.set(fn, result);
    return result;
}

export function promptToggleCapability(manager) {
    return manager?.configuration?.prefix === 'completion_'
        && manager.configuration.listIdentifier === 'completion_prompt_manager_list'
        && fingerprint(manager.handleToggle) === '477:b33f576a'
        && fingerprint(manager.isPromptDisabledForActiveCharacter) === '233:bfb066b8'
        && fingerprint(manager.getPromptOrderEntry) === '164:7f844c82';
}

export function hasActiveSortEditor(row, document) {
    if (row.querySelector('iframe, .edit_textarea, .reasoning_edit_textarea, .CodeMirror-focused, .ace_focus')) return true;
    const focused = document.activeElement;
    return !!focused && row.contains(focused)
        && (focused.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
            || focused.isContentEditable === true);
}

export function createLightweightSortHelper(row, document) {
    const view = document.defaultView;
    const width = row.offsetWidth, height = row.offsetHeight;
    if (!(width > 0 && height > 0)) return null;
    const title = row.querySelector('.completion_prompt_manager_prompt_name, .regex_script_name, [name="comment"]');
    // Only a short label is read. Never copy business HTML, IDs, handlers, or controls.
    const label = String(title?.value ?? title?.textContent ?? '').trim().slice(0, 96);
    const helper = document.createElement(row.tagName);
    helper.className = 'tf-sortable-helper';
    helper.setAttribute('aria-hidden', 'true');
    helper.textContent = label ? `☰ ${label}` : '☰';
    const source = view.getComputedStyle(row);
    Object.assign(helper.style, {
        boxSizing: 'border-box', width: `${width}px`, height: `${height}px`,
        marginTop: source.marginTop, marginRight: source.marginRight,
        marginBottom: source.marginBottom, marginLeft: source.marginLeft,
        display: 'flex', alignItems: 'center', padding: '8px 12px',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        pointerEvents: 'none', contain: 'layout style paint',
        color: 'var(--SmartThemeBodyColor, #eee)',
        background: 'var(--SmartThemeBlurTintColor, #242633)',
        border: '1px solid var(--SmartThemeBorderColor, #777)', borderRadius: '6px',
        fontFamily: source.fontFamily, fontSize: source.fontSize,
    });
    return helper;
}

// Separate entry allows deterministic fixtures without loading the application.
// Production callers use installInteractions(), which resolves the host modules.
export function installInteractionFeatures({ document = globalThis.document,
    jQuery = document?.defaultView?.jQuery, clientVersion,
    getPromptManager = () => null, options = {}, onStats = () => {} } = {}) {
    let disposed = false;
    const enabled = options.enabled !== false;
    const versionOK = clientVersion === 'SillyTavern:1.19.0:Cohee#1207';
    const promptRequested = enabled && options.promptToggle !== false;
    const dragRequested = enabled && options.lightweightDrag !== false;
    const sortableOK = versionOK && jQuery?.fn?.jquery === '3.5.1'
        && jQuery?.ui?.sortable?.prototype?.version === '1.13.2'
        && typeof jQuery.fn.sortable === 'function';
    const records = new Map();
    const counts = { promptSyncs: 0, helperCreated: 0, helperSkipped: 0, customHelpersSkipped: 0 };
    const manager = () => { try { return getPromptManager(); } catch { return null; } };
    function pruneRecords() {
        for (const [element, record] of records) {
            if (element.isConnected === false) {
                restore(record);
                records.delete(element);
            }
        }
    }
    const status = () => { pruneRecords(); return ({
        enabled: !disposed && enabled && versionOK,
        promptToggle: !disposed && promptRequested && versionOK && promptToggleCapability(manager()),
        promptToggleReason: disposed ? 'disposed' : !promptRequested ? 'disabled'
            : !versionOK ? 'host-version-mismatch' : !promptToggleCapability(manager()) ? 'prompt-capability-mismatch' : 'active',
        lightweightDrag: !disposed && dragRequested && sortableOK,
        lightweightDragReason: disposed ? 'disposed' : !dragRequested ? 'disabled'
            : !versionOK ? 'host-version-mismatch' : !sortableOK ? 'sortable-capability-mismatch' : 'active',
        managedLists: disposed ? 0 : [...records.values()].filter(record => record.instance.options.helper === record.helper).length,
        ...counts,
    }); };
    const report = () => { try { onStats(status()); } catch { /* Optional diagnostics. */ } };
    function mirrorToggle(event) {
        if (disposed || !promptRequested || !versionOK) return;
        const icon = event.target?.closest?.('.prompt-manager-toggle-action');
        const row = icon?.closest('.completion_prompt_manager_prompt');
        const list = row?.parentElement;
        if (!row?.isConnected || list?.id !== 'completion_prompt_manager_list') return;
        const current = manager();
        if (!promptToggleCapability(current)) return;
        const identifier = row.dataset.pmIdentifier;
        try {
            // The target's native listener has already changed authoritative state.
            // Unknown rows are ignored; no guessed state or token count is displayed.
            if (!identifier || !current.getPromptOrderEntry(current.activeCharacter, identifier)) return;
            const disabled = current.isPromptDisabledForActiveCharacter(identifier);
            if (typeof disabled !== 'boolean') return;
            row.classList.toggle('completion_prompt_manager_prompt_disabled', disabled);
            icon.classList.toggle('fa-toggle-off', disabled);
            icon.classList.toggle('fa-toggle-on', !disabled);
            counts.promptSyncs++;
            report();
        } catch { /* Optional visual feedback must never interrupt native saving. */ }
    }
    function restore(record) {
        if (record.instance.options.helper === record.helper) {
            try { record.instance.option('helper', record.original); } catch { /* Destroyed widget. */ }
        }
    }
    function configure(element, event) {
        pruneRecords();
        const spec = LISTS.find(([id]) => id === element?.id);
        if (!spec) return;
        const instance = jQuery(element).sortable('instance');
        if (!instance || typeof instance.option !== 'function' || instance.options.disabled) return;
        let record = records.get(element);
        if (record && record.instance !== instance) {
            restore(record); records.delete(element); record = null;
        }
        const row = event?.target?.closest?.(spec[1]);
        if (record && instance.options.helper === record.helper) {
            if (event) record.blockedRow = row && hasActiveSortEditor(row, document) ? row : null;
            return;
        }
        // Respect another extension's explicit helper, including one installed later.
        if (instance.options.helper !== 'original') {
            if (!record) counts.customHelpersSkipped++;
            return;
        }
        record = { instance, original: 'original', blockedRow: null, helper: null };
        if (row && hasActiveSortEditor(row, document)) record.blockedRow = row;
        record.helper = function (_event, item) {
            const node = item?.[0];
            if (disposed || !node || record.blockedRow === node || hasActiveSortEditor(node, document)) {
                counts.helperSkipped++; return item;
            }
            const helper = createLightweightSortHelper(node, document);
            if (!helper) { counts.helperSkipped++; return item; }
            counts.helperCreated++;
            return helper;
        };
        instance.option('helper', record.helper);
        records.set(element, record);
    }
    function prepareDrag(event) {
        if (disposed || !dragRequested || !sortableOK) return;
        const element = event.target?.closest?.(LIST_SELECTOR);
        if (!element) return;
        try { configure(element, event); } catch { /* Keep the original drag path available. */ }
    }
    if (document && versionOK && enabled) {
        if (promptRequested) document.addEventListener('click', mirrorToggle);
        if (dragRequested && sortableOK) {
            // Capture runs before the native widget's mousedown. No polling or observer
            // scans the chat; widgets recreated by the host are prepared on next use.
            document.addEventListener('pointerdown', prepareDrag, true);
            document.addEventListener('mousedown', prepareDrag, true);
            for (const [id] of LISTS) {
                const element = document.getElementById(id);
                if (element) { try { configure(element); } catch { /* Not initialized yet. */ } }
            }
        }
    }
    report();
    return { status, dispose() {
        if (disposed) return;
        disposed = true;
        document?.removeEventListener('click', mirrorToggle);
        document?.removeEventListener('pointerdown', prepareDrag, true);
        document?.removeEventListener('mousedown', prepareDrag, true);
        for (const record of records.values()) restore(record);
        records.clear();
        // jQuery UI owns a currently dragged helper and removes it on native stop.
        report();
    } };
}

export async function installInteractions({ context, options = {}, onStats = () => {} } = {}) {
    void context; // No private state, persistence, generation, or callback replacement.
    try {
        const [core, completion] = await Promise.all([import('/script.js'), import('/scripts/openai.js')]);
        return installInteractionFeatures({ clientVersion: core.CLIENT_VERSION,
            getPromptManager: () => completion.promptManager, options, onStats });
    } catch {
        return installInteractionFeatures({ clientVersion: null, options, onStats });
    }
}
