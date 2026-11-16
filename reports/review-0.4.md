# 清酌 TavernFlow 0.4 独立审查

审查结论：截至最新源码快照，没有已确认且未修复的 P0/P1，代码审查通过。主控提供的隔离故障、单轮弱网冷暖测量及正式部署汇总已复核；本版可按弱网恢复与传输减量范围交付，整页稳定提速未获证明，暖启动本轮较慢的结果保留。最终重打包及公开 HTTPS 下载校验仍待完成；手机真机、实际网络高峰和内存/耗电限度继续保留。后续门关闭回执与最新源码聚合见报告末尾。

## Routing Decision

- 方法：`code-quality-workflow` 的 `diff-regression-scan`，完整检查 0.4 新增/修改面，并按调用依赖扩读；不是对全部历史源码重新作全量审查。
- 独立窗口配置：`fork_turns="none"`、模型 `gpt-6.1-sol`、推理档位 `max`；配置依据为主控已核实的实际工具元数据。
- 目标：当前仓库，分支 `release/0.4.0`；基线 `8cfe20b6da308f40823897b683993cc8d4dbb2e9`（0.3.0）。
- 宿主依据：SillyTavern 1.19.0 / `7e8663cd9` 的公开程序源码。正式宿主仅作源码只读核对；安装/卸载实验只作用于本审查创建的临时目录。
- 执行边界：本窗口未启动浏览器、宿主服务器或模型请求，未改产品源码、第三方插件或正式数据。依主控追加授权，仅新增必要安装回归测试到 `tests/install.test.mjs`，并撰写本脱敏报告。
- 资料路由：已载入质量审查流程、audit-and-sweep、TavernWeave 通信/插件运行边界及 ST-A0；路由快照 `2026-08-18`。无待选设计候选或隐含扩权。
- 排除：`private/`、`release/`、凭证、私人配置/卡片/聊天、原始会话与网络日志。后续主控明确授权仅只读一个部署驱动脚本，未遍历其所在私人目录，也未运行该脚本。此报告只有程序位置、聚合测试结果及合成 A/B 夹具。

## Must Fix Now

当前没有未关闭的已确认 P0/P1。以下缺陷曾在本次迭代中确认，已由主控修改、由本窗口复核；不能把它们当成现版本仍存在的问题，也不能把旧快照的通过结果替代新入口的真实验收。

| 编号 | 原触发与影响 | 修复及复核证据 | 状态 |
| --- | --- | --- | --- |
| R1 / P1 | 仅按“请求文件等于当前聊天”判断原生导航，会把第三方导出当前 A 的读请求接管；用户切换 B 后，一个原本成功的响应永久 pending 并强制重载。后续仅靠直接调用栈的方案在真实多层业务 fetch 包装中失去原生调用帧，核心恢复能力未覆盖。 | `client/boot.js:204` 普通 chat fetch 完全透传；`:215` 的显式 nativeRead 从最外层调用当前完整 fetch 链。`scripts/install.py:9` 对完整指纹核验的两个原生入口作精确局部标记，不再依赖 Error.stack。实际打过标记的单聊、群聊原生函数，在独立 VM 中各穿过 20 层包装，503→完整 200 均为两次请求、完整内容、recovered=1；普通助手当前文件读切聊后原响应透传。主控真宿主汇总另记录十项单聊场景及群聊 503 恢复通过，来源与范围见下文。 | 已关闭 |
| R1b / P1 | 群聊共享 `loadGroupChat` 同时服务导航和群成员重命名的后台批处理。若直接接管它的全部 fetch，后台读也可能错误绑定当前会话。 | `scripts/install.py:11` 在共享函数新增默认 false 的 nativeNavigation 参数，仅 `getGroupChat` 的导航调用传 true。独立运行实际安装后的共享函数，默认后台路径在 A→B 后正常完成、boot reads=0；无 boot 时显式导航仍回落 fetch。原有重命名调用保持默认参数。 | 已关闭 |
| R2 / P1 | 停用路径曾令 path=false，`path?.startsWith` 仍尝试调用不存在的方法，停用后普通请求可能抛错。 | `client/boot.js:205` 使用 undefined 表示不匹配；停用后的聊天、世界书、保存和普通 GET 均返回原 fetch 结果。 | 已关闭 |
| R3 / P2 | 恢复对话框禁止取消且锁住背景，却要求复制背景输入草稿，实际无法完成这一步。 | `client/boot.js:70` 在框内提供只读草稿及复制按钮；剪贴板拒绝时聚焦/选择并提示手动复制；重载确认取消保留框。合成夹具覆盖完整 Unicode 草稿、复制拒绝及取消重载；主控 390×844 真宿主浏览器汇总记录相同行为通过。真正手机长按/键盘体验仍未验。 | 已关闭；手机真机限度保留 |
| R4 / P1 | 安装器在第二次宿主写入失败后，如果补偿写入也持续失败，异常会跳过 moved 目录恢复，TemporaryDirectory 随后删除已搬走的两个插件备份。已由持续 OSError 夹具复现两个目录消失。 | `scripts/install.py:39` 修改前独立保存三个宿主文件原字节及 recovery.json；`:47` 逐项补偿，单项失败不阻止目录恢复；`:53` 任一补偿失败时保留持久 staging 并报告其路径。一次故障分别注入安装/卸载全部三个写入点，均字节与权限完全恢复；持续故障下卸载目录完整保留，安装目录与回执保留，三个备份的 SHA 均等于故障前字节。 | 已关闭 |

