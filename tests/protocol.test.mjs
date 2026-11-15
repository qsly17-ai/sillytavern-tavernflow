import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical, hashValue, diffValues, applyOps } from '../shared/protocol.mjs';

test('canonical and SHA-256 are stable across insertion orders and Unicode', async () => {
    const a = { z: '汉字😀', '2': true, a: { y: -0, x: null }, '10': [] };
    const b = { '10': [], a: { x: null, y: 0 }, '2': true, z: '汉字😀' };
    assert.equal(canonical(a), canonical(b));
    assert.equal(canonical(a).indexOf('"10"'), 1);
    assert.equal(await hashValue(a), createHash('sha256').update(canonical(b)).digest('hex'));
});

test('same-length text, MVU, swipes, metadata, removal and append all round-trip', () => {
    const base = [{ chat_metadata: { integrity: 'one', variable: { hp: 9 } } }, { mes: 'abc', swipes: ['abc', 'def'], extra: { custom: 1 } }];
    const next = [{ chat_metadata: { integrity: 'one', variable: { hp: 7, mana: 3 } } }, { mes: 'xyz', swipes: ['xyz', 'uvw'] }, { mes: 'hello' }];
    const saved = structuredClone(base);
    const ops = diffValues(base, next);
    assert.deepEqual(applyOps(base, ops), next);
    assert.deepEqual(base, saved);
    assert.equal(ops[0].op, 'splice');
});

test('all JSON keys survive and cannot modify prototypes', () => {
    const base = JSON.parse('{"__proto__":{"safe":1},"constructor":{"prototype":{"value":2}},"toString":"old"}');
    const next = JSON.parse('{"__proto__":{"safe":3,"polluted":true},"constructor":{"prototype":{"value":4}},"toString":"new"}');
    assert.deepEqual(applyOps(base, diffValues(base, next)), next);
    assert.equal({}.polluted, undefined);
    assert.throws(() => applyOps({}, [{ op: 'set', path: ['__proto__', 'polluted'], value: true }]));
    assert.equal({}.polluted, undefined);
});

test('malformed operations reject without modifying base', () => {
    const base = { a: [1, 2] };
    for (const op of [
        { op: 'set', path: ['a', -1], value: 3 },
        { op: 'set', path: ['a', '0'], value: 3 },
        { op: 'set', path: ['a', 5], value: 3 },
        { op: 'delete', path: ['a', 0] },
        { op: 'delete', path: [] },
        { op: 'splice', path: ['a'], index: 0, deleteCount: 3, items: [] },
        { op: 'splice', path: ['a'], index: 3, deleteCount: 0, items: [] },
        { op: 'arbitrary', path: [] },
    ]) assert.throws(() => applyOps(base, [op]));
    assert.deepEqual(base, { a: [1, 2] });
});

test('invalid non-JSON values fail explicitly', () => {
    const circular = {}; circular.self = circular;
    for (const value of [undefined, { x: undefined }, NaN, Infinity, new Date(), circular, Array(2)]) {
        assert.throws(() => canonical(value));
    }
});

test('large splices do not overflow JavaScript argument limits', () => {
    const next = Array.from({ length: 150000 }, (_, index) => index);
    assert.deepEqual(applyOps([], diffValues([], next)), next);
});

test('2000 deterministic JSON pairs round-trip exactly', () => {
    let seed = 8147;
    const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    function json(depth = 0) {
        const type = random(depth > 3 ? 4 : 6);
        if (type === 0) return null;
        if (type === 1) return Boolean(random(2));
        if (type === 2) return random(10000) / 100;
        if (type === 3) return ['字😀', '', 'equal', 'A\nB', '"\\'][random(5)];
        if (type === 4) return Array.from({ length: random(5) }, () => json(depth + 1));
        const output = {};
        for (let i = 0, count = random(5); i < count; i++) Object.defineProperty(output, ['a', '2', '10', '__proto__', 'constructor'][random(5)], { value: json(depth + 1), enumerable: true, configurable: true, writable: true });
        return output;
    }
    for (let i = 0; i < 2000; i++) {
        const a = json(), b = json();
        assert.equal(canonical(applyOps(a, diffValues(a, b))), canonical(b), `pair ${i}`);
    }
});
