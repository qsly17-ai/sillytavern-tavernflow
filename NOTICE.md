# 来源与许可

清酌 TavernFlow 0.3.0，2026，Susuzi。源码按 GNU Affero General Public License version 3 only（AGPL-3.0-only）提供，完整许可证见 LICENSE。

部分兼容快速路径迁移自同一用户服务器此前开发的 ST 流式性能兼容补丁 st-linear-parser 0.3.0（AGPL-3.0-only），并重新实现为独立模块；没有沿用鸡尾酒的保存协议或内部 HTTP 回源。

评估参考项目 https://github.com/ransxd/sillytavern-incremental-save （检查版本 3a2c42，MIT）用于了解既有方案和兼容缺口；本发行版没有复制其补丁、计数估算或图片代理源码。

SillyTavern https://github.com/SillyTavern/SillyTavern （AGPL-3.0）是运行宿主。本版不打包宿主或第三方业务插件，运行时调用已安装宿主的保存与计数代码。jQuery 函数指纹只用于核对目标版本，未打包该库。

0.3 大源码接管前减负使用目标宿主的 MessageFormatter hook 与标准 CSS 能力，适配已安装的酒馆助手 4.12.1，不重写其 iframe 渲染。首屏 modulepreload 为独立实现的可选资源提示，默认关闭；它不沿用旧组合的模块代理、提前激活或空列表二次加载。

本轮配套维护使用 [LittleWhiteBox 官方 3.2.6](https://github.com/RT15548/LittleWhiteBox/tree/c508e5f5fc0b80332837868ad380675cce211e47)，保留上游原版。NY 六任务取自用户已拥有的旧预设定义，只在获授权的私有实例中迁移；本发行包不分发 NY 预设、任务正文或私人 API 配置。

MVU、酒馆助手、提示词模板、小白X、数据库、鸡尾酒、鸡尾酒+、柏宝箱、沉浸阅读等名称及其实现属于各自作者。本项目没有声称获得这些作者背书；兼容结论仅限报告中列出的版本和实际动作。

发行包不包含用户设置、聊天、角色卡、日志、凭证或隔离验收宿主；测试素材为合成数据或纯 JSON 测试夹具。