## 关键行为核对

早期 boot 不制造空聊天、旧结果或提前的业务事件。请求须满足明确同源 POST JSON 签名；写入、跨源、query 变体、Request 对象、调用者 signal/keepalive/omit 均保留原合约。聊天恢复只由指纹核验的原生入口显式进入，第三方 chat fetch 不被泛化接管。

每次尝试完整读取字节、校验 JSON，再交还原生消费者；HTTP 错误、代理 HTML、截断 JSON 不进入原生空聊天失败分支。仅第一次可恢复读失败自动重试，随后等手工动作；设置/全角色列表为 60 秒无可见进展，其他明确读为 30 秒，持续慢传不限总耗时。已经接管的在途读不会因总开关变化被直接拒绝。

服务端 Brotli 对完整设置响应异步压缩，无私人响应缓存，输入预算 64 MiB、最多两项压缩并发；协商、错误/超限回落及清理路径已追踪并测试。提前准备的保存 Worker 与 APP_READY 后路径沿用同一会话；初始化失败、健康响应体卡住、早期关闭及事件监听能力门已检查。旧保存协议的基线、冲突、结果未确认后锁定及停启边界由现有回归覆盖。

安装/卸载只管理自有两个目录、index 自有 inline 块及两个核心原生入口的精确替换（群聊入口含三个必要局部替换）。完整宿主源码 SHA 校验先行；卸载按回执逐段核验，不用整份旧核心文件覆盖用户后改。后续核心/索引无关字节、原有 mode、0.3 无早期块的旧目录回退均有复核。

## Coverage

“reviewed”指已读对应变更和相关调用路径，不代表真宿主接受。“partial”不是遗漏隐藏为通过；完整路径清单另见末尾快照。

| 范围 | 状态 | 证据与边界 |
| --- | --- | --- |
| `client/boot.js` | reviewed | 全文；签名、完整性、重试/手动恢复、开关、身份、草稿与新 nativeRead 全链 |
| `client/index.js`、`client/panel.js`、manifest | reviewed | 0.4 全部变更；健康超时覆盖 body、同一早期 Worker、APP_READY 与监听能力门、诊断和 hidden 的宿主 CSS 兼容 |
| `server/startup-wire.mjs` | reviewed | 全文；异步 Brotli、协商、有界并发、清理与原响应回落 |
| `server/startup-settings.mjs` | reviewed | 0.4 全部变更及原读取接入；非缓存和私有完整数据语义 |
| `server/index.mjs` | partial | 本轮版本变更及依赖的原生保存、状态/接入链；不是历史服务端全部源码重审 |
| `client/transport.js`、`client/worker.js`、`shared/protocol.mjs` | reviewed / partial | transport 与协议全文，Worker 关键保存/哈希/队列全链；依赖扩读，没有将 Worker 非关键旧分支声称为全量重审 |
| `scripts/install.py`、`scripts/package.mjs` | reviewed | 当前全文、两个核心入口标记、回执、一次/持续故障补偿、明确报告白名单与打包来源；收尾仅追加 CHANGELOG 复制项，精确反证无其他变化 |
| 四项 0.4 新测试文件 | reviewed | boot、index-lifecycle、install、startup-wire；安装测试本窗口补充必要故障与后改夹具 |
| 现有保存/协议/启动测试 | partial | 相关依赖用例扩读，全部执行；不是逐行审查每个旧测试 |
| 旧 render、source-guard、interactions、tokens 等 UI | partial | 运行全部回归、检查未变快照；未逐行重审全部历史实现，不把 0.3 历史真机证据当作 0.4 证据 |
| README、CONTRACT、NOTICE、USAGE、CHANGELOG、package | reviewed | 0.4 全部变更；新核心标记范围修订与后补更新记录已读；README 已明确安装夹具须使用未注入标记的原版源码副本，最终文档/报告/包版本仍须统一 |
| 安装副本 `extension/`、`server-plugin/` | reviewed（字节对应） | 收尾重新核对 24 对路径，差异为零；server-plugin/package.json 仅去掉末尾 LF，与打包生成格式一致；最终重打包及下载校验仍需完成 |
| 原生单聊/群聊、context、worldinfo、第三方读调用点 | reviewed（依赖） | 核对失败进入开场保存、合法空目录/空世界书、getContext 身份、历史/当前文件批读与群重命名共享 loader。仅程序源，无私人数据 |
| `reports/upstream-0.4.md` | reviewed | 引用的上游范围、许可与不采用的行为边界；没有下载执行上游代码 |
| `reports/runtime-0.4.json` | reviewed（主控汇总） | 字段、场景组合、完整性布尔值、恢复后 waiting、实际 chat 写入与 noop 数量交叉核对；未重跑浏览器或读取原始私人记录 |
| `reports/acceptance-0.4.md`、`reports/source-sha256-0.4.json` | reviewed（汇总/清单） | 已读主控完整冷暖对照、正式部署与公网回执；85 个清单路径在工作区逐项重算 SHA 一致，未直接重跑正式操作或打开 ZIP |
| 获准单个部署驱动脚本 | reviewed（静态） | 默认预览、停服探测、持久备份、迁移与校验 try、逐项异常补偿；未运行部署或读取其引用的数据 |
| 其余 `private/`、`release/`、凭证与正式私人数据 | excluded | 不属于独立审查输入；不遍历、读取或复制 |

