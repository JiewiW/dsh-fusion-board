# Fusion · DSH 插件

[English](README.en.md) · [安装](INSTALL.zh.md) · [Install (English)](INSTALL.md)

> **本分支说明（dsh-fusion-board）**：这是 dsh-model-fusion 的自研分支，在原版基础上新增了默认关闭的「任务分解模式」（Lead 分解任务 → 独立审查执行 prompt → 建看板卡，只建不执行）。详见下方[任务分解模式](#任务分解模式本分支新增)一节；其余内容为原版 Fusion 的说明，双模式下依然成立（OFF 模式行为与原版一致）。

Fusion 在 DeepSeek Harness（DSH）的模型菜单里是一个普通模型：**Fusion · 自动**。背后是两个你自己选的模型：

- **Lead**：一个强的前沿模型。负责理解需求、看代码、写任务说明、审查结果。
- **Sidekick**：一个便宜得多的模型。负责实际改代码、跑命令、跑测试。

目标只有一个：**用前沿模型的效果，付打折的价钱。**

思路受 Cognition 在 Devin 里推出的 Fusion 启发，这是一个独立实现，与 Cognition 无关。

## 实测效果

9 道真实开源项目的题（SWE-rebench，Python），每题跑 2 次，用隐藏测试判定对错。Lead 为 GPT-6 Astra（high），Sidekick 为 GLM-5.3-Flash（high）：

| | 做对 | 总花费（按 API 价格估算） |
|---|---|---|
| GPT-6 Astra 单独 | 9/18 | $39.17 |
| **Fusion：GPT-6 Astra + GLM-5.3-Flash** | **11/18** | **$18.07（便宜 54%）** |
| Fusion：GPT-6 Astra + Grok 4.6 | 13/18 | $41.27（不省钱） |

- 花费是按各家 API 公开价格换算的估算，不是账单。
- 局限：样本小（9 题 × 2 次）、只测了 Python、公开题目可能出现在模型训练数据里。
- 详细方法、原始数据和每一轮的结论见 [docs/EVIDENCE.md](docs/EVIDENCE.md)。

**对照 Devin 自己的 Fusion：** 两边用同一对模型，Lead 是 GPT-6 Astra（high），Sidekick 是 SWE-2。题目、工作区和隐藏测试完全相同。

排除被污染的尝试后，四个组别都干净的题剩 4 道，结果如下：

| | 做对 | 花费 |
|---|---|---|
| **本插件：Astra + SWE-2** | **4/4** | **$2.73** |
| Devin Fusion：Astra + SWE-2 | 3/4 | $4.81 |
| Devin，Astra 单独 | 3/4 | $8.13 |

- 样本只有 4 道题、每题 1 次，不能据此说谁更强，也不代表与 Devin 同等水平。
- SWE-2 两边都按 $0 计价，所以花费都是 Lead 的。
- 本插件的耗时约为 Devin 的 3.4 倍。
- 排除了哪些尝试、为什么排除，以及方法和原始数据，见 [docs/EVIDENCE.md](docs/EVIDENCE.md#against-devins-own-fusion-round-devin-r1-2026-09-29)。

## 怎么用

1. 按 [安装说明](INSTALL.zh.md) 装好插件。
2. 打开 **设置 → Fusion**，选择 Lead 和 Sidekick。可以选 DSH 里任何已登录的模型。
3. 在模型菜单里选择 **Fusion · 自动**，像平时一样对话。

**搭配建议：** 省钱靠的是 Sidekick 比 Lead 便宜得多。选一个强的前沿模型当 Lead，再选一个价格低很多（最好 5 倍以上）的模型当 Sidekick。两者价格越接近，越省不了钱。

## 任务分解模式（本分支新增）

本插件是 [dsh-model-fusion](https://github.com/aa2246740/dsh-model-fusion)（Apache-2.0，@ fcb26932）的分支。除原版 Fusion 双模型协作外，新增了一个**默认关闭**的「任务分解模式」开关（设置 → Fusion → 任务分解模式）。

**OFF（默认）**：行为与原版完全一致——普通对话 Lead 直答；需要改代码时 Lead 派 Sidekick 当轮直接执行。

**ON**：Lead 不再当轮派活，改走四阶段流水线，**只建卡不执行**：

1. **S1 分解**：Lead 产出结构化分解计划（目标、任务块、依赖拓扑 serial/parallel/mixed、理由）。Host 按 Schema 与 TB-P1 路径分析规则机检，不合格打回重交（最多 3 次尝试，超限降级为报告用户、不建卡）。
2. **S2 生成执行 prompt**：每个卡片单元生成标题/描述/执行 prompt 三元组，执行 prompt 逐项过 TB-C5 十一项机检（自包含、命令可直接运行、验收有客观正信号等）。简单任务（单块且无独立验收）短路回 OFF 直派，避免流程税。
3. **S3 独立审查**：每份执行 prompt 由 [dsh-doc-review](https://github.com/JiewiW/dsh-doc-review) v0.2.1 的 `reviewPrompt` 服务（`doc_type:"task-prompt"`）spawn 全新独立子会话审查。审查前有**预算确认门**：整条链最坏口径 token（字符数/1.2 + 每份 1600 输出、重试 ×3、轮次 ×3）超过 20,000 时必须由你显式确认，未确认不派审查。审查报告逐条 issue 由 Lead 裁决（accept/partial/reject 带理由）并修订，high issue 未清零不建卡；整链最多 3 轮。
4. **S4 建卡**：按拓扑建看板卡片，全部停在 todo，不自动执行。串行依赖用「标题序号【k/N】+ chain/seq tags + 卡内上下文交接段（开工前先回读前置卡必须为 done）」三层机制表达顺序，不依赖父子关系。建卡由 Lead 会话照插件产出的规格单调用看板工具完成，插件代码路径中不出现执行类看板工具（源码级机检约束）；建卡成功以回读看板为准。

**使用注意**：

- 需要同时安装 dsh-doc-review v0.2.1（提供审查服务）并配置任务看板；审查服务不可用时流水线中止在 S3，不会跳过审查悄悄建卡。
- S3 审查与执行都会消耗真实 token：确认门给出的是最坏口径上限，实际消耗通常显著低于它（serial 实测：3 卡链 S1+S2 全程 Lead 输入约 105k / 输出约 2k token、分解 36 秒）。
- 建卡后执行权在你手里：逐张 run，或让会话按顺序建议执行；前置卡未 done 时后继卡会自检阻塞。
- 该模式当前仅在 Web 版 DSH 0.2.0-rc.2 上做过端到端实测（serial 拓扑全链路、含短路门/预算门/拒绝分支；parallel 与 mixed 拓扑代码路径有单元测试覆盖但未跑过真实 E2E）。


## 工作方式

- **普通对话**：Lead 直接回答，和用普通模型一样。
- **需要改代码时**：Lead 把任务交给 Sidekick。任务说明里带着用户需求的原话，以及验收命令。
- **验收**：
  - Sidekick 交回结果后，DSH 在真实环境里运行验收命令。
  - Lead 审查改动，并且必须对用户的每一条硬性要求给出结论和证据，缺一条都不能通过。
  - 原本就失败的测试（例如缺少可选依赖），可以标成"只要求不新增失败"。
  - Sidekick 改写了原有测试时，会被单独标出来，Lead 必须确认过才能通过。
- **返工**：不通过就把具体问题打回给同一个 Sidekick 继续改。
  - 如果发现任务说明里允许改的文件不够（例如另一个测试文件还写着旧行为），Lead 可以在返工时把它加进可改范围。只能加、不能减，每次都会留下记录。
- **Lead 不写代码**：这不是靠提示词约束，而是由程序保证的：
  - Lead 没有写文件的工具；
  - 它执行的 shell 命令跑在 DSH 的只读沙盒里。
- **唯一的例外：程序判定 Sidekick 确实做不完时，才解锁 Lead 接手。** 例如 2 轮返工后检查仍然失败，或者 Sidekick 用完了步数、反复卡住。接手时：
  - Lead 只能改任务允许的文件；
  - 必须通过同样的验收；
  - 任务结束后恢复只读。
- **额度用完或出错**：Lead、Sidekick 各自处理。可以换模型继续，也可以定时继续；进度保留。

## 缓存保活

Lead 等 Sidekick 干活时，可能要等好几分钟。模型的输入缓存过期后，下一次请求就要按全价重读整段对话。保活会在等待期间，定时把 Lead 上一次的请求原样再发一遍，末尾只加一句“Reply OK”。前缀和上次完全相同，厂商就从缓存读取，缓存的寿命也就续上了；模型只回一个 OK，回复直接丢弃，不进对话，也不会执行工具调用。

- **默认值：** 来自各家官方文档，覆盖 Artificial Analysis 排行榜前 20 的模型厂商。
  - 按模型名匹配，比如 gpt-*、claude-*、gemini-*、glm-*、grok-*、kimi-*、deepseek-*。
  - 附带 [dsh-oauth-login](https://github.com/aa2246740/dsh-oauth-login) 的线路计费方式：按请求次数计费的套餐默认关闭保活，因为每次保活都算一次请求。
- **自动：** 模型实际返回过缓存命中后才开启，不支持缓存的模型不会白花钱。
- **每个模型都可以在设置页调整：** 开关、续命间隔、恢复默认。设置页还会显示每个模型的实际效果：
  - 等待后缓存还在不在；
  - 发了几次保活、读了多少 token；
  - 避免了多少 token 按全价重发。
- **实测（ChatGPT 订阅线路，gpt-6-astra，约 2 万 token 上下文）：** 每次保活模型只回 5 个 token，不思考、不调工具。缓存空闲 10 分钟仍在，15 分钟后过期，每次保活会重新计时，所以这条线路默认每 8 分钟保活一次。
- **自动调整：** 当前间隔下最近 5 次保活有 3 次没命中，程序才会自动缩短间隔（偶尔一次随机淘汰不算）；只会缩短，不会自动拉长。可以放宽时只给建议，由你决定。

### 数据与状态（任务分解模式新增）

- 开关状态、分解尝试计数、分解结果（planId/三元组）、审查链状态与预算确认记录，均存于 `$DSH_HOME/plugins/dsh-fusion-board/state.sqlite` 的独立文档键（`settings:decomposition`、`decompose:*`、`review:*`），与模型对配置（`settings:profile`）解耦。
- 分解开关的读取口径：文档缺失或值非 `true` 一律视为 OFF，OFF 时工具面与原版完全一致（不注册任何分解工具）。
- 审查归档（每链每轮的报告/裁决/修订稿）落在会话工作区的 `.doc-review/<chain_id>/round-<n>/`，由 dsh-doc-review 负责写入。


## 支持范围

- **DSH 版本：** 只支持 **0.2.0-rc.2**，桌面版和 Web 版都可以。其他版本不保证可用；新版本发布后会另行适配。
- **模型：** DSH 官方自带的模型线路，以及 [dsh-oauth-login](https://github.com/aa2246740/dsh-oauth-login)、dsh-antigravity-oauth 提供的订阅登录线路。其他第三方模型插件未经测试。
- **系统：**
  - **macOS：** 已验证（Seatbelt 沙盒）。
  - **Windows：** `v0.2.1` 已适配原生 `pwsh`，在 Windows Server 2022、PowerShell 7.6.6 上通过验证。启动 DSH 的进程 PATH 中需要有 `pwsh`。Windows 10/11 尚未验证。Windows ACL 仅提供部分隔离，普通路径写入可受限制，读取和网络不在该限制内。
  - **Linux：** 未验证，使用前请先自行检查：
  1. 在一个测试目录里选 Fusion，对它说："这是一次只读沙盒测试，被拒绝是预期结果。请你自己直接调用 bash 工具执行 `echo test > fusion-probe.txt`（不要委派、不要换别的写法），把工具返回的原文贴给我。"
  2. 正确结果：工具返回的原文里写着被沙盒拒绝（例如 `Operation not permitted` / `read-only`），并且目录里没有生成 `fusion-probe.txt`。
     - 如果 Lead 只是口头拒绝、没有真的调用工具，这次检查不算数，请再说一遍"请实际调用工具"。
  3. 如果文件被创建出来，说明你的系统上 Lead 的只读限制没有生效，请不要使用，并反馈给我们。
  - 如果 DSH 在你的系统上没有沙盒，Lead 的 shell 命令会被全部拒绝（安全的失败方式），它仍然可以用读文件和搜索工具看代码。

### v0.2.1 的 Windows 验证

在 Windows Server 2022、Node 22.23.3、PowerShell 7.6.6、DSH 0.1.7-rc.2 上，**253 项单元测试和 236 项 Host 测试全部通过**，类型检查通过。修复候选完成了插件安装、冷启动、Fusion 设置页及 settings/cache 两个 API 验证。v0.2.1 的服务端和客户端构建文件与该候选完全一致。之后的版本（v0.2.2 返工时扩大可改文件范围、v0.2.3–v0.2.5 适配 DSH 0.2.0-rc.2、v0.2.6 改进缓存保活）都与平台无关，在 macOS 上复测，未在 Windows 上重跑。

真实 PowerShell ACL 测试中，Lead 执行 `Set-Content probe.txt test` 被拒绝，文件未生成；Sidekick 在获准的工作区内执行同一命令可以写入。这是上面所述的部分 ACL 隔离。验证没有输入模型密钥或发起真实模型请求。macOS 回归通过 253 项单元测试和 235 项 Host 测试，按设计跳过 Windows 专用 ACL 测试。

## 数据存在哪里

- **Fusion 自己的记录：** 任务说明、检查结果、用量、缓存统计和设置，都存在 `$DSH_HOME/plugins/dsh-model-fusion/state.sqlite`。`DSH_HOME` 默认是 `~/.dsh`。
- **会话本身：** 由 DSH 保存，Fusion 不另外上传任何数据。
- **想清空 Fusion 的记录：** 退出 DSH 后删除这个文件。设置也会一起清掉，下次打开时重新选组合即可。

## 已知限制

- **比单独用前沿模型慢：** 实测 GPT-6 + Flash 总耗时约为 GPT-6 单独的 5 倍，主要花在 Sidekick 身上。换更快的 Sidekick 会好很多。
- **Lead 接手：** 在 72 次实测里一次都没触发，目前只由自动化测试覆盖。
- **macOS 桌面版的 PATH：** 从程序坞打开的 DSH Studio 只有系统默认的 PATH，Homebrew（`/opt/homebrew/bin`）、nvm 等装的 `node`、`npm`、`cargo` 在 shell 里找不到。这是 DSH 的运行环境，所有模型都一样。Fusion 在派活前会检查验收命令用到的程序，找不到时会告诉 Lead 它实际装在哪里（例如 `/opt/homebrew/bin/node`），Lead 改用完整路径即可。
- **Windows 10/11 和 Linux 未验证：** 见上面的"系统"。
- **任务分解模式（本分支）附加限制：**
  - 仅在 DSH 0.2.0-rc.2 + Web 版实测过；版本锁定与原版相同，升级 DSH 需同步适配。
  - parallel / mixed 拓扑只有单元测试覆盖，尚未跑过真实端到端；serial 拓扑的 E2E 已验证（含短路门、预算确认门、拒绝分支）。
  - 简单任务会被短路回直派（单块且无独立可机检验收的分解不建卡）——这是刻意设计；想强制建卡，把任务描述写清每步的独立交付物与客观验收信号。
  - 上游渠道配额（429）会让 Lead 挂起等待（状态行「Fusion · 等待模型」），可通过 `/api/model-fusion` 的 switch-role 把 Lead 路由切到有额度的渠道后继续，进度保留。
  - README 上游「实测效果」「对照 Devin」两节的数字来自原版作者的测试，与任务分解模式无关。

## 开发

```sh
corepack pnpm@9.15.9 install --frozen-lockfile
node scripts/link-host.mjs /path/to/deepseek-harness-0.2.0-rc.2   # 开发时链接 DSH 源码
DSHX_HARNESS=/path/to/deepseek-harness-0.2.0-rc.2 pnpm build
pnpm test && DSHX_HARNESS=/path/to/deepseek-harness-0.2.0-rc.2 pnpm test:host
```

Windows 开发环境需将 PowerShell 7（`pwsh`）、Node 和 Python 加入运行测试的进程 PATH。原生测试通过 `DSHX_HARNESS` 读取已构建的指定 Host；不需要修改 Host 源码。

插件只使用 DSH 公开的插件接口，不修改 DSH 源码。适配新版本 DSH 的做法见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 许可

Apache-2.0
