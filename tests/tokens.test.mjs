import test from 'node:test';
import assert from 'node:assert/strict';
import { installTokens } from '../client/tokens.js';

const encoder = new TextEncoder();
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const waitFor = async (condition) => {
    for (let n = 0; n < 500; n++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
    assert.fail('token condition timed out');
};
const requestOptions = (content = '测试', extra = {}) => ({
    url: '/api/tokenizers/openai/count?model=gpt-4o', type: 'POST', async: true,
    contentType: 'application/json; charset=utf-8', data: JSON.stringify([{ role: 'user', content }]), ...extra,
});

async function harness(operation, implementation) {
    const previous = { jQuery: globalThis.jQuery, fetch: globalThis.fetch, location: globalThis.location };
    const registered = [];
    const requests = [];
    const controllers = [];
    const $ = { ajaxTransport(expression, factory) { registered.push({ expression, factory }); } };
    globalThis.jQuery = $;
    globalThis.location = { href: 'https://st.test/', origin: 'https://st.test' };
    globalThis.fetch = async (url, init = {}) => {
        const call = { url, init, payload: JSON.parse(init.body) };
        requests.push(call);
        if (implementation) return implementation(call);
        if (String(url).endsWith('/tokens')) return json({ ok: true, results: call.payload.requests.map(({ messages }) => ({ token_count: encoder.encode(messages[0]?.content || '').byteLength })) });
        return json({ token_count: 42 });
    };
    const install = (options = {}) => {
        const controller = installTokens({ context: { getRequestHeaders: () => ({ 'x-csrf-token': 'context-test' }) }, ...options });
        controllers.push(controller);
        return controller;
    };
    const select = (options, original = {}) => {
        for (const { factory } of registered) {
            const result = factory(options, original, {});
            if (result) return result;
        }
    };
    const begin = (options = requestOptions(), original = {}) => {
        const transport = select(options, original);
        assert.ok(transport, 'expected a token transport');
        const completions = [];
        let resolve;
        const done = new Promise((complete) => { resolve = complete; });
        transport.send({ 'Content-Type': 'application/json', 'x-csrf-token': 'native-test', 'x-native-header': 'preserve' }, (...args) => { completions.push(args); resolve(args); });
        return { transport, completions, done };
    };
    try { await operation({ $, registered, requests, install, select, begin }); }
    finally {
        for (const controller of controllers) controller.dispose();
        // Tests await admitted requests before returning; permit final telemetry microtasks.
        await new Promise((resolve) => setImmediate(resolve));
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
        }
    }
}

test('same-turn local asynchronous counts share one batch and retain individual results', async () => {
    await harness(async ({ registered, requests, install, begin }) => {
        const controller = install();
        assert.equal(registered.length, 1);
        assert.equal(registered[0].expression, '+*');
        const counting = ['a', '中文', '😀'].map((text) => begin(requestOptions(text)));
        const results = await Promise.all(counting.map(({ done }) => done));
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, '/api/plugins/tavern-flow/tokens');
        assert.equal(requests[0].payload.requests.length, 3);
        assert.equal(new Headers(requests[0].init.headers).get('x-csrf-token'), 'context-test');
        assert.deepEqual(results.map(([, , response]) => JSON.parse(response.text).token_count), [1, 6, 4]);
        assert.ok(results.every(([status, statusText, , headers]) => status === 200 && statusText === 'success' && headers.includes('application/json')));
        assert.ok(counting.every(({ completions }) => completions.length === 1));
        assert.equal(controller.status().requests, 3);
        assert.equal(controller.status().batches, 1);
    });
});

test('sync, remote, custom-XHR and non-native request semantics leave jQuery transport untouched', async () => {
    await harness(async ({ requests, install, select }) => {
        const controller = install();
        const cases = [
            [requestOptions('同步', { async: false })],
            ...['qwen2', 'command-r', 'command-a', 'nemo', 'deepseek', 'QWEN-72B'].map((model) => [requestOptions('远端', { url: `/api/tokenizers/openai/count?model=${model}` })]),
            [requestOptions(), { xhr() {} }],
            [requestOptions('原生凭证', { username: 'user' })],
            [requestOptions('XHR配置', { xhrFields: { withCredentials: true } })],
            [requestOptions('MIME覆盖', { mimeType: 'text/plain' })],
            [requestOptions('跨域', { url: 'https://another.test/api/tokenizers/openai/count?model=gpt-4o' })],
            [requestOptions('其他接口', { url: '/api/tokenizers/llama/count' })],
            [requestOptions('其他方法', { type: 'GET' })],
            [requestOptions('非JSON', { contentType: 'text/plain' })],
            [requestOptions('坏数据', { data: '{bad json' })],
            [requestOptions('对象根', { data: '{"content":"text"}' })],
            [requestOptions('非消息元素', { data: '[null]' })],
            [requestOptions('过大', { data: 'x'.repeat(1048577) })],
        ];
        for (const [options, original] of cases) assert.equal(select(options, original), undefined, JSON.stringify({ url: options.url, async: options.async, type: options.type }));
        assert.equal(requests.length, 0);
        assert.equal(controller.status().requests, 0);
    });
});

