/* TavernFlow's JSON protocol is independent of the host and third-party extensions. */
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Stable JSON, including integer-like keys, independent of object insertion order. */
export function canonical(value) {
    const active = new Set();
    function encode(item, depth) {
        if (depth > 256) throw new TypeError('JSON nesting is too deep');
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
        if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
        if (typeof item !== 'object' || active.has(item)) throw new TypeError('Expected finite, acyclic JSON data');
        if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
            throw new TypeError('Expected a plain JSON object');
        }
        active.add(item);
        let encoded;
        if (Array.isArray(item)) {
            const values = [];
            for (let i = 0; i < item.length; i++) {
                if (!own(item, i)) throw new TypeError('Sparse arrays are not JSON data');
                values.push(encode(item[i], depth + 1));
            }
            encoded = `[${values.join(',')}]`;
        } else {
            encoded = `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode(item[key], depth + 1)}`).join(',')}}`;
        }
        active.delete(item);
        return encoded;
    }
    return encode(value, 0);
}

export async function hashValue(value) {
    const bytes = new TextEncoder().encode(canonical(value));
    if (globalThis.crypto?.subtle) {
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    // Node's WebCrypto can be absent in test runners; browsers use the branch above.
    if (typeof process !== 'undefined' && process.versions?.node) {
        const { createHash } = await import('node:crypto');
        return createHash('sha256').update(bytes).digest('hex');
    }
    throw new Error('SHA-256 requires a secure browser context');
}

function equal(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && equal(a[key], b[key]));
}

/** A structural delta. Arrays use a single splice when their length changes. */
export function diffValues(base, next) {
    const ops = [];
    function visit(a, b, path) {
        if (equal(a, b)) return;
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length === b.length) {
                for (let i = 0; i < a.length; i++) visit(a[i], b[i], [...path, i]);
                return;
            }
            let start = 0;
            while (start < Math.min(a.length, b.length) && equal(a[start], b[start])) start++;
            let endA = a.length, endB = b.length;
            while (endA > start && endB > start && equal(a[endA - 1], b[endB - 1])) { endA--; endB--; }
            ops.push({ op: 'splice', path, index: start, deleteCount: endA - start, items: b.slice(start, endB) });
            return;
        }
        if (object(a) && object(b)) {
            for (const key of Object.keys(a)) if (!own(b, key)) ops.push({ op: 'delete', path: [...path, key] });
            for (const key of Object.keys(b)) {
                if (!own(a, key)) ops.push({ op: 'set', path: [...path, key], value: b[key] });
                else visit(a[key], b[key], [...path, key]);
            }
            return;
        }
        ops.push({ op: 'set', path, value: b });
    }
    visit(base, next, []);
    return ops;
}

const clone = value => JSON.parse(canonical(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;
function keyFor(container, key) {
    if (Array.isArray(container)) {
        if (!integer(key) || key >= container.length) throw new TypeError('Invalid array path');
    } else if (!object(container) || typeof key !== 'string') throw new TypeError('Invalid object path');
    return key;
}
function at(root, path) {
    let cursor = root;
    for (const key of path) {
        keyFor(cursor, key);
        if (!own(cursor, key)) throw new TypeError('Path does not exist');
        cursor = cursor[key];
    }
    return cursor;
}

/** Applies a validated delta to an independent JSON copy; never writes a prototype. */
export function applyOps(base, ops) {
    if (!Array.isArray(ops) || ops.length > 100000) throw new TypeError('Invalid operations');
    let result = clone(base);
    for (const operation of ops) {
        if (!operation || !Array.isArray(operation.path) || operation.path.length > 256 ||
            !operation.path.every(key => typeof key === 'string' || integer(key))) throw new TypeError('Invalid operation path');
        const { op, path } = operation;
        if (op === 'splice') {
            const target = at(result, path);
            const { index, deleteCount, items } = operation;
            if (!Array.isArray(target) || !integer(index) || index > target.length || !integer(deleteCount) ||
                deleteCount > target.length - index || !Array.isArray(items)) throw new TypeError('Invalid splice');
            // Avoid argument limits for a full chat-sized splice.
            const tail = target.slice(index + deleteCount);
            target.length = index;
            for (const item of clone(items)) target.push(item);
            for (const item of tail) target.push(item);
        } else if (op === 'set') {
            const value = clone(operation.value);
            if (path.length === 0) { result = value; continue; }
            const target = at(result, path.slice(0, -1));
            const key = keyFor(target, path.at(-1));
            Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
        } else if (op === 'delete') {
            if (path.length === 0) throw new TypeError('Cannot delete the root');
            const target = at(result, path.slice(0, -1));
            const key = keyFor(target, path.at(-1));
            if (Array.isArray(target) || !own(target, key)) throw new TypeError('Invalid delete');
            delete target[key];
        } else throw new TypeError('Unknown operation');
    }
    return result;
}
