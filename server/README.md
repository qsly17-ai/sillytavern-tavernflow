# 服务端适配边界

目标为 SillyTavern **1.19.0 / 7e8663cd9**。插件从服务进程的 `process.cwd()` 找到宿主，核对 `package.json` 名称及版本，再导入宿主自己的 ES 模块；没有内部 HTTP 请求、固定端口或新 npm 依赖。安装根需保留 `server/`、`shared/`，并以 `server/index.mjs` 为 `package.json.main`。

下列事实依据目标宿主源码核实，调用它们保留原生语义，没有复制鸡尾酒或柏宝箱的实现：

| 调用点 | 来源 | 用途 |
| --- | --- | --- |
| `trySaveChat(chatData,filePath,force,handle,cardName,backups)` | `src/endpoints/chats.js:532` | 原生完整性校验、原子写入、按聊天限频备份；确认覆盖仍需通过当前文件哈希检查 |
| `router` 的 `POST /save` 单处理函数 | `src/endpoints/settings.js:206` | 原生设置格式、原子写入、十分钟设置快照；额外检查 `{result:'ok'}`，防止该原生接口将错误按 HTTP 200 返回 |
| `getUserDirectories(handle)` | `src/users.js:683` | 核对认证中间件提供的用户目录，客户端不能指定其他用户文件 |
| `router` 的 `POST /openai/count` 单处理函数 | `src/endpoints/tokenizers.js:916` | 批量合并、结果缓存，完整保留原生响应 |

所有优化保存请求按**文件资源**串行，不同资源可并发。每次检查内容哈希；错误和冲突不自动重试全量覆盖。读取缓存同时检查统计指纹与原始文件 SHA，避免极快的等字节原地写入因时间戳相同而漏判；内容未变时复用解析结果。已有 JSON 损坏会报错，不能当作空聊天。写入后重新读取并核对内容哈希。原生相对或绝对 `dataRoot` 均可使用。

这些锁不覆盖原生或其他插件写入，也不是操作系统级原子比较交换。原生入口仍可保存，无法宣称全局防丢档。备份数量、写入持久性和快照策略仍由原生实现及宿主配置决定。插件没有新增历史恢复中心。

`/tokens` 格式：`{requests:[{model,messages}]}`，结果为 `{ok:true,results:[原生响应],nativeEquivalent:true}`。这个标记表示与原生计算一致，不宣称任意模型都使用精确匹配的词表；原生本身存在模型别名与异常估算。`qwen2`、`command-r`、`command-a`、`nemo`、`deepseek` 可能触发下载，因此不纳入本插件批量路径，返回 503，原生路径照常保留。

验证命令：

```bash
node --test tests/backend.test.mjs tests/protocol.test.mjs
TAVERNFLOW_HOST_ROOT=/实际/SillyTavern目录 node --test tests/backend-native.test.mjs
```

第二条只读取指定宿主源码，子进程使用新临时配置及 `DATA_ROOT`，验证设置/单聊/群聊落盘、原生备份、完整性冲突及 Token 结果一致；不载入正式配置或用户聊天。它不代替实际浏览器、用户手机和全部插件组合验收。


## 0.2 启动读取

`startup-settings.mjs`仅在1.19.0的settings.js整文件及/get回调双指纹匹配时，内存替换/get单回调。保持所有原生键、字符串内容、排序和false/null/0；每次全新读取，异步I/O全局上限8，dispose按所有权恢复。默认启用；无磁盘核心补丁，不缓存响应。health.startup.active报告实际接管状态。

完整HTTP测试含原生Express response.send、JSON序列化和ETag，见`reports/startup-http-benchmark.md`。合成29.6MB响应逐次SHA一致，单请求中位+2.4%，四并发中位-18.0%；目标是降低同步阻塞，不代表所有首屏更快。

从 0.4.1 起，`POST /quick-reply-presets` 在同一适配激活时复用完整设置读取的 Quick Reply 文件顺序和解析逻辑。请求受宿主登录与 CSRF 保护；没有为该接口缓存文件内容。

0.5.0：助手 4.12.2 辅助生成适配只处理已登录用户访问其自己已安装的指定构建。目标宿主文件、路由和构建哈希须匹配；否则继续原处理。服务端不留存助手文件副本，不写用户扩展目录。/health 的 helperGeneration 报告路由是否接入，浏览器模块状态另行确认本页是否真的加载过匹配的构建。
