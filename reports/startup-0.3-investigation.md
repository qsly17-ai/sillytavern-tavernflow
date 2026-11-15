# 清酌 0.3 首屏调查与入口预取候选

调查日期：2026-11-15。目标宿主为已安装的 SillyTavern 1.19.0。此次只实现 `client/startup.mjs`，没有改核心、正式配置、其他产品模块或启动真实浏览器。**尚无本候选的浏览器速度收益结论。**

## 为什么 0.2 首屏仍接近原生

清酌 0.2 的前端 manifest 为 `loading_order:999`，并等待原生 `APP_READY` 后才安装大部分模块。这些优化能作用于之后的保存、交互和聊天显示，但赶不上首屏插件下载与初始化。

0.2 的 `startup-settings.mjs` 是每次读取当前磁盘数据的异步接口，主要改善服务端处理大设置期间对其他请求的阻塞。既有完整 HTTP 测量中，单并发中位数 123.48→126.40 ms，不能用它宣称首屏加速；它没有减少浏览器收到的数据，也没有提前初始化业务插件。

1.19.0 启动会先等待 `getSettings()`；其中按 manifest 顺序逐个等待插件 JS、CSS、locale 与 activate hook，然后才依次获取头像、角色、背景等。原生 manifest 下载已经并行，不必再重复实现一套。

## 旧组合的快包含不同机制

| 路径 | 实际改变 | 采用判断 |
| --- | --- | --- |
| 鸡尾酒 startup-optimizer | 同页并行预取头像/角色/背景；`SETTINGS_LOADED` 提前撤遮罩 | 预取可单独评估；撤遮罩只是更早看见页面，不代表已就绪 |
| 鸡尾酒+ module-proxy | 改启动函数调用顺序、并行插件激活、延后部分初始化 | 存在真实并行收益，同时改变插件时序；本候选不复制 |
| 鸡尾酒+ deferred activation | 在 `APP_READY` 后才激活扩展，通过事件重放补偿 | 壳先显示，业务随后就绪；不用于用户要求的单次完整就绪 |
| 鸡尾酒+ characters-all | 未命中时可先给 `[]`，后台构造后再调用核心 `getCharacters()` | 明确的二次加载，不复制 |
| 鸡尾酒+ stale cache | 可在角色签名变化时立即返回旧缓存，再后台更新 | 降低等待但可能先显示旧列表，不复制 |
| 鸡尾酒+ settings cache | 文件签名相同时重用响应正文 | 不属于 0.2 的全新鲜异步读取；本候选不取设置快照 |
| 鸡尾酒+ resource preload | 扩展 JS 使用原 URL 的 modulepreload，CSS 使用 preload | 可与执行顺序分开，作为本轮最小候选 |
| 柏宝箱 fast-bootstrap | 走独立后端的 partial 设置/快速角色接口，失败后原生回退 | 旧服务端是否存在须单独核实，配置开关不等于生效 |

正式宿主已启用原生浅角色列表、角色内存缓存与磁盘缓存。不能把这些原生能力包装成清酌新增收益。旧角色直接 PNG 扫描器同时重写了卡片字段归一化与统计行为，迁移成本大于简单的预取提示，本轮不采用。

## 已实现的唯一候选

`installStartupPreload()` 在清酌入口期安装；建议 manifest 顺序 `-100`。它接收宿主当前的 `extensionNames`、`getExtensionManifest`、`modules`、`CLIENT_VERSION.split(':')[1]`，不自行重新 discover、不读取设置、不执行目标业务模块。

原生先后顺序和 `loading_order` 同分的名称比较保持不变。候选仅向当前页面增加 `rel=modulepreload`、`fetchPriority=low` 的资源提示。初始最多提前两个后续合格入口；只有观察到原生 SCRIPT 入口真实 load/error 才向前推进。提示自身下载完毕不再继续填满全部插件队列。

