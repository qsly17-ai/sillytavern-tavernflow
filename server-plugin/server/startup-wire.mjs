// SPDX-License-Identifier: AGPL-3.0-only
import { brotliCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';

const compressBrotli = promisify(brotliCompress);
const ENCODINGS = ['br', 'gzip', 'deflate', 'identity'];
const PREFERRED_ENCODINGS = ['br', 'gzip'];
const PARAMETERS = { [constants.BROTLI_PARAM_QUALITY]: 6, [constants.BROTLI_PARAM_LGWIN]: 24 };
const writable = (request, response) => !request.aborted && !response.headersSent && !response.writableEnded && !response.destroyed;
let sharedActive = 0; // Reinstalling an adapter cannot double its in-flight budget.

/** Fresh JSON bytes only. Native Express/compression still own every fallback. */
export function createStartupWireSender({ Negotiator, compress = compressBrotli,
    minBytes = 256 * 1024, maxBytes = 64 * 1024 * 1024, concurrency = 2 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2
        || !Number.isInteger(minBytes) || minBytes < 1 || !Number.isInteger(maxBytes)
        || maxBytes < minBytes || maxBytes > 64 * 1024 * 1024) throw new RangeError('Invalid startup wire limits');
    const counters = { active: 0, peak: 0, compressed: 0, bypassed: 0, failures: 0, aborted: 0, inputBytes: 0, outputBytes: 0 };
    function eligible(request, response, value) {
        try {
            const accepted = request.headers?.['accept-encoding'] || '';
            return typeof Negotiator === 'function' && /(?:^|,)\s*br\s*(?:;|,|$)/i.test(accepted)
                && new Negotiator(request).encoding(ENCODINGS, PREFERRED_ENCODINGS) === 'br'
                && request.method === 'POST' && response.statusCode === 200
                && value !== null && typeof value === 'object' && !Buffer.isBuffer(value)
                && ['send', 'setHeader', 'getHeader', 'removeHeader', 'vary', 'once', 'removeListener'].every(key => typeof response[key] === 'function')
                && typeof response.app?.get === 'function'
                && !['json replacer', 'json spaces', 'json escape'].some(key => response.app.get(key))
                && !response.getHeader('Content-Encoding')
                && !/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(response.getHeader('Cache-Control') || '')
                && (!response.getHeader('Content-Type') || /^application\/json(?:\s*;|$)/i.test(response.getHeader('Content-Type')));
        } catch { return false; }
    }
    async function send(request, response, value) {
        const native = () => {
            counters.bypassed++;
            if (!writable(request, response)) return;
            if (response.statusCode === 200 && typeof response.setHeader === 'function') {
                const noTransform = /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(response.getHeader?.('Cache-Control') || '');
                response.setHeader('Cache-Control', `private, no-store${noTransform ? ', no-transform' : ''}`);
            }
            return response.send(value);
        };
        if (!writable(request, response)) return;
        if (sharedActive >= 2 || counters.active >= concurrency || !eligible(request, response, value)) return native();
        sharedActive++;
        counters.active++;
        counters.peak = Math.max(counters.peak, counters.active);
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once('close', abort);
        request.once?.('aborted', abort);
        try {
            let output, size;
            try {
                const json = JSON.stringify(value);
                size = Buffer.byteLength(json);
                if (size < minBytes || size > maxBytes) return native();
                output = await compress(Buffer.from(json), { params: PARAMETERS, signal: controller.signal, maxOutputLength: maxBytes });
                if (!Buffer.isBuffer(output)) throw new TypeError('Invalid compressed startup response');
            } catch (error) {
                if (controller.signal.aborted || !writable(request, response)) { counters.aborted++; return; }
                counters.failures++;
                return native();
            }
            if (controller.signal.aborted || !writable(request, response)) { counters.aborted++; return; }
            // A later owner may have changed status/headers/JSON options while encoding.
            if (!eligible(request, response, value)) return native();
            response.vary('Accept-Encoding');
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Cache-Control', 'private, no-store');
            response.setHeader('Content-Encoding', 'br');
            const result = response.send(output);
            counters.compressed++;
            counters.inputBytes += size;
            counters.outputBytes += output.length;
            return result;
        } finally {
            response.removeListener('close', abort);
            request.removeListener?.('aborted', abort);
            counters.active--;
            sharedActive--;
        }
    }
    return { send, stats: () => ({ ...counters }) };
}