## Verification：本窗口亲测

运行期源码修订完成后运行（后续打包白名单与格式修正的最小复核见末尾回执）：

```text
TAVERNFLOW_HOST_ROOT=/root/SillyTavern UV_THREADPOOL_SIZE=1 NODE_OPTIONS=--v8-pool-size=1 npm test
155 tests / 155 pass / 0 fail / 0 skipped；约 8.02 秒

UV_THREADPOOL_SIZE=1 NODE_OPTIONS=--v8-pool-size=1 npm run check
syntaxFiles=66，manifest=true

git diff --check
通过
```

独立临时实验补充了实际打标宿主函数在 20 层业务包装下的单聊、群聊恢复，群后台共享 loader 默认透传，以及缺少早期 boot 时的 fetch 回落，共四项通过。它们使用合成 JSON 和依赖桩，证明入口与包装关系；不替代真实浏览器、真实插件初始化或全部存档事件序列。

安装回归五项均随上述全套通过，覆盖预览、index 字节/权限、版本回退、安装目录篡改、核心标记篡改、核心段外后改、六个一次写故障点，以及安装/卸载持续补偿故障的备份字节/回执保留。没有注入断电、SIGKILL 或真实磁盘耗尽。

补充只读检查获准的单个部署驱动：默认只预览，应用前要求正式端口离线；先持久备份三个核心文件和两个自有目录，再执行回退/安装。迁移及保护文件/设置校验在异常补偿范围内，各项恢复独立尝试，原备份保留。未发现新的静态阻断问题，但未执行该脚本；若执行报错或恢复不完整，必须保持停服并检查备份，不能把尽力补偿当成已经完整还原。

## Verification：主控真实宿主脱敏汇总

来源为 `reports/runtime-0.4.json`；本窗口核对版本为 4,229 字节，SHA-256 `0bb5c470eb1c522a2a4935f22b7ed69f628b6cb9f5f9278eb1465cb91a26a6f6`。主控运行环境记录为 SillyTavern 1.19.0 / 7e8663cd9、Chromium headless、390×844 视口。本窗口只核对脱敏汇总的内容和一致性，没有重跑真实浏览器，也没有重新读取 `private/` 原始材料。messageHashScope 明确哈希覆盖全部消息的 `.mes` 正文原序，变量另算；全部消息对象的其他元数据未被这两个哈希一并覆盖，未知字段保留另据群聊结果与保存回归。

| 主控场景 | 汇总记录与本窗口核对结果 |
| --- | --- |
| 轻卡五项 | headers、body、HTTP 错误、坏 JSON、连续失败后手动重试全部存在；3 条消息、0 iframe，全部正文/变量 hash 均一致，framesReady=true，恢复后 waiting=0 |
| 重卡五项 | 同样五项组合齐全；8 条消息、3 iframe，全部正文/变量 hash 均一致，framesReady=true，恢复后 waiting=0 |
| 请求与保存语义 | 前四种故障各为 2 次读请求，手动恢复为 3 次；十场景实际 chat 写入合计 0，noop 核验合计 10。不能将这些 noop 请求计成意外开场落盘，也不能表述为所有保存请求均为零 |
| 新页世界书故障 | faultCalls=4、recovered=1；8 条消息、3 iframe，framesReady=true。主控说明使用独立新页，确有目标读取，避免用无请求的已加载状态冒充故障测试 |
| 真实群聊 | 503→完整响应，2 次请求、1 条消息、未知字段保留、恢复后 waiting=0 |
| 窄屏草稿恢复 | 完整 Unicode 草稿、剪贴板拒绝后选中降级、取消重载后草稿保留，三个字段均为 true |
| 模型和页面错误 | 主控说明正文生成通过 CDP 阻断；汇总记录 generationRequestsBlocked=true、realModelCalls=0、pageErrors=[]。本窗口未执行模型请求 |

这些结果支持指定隔离场景的恢复与数据语义，不证明所有私人卡片、第三方辅助模型路由、手机浏览器或实际高峰网络均已认证。响应头/体卡住场景约 32.3–34.1 秒完成恢复，连续失败手动场景约 62.4/81.3 秒；这是故障恢复时间，不能当成首屏提速百分比。后续单轮冷暖对照已由主控完成，结果和限度见末尾回执，未用旧版收益填补。