- 同源扩展目录内 `.js` / `.mjs` 原始 URL，保留 `?ver=`；拒绝外域、绝对路径、路径穿越、编码路径逃逸、反斜杠与 fragment。
- 先排除禁用扩展、未满足 Extras 要求、缺少或禁用依赖、最低版本不满足者；每次准备提示前再核对当前禁用状态。
- 不给已存在的同 URL SCRIPT 再加提示；不处理此前已完成的扩展。
- 只接受已核实的 1.19.0。缺少标准 modulepreload 或事件能力、Save-Data、2G、初始后台页时保持原生。
- 原生剩余入口完成、`APP_READY`、`CHAT_CHANGED`、页面转后台、30 秒上限或显式 `dispose()`，均移除自有监听和 link；不移除其他扩展节点。
- 没有 CSS、模板、API 或聊天资源预取，没有 SW、fetch 替换、settings 响应缓存、APP_READY 伪造或 reload。

入口接线应直接、同步调用，不等 `APP_READY`，独立持有返回句柄；不能因为普通显示选项变更重建此模块。启停时调用 `dispose()`。1.19.0 会给较晚的 `APP_READY` 订阅重放事件，所以页面完全加载后再启用不会重新预取。

```js
const startup = installStartupPreload({
    context: SillyTavern.getContext(),
    extensionNames: extensions.extensionNames,
    getManifest: extensions.getExtensionManifest,
    availableModules: extensions.modules,
    clientVersion: core.CLIENT_VERSION.split(':')[1],
    enabled: true,
});
```

`core`、`extensions` 应由入口使用目标宿主现有模块导出取得。本模块不会导入业务扩展。

## 复用条件与无收益边界

已经核对宿主 `addExtensionScript` 使用 `/scripts/extensions/${name}/${manifest.js}`，本候选将同一字面路径交给相同 URL 规范化规则，包含 query，单元测试验证这一条件。modulepreload 不执行模块；它可以提前完成下载、解析和编译，原生 SCRIPT 才负责执行。不得改成 `import(target)`，那会提前执行。

实际是否重用还需浏览器网络轨迹确认：URL 与 query、模块类型、credentials/crossorigin、页面模块 map、服务端响应与缓存规则均应相容。当前宿主 SCRIPT 无 crossorigin，候选 link 也保留默认同源凭证模式。记录每入口的实际传输与加载时刻，不能用“增加了 link 数”代替重用证据。

暖缓存、低延迟回环网络、初始化 CPU 或远程脚本成为主因时，收益可能很小。modulepreload 没有减少总脚本字节或业务初始化工作；更早编译也可能挤占主线程。`fetchPriority=low` 是浏览器提示，不是带宽隔离；两个入口的依赖图仍可能发出更多请求。删除 hint 不保证取消已经发出的浏览器请求。因此它仅保证有界入口提示和及时停止，不保证任意网络下无竞争。

对目标消息 iframe 自身、MVU 更新后的重渲染或插图 tag 的卡顿，此候选没有直接修复作用，不能把两类问题混作一个优化成果。

## 已运行检查与待验收门

`UV_THREADPOOL_SIZE=1 NODE_OPTIONS=--v8-pool-size=1 node --test tests/startup-preload.test.mjs`：6/6 通过。覆盖 URL/query 边界、原生排序/资格、提示完成不无界推进、原生入口事件推进、禁用状态复查、节点所有权、ready 重放、聊天/后台退出与能力失配。`node --check client/startup.mjs` 通过。

主控接线后需在同一插件版本和同一数据上交替开关测量：冷网络/暖缓存各至少三组；明确区分最后业务就绪、遮罩消失和首个正文。记录 settings/get、插件 JS 瀑布、角色列表与聊天 iframe 阶段，同时收集最大 longtask。冷网络可在隔离宿主用网络限速制造，不要清正式数据或关闭业务插件制造结果。

若实际传输重复、初始化次序变化、业务缺失、长任务变差或提速无法测出，本轮先关闭此可选模块。回退只需不调用该模块/关闭其选项并刷新；它没有永久状态、核心修改、SW 或服务器响应缓存。

源码私有证据：`private/startup-03-source-evidence.json`。该文件只记录已检查公共程序源码的路径、SHA-256 与行范围，不收录设置、卡片、聊天或密钥。技能路由为 `sillytavern-extension-dev` / `code-quality-workflow`；快照 2026-08-18，已读 ST-A0、ST-D5、ST-E5。实际接口与时序结论以本次 1.19.0 安装源码为权威，浏览器与手机收益尚待主控验证。
