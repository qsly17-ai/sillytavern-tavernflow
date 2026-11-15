// Optional offline browser gate. No real host, user data, or model is contacted.
// Requires TAVERNFLOW_PLAYWRIGHT_PATH, TAVERNFLOW_CHROMIUM_PATH,
// TAVERNFLOW_JQUERY_PATH and TAVERNFLOW_JQUERY_UI_PATH.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TAVERNFLOW_PLAYWRIGHT_PATH ?? 'playwright');
const browser = await chromium.launch({ executablePath: process.env.TAVERNFLOW_CHROMIUM_PATH,
    headless: true, args: ['--no-sandbox'] });
try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1600 } });
    page.setDefaultTimeout(10000);
    if (!process.env.TAVERNFLOW_JQUERY_PATH || !process.env.TAVERNFLOW_JQUERY_UI_PATH) throw new Error('host library paths required');
    await page.addScriptTag({ path: process.env.TAVERNFLOW_JQUERY_PATH });
    await page.addScriptTag({ path: process.env.TAVERNFLOW_JQUERY_UI_PATH });
    const source = await readFile(new URL('../client/interactions.js', import.meta.url), 'utf8');
    const fixture = await readFile(new URL('./fixtures/prompt-manager-1.19.0.mjs', import.meta.url), 'utf8');
    await page.addScriptTag({ type: 'module', content: `${fixture}\nwindow.PromptManagerFixture=PromptManagerFixture;` });
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.installTFFeatures=installInteractionFeatures;` });
    const checks = await page.evaluate(async () => {
        const checks = [];
        const assert = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
        const manager = new window.PromptManagerFixture();
        const list = document.createElement('ul');
        list.id = 'completion_prompt_manager_list';
        list.innerHTML = '<li class="completion_prompt_manager_prompt" data-pm-identifier="main"><span class="prompt-manager-toggle-action fa-toggle-on"></span><span class="tokens">42</span></li>';
        document.body.append(list);
        const row = list.firstElementChild, icon = row.firstElementChild;
        icon.addEventListener('click', manager.handleToggle);
        const module = window.installTFFeatures({ clientVersion: 'SillyTavern:1.19.0:Cohee#1207',
            getPromptManager: () => manager, options: { lightweightDrag: false } });
        assert(module.status().promptToggle, 'native prompt authority capability');
        icon.click();
        assert(!manager.entries[0].enabled && icon.classList.contains('fa-toggle-off')
            && row.classList.contains('completion_prompt_manager_prompt_disabled'), 'first toggle is immediately authoritative');
        assert(manager.renderCalls === 1 && manager.saveCalls === 1 && manager.counts.main === null,
            'native render/save/token invalidation preserved');
        assert(row.querySelector('.tokens').textContent === '42', 'token display is not fabricated');
        icon.click(); icon.click();
        assert(manager.saveCalls === 3 && manager.renderCalls === 3 && module.status().promptSyncs === 3,
            'three clicks keep all native calls');
        const laterManager = new window.PromptManagerFixture();
        laterManager.entries[0].enabled = false;
        icon.removeEventListener('click', manager.handleToggle);
        icon.addEventListener('click', laterManager.handleToggle);
        module.dispose();
        const current = window.installTFFeatures({ clientVersion: 'SillyTavern:1.19.0:Cohee#1207',
            getPromptManager: () => laterManager, options: { lightweightDrag: false } });
        icon.click();
        assert(laterManager.entries[0].enabled && icon.classList.contains('fa-toggle-on'), 'reinstall reads current manager state');
        current.dispose();
        const mismatch = window.installTFFeatures({ clientVersion: 'SillyTavern:1.20.0:Cohee#1207', getPromptManager: () => laterManager });
        icon.click();
        assert(!laterManager.entries[0].enabled && icon.classList.contains('fa-toggle-on')
            && mismatch.status().promptSyncs === 0, 'version mismatch leaves native path untouched');
        mismatch.dispose(); list.remove();
        return checks;
    });
    await page.addStyleTag({ content: `body{margin:16px;font:16px sans-serif;background:#15171c;color:#eee}
        #world_popup_entries_list{width:650px;margin:0;padding:0;list-style:none}
        .world_entry{position:relative;box-sizing:border-box;height:110px;padding:8px;border:1px solid #666;margin:4px 0;background:#28303c}
        .drag-handle{display:inline-block;width:44px;height:28px;cursor:move;vertical-align:middle}
        textarea{width:120px;height:24px;vertical-align:middle}.ui-sortable-placeholder{border:1px dashed orange}
        .heavy-grid{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:1px;font-size:9px}
        .heavy-grid>div{border:1px solid #446;box-shadow:0 1px 2px #0005;overflow:hidden}
        .heavy-grid input{width:30px;height:10px;font-size:8px;padding:0}` });
    await page.evaluate(() => {
        window.tfChecks = [];
        window.tfAssert = (condition, label) => { if (!condition) throw new Error(label); window.tfChecks.push(label); };
        window.makeSortFixture = ({ heavy = false, original = false, callbackCancel = false } = {}) => {
            window.tfModule?.dispose();
            const previous = document.querySelector('#world_popup_entries_list');
            if (previous) { window.jQuery(previous).sortable('destroy'); previous.remove(); }
            const list = document.createElement('ul'); list.id = 'world_popup_entries_list';
            const fragment = document.createDocumentFragment();
            for (let i = 0; i < 4; i++) {
                const row = document.createElement('li'); row.className = 'world_entry'; row.id = `synthetic-${i}`;
                row.innerHTML = `<span class="drag-handle">☰</span><textarea name="comment">Synthetic ${i}</textarea><span class="marker">original node</span>`;
                if (heavy) {
                    row.style.height = '300px';
                    const grid = document.createElement('div'); grid.className = 'heavy-grid';
                    for (let j = 0; j < 200; j++) {
                        const cell = document.createElement('div');
                        cell.innerHTML = `<span>${j}</span><input value="${j}"><span> · </span>`; grid.append(cell);
                    }
                    row.append(grid);
                }
                fragment.append(row);
            }
            list.append(fragment); document.body.append(list);
            window.tfFirst = list.firstElementChild;
            window.tfMarker = window.tfFirst.querySelector('.marker');
            window.tfEvents = [];
            const record = type => (_event, ui) => window.tfEvents.push({ type, item: ui.item[0],
                helper: ui.helper?.[0], helperHeight: ui.helper?.[0]?.offsetHeight,
                placeholderHeight: ui.placeholder?.[0]?.offsetHeight });
            const update = record('update'), stop = record('stop');
            window.jQuery(list).sortable({ delay: 0, distance: 1, handle: '.drag-handle', items: '.world_entry',
                start: record('start'), update, stop });
            window.tfModule = window.installTFFeatures({ clientVersion: 'SillyTavern:1.19.0:Cohee#1207',
                options: { promptToggle: false, lightweightDrag: !original } });
            window.tfAssert(window.jQuery(list).sortable('option', 'update') === update
                && window.jQuery(list).sortable('option', 'stop') === stop, 'native callback identities retained');
            return { height: window.tfFirst.offsetHeight, count: window.tfFirst.querySelectorAll('*').length };
        };
    });
    const dragStart = async () => {
        const box = await page.locator('#synthetic-0 .drag-handle').boundingBox();
        await page.mouse.move(box.x + 15, box.y + 14); await page.mouse.down();
        await page.mouse.move(box.x + 18, box.y + 25, { steps: 2 });
        return box;
    };
    const dragToEnd = async (box, distance = 300, steps = 12) => {
        await page.mouse.move(box.x + 25, box.y + distance, { steps }); await page.mouse.up();
    };
    const geometry = await page.evaluate(() => window.makeSortFixture());
    let start = await dragStart();
    await page.evaluate(height => {
        const event = window.tfEvents.find(event => event.type === 'start');
        window.tfAssert(event.item === window.tfFirst && event.helper !== window.tfFirst, 'actual drag keeps original ui.item');
        window.tfAssert(event.helperHeight === height && event.placeholderHeight === height, 'helper and placeholder keep original height');
        window.tfAssert(event.helper.querySelectorAll('textarea,input,button,iframe').length === 0, 'actual helper has no business controls');
    }, geometry.height);
    await dragToEnd(start);
    await page.evaluate(() => {
        const events = window.tfEvents;
        window.tfAssert(events.filter(e => e.type === 'update').length === 1 && events.filter(e => e.type === 'stop').length === 1,
            'one native update and stop after reorder');
        window.tfAssert(document.querySelector('#world_popup_entries_list').children[0] !== window.tfFirst,
            'native engine changes actual order');
        window.tfAssert(window.tfFirst.querySelector('.marker') === window.tfMarker, 'original child node identity survives reorder');
        window.tfAssert(!document.querySelector('.tf-sortable-helper'), 'native stop removes lightweight helper');
    });
    // Native cancellation must retain its own callback/order semantics.
    const cancellation = [];
    for (const original of [true, false]) {
        await page.evaluate(original => window.makeSortFixture({ original }), original);
        start = await dragStart();
        await page.mouse.move(start.x + 25, start.y + 270, { steps: 8 });
        await page.evaluate(() => window.jQuery('#world_popup_entries_list').sortable('cancel'));
        await page.mouse.up();
        cancellation.push(await page.evaluate(() => ({ order: [...document.querySelector('#world_popup_entries_list').children].map(n => n.id),
            callbacks: window.tfEvents.map(e => e.type) })));
    }
    if (JSON.stringify(cancellation[0]) !== JSON.stringify(cancellation[1])) throw new Error('cancellation semantics differ');
    checks.push('native cancellation order and callback semantics match original helper');
    await page.evaluate(() => {
        window.makeSortFixture();
        const widget = window.jQuery('#world_popup_entries_list').sortable('instance');
        const helper = widget.options.helper;
        const frame = document.createElement('iframe'); window.tfFirst.append(frame);
        const iframeWindow = frame.contentWindow; iframeWindow.testState = 7;
        window.tfAssert(helper(null, window.jQuery(window.tfFirst))[0] === window.tfFirst, 'iframe row uses original helper');
        window.tfAssert(frame.contentWindow === iframeWindow && frame.contentWindow.testState === 7, 'iframe identity and state untouched');
        frame.remove();
        window.tfFirst.querySelector('textarea').focus();
        window.tfAssert(helper(null, window.jQuery(window.tfFirst))[0] === window.tfFirst, 'focused editor uses original helper');
        document.activeElement.blur();
        const later = () => window.tfFirst;
        widget.option('helper', later); window.tfModule.dispose();
        window.tfAssert(widget.options.helper === later, 'dispose respects a later helper owner');
        window.makeSortFixture();
        const second = window.jQuery('#world_popup_entries_list').sortable('instance');
        window.tfModule.dispose();
        window.tfAssert(second.options.helper === 'original', 'dispose restores native default helper');
        second.option('helper', later);
        window.tfModule = window.installTFFeatures({ clientVersion: 'SillyTavern:1.19.0:Cohee#1207' });
        window.tfAssert(second.options.helper === later && window.tfModule.status().customHelpersSkipped === 1,
            'preexisting custom helper is preserved');
        window.tfModule.dispose();
        second.option('helper', 'original');
        window.tfModule = window.installTFFeatures({ clientVersion: 'SillyTavern:1.19.0:Cohee#1207' });
        window.jQuery('#world_popup_entries_list').sortable('destroy').sortable({ items: '.world_entry', handle: '.drag-handle' });
        const recreated = window.jQuery('#world_popup_entries_list').sortable('instance');
        window.tfFirst.querySelector('.drag-handle').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
        window.tfAssert(typeof recreated.options.helper === 'function', 'recreated native widget is prepared lazily');
        window.tfModule.dispose();
        window.tfAssert(recreated.options.helper === 'original', 'recreated widget restores on dispose');
    });
    const extraChecks = await page.evaluate(() => window.tfChecks.slice());
    // Finish the synthetic lazy-preparation mousedown before measuring real drags.
    await page.mouse.up();
    const session = await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    const rounds = [];
    const metrics = async () => Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
    for (let round = 0; round < 3; round++) {
        for (const original of round % 2 ? [false, true] : [true, false]) {
            const fixtureStats = await page.evaluate(original => window.makeSortFixture({ heavy: true, original }), original);
            await page.evaluate(() => { window.tfFrameTimes = []; window.tfFrameRunning = true;
                let previous = performance.now();
                const sample = now => { window.tfFrameTimes.push(now - previous); previous = now;
                    if (window.tfFrameRunning) requestAnimationFrame(sample); };
                requestAnimationFrame(sample);
            });
            const before = await metrics();
            start = await dragStart();
            await page.mouse.move(start.x + 100, start.y + 850, { steps: 45 });
            await page.mouse.move(start.x + 25, start.y + 650, { steps: 20 });
            await page.mouse.up();
            const after = await metrics();
            const frames = await page.evaluate(() => {
                window.tfFrameRunning = false;
                const events = window.tfEvents.map(event => event.type);
                if (events.join(',') !== 'start,update,stop') throw new Error(`benchmark drag incomplete: ${events}`);
                if (document.querySelector('#world_popup_entries_list').firstElementChild === window.tfFirst)
                    throw new Error('benchmark did not reorder');
                return window.tfFrameTimes.slice(1);
            });
            rounds.push({ round, helper: original ? 'original' : 'lightweight', ...fixtureStats,
                layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
                styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
                scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
                taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
                frameCount: frames.length, maxFrameMs: Math.max(...frames),
                framesOver25Ms: frames.filter(ms => ms > 25).length });
        }
    }
    const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const medians = Object.fromEntries(['original', 'lightweight'].map(helper => [helper,
        Object.fromEntries(['layoutMs', 'styleMs', 'scriptMs', 'taskMs', 'maxFrameMs', 'framesOver25Ms'].map(key => [key,
            median(rounds.filter(result => result.helper === helper).map(result => result[key]))]))]));
    process.stdout.write(`${JSON.stringify({ browser: browser.version(), jquery: '3.5.1', jqueryUI: '1.13.2',
        checks: [...checks, ...extraChecks], cancellation, rounds, medians,
        note: 'Synthetic offline desktop Chromium sortable benchmark; no full-host, phone, GPU, power, or overall speed claim.' }, null, 2)}\n`);
} finally { await browser.close(); }