## Refactor Signals / Slimming Opportunities

没有证据要求重构整个加载器或旧保存协议。此次改动属于有明确验收面的局部修复，继续扩大缓存、全局锁或业务插件代理会超出 0.4 范围。

原调用栈识别已被显式入口替代，避免继续堆叠浏览器/第三方栈格式白名单。没有额外删除稳定兼容路径的建议。安装副本属于生成交付物，应通过既定打包同步，不把副本漂移当成手工删减机会。

## Do Not Touch Yet

保持旧业务插件、提示词/变量处理、事件顺序、原生合法空聊天、新页基线/冲突保护以及第三方后台读的原有职责。不要为追求首屏数字裁聊天、提前发 CHAT_CHANGED/chatLoaded、关闭变量保存、伪造设置或静默回落写入。

本报告不授权操作正式数据、修改第三方源码、部署新宿主、扩大网络监听或调用模型。主控已有会话授权是否覆盖后续部署，由主控按原任务判断；本窗口不新增确认流程。

## Residual Risk / Verification Gaps

- **P2：客户端响应内存预算尚未量化。** 完整字节缓冲后仍要 Blob.text + JSON.parse 校验，原生消费者再次解析；没有客户端响应总字节/并发硬上限。大聊天、手机内存峰值、耗电和主线程停顿未在本窗口实测；Worker 六份快照也不是总字节预算。README 已承认该限度，不能宣称全面解决手机卡顿。
- 服务端 64 MiB/两并发只约束压缩路径；前置 JSON.stringify 仍同步，判超限前已构造字符串，不是全服务 CPU/内存硬上限。没有正式宿主压力测试证据。
- 30/60 秒基于 JS 能见的响应头/解压 chunk。后台计时器、连接占用或压缩块可影响判断；持续传输没有总时限。第三方包装若丢弃 AbortSignal 或自行永久等待，不能据此承诺所有加载死等均可恢复。
- 普通非 chat 白名单读仍可能来自第三方；Request/自带 signal 等路径保留原生语义。iframe、远程资源、独立 Worker/XHR 和业务自身异步等待不在完整恢复承诺内。新入口已消除对 Error.stack 的依赖，仍未做真 Safari/手机真机验收。
- 原生 200 的 `{}`/`[]` 可能代表合法新聊天，也可能是宿主吞掉文件错误；扩展无法从同样响应可靠区分。保留原生合法空语义，不声称完成磁盘损坏防护。
- 故障模态阻止背景切聊，认证失效仍需用户重新登录或刷新。主控已提供 390×844 窄屏与剪贴板拒绝降级证据，真正手机长按/键盘体验仍未验证。
- 提前准备保存 Worker 仍发生在扩展可运行以后，首次 settings 读取没有可信页面基线；其他页面、XHR/独立 Worker 及首次未知基线写竞争未因此消失。既有保护测试通过并不等于全局存档锁。
- 安装补偿针对可捕获异常；三文件提交不是断电原子事务。只保留原 mode，不额外承诺 owner/ACL。持续补偿失败会留下需人工检查的恢复目录，不应继续安装或声称自动完全还原。
- 安装前源码指纹与后续提交之间没有跨进程文件锁；部署时应停止并发核心源码编辑。既有预提交字节比较不是跨进程互斥保证。
- 0.4 的真实性能、故障与提交语义以主控新证据为准；0.3 历史测量不能与本版结果相加。本窗口已核对 runtime 与完整 acceptance 脱敏报告，未亲自执行正式部署/公网操作，也未直接打开发行 ZIP。n=1 冷启动小降、暖启动慢 13.486 秒，不能宣称稳定整页提速或已排除新版开销；最终重打包及公开下载校验仍待主控完成。

## Verification Gates / Optimization Eligibility

结论：**Eligible for Gate Review；代码审查通过，没有已确认且未修复的 P0/P1。整版发布仍受剩余门约束。**

