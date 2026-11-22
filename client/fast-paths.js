// SPDX-License-Identifier: AGPL-3.0-only
// Migrated from Susuzi's st-linear-parser 0.3.0. No cocktail-plus protocol dependency.
import { installLinearEscapeScan } from './lib/linear-scan.js';
import { installMetaAnchor } from './lib/meta-anchor.js';
import { installEmptyClearGuard } from './lib/empty-clear.js';
export async function installFastPaths({ context, getBoxVersion, onStats = () => {} } = {}) {
    const patches = [];
    const state = { enabled: false, reason: 'host-capability-unavailable', parser: false, metaRegex: false };
    let guard, disposed = false;
    const status = () => ({ ...state, emptyClear: guard?.status() });
    try {
        const [{ PARSER_FLAG }, { RegexProvider }] = await Promise.all([
            import('/scripts/slash-commands/SlashCommandParser.js'), import('/scripts/extensions/regex/engine.js'),
        ]);
        const parser = installLinearEscapeScan(context?.SlashCommandParser, PARSER_FLAG);
        const regex = installMetaAnchor(RegexProvider);
        patches.push(parser, regex);
        state.parser = parser.applied; state.metaRegex = regex.applied;
        guard = installEmptyClearGuard(globalThis.window, () => globalThis.SillyTavern.getContext(), getBoxVersion, onStats);
        state.enabled = parser.applied || regex.applied;
        state.reason = state.enabled ? 'active' : 'host-algorithm-changed-or-existing-patch';
    } catch { /* Version-fingerprinted optional fast paths fail open. */ }
    try { onStats(status()); } catch { /* telemetry */ }
    return { status, dispose() {
        if (disposed) return;
        disposed = true; guard?.restore();
        for (const patch of patches.reverse()) patch.restore?.();
        state.enabled = false; state.reason = 'disposed';
    } };
}
