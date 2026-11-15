import test from 'node:test';
import assert from 'node:assert/strict';
import { installUIOptimizations } from '../client/ui-optimizations.js';

test('input spelling is unchanged by default and opt-in is reversible', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const attrs = new Map([['spellcheck', 'true']]);
    const input = {
        value: '草稿，不应变化',
        getAttribute: name => attrs.get(name) ?? null,
        setAttribute: (name, value) => attrs.set(name, value),
        removeAttribute: name => attrs.delete(name),
    };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        getElementById: () => input, defaultView: { CSS: { supports: () => true } },
    } });
    try {
        const baseline = installUIOptimizations();
        assert.equal(baseline.status().nativeInputSizing, true);
        assert.equal(input.getAttribute('spellcheck'), 'true');
        baseline.dispose();
        const optional = installUIOptimizations({ options: { disableSpellcheck: true } });
        assert.equal(input.getAttribute('spellcheck'), 'false');
        assert.equal(optional.status().spellcheckDisabled, true);
        optional.dispose();
        optional.dispose();
        assert.equal(input.getAttribute('spellcheck'), 'true');
        assert.equal(input.value, '草稿，不应变化');
        const externalOwner = installUIOptimizations({ options: { disableSpellcheck: true } });
        input.setAttribute('spellcheck', 'true');
        externalOwner.dispose();
        assert.equal(input.getAttribute('spellcheck'), 'true');
        assert.equal(externalOwner.status().animationQueuePatched, false);
    } finally {
        if (previous) Object.defineProperty(globalThis, 'document', previous);
        else delete globalThis.document;
    }
});
