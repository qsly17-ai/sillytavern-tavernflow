/**
 * Preserve ST 1.19.0 testSymbol semantics, changing only its leading-backslash count.
 * Authority: installed release 7e8663cd9, SlashCommandParser.js:583.
 */
export function installLinearEscapeScan(Parser, flags) {
    const original = Parser?.prototype?.testSymbol;
    if (typeof original !== 'function' || flags?.STRICT_ESCAPING !== 1) {
        return { applied: false, reason: 'unsupported-parser-capability' };
    }
    const source = Function.prototype.toString.call(original);
    // Exact source compatibility fingerprint for the reviewed ST 1.19.0 method.
    // This is an algorithm/version guard, not a security or integrity signature.
    let fingerprint = 2166136261;
    for (let i = 0; i < source.length; i++) {
        fingerprint = Math.imul(fingerprint ^ source.charCodeAt(i), 16777619) >>> 0;
    }
    if (source.length !== 1912 || fingerprint !== 0x82a87248 ||
        !source.includes(".replace(/^(\\\\*).*$/s, '$1').length") ||
        !source.includes('this.jumpedEscapeSequence ? -1 : 0') ||
        !source.includes('this.testSymbolLooseyGoosey(sequence, offset)')) {
        return { applied: false, reason: 'host-algorithm-changed-or-already-fixed' };
    }
    function linearTestSymbol(sequence, offset = 0) {
        if (!this.flags[flags.STRICT_ESCAPING]) {
            return this.testSymbolLooseyGoosey(sequence, offset);
        }
        const escapeOffset = this.jumpedEscapeSequence ? -1 : 0;
        const rawStart = this.index + offset + escapeOffset;
        // Match String.slice normalization, including a possible negative start.
        const start = rawStart < 0 ? Math.max(this.text.length + rawStart, 0)
            : Math.min(rawStart, this.text.length);
        let escapes = 0;
        while (this.text.charCodeAt(start + escapes) === 92) escapes++;
        const test = sequence instanceof RegExp
            ? text => new RegExp(`^${sequence.source}`).test(text)
            : text => text.startsWith(sequence);
        if (test(this.text.slice(rawStart + escapes))) {
            if (escapes == 0) return true;
            if (!this.jumpedEscapeSequence && offset == 0) {
                this.index++;
                this.jumpedEscapeSequence = true;
            }
            return false;
        }
    }
    Parser.prototype.testSymbol = linearTestSymbol;
    return {
        applied: true,
        restore() {
            if (Parser.prototype.testSymbol === linearTestSymbol) {
                Parser.prototype.testSymbol = original;
                return true;
            }
            return false;
        },
    };
}
