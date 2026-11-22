import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createHelperGeneration } from '../client/helper-generation.mjs';
import { hasVerifiedRegexProvider, installMetaAnchor } from '../client/lib/meta-anchor.js';
import { adaptHelperBundle } from '../server/helper-generation.mjs';

const rule = changes => ({ placement: [1, 2], promptOnly: true, findRegex: 'X', replaceString: '', substituteRegex: 0, ...changes });
function fixture(rules = [], options = {}) {
    const window = {};
    const render = function (mode) { this.paints.push(mode); };
    const instance = { render, paints: [] };
    const setup = () => { instance.render(false); return instance; };
    const owner = createHelperGeneration({ getRules: () => rules, compile: text => new RegExp(text, 'g'), nativeRender: render, window, ...options });
    return { window, owner, bridge: window[Symbol.for('tavernflow.helperGeneration.bridge.v1')], instance, setup };
}
const rows = n => Array.from({ length: n }, (_, i) => ({ mes: 'floor ' + i, name: 'fixture', is_user: !(i % 2), extra: {} }));
test('2 of 20/100/500 floors preserve chronology, depth, fields, filtering and real row identities', () => {
    for (const count of [20, 100, 500]) {
        const { bridge, owner } = fixture([rule({ findRegex: 'floor' }), rule({ findRegex: 'nobody', replaceString: '{{incvar::effect}}' })]);
        const chat = rows(count);
        chat.splice(-1, 0, { mes: 'system', is_system: true });
        chat.at(-1).extra.media = [{ type: 'image', url: '/fixture.png' }];
        chat.at(-1).custom = [1, 2];
        const retained = bridge.history(chat, 2);
        assert.deepEqual(retained, [chat.at(-3), chat.at(-1)]);
        assert.equal(retained[1], chat.at(-1));
        assert.equal(owner.status().skippedFloors, count - 2);
        assert.equal(bridge.history(chat, undefined), chat);
        assert.equal(bridge.history(chat, -1), chat);
        assert.equal(bridge.history(chat, 1.5), chat);
    }
});
test('native regex side effects are not reordered or omitted, including preceding delete exposing a later match', () => {
    const chat = rows(4);
    chat[0].mes = 'aXb';
    const stateful = rule({ findRegex: 'ab', replaceString: '{{random}}' });
    assert.equal(fixture([rule({}), stateful]).bridge.history(chat, 2), chat);
    assert.equal(fixture([rule({ substituteRegex: 1 })]).bridge.history(chat, 2), chat);
    assert.deepEqual(fixture([rule({}), { ...stateful, placement: [2] }]).bridge.history(chat, 2), chat.slice(-2));
    assert.deepEqual(fixture([rule({}), { ...stateful, maxDepth: 1 }]).bridge.history(chat, 2), chat.slice(-2));
    assert.deepEqual(fixture([{ ...stateful, disabled: true }]).bridge.history(chat, 2), chat.slice(-2));
});
test('sparse native formatter and unfamiliar data retain native behavior without invoking getters', () => {
    const { bridge } = fixture();
    const chat = rows(4);
    chat[3].extra[Symbol.for('ignore')] = true;
    assert.equal(bridge.history(chat, 2), chat);
    delete chat[3].extra[Symbol.for('ignore')];
    chat[0].extra.tool_invocations = [{ reasoning: 'keep' }];
    assert.equal(bridge.history(chat, 2), chat);
    delete chat[0].extra.tool_invocations;
    let reads = 0;
    Object.defineProperty(chat[0], 'custom', { get: () => ++reads, enumerable: true });
    assert.equal(bridge.history(chat, 2), chat);
    assert.equal(reads, 0);
});
test('dynamic rules and providers retain all native calls without touching foreign getters', () => {
    let reads = 0;
    const dynamic = rule({});
    Object.defineProperty(dynamic, 'findRegex', { get() { reads++; return 'X'; } });
    const positions = [1, 2];
    Object.defineProperty(positions, 0, { get() { reads++; return 1; } });
    const chat = rows(4);
    for (const candidate of [dynamic, rule({ placement: positions }), rule({ minDepth: { valueOf() { reads++; return 0; } } })]) {
        assert.equal(fixture([candidate]).bridge.history(chat, 2), chat);
    }
    assert.equal(fixture([], { ownsProvider: () => false, getRules: () => { reads++; return []; } }).bridge.history(chat, 2), chat);
    assert.equal(reads, 0);
});
test('manager scopes redraws per loop and flushes the final state, with no global render or other request interception', () => {
    const { bridge, instance, setup, owner, window } = fixture();
    const first = [], parallel = [];
    assert.equal(bridge.manager(first, instance, setup, {}), instance);
    bridge.manager(parallel, instance, setup, {});
    bridge.manager(first, instance, setup, {});
    bridge.manager(first, instance, setup, {});
    instance.render(true); // explicit UI render receives the original method
    bridge.finish(first, instance);
    bridge.finish(parallel, instance);
    bridge.finish(first, instance);
    assert.deepEqual(instance.paints, [false, false, true, false]);
    assert.equal(owner.status().coalescedRenders, 2);
    instance.render = () => instance.paints.push('foreign');
    bridge.manager(first, instance, setup, {});
    bridge.manager(first, instance, setup, {});
    bridge.finish(first, instance);
    assert.deepEqual(instance.paints.slice(-2), ['foreign', 'foreign']);
    assert.equal(owner.status().enabled, false);
    window[Symbol.for('tavernflow.helperGeneration.abi')] = 1;
    assert.equal(owner.status().enabled, true);
    owner.dispose();
    assert.equal(window[Symbol.for('tavernflow.helperGeneration.bridge.v1')], undefined);
});
test('a similarly sized or unfamiliar Helper binary passes through untouched', () => {
    assert.equal(adaptHelperBundle(Buffer.alloc(1154343)), null);
    assert.equal(adaptHelperBundle(Buffer.from('different build')), null);
});