test('abort before flush removes one count without canceling sibling requests', async () => {
    await harness(async ({ requests, install, begin }) => {
        const controller = install();
        const canceled = begin(requestOptions('取消'));
        const live = begin(requestOptions('保留'));
        canceled.transport.abort(); canceled.transport.abort();
        await live.done;
        assert.equal(requests.length, 1);
        assert.equal(requests[0].payload.requests.length, 1);
        assert.equal(requests[0].payload.requests[0].messages[0].content, '保留');
        assert.equal(canceled.completions.length, 0);
        assert.equal(live.completions.length, 1);
        assert.equal(controller.status().canceled, 1);
    });
});

test('abort during shared fetch ignores only the canceled callback', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await harness(async ({ requests, install, begin }) => {
        const controller = install();
        const canceled = begin(requestOptions('发出后取消'));
        const live = begin(requestOptions('继续计数'));
        await waitFor(() => requests.length === 1);
        canceled.transport.abort();
        release();
        await live.done;
        assert.equal(canceled.completions.length, 0);
        assert.equal(live.completions.length, 1);
        assert.equal(requests.length, 1);
        assert.equal(controller.status().canceled, 1);
    }, async ({ payload }) => { await gate; return json({ ok: true, results: payload.requests.map(() => ({ token_count: 99 })) }); });
});

test('UTF-8 byte budgeting splits Chinese and emoji batches below 4 MiB', async () => {
    await harness(async ({ requests, install, begin }) => {
        const controller = install();
        const counts = [
            begin(requestOptions('中'.repeat(800000))),
            begin(requestOptions('中'.repeat(800000))),
            ...Array.from({ length: 4 }, () => begin(requestOptions('😀'.repeat(300000)))),
        ];
        await Promise.all(counts.map(({ done }) => done));
        assert.ok(requests.length >= 3, 'character counts must not masquerade as UTF-8 bytes');
        assert.equal(requests.flatMap(({ payload }) => payload.requests).length, 6);
        for (const { init } of requests) assert.ok(encoder.encode(init.body).byteLength <= 4 * 1024 * 1024, `batch exceeded 4 MiB: ${encoder.encode(init.body).byteLength}`);
        assert.equal(controller.status().requests, 6);
        assert.equal(controller.status().batches, requests.length);
    });
});

test('batch HTTP, invalid JSON, wrong result count and network errors each fall back exactly once per original request', async (t) => {
    for (const failure of ['http', 'json', 'count', 'network']) await t.test(failure, async () => {
        await harness(async ({ requests, install, begin }) => {
            const controller = install();
            const options = [requestOptions('a'), requestOptions('b', { url: '/api/tokenizers/openai/count?model=claude' })];
            const counts = options.map((option) => begin(option));
            const results = await Promise.all(counts.map(({ done }) => done));
            assert.equal(requests.filter(({ url }) => String(url).endsWith('/tokens')).length, 1);
            const fallbacks = requests.filter(({ url }) => !String(url).endsWith('/tokens'));
            assert.equal(fallbacks.length, 2);
            for (let i = 0; i < 2; i++) {
                assert.equal(fallbacks[i].url, options[i].url);
                assert.equal(fallbacks[i].init.body, options[i].data);
                assert.equal(fallbacks[i].init.headers['x-native-header'], 'preserve');
                assert.equal(results[i][0], 200);
                assert.deepEqual(JSON.parse(results[i][2].text), { token_count: 42 });
                assert.equal(counts[i].completions.length, 1);
            }
            assert.equal(controller.status().failures, 1);
        }, ({ url }) => {
            if (!String(url).endsWith('/tokens')) return json({ token_count: 42 });
            if (failure === 'http') return json({ error: 'unavailable' }, 503);
            if (failure === 'json') return new Response('not json');
            if (failure === 'count') return json({ ok: true, results: [] });
            throw new TypeError('offline');
        });
    });
});

test('native fallback failure reports failure once and never loops back into batching', async () => {
    await harness(async ({ requests, install, begin }) => {
        const controller = install();
        const count = begin();
        const response = await count.done;
        assert.deepEqual(response, [0, 'error']);
        assert.equal(requests.length, 2);
        assert.equal(count.completions.length, 1);
        assert.equal(controller.status().failures, 1);
    }, () => { throw new TypeError('all requests offline'); });
});

test('dispose lets admitted counts finish and its inert dispatcher immediately yields to native jQuery', async () => {
    await harness(async ({ registered, requests, install, select, begin }) => {
        const controller = install();
        const accepted = begin(requestOptions('已经接纳'));
        controller.dispose();
        assert.equal(controller.status().enabled, false);
        assert.equal(controller.status().reason, 'disposed');
        assert.equal(select(requestOptions('禁用后原生')), undefined);
        await accepted.done;
        assert.equal(accepted.completions.length, 1);
        assert.equal(requests.length, 1);
        const replacement = install();
        assert.equal(replacement.status().enabled, true);
        assert.equal(registered.length, 1, 'reinstall must reuse one dispatcher');
        const duplicate = install();
        assert.equal(duplicate.status().reason, 'token-batcher-already-installed');
        duplicate.dispose();
        assert.ok(select(requestOptions('仍归新owner')));
        replacement.dispose();
        assert.equal(select(requestOptions()), undefined);
    });
});
