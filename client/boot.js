// SPDX-License-Identifier: AGPL-3.0-only
// Classic early loader for verified SillyTavern 1.19.0. Installed inline by the
// hash-checked installer, before native startup. No cache, write retry or events.
(() => {
    'use strict';
    const host = globalThis;
    if (host !== host.top || host.__tavernFlowBoot || !host.fetch || !host.AbortController || !host.ReadableStream) return;
    const original = host.fetch;
    const names = new Map([
        ['/api/settings/get', '设置'], ['/api/characters/all', '角色列表'], ['/api/characters/get', '角色'],
        ['/api/chats/get', '聊天'], ['/api/chats/group/get', '群聊'], ['/api/worldinfo/get', '世界书'],
        ['/api/backgrounds/all', '背景列表'], ['/api/backgrounds/folders', '背景文件夹'],
    ]);
    const stats = { version: '0.5.0', reads: 0, recovered: 0, retries: 0, waiting: 0, active: 0 };
    const waiting = new Set();
    const nativeResponses = new WeakMap();
    const chatBodies = new WeakMap();
    const validatedValues = new WeakMap();
    const validatedSettings = new WeakMap();
    let savePreparer;
    // Only our newly built complete response owns this parsed value. Its clones
    // keep independent native bodies. Do not wait for cancellation: a cloned
    // (teed) stream may wait indefinitely for the other reader.
    async function json() {
        if (!validatedValues.has(this) || this.bodyUsed || this.body.locked) return Response.prototype.json.call(this);
        const value = validatedValues.get(this);
        validatedValues.delete(this);
        const reader = this.body.getReader();
        void reader.cancel().catch(() => {});
        return value;
    }
    const adoptions = new Map();
    let adoptionId = 0, sendAdoption;
    let enabled = true, dialog, label, button, draftArea, copyDraft;
    // This is an inactivity limit: a large response making progress may take any
    // total time. Test clocks may replace timers, never product URL parameters.
    const idleMs = 30000;
    function render() {
        // A broken host dialog must never reject a native read into the
        // empty-chat fallback. The retry API also remains available to the panel.
        try { renderNow(); } catch { stats.waiting = waiting.size; }
        try { host.dispatchEvent?.(new CustomEvent('tavernflow:loading')); } catch { /* Diagnostics are optional. */ }
    }
    function reload() {
        const draft = document.getElementById?.('send_textarea')?.value;
        if (!draft || host.confirm('当前输入尚未发送。草稿已显示在恢复框中，请取消后复制；确认则重新加载酒馆。')) host.location.reload();
    }
    function retry() {
        if ([...waiting].some(row => row.stale)) { reload(); return; }
        for (const entry of waiting) entry.wake?.();
    }
    function chatIdentity() {
        try {
            const context = host.SillyTavern?.getContext?.();
            return context && JSON.stringify([context.characterId, context.groupId, context.chatId]);
        } catch { return undefined; }
    }
    function selectedRead(pathname, body) {
        try {
            const context = host.SillyTavern?.getContext?.();
            const request = JSON.parse(body);
            if (!context || !context.chatId) return;
            // Helper APIs also read historical files. Bind only a read of the
            // currently selected chat, rather than interrupting background export.
            if (pathname === '/api/chats/group/get') {
                if (!context.groupId || request.id !== context.chatId) return;
            } else if (pathname === '/api/chats/get') {
                if (context.groupId || request.file_name !== context.chatId || request.avatar_url !== context.characters?.[context.characterId]?.avatar) return;
            } else return;
            return chatIdentity();
        } catch { return undefined; }
    }
    function renderNow() {
        stats.waiting = waiting.size;
        if (!waiting.size) { if (dialog?.open) dialog.close(); return; }
        if (!host.document?.body) { host.document?.addEventListener('DOMContentLoaded', render, { once: true }); return; }
        if (!dialog) {
            dialog = document.createElement('dialog'); dialog.id = 'tf-load-recovery';
            dialog.setAttribute('aria-labelledby', 'tf-load-title');
            dialog.style.cssText = 'color:#eee;background:#26272b;border:1px solid #777;border-radius:12px;padding:22px;width:min(330px,calc(100vw - 48px));box-sizing:border-box;line-height:1.6;z-index:2147483647';
            const title = document.createElement('strong'); title.id = 'tf-load-title'; title.textContent = '连接暂时不畅';
            label = document.createElement('p'); label.setAttribute('role', 'status');
            button = document.createElement('button'); button.type = 'button'; button.textContent = '重试读取';
            button.style.cssText = 'padding:8px 18px;border-radius:7px;border:1px solid #aaa;color:inherit;background:#444;font:inherit';
            button.addEventListener('click', retry);
            const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '重新加载酒馆';
            refresh.style.cssText = button.style.cssText + ';margin:8px'; refresh.addEventListener('click', reload);
            draftArea = document.createElement('textarea'); draftArea.readOnly = true; draftArea.rows = 4;
            draftArea.setAttribute('aria-label', '未发送的草稿，可选择复制');
            draftArea.style.cssText = 'width:100%;box-sizing:border-box;margin:10px 0;color:inherit;background:#191a1e;font:inherit';
            copyDraft = document.createElement('button'); copyDraft.type = 'button'; copyDraft.textContent = '复制草稿'; copyDraft.style.cssText = button.style.cssText;
            copyDraft.addEventListener('click', async () => {
                try {
                    if (!host.navigator?.clipboard?.writeText) throw new Error('clipboard-unavailable');
                    await host.navigator.clipboard.writeText(draftArea.value); copyDraft.textContent = '已复制草稿';
                } catch {
                    draftArea.focus?.(); draftArea.select?.(); copyDraft.textContent = '请长按或选择框内草稿复制';
                }
            });
            dialog.addEventListener('cancel', event => event.preventDefault());
            dialog.append(title, label, button, refresh, draftArea, copyDraft); document.body.append(dialog);
        }
        const rows = [...waiting];
        const draft = document.getElementById?.('send_textarea')?.value || '';
        draftArea.value = draft; draftArea.hidden = copyDraft.hidden = !draft;
        const stale = rows.some(row => row.stale);
        const busy = !stale && rows.some(row => row.retrying);
        button.textContent = stale ? '重新加载酒馆' : '重试读取';
        label.textContent = stale ? '读取期间聊天已切换。请复制未保存的输入，再重新加载酒馆。' : busy ? '正在重新读取，请稍候…' : `未能完整读取${[...new Set(rows.map(row => row.label))].join('、')}。请确认网络及登录状态后重试；重载前请先保留草稿。`;
        button.disabled = busy;
        if (dialog.isConnected === false) document.body.append(dialog);
        if (!dialog.open) {
            try { dialog.showModal(); }
            catch {
                dialog.setAttribute('open', '');
                dialog.style.position = 'fixed'; dialog.style.inset = '0';
            }
        }
    }
    function qualify(input, init) {
        try {
            // Requests and caller-owned cancellation retain their native contract.
            if (!(typeof input === 'string' || input instanceof URL) || init?.signal || init?.keepalive || init?.credentials === 'omit') return;
            const url = new URL(input, host.location.href);
            if (url.origin !== host.location.origin || url.search || !names.has(url.pathname) || String(init?.method).toUpperCase() !== 'POST') return;
            const headers = new Headers(init.headers);
            if (headers.has('content-encoding') || !headers.get('content-type')?.toLowerCase().includes('application/json')) return;
            if (init.body !== undefined && (typeof init.body !== 'string' || init.body.length > 8192)) return;
            if (init.body) JSON.parse(init.body);
            return url.pathname;
        } catch { /* An unrecognised request always keeps native behaviour. */ }
    }
    async function attempt(receiver, input, init, pathname, fetcher) {
        const controller = new AbortController();
        // Startup lists can be tens of MB. Browsers expose decompressed chunks,
        // so a Brotli block or an occupied connection can hide wire progress.
        const deadline = pathname === '/api/settings/get' || pathname === '/api/characters/all' ? 60000 : idleMs;
        let timer;
        const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), deadline); };
        let reader;
        try {
            touch();
            const response = await fetcher.call(receiver, input, { ...init, signal: controller.signal });
            touch();
            if (!response.ok) {
                // The character endpoint uses 404 to mean the card was deleted.
                if (pathname === '/api/characters/get' && response.status === 404) return response;
                void response.body?.cancel().catch(() => {});
                const error = new Error('http'); error.status = response.status; throw error;
            }
            if (!response.body) throw new Error('empty-response');
            reader = response.body.getReader();
            const chunks = [];
            while (true) {
                const next = await reader.read();
                if (next.done) break;
                chunks.push(next.value); touch();
            }
            clearTimeout(timer);
            // Blob keeps the binary chunks; no tee/clone of large user responses.
            const blob = new Blob(chunks);
            // Proxy HTML and truncated JSON must never reach getChat's empty-chat
            // failure branch. Validation never logs the user's response contents.
            const value = JSON.parse(await blob.text());
            if (pathname === '/api/settings/get' && (!value || Array.isArray(value) || typeof value.settings !== 'string')) throw new Error('invalid-settings');
            if (pathname.startsWith('/api/chats/') && !Array.isArray(value)) {
                const newSingleChat = pathname === '/api/chats/get' && value !== null && typeof value === 'object' && Object.keys(value).length === 0;
                if (!newSingleChat) throw new Error('invalid-chat');
            }
            let saved;
            if (pathname === '/api/settings/get' && typeof value?.settings === 'string') {
                saved = JSON.parse(value.settings);
                if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('invalid-settings');
                const options = saved.extension_settings;
                if (options?.disabledExtensions?.includes('third-party/tavern-flow') || options?.['tavern-flow']?.enabled === false) enabled = false;
            }
            const headers = new Headers(response.headers);
            headers.delete('content-encoding'); headers.delete('content-length');
            const complete = new Response(blob, { status: response.status, statusText: response.statusText, headers });
            function metadata(result) {
                for (const key of ['url', 'type', 'redirected']) Object.defineProperty(result, key, { value: response[key] });
                const clone = result.clone;
                Object.defineProperty(result, 'clone', { value() { return metadata(clone.call(this)); } });
                return result;
            }
            metadata(complete);
            validatedValues.set(complete, value);
            Object.defineProperty(complete, 'json', { configurable: true, writable: true, value: json });
            if (saved) validatedSettings.set(complete, { text: value.settings, saved });
            if (pathname.startsWith('/api/chats/')) chatBodies.set(complete, blob);
            return complete;
        } finally {
            clearTimeout(timer);
            reader?.releaseLock();
        }
    }
    async function read(receiver, input, init, pathname, fetcher = original) {
        const entry = { label: names.get(pathname), retrying: false, wake: null, stale: false };
        const identity = selectedRead(pathname, init.body);
        stats.reads++; stats.active++;
        let failures = 0;
        try {
            while (true) {
                try {
                    const response = await attempt(receiver, input, init, pathname, fetcher);
                    if (identity !== undefined && chatIdentity() !== identity) {
                        entry.stale = true;
                        throw new Error('chat-selection-changed');
                    }
                    if (failures) stats.recovered++;
                    return response;
                } catch (error) {
                    failures++;
                    waiting.add(entry);
                    const automatic = !entry.stale && failures === 1 && (!error.status || error.status >= 500 || error.status === 408 || error.status === 429);
                    entry.retrying = automatic; render();
                    if (automatic) {
                        // Retry a failed read once; never perform automatic writes.
                        await new Promise(resolve => setTimeout(resolve, 750));
                    } else {
                        entry.retrying = false; render();
                        await new Promise(resolve => { entry.wake = resolve; });
                        entry.wake = null; entry.retrying = true; render();
                    }
                    stats.retries++;
                }
            }
        } finally {
            waiting.delete(entry); stats.active--; render();
        }
    }
    function wrapped(input, init) {
        const path = enabled ? qualify(input, init) : undefined;
        // Native settings and chat navigation have verified hooks. Other
        // callers of the same URLs keep their own response and recovery.
        if (path === '/api/settings/get' || path?.startsWith('/api/chats/')) return original.apply(this, arguments);
        return path ? read(this, input, { ...init, headers: new Headers(init.headers) }, path) : original.apply(this, arguments);
    }
    host.fetch = wrapped;
    host.__tavernFlowBoot = Object.freeze({
        status: () => ({ ...stats, enabled, reason: enabled ? 'active' : 'disabled' }),
        retry,
        async nativeRead(input, init) {
            const path = qualify(input, init);
            const identity = path ? JSON.parse(init.body || '{}') : undefined;
            // Call the current complete fetch chain, so business wrappers remain
            // in place. Its signal makes the ordinary boot wrapper pass through.
            const response = enabled && (path === '/api/settings/get' || path?.startsWith('/api/chats/'))
                ? await read(host, input, { ...init, headers: new Headers(init.headers) }, path, host.fetch)
                : await host.fetch(input, init);
            if (path && response.ok) nativeResponses.set(response, { path, identity });
            return response;
        },
        parseNativeSettings(response, text) {
            const entry = validatedSettings.get(response);
            validatedSettings.delete(response);
            return entry && entry.text === text ? entry.saved : JSON.parse(text);
        },
        outsideCompressionWindow(length, config) {
            if (!enabled) return false;
            const min = Number(config.minPayloadSize) || 0;
            const max = Number(config.maxPayloadSize) || 0;
            return (max > 0 && length > max) || length * 3 < min;
        },
        nativeSavePreparer(path, nativeCompress) {
            return enabled && savePreparer ? savePreparer(path, nativeCompress) : nativeCompress;
        },
        connectSavePreparer(listener) {
            savePreparer = listener;
            return () => { if (savePreparer === listener) savePreparer = undefined; };
        },
        adoptRead(response, value) {
            const resource = nativeResponses.get(response);
            if (!resource) return;
            nativeResponses.delete(response);
            // Settings are already an immutable string. Normally chat reads
            // can reuse the completed Blob, without cloning a mutable history.
            let snapshot;
            try { snapshot = resource.path === '/api/settings/get' ? value : chatBodies.get(response) ?? structuredClone(value); }
            catch { /* Missing snapshots fail closed in the saving Worker. */ }
            chatBodies.delete(response);
            const adoptionKey = JSON.stringify([resource.path, resource.identity]);
            const message = { type: 'seed', ...resource, snapshot, adoptionKey, adoptionId: ++adoptionId };
            adoptions.delete(adoptionKey);
            adoptions.set(adoptionKey, message);
            // Before a Worker is available (including while disabled), retain
            // the settings and the last six chat snapshots. Older entries keep
            // their identity so their old base can never silently be replaced.
            const chats = [...adoptions.values()].filter(item => item.path !== '/api/settings/get' && item.snapshot !== undefined);
            if (chats.length > 6) chats[0].snapshot = undefined;
            sendAdoption?.(message);
        },
        connectAdoptions(listener) {
            sendAdoption = listener;
            for (const message of adoptions.values()) listener(message);
            return () => { if (sendAdoption === listener) sendAdoption = undefined; };
        },
        settleAdoption(key, id) {
            if (adoptions.get(key)?.adoptionId === id) adoptions.delete(key);
        },
        async quickReplyRead(input, init) {
            if (enabled && qualify(input, init) === '/api/settings/get') {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 8000);
                try {
                    const response = await host.fetch('/api/plugins/tavern-flow/quick-reply-presets', { ...init, signal: controller.signal });
                    if (response.ok) {
                        const value = await response.json();
                        if (Array.isArray(value?.quickReplyPresets)) return Response.json(value);
                    } else {
                        void response.body?.cancel().catch(() => {});
                    }
                } catch { /* A missing plugin or failed small read uses the native route. */ }
                finally { clearTimeout(timer); }
            }
            return host.fetch(input, init);
        },
        // Disabling affects new reads. In-flight reads keep recovery until they
        // finish, so toggling cannot reject an outstanding native getChat.
        setEnabled(value) { enabled = !!value; },
    });
})();