// Run the actual formatter read from the user's explicit test host. All injected
// messages and function dependencies are synthetic and never access chat files.
test('pinned 1.19 setOpenAIMessages produces identical model history for safe bounded reads', { skip: !process.env.TAVERNFLOW_HOST_ROOT }, async () => {
    const source = await fs.readFile(path.join(process.env.TAVERNFLOW_HOST_ROOT, 'public/scripts/openai.js'), 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), '0b77c30282825540265d5a09e681e5ccacf6760b05111ec880ffe237a9250604');
    const body = source.match(/^function setOpenAIMessages\(chat\) \{[\s\S]*?^\}/m)[0];
    const env = {
        oai_settings: { names_behavior: 1, chat_completion_source: 'local' }, getChatCompletionModel: () => 'fixture',
        IGNORE_SYMBOL: Symbol.for('ignore'), system_message_types: { NARRATOR: 'narrator' },
        character_names_behavior: { NONE: 0, DEFAULT: 1, CONTENT: 2, COMPLETION: 3 }, selected_group: 1,
        name1: 'user', name2: 'fixture', getMediaDisplay: () => 'gallery', getMediaIndex: () => 1,
    };
    const format = Function(...Object.keys(env), 'return (' + body + ')')(...Object.values(env));
    const processHistory = chat => {
        const list = chat.filter(m => !m.is_system);
        return list.map((m, i) => ({ ...m, mes: m.mes + '/depth=' + (list.length - 1 - i), index: i }));
    };
    const { bridge } = fixture();
    const chat = rows(50);
    chat[10].extra[env.IGNORE_SYMBOL] = true;
    chat.splice(45, 0, { is_system: true, mes: 'hidden' });
    Object.assign(chat.at(-1).extra, { type: 'narrator', media: [{ type: 'file', url: '/fixture' }], reasoning: 'test', api: 'local', model: 'fixture' });
    for (const n of [0, 1, 2, 18, 49]) {
        const actual = format(processHistory(bridge.history(chat, n))).slice(0, n);
        const expected = format(processHistory(chat)).slice(0, n);
        assert.deepEqual(actual, expected);
    }
});
test('only the native or owned regex provider can narrow history, including after live replacement', { skip: !process.env.TAVERNFLOW_HOST_ROOT }, async () => {
    const source = await fs.readFile(path.join(process.env.TAVERNFLOW_HOST_ROOT, 'public/scripts/extensions/regex/engine.js'), 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), '091bb3402a12552cf1754d6e4d2b44df38d3553aa374539896c716e78905d350');
    const body = source.match(/^export class RegexProvider \{[\s\S]*?^\}/m)[0].slice('export '.length);
    const Provider = Function('return (' + body + ')')();
    assert.equal(hasVerifiedRegexProvider(Provider), true);
    const owned = installMetaAnchor(Provider);
    assert.equal(owned.applied, true);
    assert.equal(hasVerifiedRegexProvider(Provider), true);
    Object.defineProperty(Provider.instance, 'get', { get() { throw Error('foreign getter invoked'); }, configurable: true });
    assert.equal(hasVerifiedRegexProvider(Provider), false);
    delete Provider.instance.get;
    assert.equal(owned.restore(), true);
    assert.equal(hasVerifiedRegexProvider(Provider), true);
    Provider.prototype.get = () => null;
    assert.equal(hasVerifiedRegexProvider(Provider), false);
});

test('do not pre-run an unfamiliar expression before native fallback', () => {
    let probes = 0;
    const expression = new RegExp('(?:word)+');
    Object.defineProperty(expression, 'exec', { get() { probes++; return RegExp.prototype.exec; } });
    const { bridge } = fixture([rule({ replaceString: 'present' })], { compile: () => expression });
    const chat = rows(6);
    assert.equal(bridge.history(chat, 2), chat);
    assert.equal(probes, 0);
    const complex = fixture([rule({ findRegex: 'word.*', replaceString: 'matched' })]);
    assert.equal(complex.bridge.history(chat, 2), chat);
});
