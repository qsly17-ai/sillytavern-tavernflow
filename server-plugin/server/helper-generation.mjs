// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const target = 'JS-Slash-Runner/dist/index.js';
const bundleBytes = 1154343;
const bundleHash = '38376664bfa11394b9db8deebda417476590a35bc0359e42d5e219e90563a3e8';
const hostFiles = {
    'src/users.js': '3100591d000a28f6d3a548242c9de69060c2fd4777c170b13f38a99bc67f3476',
    'public/scripts/PromptManager.js': 'b0054793b763d92b265f5f487645b68b4eca0867cb5ad6b5deb1034004b2c1cc',
    'public/scripts/openai.js': '0b77c30282825540265d5a09e681e5ccacf6760b05111ec880ffe237a9250604',
    'public/scripts/extensions/regex/engine.js': '091bb3402a12552cf1754d6e4d2b44df38d3553aa374539896c716e78905d350',
};
const anchors = [
    ['kt(await NW(x))', 'kt(await NW(globalThis[Symbol.for("tavernflow.helperGeneration.bridge.v1")]?.history?.(x,e.max_chat_history)??x))'],
    ['i=At(Ct);if(i&&i.serviceSettings.names_behavior', 'i=globalThis[Symbol.for("tavernflow.helperGeneration.bridge.v1")]?.manager?.(b,Tt,At,Ct)??At(Ct);if(i&&i.serviceSettings.names_behavior'],
    ['n.freeBudget(m),c?(n.add(f,o)', 'globalThis[Symbol.for("tavernflow.helperGeneration.bridge.v1")]?.finish?.(b,Tt);n.freeBudget(m),c?(n.add(f,o)'],
    ['//# sourceMappingURL=index.js.map', 'globalThis[Symbol.for("tavernflow.helperGeneration.abi")]=1;'],
];

// The installed bundle is never persisted or distributed. Imports still resolve
// against the original authenticated URL. A changed build is served natively.
export function adaptHelperBundle(bytes) {
    if (bytes.length !== bundleBytes || sha(bytes) !== bundleHash) return null;
    let source = bytes.toString('utf8');
    for (const [before, after] of anchors) {
        if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) return null;
        source = source.replace(before, () => after);
    }
    return source;
}

async function readInstalled(root) {
    const file = path.resolve(root, target);
    if (await fs.realpath(file) !== file) return null;
    const handle = await fs.open(file, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== bundleBytes) return null;
        const bytes = Buffer.allocUnsafe(bundleBytes + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!read.bytesRead) break;
            offset += read.bytesRead;
        }
        return adaptHelperBundle(bytes.subarray(0, offset));
    } finally { await handle.close(); }
}

export async function installHelperGenerationRoute({ hostRoot = process.cwd(), usersRouter, read = readInstalled } = {}) {
    let reason = 'unverified-host', layer, original, replacement;
    const owner = {
        status: () => ({ active: Boolean(replacement && layer?.handle === replacement), reason:
            replacement && layer?.handle !== replacement ? 'ownership-lost' : reason }),
        dispose() {
            if (replacement && layer?.handle === replacement) layer.handle = original;
            replacement = undefined;
            reason = 'disposed';
        },
    };
    try {
        const checks = await Promise.all(Object.entries(hostFiles).map(async ([file, hash]) =>
            sha(await fs.readFile(path.join(hostRoot, file))) === hash));
        if (!checks.every(Boolean)) return owner;
        usersRouter ??= (await import(pathToFileURL(path.resolve(hostRoot, 'src/users.js')).href)).router;
        const layers = usersRouter.stack;
        const index = layers.findIndex(item => item.name === 'extensionsEnabledFeatureGuard');
        const guard = layers[index];
        layer = layers[index + 1];
        const shape = String(/^\/scripts\/extensions\/third-party\/(.*)\/?(?=\/|$)/i);
        if (index < 0 || String(guard.regexp) !== shape || String(layer?.regexp) !== shape ||
            sha(Function.prototype.toString.call(guard.handle)) !== '1ba0dea6674758d777c45df78209da5e71580b19f5f5e414cbcf647a24702e11' ||
            sha(Function.prototype.toString.call(layer.handle)) !== '8f4899d9c877a04245e8fe171755ff5f9d2d3bb75f16f9ab7c52225eb70651e7') return owner;
        original = layer.handle;
        replacement = async function tavernFlowHelperAsset(req, res, next) {
            const root = req.user?.directories?.extensions;
            if (req.method === 'GET' && req.params?.[0] === target && req.user?.profile?.handle &&
                typeof root === 'string' && !req.headers?.range) {
                let source;
                try { source = await read(root); } catch { /* Fall through to the existing per-user/static-file response. */ }
                if (source && layer.handle === replacement) {
                    res.set('Cache-Control', 'private, no-cache');
                    return res.type('application/javascript').send(source);
                }
            }
            return original(req, res, next);
        };
        layer.handle = replacement;
        reason = 'active';
    } catch { reason = 'adapter-unavailable'; }
    return owner;
}
