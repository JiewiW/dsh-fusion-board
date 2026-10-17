// FT05/FT06/FT07 — ON 模式 Lead 分解系统提示（S1）。
// TB-P1 路径分析（列块→标依赖→定拓扑，依赖无法判定保守按串行）内置为固定步骤与自检表，
// 拓扑三枚举 + 保守串行兜底在 prompt（本文件）与代码（schema.ts/topology.ts）两侧同时落地。

import { buildTbP1Section } from './tb-p1.js'
import { TOPOLOGY_VALUES } from './schema.js'

/** decomposition JSON Schema 的 prompt 侧文字化（与 schema.ts 字段一一对应）。 */
const SCHEMA_SECTION = [
  '## 输出格式（S1 分解计划，必须是且仅是一个 JSON 对象）',
  '{',
  '  "goal": "用户目标复述（一句话，自包含）",',
  '  "blocks": [',
  '    {',
  '      "id": "b1（计划内唯一，≤40字符）",',
  '      "title": "块标题（一行）",',
  '      "deliverables": ["交付物及路径（绝对路径或工作区相对路径）"],',
  '      "acceptance": ["客观验收：命令 + 正信号串，如 \u0022vitest 退出码 0 且 Test Files N passed\u0022"],',
  '      "inputs": ["开工前必须存在/可读的输入物"],',
  '      "touches": ["允许改动的路径（权限最小化）"],',
  '      "dependsOn": ["同计划内 block id；无依赖则空数组"],',
  '      "parallelGroup": "可选：同一组名表示可并发（仅 dependsOn 为空的块允许）",',
  '      "rationale": "本块不可再合并/必须串行（或可并行）的依据；紧耦合微步骤以\u0022微步骤=\u0022开头",',
  '      "topology": "见顶层字段，块级不填"',
  '    }',
  '  ],',
  `  "topology": "${TOPOLOGY_VALUES.join(' | ')}"（三枚举，别无他值）`,
  '  "rationale": "整体拓扑判定依据"',
  '}',
].join('\n')

const RULES_SECTION = [
  '## 分解规则（硬性）',
  '- 必须先完成下方 TB-P1 路径分析，再给出 JSON；分析过程写进 rationale，不单独输出。',
  '- 凡 dependsOn 非空的块，禁止标记 parallelGroup（代码侧同样强制，违反即校验失败）。',
  '- 依赖无法判定时按串行处理，并在该块 rationale 注明「保守串行」（TB-P1 保守口径）。',
  '- acceptance 每条必须是客观命令 + 正信号串，禁止「做好、完善、合理」类无法机检的措辞。',
  '- touches 权限最小化：只列本块必须改动的路径，禁止整仓放行。',
  '- 简单任务短路：若判断只有 1 个块且无独立验收信号（拆了也不产生可并行/可介入价值），',
  '  不要输出分解 JSON，直接回复「短路：<原因>」，走 OFF 直派路径并向用户说明（§6 D6）。',
  '- 分解计划未通过 Schema 校验不得进入 S2；校验失败会带 issues 清单退回，按清单逐条修正后重发完整 JSON。',
].join('\n')

/** ON 模式下 fusion_decompose 工具的使用指引（工具参数与返回约定）。 */
const TOOL_SECTION = [
  '## 工具调用方式',
  '完成上述分析后，调用 fusion_decompose，参数 decomposition=你产出的完整 JSON 文本（workspaceRoot 可选，默认当前工作区）。',
  '工具返回：成功=S2 卡片三元组清单（title/description/prompt/tags，供后续 S4 建卡）；',
  '失败=issues 清单（逐条 [code] path: message），据此修正后再次调用；同一分解最多 3 次尝试（含首次），',
  '超限将按降级口径回报用户且不建卡。短路判定由代码侧兜底：即使你未自判，单块且无独立验收也会被短路回 OFF 直派。',
].join('\n')

export function buildLeadDecompositionPrompt(): string {
  return [
    '# 任务分解模式（ON）— Lead S1 职责',
    '你是 Lead。ON 模式下禁止直接派活（fusion_delegate 已被门控），唯一合法第一步是完成任务分解（S1）并交由工具生成卡片三元组（S2）。',
    '',
    SCHEMA_SECTION,
    '',
    RULES_SECTION,
    '',
    buildTbP1Section(),
    '',
    TOOL_SECTION,
  ].join('\n')
}