| 责任门 | 通过条件 | 当前状态 |
| --- | --- | --- |
| 指定真宿主故障矩阵 | 轻/重单聊各五项、独立新页世界书和群聊 503 恢复；保留真实业务包装 | 主控脱敏汇总复核通过，详见来源与范围 |
| 原生/业务数据语义 | 完整消息/变量/未知字段/iframe 正确；恢复期间无伪空开场写入；区分真正落盘提交与只核验哈希的 noop | 主控指定场景汇总复核通过；实际 chat 写入 0、noop 合计 10 |
| 草稿与窄屏 | 对话框内可访问完整草稿；复制许可拒绝可选中；取消重载保留草稿 | 本窗口夹具与主控 390×844 汇总通过；手机真机行为未验 |
| 启动传输与弱网性能 | 同一候选的设置语义/传输字节、1.5 Mbps/150 ms 冷暖对照，APP_READY 与完整正文分开，不伪造就绪 | 主控单轮测量报告已复核；无稳定整页提速证据，暖慢 13.486 秒；仅按恢复与传输减量范围交付 |
| 冻结与安装副本 | source 快照无未审漂移；生成的前后端、协议及清单字节一致 | 工作区 24 对副本、85 项清单已亲自核对；主控回执报告 ZIP 两布局安装/回退通过，本报告更新后仍须重打包 |
| 安装/回退与原改动 | 正式目标匹配既定指纹，备份/预览；仅自有 index 块、两个核心入口和自有目录改变，原后改保留 | 本窗口临时故障夹具通过；正式部署/210 文件保护/原改动/公网/选项恢复已据主控报告关闭，未亲测正式实例 |
| 证据与下载交付 | 新 0.4 报告、源码 SHA 清单、ZIP 对应同一候选；公开 HTTPS 实际 GET 为 200 且 SHA 与本地逐字节一致 | 最终重打包与公开 HTTPS 校验待主控完成；旧 ZIP 哈希不作为本报告更新后的成品哈希 |
| 手机真机与实际高峰 | 内存/耗电、移动键盘、后台计时器和实际高峰表现 | 未验证；报告必须继续保留此限度 |

完成剩余发布门以前，不建议宣告整版交付通过；这些已获授权的常规检查不需要新增用户确认。

## Source Snapshot

本表是输入清单和漂移检测依据，不是“每个历史文件均已完整审查”的声明。清单覆盖 client/server/shared/scripts/tests 全部文件（排除 __pycache__），加 README、CONTRACT、NOTICE、USAGE、CHANGELOG、package 及存在时的锁文件；不含私人目录、报告和生成交付目录。聚合算法：按 path 排序，将每项 `path + NUL + sha256 + LF` 拼接为 UTF-8，再计算 SHA-256。

- 初次锁定：2026-11-16T08:27:08.170600+00:00，54 个文件，聚合 `3d964fd5db6c3d1fe38459b58a46bb45ab622d340dac2c4070a6b393d7840e01`。
- 显式入口修订前复核：2026-11-16T08:38:54.001454+00:00，聚合 `0cc756242b63d788cf209a1a4c4a8d42fd9194f8d0f1ede3010923dcd1609ea5`。
- 前次复核：2026-11-16T08:58:12.389285+00:00，原 54 项聚合 `1c27508bf8de4a28adfb002c8984a315d3ff772f8c9d1067611436887f473429`。测试后 README/CONTRACT 两份文档修订已重读，产品与测试源码无漂移。
- 首轮定稿复核：2026-11-16T09:03:10.935142+00:00，补纳本轮新改的 CHANGELOG 后共 55 个文件，聚合 `1fd75f83596b71a79c8ea366ffac7ae924b7808a9fd78c269244ade418a3d973`。原 54 项无变化，只有清单新增已读的更新记录，产品与测试源码继续无漂移。
- 文档说明补核：2026-11-16T09:09:27.772482+00:00，55 项聚合 `5603e5c654815fc0cd7e04c3e513121cd621ea5ae454e2b23c92b4bb26751b24`。仅 README 修正 TAVERNFLOW_HOST_ROOT 应指向未注入标记的原版源码副本；此说明符合完整指纹校验的安装夹具要求。其他 54 项及 runtime 汇总无变化，没有重跑产品测试。
- 收尾复核：2026-11-16T09:18:31.715220+00:00，55 项聚合 `c4f3e9ab9268534c1d5cbd8c93812e00037f3225df4d9a44c36e62e9eee61be5`。仅 scripts/package.mjs 增加 CHANGELOG 白名单复制；其余 54 项继续无漂移。server-plugin/package.json 的末尾 LF 格式修正不在本 55 项聚合内，独立哈希列于末尾回执。
- “相同/已复核变更”相对初次审查快照，不是相对 Git 0.3.0。报告落盘后如产品/测试源码变更，应复核变化再更新快照；仅主控报告与下载副本不改变本聚合。

