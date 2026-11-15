// Manual browser gate; optional Playwright is not a runtime extension dependency.
// Set TAVERNFLOW_PLAYWRIGHT_PATH, TAVERNFLOW_CHROMIUM_PATH and
// TAVERNFLOW_JQUERY_PATH to the installed test tools/host jQuery file.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TAVERNFLOW_PLAYWRIGHT_PATH ?? 'playwright');
const browser = await chromium.launch({ executablePath: process.env.TAVERNFLOW_CHROMIUM_PATH,
    headless: true, args: ['--no-sandbox'] });
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    if (!process.env.TAVERNFLOW_JQUERY_PATH) throw new Error('TAVERNFLOW_JQUERY_PATH is required');
    await page.addScriptTag({ path: process.env.TAVERNFLOW_JQUERY_PATH });
    const source = await readFile(new URL('../client/ui-optimizations.js', import.meta.url), 'utf8');
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.installTFUI = installUIOptimizations;` });
    const results = await page.evaluate(() => {
        const $ = window.jQuery;
        const originalFind = $.fn.find;
        const checks = [];
        const assert = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
        const create = (count, multiple = false) => {
            const select = document.createElement('select');
            select.multiple = multiple;
            const fragment = document.createDocumentFragment();
            for (let i = 0; i < count; i++) fragment.appendChild(new Option(`option ${i}`, `${i}`));
            select.append(fragment);
            document.body.append(select);
            return select;
        };
        const module = window.installTFUI();
        assert(module.status().selectedOptionsFastPath, 'pinned jQuery capability enabled');
        const compare = (select, label) => {
            const query = $(select);
            const expected = Reflect.apply(originalFind, query, ['option:selected']).toArray();
            const actual = query.find('option:selected');
            assert(expected.length === actual.length && expected.every((node, i) => node === actual[i]), label);
            assert(actual.end() === query, `${label}: .end identity`);
            return actual;
        };
        const single = create(100);
        single.selectedIndex = 73;
        compare(single, 'single');
        single.options[73].disabled = true;
        compare(single, 'disabled selected option');
        const snapshot = $(single).find('option:selected');
        single.options[17].selected = true;
        compare(single, 'programmatic selection without events');
        assert(snapshot[0] === single.options[73], 'snapshot is not a live collection');
        single.selectedIndex = -1;
        compare(single, 'no selection');
        single.append(new Option('new option', 'new', false, true));
        compare(single, 'add selected option immediately');
        single.removeChild(single.lastElementChild);
        compare(single, 'remove selected option immediately');
        const multiple = create(100, true);
        multiple.options[3].selected = true;
        multiple.options[50].selected = true;
        const group = document.createElement('optgroup');
        group.disabled = true;
        group.appendChild(new Option('grouped', 'grouped', false, true));
        multiple.append(group);
        compare(multiple, 'multiple with disabled optgroup');
        compare(create(0), 'empty');
        compare($([single, multiple]), 'multiple contexts fallback');
        const inner = create(10);
        single.append(inner);
        compare(single, 'nested select fallback');
        inner.remove();
        const oldPseudo = $.expr.pseudos.selected;
        $.expr.pseudos.selected = option => option.value === '5';
        compare(single, 'custom selected pseudo fallback');
        $.expr.pseudos.selected = oldPseudo;
        const before = module.status();
        assert(before.selectedOptionHits > 0 && before.selectedOptionFallbacks > 0, 'both optimization and fallback exercised');
        const timings = [];
        for (const count of [100, 1000]) {
            const select = create(count);
            select.selectedIndex = count - 1;
            const query = $(select);
            const iterations = count === 100 ? 250 : 100;
            const native = [], baseline = [];
            for (let warm = 0; warm < 20; warm++) query.find('option:selected');
            for (let round = 0; round < 3; round++) {
                let start = performance.now();
                for (let i = 0; i < iterations; i++) Reflect.apply(originalFind, query, ['option:selected']);
                baseline.push(performance.now() - start);
                start = performance.now();
                for (let i = 0; i < iterations; i++) query.find('option:selected');
                native.push(performance.now() - start);
            }
            const median = values => values.sort((a, b) => a - b)[1];
            const originalMs = median(baseline), optimizedMs = median(native);
            timings.push({ count, iterations, rounds: 3, originalMs, optimizedMs, speedup: originalMs / optimizedMs });
            select.remove();
        }
        module.dispose();
        assert($.fn.find === originalFind, 'dispose restores original function');
        const second = window.installTFUI();
        const installedFind = $.fn.find;
        const laterWrapper = function () { return Reflect.apply(installedFind, this, arguments); };
        $.fn.find = laterWrapper;
        second.dispose();
        const afterDispose = second.status().selectedOptionHits;
        compare(single, 'later wrapper remains functional after dispose');
        assert($.fn.find === laterWrapper && second.status().selectedOptionHits === afterDispose,
            'later owner retained and disposed optimization inert');
        $.fn.find = originalFind;
        return { jquery: $.fn.jquery, checks, timings, status: before,
            note: 'Synthetic desktop Chromium selector benchmark, not full-host or phone performance.' };
    });
    process.stdout.write(`${JSON.stringify({ browser: browser.version(), ...results }, null, 2)}\n`);
} finally {
    await browser.close();
}
