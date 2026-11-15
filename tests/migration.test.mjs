import test from 'node:test';
import assert from 'node:assert/strict';
import { retireLegacyWorker } from '../client/migration.js';
test('legacy migration unregisters exact same-origin owner only and never reloads', async () => {
    const removed = [], origin = 'https://example.test';
    const reg = (scriptURL, key, state = 'active') => ({ [state]: { scriptURL }, async unregister() { removed.push(key); return true; } });
    const result = await retireLegacyWorker({ origin, serviceWorker: {
        controller: { scriptURL: origin + '/api/plugins/cocktail-plus/sw.js' },
        getRegistrations: async () => [reg(origin + '/api/plugins/cocktail-plus/sw.js', 'old'),
            reg(origin + '/api/plugins/other/sw.js', 'other'), reg('https://else.test/api/plugins/cocktail-plus/sw.js', 'foreign'),
            reg(origin + '/api/plugins/cocktail-plus/sw.js', 'waiting', 'waiting')],
    } });
    assert.deepEqual(removed, ['old', 'waiting']);
    assert.deepEqual(result, { supported: true, retired: 2, controlled: true });
});
test('migration survives absent/denied service worker capability', async () => {
    assert.equal((await retireLegacyWorker({})).supported, false);
    assert.equal((await retireLegacyWorker({ serviceWorker: { getRegistrations() { throw Error('denied'); } } })).failed, true);
});