| 路径 | 字节 | SHA-256 | 相对首次快照 |
| --- | ---: | --- | --- |
| `CHANGELOG.md` | 1374 | `39f7c311791e67bc344f12505762baf4283d0a661c6b588f199de3f98d3e1e5f` | 定稿新增审查路径 |
| `CONTRACT.md` | 5951 | `4f51e8bd7e3305e4ef39b68c4d92bac7e376845f3b72119825649fbeb8565b7c` | 已复核变更 |
| `NOTICE.md` | 2379 | `c3aaec3e57933538187d2b4947faa56c3bad7b58208cc9dadc23c7cfe3959af9` | 相同 |
| `README.md` | 8527 | `b5522b62a1a9278101133e59bd2135517f454e68e1ecf11d4f17d4b164a2cce4` | 已复核变更 |
| `USAGE.zh-CN.txt` | 2131 | `3e5eca54120ee3c66d01947fe5eb5973225f29c62e7d00625a8308e8ba3c1465` | 相同 |
| `client/boot.js` | 14020 | `647b6c491ca92a912ca1a143a2f4a8e417220824e0a74ceef2e29f9a1bf2f369` | 已复核变更 |
| `client/fast-paths.js` | 1723 | `53a6f38c633817f3f4a199103678b2ab47be30e707a48ad49e8c01b1795f76b9` | 相同 |
| `client/index.js` | 10405 | `103cb552b1899cbfe8f396c57de7826f883d283b038999440509b303370b4c51` | 相同 |
| `client/interactions.js` | 11076 | `5f553815fcd6b6069ea09e5b4bbf5ea9080d7f99a59441770f394dba3fe5e64c` | 相同 |
| `client/lib/empty-clear.js` | 1830 | `6d3036e348ae58bf47e15bd2a04897f61184c25baee4ed485a4cc5e567a6a89f` | 相同 |
| `client/lib/linear-scan.js` | 2592 | `4d0edde5394f8bc21891e2589e27ca5bc40ce8b22aa0850fa85985d26b7d8ffb` | 相同 |
| `client/lib/meta-anchor.js` | 1725 | `89cc6b4c24d6c3dca80beeb108f75e4ad2f940bbc432be2d4eda07a60d6d45a7` | 相同 |
| `client/manifest.json` | 282 | `832bccb263c113f27d4f123adf929e9777c6def636c9e0734e4d04151e443cc9` | 相同 |
| `client/migration.js` | 1092 | `abd6d0d4524483dbac1f9657d81136f317b96629155955fdb44eebf906ba6fd4` | 相同 |
| `client/panel.js` | 8037 | `e2212ba1d825ee45bb992b9f2468591233cf6654c8627e6a4f61673ce0102260` | 已复核变更 |
| `client/render.js` | 18647 | `88c9841dfd240572f533e9ed227baaa6de6fa4daaaf531bece43b4198603be3a` | 相同 |
| `client/source-guard.js` | 16905 | `a89ed25544e2b11b82035b0b977c9d40f83426d16034ed7aad9d6a5baa0ad83b` | 相同 |
| `client/startup.mjs` | 8417 | `aa5877c5a8572af8b7b95132b7482928f267f0fbeb23f7a33a773431dc40e0dd` | 相同 |
| `client/style.css` | 2638 | `8b29115dd7a3d9dc217a2e517958dc43ca9ee6f044363011a733a50e8747d4e1` | 相同 |
| `client/tokens.js` | 5737 | `2aa7137571ff4054b95b5d8f506336dbd8cc7ba0bb97c8515690916e2d85df06` | 相同 |
| `client/transport.js` | 15515 | `bb20f8255de0a9669d5dd68b8d8856f640f6d34d24c9acdfe5330785273f8172` | 相同 |
| `client/ui-optimizations.js` | 6149 | `5858602e61022f600d22876f298f457a169f962862edbc4f70e761c68e3ea5f7` | 相同 |
| `client/worker.js` | 19125 | `b2362035e296f6caee6be469461d9e6751ed2f333d4f4c86b2595b5ae941f0a2` | 相同 |
| `package.json` | 255 | `31b26b7dbb6fc89569f665fcda366a73669daef970757ad1edf6dd088df07dda` | 相同 |
| `scripts/check.mjs` | 975 | `2834c023fe439ad4f8aa639c2e544f5bcd36c746573460bf5f08b5111dac7bfa` | 相同 |
| `scripts/install.py` | 9522 | `3bdb8206f2a9c2a34eef94cf63f9252bed9b86bc340e73a3582a06b211c1780b` | 已复核变更 |
| `scripts/package.mjs` | 2522 | `49d06edac6b879c953e8d673164f5930aff635c2782969567b964934959b52aa` | 已复核变更 |
| `scripts/startup-http-benchmark.mjs` | 14885 | `dec0a5350e15dfe357f8c342382958231fe9a493032eaf2db902f807ef9d7268` | 相同 |
| `server/README.md` | 3485 | `a6f3e9221c866f559dcca9be5c4957b9cfaa3675899ca5eef0dce36ac30b3d02` | 相同 |
| `server/index.mjs` | 19699 | `1e324471d0be79761f5863548ea0e7e0e36ffdbca86098c761ac2a9a1b48f245` | 相同 |
| `server/startup-settings.mjs` | 11645 | `56b22f36969b2660ac3f3add56347830677566549c3b521758d9d64f674db80b` | 相同 |
| `server/startup-wire.mjs` | 5124 | `873eb7241d3998b133e4e36512ab26ba002c31a7e9600bb75f1d723cad8ac1c8` | 相同 |
| `shared/protocol.mjs` | 6728 | `dc361359c2e846a88f65243dd07cb34661478c7aec701148853e9cf4883d483d` | 相同 |
| `tests/backend-native.test.mjs` | 6452 | `61749052ba3e734261693dc55f740b203619702b662fc344f4c911137df705f2` | 相同 |
| `tests/backend.test.mjs` | 11584 | `dba31c458fd75c9825418d0e3e1892dcbded4c72b7b7ede4be82a4c022d037f1` | 相同 |
| `tests/boot.test.mjs` | 12253 | `82aa41d7904bc62b3cdb9abd70eda0b595e3dac03bbc8d56e5cf717e666744ee` | 已复核变更 |
| `tests/fixtures/prompt-manager-1.19.0.mjs` | 1683 | `92ccf3fadbbd5db5ab610cbcc7f22dad9d96bf91ef2ffc1b27c42944240adce2` | 相同 |
| `tests/index-lifecycle.test.mjs` | 12861 | `4bdf6f92f2ee0d0266fd953bdcdfcab29f3a398665a1ba58b42a18e2da2b1200` | 相同 |
| `tests/install.test.mjs` | 11459 | `2b34c11f68ea2fa9c1422bddd34cafdbda20f52799e5ea434b258d96340896d1` | 已复核变更 |
| `tests/interactions-browser.mjs` | 16314 | `6f2089dbbd2cef856c1a9450c102e42416b39b65ac9e5c88f0b4f93dd4ed3087` | 相同 |
| `tests/interactions.test.mjs` | 7826 | `2edaf32f4786283398ca3257f0fe164155b625c2270b4c962ab44534ca1b5068` | 相同 |
| `tests/migration.test.mjs` | 1318 | `35b9cfee5bdfcc70e602d2c09845e32c63aefcb68b72407283fb5cc1d7bf8902` | 相同 |
| `tests/protocol.test.mjs` | 3967 | `47323bf2c8fdcc30b6649765a1ddae4178ce34bb7d31e68ce4a07787aeb91627` | 相同 |
| `tests/render-chat-switch.test.mjs` | 3335 | `47a4b069347a6eb80f70f62c1dc56029afdc87b26496f12dbf3851bcefabd79c` | 相同 |
| `tests/render-host-reads.test.mjs` | 8012 | `62fc2ba938590831c8e9e36ea2463e9de84a4a83a43ad6be7fb6b4d33101a227` | 相同 |
| `tests/render-policy.test.mjs` | 4367 | `e1964e2cfbed672f76a168e0aaa29b53f660245205ec7a7d53cb7f314ead751e` | 相同 |
| `tests/render-select-browser.mjs` | 6342 | `5f6616093e3a61332b4b2204afc98c0fd3f96291a09cdeac1df8469a74f6b1da` | 相同 |
| `tests/render-ui.test.mjs` | 1853 | `6399ec7204f931a486f94bdd9dc8258dc8b7f2b360af1cfb18a1ac6500d452e8` | 相同 |
| `tests/source-guard.test.mjs` | 22436 | `4f905a1eb56074325e3ef4f098f972f623a1a2672d5a6d4a607965635d145e6f` | 相同 |
| `tests/startup-preload.test.mjs` | 6827 | `adc452ace28a76090991f2699d2dfe2976d836a0bf64ab1f6b33a764e36e58ca` | 相同 |
| `tests/startup-settings.test.mjs` | 16006 | `6d633bb8a8fdd84bc64ac247da98df29bc4dd5d02f26ee2a7c347e3b6126a942` | 相同 |
| `tests/startup-wire.test.mjs` | 8448 | `5a28c5b58552ffdb2a3524aaf076eccf2c4d0f175b7eb1eb97c60f11cde91e7d` | 相同 |
| `tests/tokens.test.mjs` | 12141 | `a02797bd67c85ee9405528542a524d33bdf611447750aa358917812007e379f0` | 相同 |
| `tests/transport-client.test.mjs` | 26379 | `cbdbe41c64f3f40ec78842a6efb05a257d3cc657e456d6be54b763c4304724ce` | 相同 |
| `tests/transport-worker.test.mjs` | 18541 | `3b57c7ab19ec1b87b550580522dcc20182d1d3a754e0333454dd253824a2e7b7` | 相同 |

