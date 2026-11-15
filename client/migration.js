// SPDX-License-Identifier: AGPL-3.0-only
// Retire only the previous optimizer's worker. Never reload a page containing a draft.
export async function retireLegacyWorker({ serviceWorker = globalThis.navigator?.serviceWorker, origin = globalThis.location?.origin } = {}) {
    const ours = worker => {
        if (!worker?.scriptURL || !origin) return false;
        try { const url = new URL(worker.scriptURL); return url.origin === origin && url.pathname === '/api/plugins/cocktail-plus/sw.js'; }
        catch { return false; }
    };
    if (!serviceWorker?.getRegistrations) return { supported: false, retired: 0, controlled: false };
    try {
        const controlled = ours(serviceWorker.controller);
        let retired = 0;
        for (const reg of await serviceWorker.getRegistrations()) {
            if ([reg.active, reg.waiting, reg.installing].some(ours) && await reg.unregister()) retired++;
        }
        return { supported: true, retired, controlled };
    } catch { return { supported: true, retired: 0, controlled: ours(serviceWorker.controller), failed: true }; }
}
