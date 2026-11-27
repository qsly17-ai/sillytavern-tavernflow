# 清酌维护手册

支持的宿主为 SillyTavern 1.19.0（`7e8663cd9`）。[数据合同](CONTRACT.md) 描述外部行为，[每版验收](reports/acceptance-0.5.1.md) 记录实际验证。先在隔离实例复现，再更新正式包。

| 路径 | 第一处检查 | 必须保持的行为 |
|---|---|---|
| 开屏、设置和切换聊天 | `client/boot.js` + `server/startup-settings.mjs` | 只把完整、新鲜的数据交还给原生；异常群聊不能伪装成空档；后台读取不能接管保存基线 |
| 设置、单聊、群聊保存 | `client/transport.js → client/worker.js → server/index.mjs` | 主线程同步截取原生快照，Worker 算差量，服务端核对当前文件并原生落盘；已经发出但结果不明时保护当前页，不重写 |
| 差量协议 | `shared/protocol.mjs` | 相同 JSON 得到相同 SHA-256；改动只生成必要操作；应用差量返回独立副本，保留未知字段 |
| 历史显示与助手网页 | `client/render.js`、`client/source-guard.js` | 历史纯文字只改变绘制时机，最新五楼始终实时。重源码仅在助手接管前暂缓绘制，超时恢复，不移除 iframe 或接管事件 |
| 助手辅助生成、小白X及其他快路 | `client/helper-generation.mjs`、`server/helper-generation.mjs`、`client/fast-paths.js` | 特定实现通过指纹并满足条件时才接管。宏或正则可能有副作用时保留全流程；双空才跳过小白X清理 |

## 变更与复测

1. 先记实际宿主、插件版本和构建提交。更新上游插件后，先看清酌面板是否只有某一项退回原生，再核对该项所依赖的接口。提示词模板用普通求值和后台编译检查，不按版本加分支。小白X 核对清理函数、任务设置修整与已处理记录统计，再用「两处均为空不保存／任一有记录照常清理」验证。相同版本号也可能有不同构建；未知实现保持原生，其他优化继续工作。
2. 在原生入口造一个合成场景，每次只切换一个候选。渲染可用 500 楼长聊天，对最新三楼分 24 批调用宿主 `updateMessageBlock`，每批之间留两帧；记录 `getStatus().modules.render.totalClassified` 时也核对队列是否仍有待处理项。另试历史编辑、选中文字、滚回顶部、删除尾楼后的面板计数及 iframe 操作。分类计数只反映清酌的工作量。
3. 保存改动同时检查差量前后值、服务器响应和刷新后的实际文件。至少覆盖并发旧页、意外断开、完整性确认、未知字段。涉及辅助模型时，用固定 HTTP 响应运行真实 `generateRaw` 与变量写回，核对提示词、宏副作用和落盘。按准备耗时、保存总往返、整页加载分别记录，不把局部数字相加。

```bash
TAVERNFLOW_HOST_ROOT=/path/to/clean-stock-SillyTavern npm test
npm run check
node scripts/diff-benchmark.mjs /path/to/baseline/shared/protocol.mjs
```

宿主路径应为固定版本的干净源码，安装器或测试不会借此读取正式账号。差量对照只用合成 JSON，交替测量旧、新实现，排除预热；单项时间不是保存总时间。没有手机真机时记录视口、CPU 降速和结果边界。

## 发布与回退

- 源码唯一来源是 `client/`、`server/`、`shared/`；`extension/`、`server-plugin/` 由 `npm run package` 的暂存目录生成，发布时同步，不手改。核对 manifest、早期脚本、前端、面板和服务端同为发行版本。
- 先补本版验收和源码 SHA 清单。用独立审查会话复核最终实现；发现问题时重新测试，复核修订。生成 ZIP 后按条目校验源码与安装副本，并在干净宿主验证既有版本升级和完整回退。
- 正式安装前停止写入，备份自己的目录及宿主自有标记所在文件。预检成功才卸载旧版并安装；异常使用备份回退，避免用旧聊天或设置覆盖用户新数据。重启后核对公开页面和真实资产版本。发布同一份已验收的 ZIP。