## 后续门关闭回执 / 最新源码聚合

本节补记首轮代码审查后的收尾证据。**“本窗口亲核”仅指本独立审查窗口实际执行的静态、夹具和测试检查；正式实例、弱网测量、发行 ZIP 安装演练及公网操作均来自主控回执，不能转述成本窗口亲测。** 没有新增已确认且未修复的 P0/P1。

### 本窗口亲核的最小收尾变更

- `scripts/package.mjs` 仅在成品文档白名单增加 `CHANGELOG.md`。删除这一新增字符串后，文件哈希精确回到前次审查值；`node --check scripts/package.mjs` 通过。
- `server-plugin/package.json` 仅删除最后一个 LF，JSON 内容及版本 `0.4.0` 不变；补回该 LF 后哈希精确回到前次值。这是生成副本字节对齐，不是运行逻辑变更。
- 当前工作区 24 对 client/extension、server/shared 安装副本逐字节一致；已逐项重算 `reports/source-sha256-0.4.json` 的 85 个安全相对路径，全部匹配。未直接读取发行 ZIP，不能用工作区检查代替最终归档检查。
- 收尾未改变产品运行逻辑或测试源码。此前亲测全套 155/155、无 skip/fail 的结果继续适用于运行逻辑；本次只补打包脚本语法与字节检查，没有为文档白名单和末尾 LF 重跑产品测试。

