# 清酌 0.3.0 兼容与数据合同

目标宿主：SillyTavern 1.19.0（7e8663cd9）。浏览器扩展和配套服务端插件共同提供优化，不依赖鸡尾酒、柏宝箱或旧线性补丁。

## 兼容边界

保留原生业务语义和未知字段，不修改 MVU、酒馆助手、提示词模板、小白X、数据库或用户角色卡的源码。酒馆助手接管前减负仅适配已核验的 4.12.1。宿主或第三方实现不匹配时，相应适配保留原生路径。

不提供私人预设、循环任务或模型配置。不会通过空列表、旧启动响应、提前撤遮罩或跳过变量保存制造提速。

## 保存协议

API 前缀 `/api/plugins/tavern-flow`。

- `POST /save`：`{kind:settings|chat|group,identity,mode:full|patch|noop,baseHash,nextHash,value?,ops?}`。
- 单聊 identity 为 `{avatar_url,file_name,ch_name}`，群聊为 `{id}`，设置为 `{}`。
- 成功返回 `200 {ok:true,hash,mode}`；冲突返回 `409 {ok:false,error:conflict,hash}`；错误不伪报成功，不盲目重试全量覆盖。
- `POST /state`：`{kind,identity}`，返回 `{ok:true,hash,value}`。
- `GET /health`：只报告版本与能力，不返回私人内容。

`shared/protocol.mjs` 提供规范化、SHA-256、差量与差量应用。操作为 `{op:set|delete,path,value?}` 或 `{op:splice,path,index,deleteCount,items}`。客户端使用 Worker 处理解析、哈希、差量和提交；同资源排队，服务端调用目标宿主原生保存函数。

上述队列不覆盖原生及其他写入者，不是全局存档锁。首次页面读取基线和跨页面并发边界见 README。冲突或结果未确认时，保留未保存内容，再刷新读取。

## 验证与回退

同版源码测试、真实宿主适配、隔离运行和独立审查的结果见 `reports/acceptance-0.3.md`、`runtime-0.3.json`、`review-0.3.md`。报告对应固定发行包，不替代其他版本、全部辅助模型或手机真机验证。

安装器只管理自己的两个目录。回退先核对安装哈希；文件被后续修改时拒绝自动删除。完整安装与回退需要服务器管理权限及重启对应酒馆实例。

用户已验收当前 0.3.0。后续改进依实际反馈开展，不承诺所有设备和所有卡片的固定收益。
