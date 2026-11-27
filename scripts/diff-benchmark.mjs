// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import * as next from '../shared/protocol.mjs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.argv[2]) throw new Error('Pass the local baseline shared/protocol.mjs as an argument');
const old = await import(pathToFileURL(resolve(process.argv[2])));

const body = '中文与标记 [state] 😀，'.repeat(260);
function row(index) {
    const map = Array.from({ length: 16 }, (_, key) => ({ index: key, value: index + key }));
    return {
        mes: index + body,
        is_user: index % 2 === 0,
        extra: { mvu: { hp: 5, map: { a: 1, b: [1, 2, 3, 4, 5] }, note: index + 'end' } },
        variables: [{ hp: 100, profile: { map } }],
        swipes: [index + body, index + 'old'],
        swipe_info: [{ send_date: 'synthetic', extra: { id: index, values: [null, { a: 1 }] } }],
    };
}
const chat = [{ chat_metadata: { integrity: 'fixture' } }, ...Array.from({ length: 500 }, (_, index) => row(index))];
const settings = {
    extension_settings: Object.fromEntries(Array.from({ length: 800 }, (_, index) => ['fixture-' + index, row(index)])),
    presets: [{ flag: false, unused: 'unchanged' }],
};
const cases = [
    ['edit last MVU', chat, value => value.at(-1).variables[0].hp++],
    ['append floor', chat, value => value.push(row(500))],
    ['toggle one late setting', settings, value => value.extension_settings['fixture-799'].extra.mvu.hp++],
    ['replace every extra', chat, value => { for (const message of value) if (message.extra) message.extra = false; }],
];
const median = samples => samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)];
const results = [];
for (const [name, value, edit] of cases) {
    const baseJSON = JSON.stringify(value);
    const replacement = JSON.parse(baseJSON);
    edit(replacement);
    const nextJSON = JSON.stringify(replacement);
    const times = [[], []];
    const implementations = [old.diffValues, next.diffValues];
    for (let round = 0; round < 26; round++) {
        for (const index of round % 2 ? [1, 0] : [0, 1]) {
            const base = JSON.parse(baseJSON), updated = JSON.parse(nextJSON);
            const start = performance.now();
            const ops = implementations[index](base, updated);
            const elapsed = performance.now() - start;
            if (round >= 5) times[index].push(elapsed);
            if (round === 0) assert.equal(JSON.stringify(ops), JSON.stringify(old.diffValues(base, updated)));
        }
    }
    results.push({ name, bytes: Buffer.byteLength(baseJSON), old: median(times[0]), next: median(times[1]) });
}
console.log(JSON.stringify(results, null, 2));