### 主控测量报告复核及性能边界

已完整读取主控脱敏报告 `reports/acceptance-0.4.md`：7,132 字节，SHA-256 `c9c4076dd8902f86cb67a333575988b5c49678fd590ab71343b7fe7f0165155e`。此前核对的 `reports/runtime-0.4.json` 未变化：4,229 字节，SHA-256 `0bb5c470eb1c522a2a4935f22b7ed69f628b6cb9f5f9278eb1465cb91a26a6f6`。本窗口复核了报告内容与表述，没有亲自发起这轮宿主操作或测量。

弱网条件为 RTT 150 ms、下行 1.5 Mbps、上行 0.75 Mbps，以 APP_READY 为终点；每种条件仅一次串行对照：

| 条件 | 0.3 | 0.4 | 本次差值 |
| --- | ---: | ---: | --- |
| 冷启动 | 152.703 s | 149.093 s | 快 3.610 s，约 2.36% |
| 暖启动 | 121.269 s | 134.755 s | 慢 13.486 s，约 11.12% |

这些数据关闭了“尚未提供本版冷暖测量”的证据缺口，**没有证明稳定整页提速，且不能排除新版开销**。第二次大 settings 读取与请求争用仍在；不能据单轮结果强行归因，也不能把性能目标标为稳定达成。候选此次 retries 为 0、pageerror 为 0。发行判断限于弱网故障恢复与已验证的传输减量，不以稳定提速作承诺。

固定同一 settings 响应的传输对照中，解压后 32,008,511 字节及 SHA 相同，压缩响应由 4,525,620 降至 3,835,616 字节，减少约 15.25%。这只证明同一响应的传输减量，不等于整页速度提升。

上传统计只覆盖 APP_READY 后 1.5 秒以前的观察窗口。0.3 原生全量 settings 上传冷/暖分别为 18,146,500 / 36,293,000 字节；0.4 观察点原生全量为 0 / 0，暖启动另有 609 字节的 flow 请求体，冷启动 Worker 仍有 pending。不得扩展为全会话零上传。runtime 汇总中实际 chat 写入合计为 0、哈希核验 noop 合计为 10，也不得改写为“全部保存请求为零”。消息正文哈希只覆盖 `.mes` 正文原序，变量另有哈希，不代表所有消息元数据均获哈希证明。

### 主控正式部署与归档演练回执

据上述 acceptance 及主控补充回执，正式目标已从 0.3 升至 0.4，并重启对应 PM2 服务；已持久备份三个核心文件和两个自有目录。升级不改 settings，210 个保护文件 SHA 一致；原有 index 以外两份 dirty 保留，去除自有 index 块并逆换两个核心入口后，与升级前备份逐字节一致。七项既有定义、预设 SHA 和默认模型不变，未选择正式聊天或调用模型生成。

主控报告的公网新页为 390×844，前后端均为 0.4，early boot、Worker、模块及 helper API 就绪，waiting 为 0，无 pageerror。原生面板选项完成“写入、落盘、恢复原值、再次落盘”；原有选项保留，包括用户此前已开启的实验预取和轻量拖影。主控还报告正式 runtime 全部 client/server/shared 文件与候选逐字节一致。**这些属于主控执行结果，本窗口没有接触或亲测正式实例。**

主控另报告从生成 ZIP 实际展开后，分别以 full-source（含 client）和 install-only（不含 client，仅含 extension/server-plugin 安装副本）两种布局，在临时宿主完成预览、安装、回退预览和回退；三个核心文件及 package 文件字节完全还原。本窗口未亲自展开 ZIP 或执行这两次演练。既有 ZIP 的统计与哈希仅对应旧归档，本报告更新后必须重新打包，不得沿用为最终成品证明。

### 最新聚合与尚待完成的交付门

本窗口最后冻结的 55 路径快照时间为 `2026-11-16T09:18:31.715220+00:00`，按上文算法聚合 SHA-256 为 `c4f3e9ab9268534c1d5cbd8c93812e00037f3225df4d9a44c36e62e9eee61be5`。相对前次 `5603e5c654815fc0cd7e04c3e513121cd621ea5ae454e2b23c92b4bb26751b24`，只有 `scripts/package.mjs` 变化，其余 54 项一致。

`server-plugin/package.json` 不在这 55 路径聚合中，独立记录为 129 字节，SHA-256 `017a798be803bde020db748cfc31a363906693dcaf4e13a4351a62d58f417e45`；`scripts/package.mjs` 为 2,522 字节，SHA-256 `49d06edac6b879c953e8d673164f5930aff635c2782969567b964934959b52aa`。

本报告落盘后，仍由主控完成最终重包、清单及归档内容复核，并从公开 HTTPS 地址实际 GET 下载，确认 HTTP 200 且下载字节/SHA 与本地最终成品相同。本窗口未验证最终公开下载，不把这些待办标为通过。手机真机、Safari、内存/耗电峰值、后台计时器及持续信号丢失等既存残余继续保留，不因收尾回执而消失。
