import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { createStartupWireSender } from '../server/startup-wire.mjs';

const Br = class { encoding() { return 'br'; } };
function fixture() {
    const request = Object.assign(new EventEmitter(), { method: 'POST', headers: { 'accept-encoding': 'br' } });
    const headers = new Map(), config = {};
    const response = Object.assign(new EventEmitter(), { statusCode: 200, app: { get: key => config[key] },
        getHeader: key => headers.get(key), setHeader: (key, value) => headers.set(key, value), removeHeader: key => headers.delete(key),
        vary(value) { this.setHeader('Vary', value); }, send(value) { this.body = value; return this; } });
    return { request, response, config, value: { unknown: '保留 <>& 😀', raw: ' { "原文": true }\n', text: 'x'.repeat(600) } };
}
test('wire bypasses unavailable/native/custom/error/encoded/oversize paths and preserves failed compression', async () => {
    const unavailable = fixture();
    await createStartupWireSender().send(unavailable.request, unavailable.response, unavailable.value);
    assert.equal(unavailable.response.body, unavailable.value);
    for (const mutate of [f => f.config['json replacer'] = () => null, f => f.config['json spaces'] = 2,
        f => f.config['json escape'] = true, f => f.response.statusCode = 500,
        f => f.response.setHeader('Content-Encoding', 'gzip'), f => f.response.setHeader('Cache-Control', 'no-transform'),
        f => f.response.setHeader('Content-Type', 'text/html'), f => f.value.text = 'x', f => f.value.text = 'x'.repeat(5000)]) {
        const f = fixture(); mutate(f);
        const sender = createStartupWireSender({ Negotiator: Br, minBytes: 256, maxBytes: 4096, compress() { assert.fail('must stay native'); } });
        await sender.send(f.request, f.response, f.value); assert.equal(f.response.body, f.value); assert.equal(sender.stats().active, 0);
        if (f.response.statusCode === 200) assert.match(f.response.getHeader('Cache-Control'), /^private, no-store/);
        else assert.equal(f.response.getHeader('Cache-Control'), undefined);
    }
    const f = fixture(), missing = createStartupWireSender();
    await missing.send(f.request, f.response, f.value); assert.equal(f.response.body, f.value);
    const failing = createStartupWireSender({ Negotiator: Br, compress: async () => { throw new Error('injected encoder failure'); } });
    f.value.text = 'x'.repeat(300000);
    await failing.send(f.request, f.response, f.value);
    assert.equal(f.response.body, f.value); assert.equal(f.response.getHeader('Content-Encoding'), undefined); assert.equal(failing.stats().failures, 1);
});

test('compression admission is bounded; disconnect and sent headers never replay a response or retain listeners', async () => {
    const jobs = [];
    const sender = createStartupWireSender({ Negotiator: Br, minBytes: 256, maxBytes: 4096,
        compress: (_input, { signal }) => new Promise((resolve, reject) => {
            jobs.push(resolve); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }) });
    const first = fixture(), second = fixture(), third = fixture();
    const a = sender.send(first.request, first.response, first.value), b = sender.send(second.request, second.response, second.value);
    await createStartupWireSender({ Negotiator: Br, compress: async () => { throw new Error('global concurrency exceeded'); } }).send(third.request, third.response, third.value);
    assert.equal(jobs.length, 2); assert.equal(third.response.body, third.value); assert.equal(sender.stats().peak, 2);
    first.request.emit('aborted'); await a;
    second.response.headersSent = true; jobs[1](Buffer.from('encoded')); await b;
    for (const f of [first, second]) {
        assert.equal(f.response.body, undefined); assert.equal(f.response.listenerCount('close'), 0); assert.equal(f.request.listenerCount('aborted'), 0);
    }
    assert.equal(sender.stats().active, 0); assert.equal(sender.stats().aborted, 2);
});

test('the actual Node Brotli encoder cancels on response close and releases admission', async () => {
    const f = fixture(), sender = createStartupWireSender({ Negotiator: Br });
    f.value.text = 'x'.repeat(1048576);
    const pending = sender.send(f.request, f.response, f.value);
    f.response.emit('close'); await pending;
    assert.equal(sender.stats().active, 0); assert.equal(sender.stats().aborted, 1);
    assert.equal(f.response.body, undefined); assert.equal(f.response.listenerCount('close'), 0);
});

let host;
try { if (process.env.TAVERNFLOW_HOST_ROOT) host = createRequire(path.join(process.env.TAVERNFLOW_HOST_ROOT, 'package.json')); } catch {}
test('real HTTP Express/compression preserves decoded SHA, negotiation, headers, fresh values and custom JSON', { skip: !host }, async t => {
    const express = host('express'), compression = host('compression');
    const Negotiator = createRequire(host.resolve('compression'))('negotiator');
    const app = express(), sender = createStartupWireSender({ Negotiator });
    let value = { settings: ' { "preserved": "<>& 😀" }\n', unknown: { future: false }, text: '中文😀 abc<>& 0123456789\n'.repeat(20000) };
    app.use(compression()); app.use((_request, response, next) => { response.vary('Origin'); next(); });
    app.post('/native', (_request, response) => response.send(value));
    app.post('/wire', (request, response, next) => sender.send(request, response, value).catch(next));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const call = (url, accept) => new Promise((resolve, reject) => {
        const headers = accept === undefined ? {} : { 'Accept-Encoding': accept };
        const request = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method: 'POST', headers }, response => {
            const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
                const raw = Buffer.concat(chunks), encoding = response.headers['content-encoding'];
                const decoded = ({ br: brotliDecompressSync, gzip: gunzipSync, deflate: inflateSync }[encoding] || (v => v))(raw);
                resolve({ headers: response.headers, decoded, raw });
            });
        }); request.on('error', reject); request.end();
    });
    const sha = bytes => createHash('sha256').update(bytes).digest('hex');
    const optimizedHeaders = ['br', 'gzip, br', 'gzip, deflate, br, zstd'];
    for (const accept of [...optimizedHeaders, 'br;q=0,gzip;q=1', 'br;q=.2,gzip;q=.9', 'identity;q=1,br;q=.2', '*', undefined]) {
        const before = sender.stats().compressed, original = await call('/native', accept), optimized = await call('/wire', accept);
        assert.equal(sha(optimized.decoded), sha(original.decoded)); assert.equal(sha(optimized.decoded), sha(Buffer.from(JSON.stringify(value))));
        assert.equal(optimized.headers['content-encoding'], original.headers['content-encoding']);
        assert.match(optimized.headers.vary, /Origin/); assert.match(optimized.headers.vary, /Accept-Encoding/);
        const used = sender.stats().compressed > before; assert.equal(used, optimizedHeaders.includes(accept), accept);
        assert.equal(optimized.headers['cache-control'], 'private, no-store');
        if (used) assert.match(optimized.headers['content-type'], /^application\/json; charset=utf-8$/);
    }
    value = { ...value, settings: 'same fresh replacement', unknown: { future: 0 } };
    assert.deepEqual(JSON.parse((await call('/wire', 'br')).decoded), value);
    for (const [key, setting] of [['json spaces', 2], ['json escape', true], ['json replacer', ['settings', 'text']]]) {
        app.set(key, setting); const before = sender.stats().compressed;
        assert.equal(sha((await call('/native', 'br')).decoded), sha((await call('/wire', 'br')).decoded));
        assert.equal(sender.stats().compressed, before); app.set(key, undefined);
    }
    assert.equal(sender.stats().active, 0);
});
