// SPDX-License-Identifier: AGPL-3.0-only
const reasons = { active: '运行中', disabled: '已关闭', disposed: '已停止', starting: '准备中',
    'overlapping-optimizer': '检测到重叠优化，请先停用旧组合并刷新', 'backend-unavailable': '服务端未就绪',
    'worker-capability-unavailable': '浏览器暂不支持后台保存', 'native-input-sizing-preserved': '保留原生输入布局',
    'reload-required': '保存冲突或结果未确认，请刷新后重新读取',
    'disabled-or-existing-compat-patch': '已关闭或由原兼容补丁处理',
    'native-selected-options-fast-path': '原生选项查询快路', preloading: '并行预取中',
    'native-entries-complete': '本次预取完成', 'app-ready': '酒馆已就绪', 'chat-opened': '已让出聊天加载',
    'connection-saving': '省流量模式，保持原生加载', 'background-page': '后台页面，保持原生加载',
    'unverified-host-version': '当前版本保持原生加载', 'no-later-entries': '无需预取', 'time-limit': '预取结束',
    'next-start': '下次打开时生效', 'host-capability-unavailable': '当前浏览器保持原生显示',
    'host-version-mismatch': '酒馆版本变化，保持原生显示', 'helper-version-mismatch': '助手版本变化，保持原生显示',
    'version-unavailable': '版本未确认，保持原生显示', 'stylesheet-failed': '样式不可用，保持原生显示',
    'runtime-failed': '已安全恢复原生显示', 'chat-timeout-budget-exhausted': '本聊天保持原生显示' };
const bytes = n => n < 1024 ? `${Math.round(n)} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
export function mountPanel({ onChange }) {
    const root = document.createElement('div'); root.id = 'tf-panel';
    root.className = 'extension_container';
    root.innerHTML = `<details class="tf-shell"><summary><span class="tf-mark" aria-hidden="true">酌</span><span><b>清酌</b><small>TavernFlow · 性能优化</small></span><span class="tf-state">准备中</span></summary>
      <div class="tf-body"><p class="tf-intro">前端加载减负、后台差量保存，让聊天和常用操作更及时回应。</p>
      <div class="tf-metrics" aria-live="off"><div><strong data-stat="saved">0 B</strong><span>本页减少上传</span></div><div><strong data-stat="deferred">0</strong><span>轻量绘制楼层</span></div><div><strong data-stat="saves">0</strong><span>后台保存次数</span></div></div>
      <div class="tf-notice" role="status"></div><div class="tf-switches"></div>
      <p class="tf-note">MVU、酒馆助手、提示词模板、小白X与数据库仍负责原有功能。含 iframe 的楼层保持实时。</p>
      <details class="tf-diagnostics"><summary>模块状态</summary><dl></dl></details>
      <small class="tf-version">0.3.0 · SillyTavern 1.19.0</small></div></details>`;
    const switches = root.querySelector('.tf-switches');
    const choices = [['enabled', '启用清酌'], ['sourceGuard', '重前端加载减负'], ['startupPreload', '首屏并行预取（试验，下次打开生效）'], ['transport', '后台差量保存'], ['render', '历史文字绘制减负'], ['tokens', '合并并发 Token 计数'], ['fastPaths', '命令与正则快速路径'], ['quickDrawers', '抽屉即时展开'], ['interactions', '预设开关即时响应'], ['lightweightDrag', '轻量拖影（试验）']];
    for (const [key, label] of choices) {
        const row = document.createElement('label'); row.className = 'tf-switch';
        const text = document.createElement('span'); text.textContent = label;
        const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.option = key;
        row.append(text, input); switches.append(row);
    }
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) throw new Error('TavernFlow: extension settings container unavailable');
    target.append(root);
    const listener = event => {
        const key = event.target?.dataset?.option;
        if (key) Promise.resolve(onChange(key, event.target.checked)).catch(() => {
            root.querySelector('.tf-notice').textContent = '切换未完成，请刷新后查看模块状态。';
        });
    };
    root.addEventListener('change', listener);
    let timer, latest;
    const paint = () => {
        timer = null;
        if (!latest) return;
        const { modules = {}, options = {}, blockers = [] } = latest;
        const transport = modules.transport || {};
        const requiresReload = latest.requiresReload || transport.requiresReload;
        root.querySelector('[data-stat="saved"]').textContent = bytes(Math.max(0, (transport.sourceBytes || 0) - (transport.sentBytes || 0)));
        root.querySelector('[data-stat="deferred"]').textContent = String(modules.render?.deferred || 0);
        root.querySelector('[data-stat="saves"]').textContent = String(transport.completed || 0);
        const state = root.querySelector('.tf-state');
        state.textContent = requiresReload ? '需刷新' : !latest.enabled ? '已暂停' : blockers.length ? '待切换' : transport.enabled ? '运行中' : '前端模式';
        const notice = root.querySelector('.tf-notice');
        notice.textContent = requiresReload ? '保存发生冲突，或上次保存结果未确认。请先复制未保存的输入和修改，再刷新并重新打开聊天。切换开关不会解除此保护。' : blockers.length ? `当前仍加载 ${blockers.join('、')}，清酌已让出重叠模块。停用旧优化并刷新后接管。` : !latest.backend ? '未连接清酌服务端，后台保存和计数保持原生路径。' : latest.legacyWorker?.controlled ? '已注销旧优化后台。请先保存草稿，再关闭所有旧酒馆页面并重新打开，完成切换。' : latest.legacyWorker?.failed ? '旧优化后台注销未完成，请关闭旧页面后重开查看。' : '';
        notice.hidden = !notice.textContent;
        for (const input of root.querySelectorAll('[data-option]')) input.checked = !!options[input.dataset.option];
        const dl = root.querySelector('dl'); dl.replaceChildren();
        for (const [key, label] of [['sourceGuard', '重前端'], ['preload', '首屏预取'], ['transport', '后台保存'], ['render', '长聊天'], ['tokens', 'Token计数'], ['fastPaths', '快速路径'], ['interactions', '预设与拖动'], ['ui', '输入布局']]) {
            const status = modules[key] || {}, dt = document.createElement('dt'), dd = document.createElement('dd');
            dt.textContent = label; dd.textContent = key === 'ui' && status.selectedOptionsFastPath ? `选项查询快路 · 命中 ${status.selectedOptionHits || 0} 次` : reasons[status.reason] || status.reason || '准备中'; dl.append(dt, dd);
        }
        if (latest.backend?.startup) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = '启动读取'; dd.textContent = latest.backend.startup.active ? '全新鲜异步读取' : '原生路径'; dl.append(dt, dd); }
    };
    return { update(state) { latest = state; if (!timer) timer = setTimeout(paint, 150); },
        dispose() { clearTimeout(timer); root.removeEventListener('change', listener); root.remove(); } };
}
