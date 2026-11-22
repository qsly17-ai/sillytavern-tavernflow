export const ORIGINAL_META_PATTERN = "/^[\\s\\S]*(?=<storytext\\b[^>]*>|<content\\b|(?:#{1,6}[^\\S\\r\\n]*|【|\\[)(?:正文|正式回复|最终回复|最终回答|故事正文)(?:】|\\])?[^\\S\\r\\n]*[:：]?[^\\S\\r\\n]*(?=[\\r\\n]|$)|^[^\\S\\r\\n]*(?:#{1,6}[^\\S\\r\\n]*)?(?:【|\\[)?(?:正文|正式回复|最终回复|最终回答|故事正文)(?:】|\\])?[^\\S\\r\\n]*[:：]?[^\\S\\r\\n]*\\r?$)/im";
export const OPTIMIZED_META_PATTERN = ORIGINAL_META_PATTERN.replace('/^', '/^(?<![\\s\\S])');

const verifiedGetters = new WeakSet();
function isNativeGetter(method) {
    if (typeof method !== 'function') return false;
    const source = Function.prototype.toString.call(method);
    let fingerprint = 2166136261;
    for (let i = 0; i < source.length; i++) fingerprint = Math.imul(fingerprint ^ source.charCodeAt(i), 16777619) >>> 0;
    return source.length === 884 && fingerprint === 0xb0b0cce6;
}

// Check descriptors without invoking third-party getters. The Helper must
// keep each native per-floor call when another extension owns the provider.
export function hasVerifiedRegexProvider(Provider) {
    const instance = Object.getOwnPropertyDescriptor(Provider, 'instance')?.value;
    if (!instance || Object.getPrototypeOf(instance) !== Provider.prototype || Object.hasOwn(instance, 'get')) return false;
    const method = Object.getOwnPropertyDescriptor(Provider.prototype, 'get')?.value;
    if (verifiedGetters.has(method)) return true;
    if (!isNativeGetter(method)) return false;
    verifiedGetters.add(method);
    return true;
}

/** Keep multiline marker semantics, while trying the removable prefix only at offset 0. */
export function installMetaAnchor(Provider) {
    const original = Provider?.prototype?.get;
    if (typeof original !== 'function') return { applied: false, reason: 'unsupported-regex-provider' };
    if (!isNativeGetter(original)) {
        return { applied: false, reason: 'host-regex-provider-changed-or-already-patched' };
    }
    try { new RegExp('(?<![\\s\\S])'); }
    catch { return { applied: false, reason: 'lookbehind-unavailable' }; }
    function getWithMetaAnchor(regexString) {
        return original.call(this, regexString === ORIGINAL_META_PATTERN ? OPTIMIZED_META_PATTERN : regexString);
    }
    Provider.prototype.get = getWithMetaAnchor;
    verifiedGetters.add(getWithMetaAnchor);
    return {
        applied: true,
        restore() {
            if (Provider.prototype.get !== getWithMetaAnchor) return false;
            Provider.prototype.get = original;
            return true;
        },
    };
}
