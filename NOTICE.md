# Notice — dsh-fusion-board

本产品 `dsh-fusion-board` 是基于上游项目 **dsh-model-fusion** 的衍生作品（fork），
依据 Apache License 2.0 进行改造。上游许可证全文保留于本仓库 [LICENSE](LICENSE)。

- 上游来源仓库：https://github.com/aa2246740/dsh-model-fusion
- 衍生基线提交（commit）：`fcb26932e569b07e6de8faf54ce30bb6b1a597f8`
- 上游许可证：Apache License 2.0
- 原作者版权归属归上游作者所有；本衍生作品不抹除上游许可与来源声明。

## 本 fork（dsh-fusion-board）相对上游的改造范围

1. 命名与身份区分（禁止与原插件同名共存）：
   - npm 包名 / cordis 插件名：`dsh-fusion-board`（原 `dsh-model-fusion`）。
   - `cordis.patch.yml` 插件行 id：`dsh-external/dsh-fusion-board`。
   - 模型 provider id：`dsh-fusion-board`；模型菜单显示名：`Fusion Board · 自动`（原 `Fusion · 自动`）。
   - 客户端设置分区 label：`Fusion Board`；设置分区 slot id：`fusion-board`；
     会话输入坞 slot id：`fusion-board-configuration`（避免与原插件在同一 Web 单页
     注册相同 list-slot id 而触发 `already has an entry with id ...` 加载错误）。
   - 运行时状态目录按插件名派生为 `plugins/dsh-fusion-board/`，租约目录为
     `~/.local/state/dsh-fusion-board/`，与原插件数据完全隔离。
   - 用户可见的设置导航与菜单名引用由 “设置 → Fusion / Settings → Fusion”
     同步改为 “设置 → Fusion Board / Settings → Fusion Board”。
   - 斜杠命令名（`/fusion ...`）与会话内工具名（`fusion_*`）保持上游原样：
     它们是会话/provider 作用域资源，模型路由互斥，不构成全局同名冲突。

2. 新增「任务分解模式」开关（默认关闭）：
   - 设置项 `taskDecompositionMode: boolean = false`，默认 `false`。
   - 设置页提供开关并持久化；关闭（OFF）时逐行走上游原始逻辑。

3. 开关打开（ON）时仅放置**占位桩**：
   - 在派活决策点直接返回「任务分解模式建设中」提示文本；
   - 不派发 Sidekick、不创建看板卡片、不调用审查。
   - S1–S4 真实任务分解流水线在本版本中**未实现**。

除上述命名/开关/占位桩外，OFF 路径的业务逻辑与上游基线提交保持一致；
历史文档（RELEASE-*.md、docs/benchmark 等）中保留的旧名称属于上游历史事实，未作改写。
