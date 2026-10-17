// FT08 依赖 — TB-C5 十一项最低覆盖的机检清单与检查函数。
//
// 判据单一来源（禁止漂移口径）：本文件是 dsh-doc-review **v0.2.1** task-prompt SKILL
// 文末「TB-C5 十一项自查清单」（锚点 C5-1～C5-11）的机检副本。
// 源文件：D:\dsh\dsh-doc-review\skills\doc-review-task-prompt\SKILL.md（version=0.2.1）。
// 更新方式：从该 SKILL 重新复制并同步 SOURCE_VERSION，不在本文件独立演化规则。

import type { SchemaIssue } from './schema.js'

/** 来源版本标注：机检口径所属的 doc-review 发布版本。 */
export const TB_C5_SOURCE_VERSION = '0.2.1'
export const TB_C5_SOURCE_PATH = 'D:\\dsh\\dsh-doc-review\\skills\\doc-review-task-prompt\\SKILL.md'

export interface TbC5Item {
  readonly anchor: string
  readonly title: string
  /** 机检信号：在 prompt 全文中能命中该正则即视为"有对应段落"（缺项判前已含同义段落匹配面）。 */
  readonly pattern: RegExp
  readonly hint: string
}

export const TB_C5_ITEMS: readonly TbC5Item[] = [
  { anchor: 'C5-1', title: '自包含目标', pattern: /## 目标（自包含）[\s\S]*?\n(?=## )/, hint: '缺「## 目标（自包含）」小节及内容' },
  { anchor: 'C5-2', title: '工作区绝对路径', pattern: /## 工作区[\s\S]*?(?:[A-Za-z]:[\\/]|\/home\/|\/var\/|\/tmp\/)/, hint: '缺「## 工作区」及绝对路径' },
  { anchor: 'C5-3', title: '输入物清单', pattern: /## 输入物清单[\s\S]*?\n- \S/, hint: '缺「## 输入物清单」或无条目' },
  { anchor: 'C5-4', title: '产物及路径', pattern: /## 产物及路径[\s\S]*?\n- .*(?:[A-Za-z]:[\\/]|\/|\S+\.\S+)/, hint: '缺「## 产物及路径」或条目不含文件路径' },
  { anchor: 'C5-5', title: '执行步骤有序', pattern: /## 执行步骤[\s\S]*?Step 1/, hint: '缺「## 执行步骤」或未从 Step 1 编号' },
  { anchor: 'C5-6', title: '每步命令可直接运行', pattern: /```powershell\n[\s\S]*?\n```/, hint: '步骤中缺可直接运行的命令代码块' },
  { anchor: 'C5-7', title: '验收客观正信号', pattern: /## 验收信号[\s\S]*?(退出码|正信号)/, hint: '缺「## 验收信号」或无退出码/正信号口径' },
  { anchor: 'C5-8', title: '边界范围', pattern: /## 边界[\s\S]*?\n(?=[^\s])/m, hint: '缺「## 边界」小节内容' },
  { anchor: 'C5-9', title: '不得碰禁令清单', pattern: /## 禁令清单[\s\S]*?禁止/, hint: '缺「## 禁令清单」或无「禁止」条目' },
  { anchor: 'C5-10', title: '上下文交接', pattern: /## 上下文交接[\s\S]*?(task_board_get|卡 id|文件路径)/, hint: '缺「## 上下文交接」或无卡 id/文件路径交接物' },
  { anchor: 'C5-11', title: '引用路径可追溯', pattern: /## 引用与来源[\s\S]*?(dsh-doc-review v|【待核实】|来源版本)/, hint: '缺「## 引用与来源」，判据/引用未标来源版本或【待核实】' },
]

export interface TbC5CheckResult {
  readonly ok: boolean
  readonly issues: readonly SchemaIssue[]
}

/** 逐条机检 prompt 的 TB-C5 覆盖；一条缺项一个 issue（同源 SKILL 的机检纪律）。 */
export function checkPromptC5(prompt: string): TbC5CheckResult {
  const issues: SchemaIssue[] = []
  for (const item of TB_C5_ITEMS) {
    if (!item.pattern.test(prompt)) {
      issues.push({
        code: `TB_C5_${item.anchor.replace('-', '_')}_MISSING`,
        path: '$.prompt',
        message: `[D10][${item.anchor}] ${item.title}缺失：${item.hint}`,
      })
    }
  }
  return { ok: issues.length === 0, issues }
}

/** 生成注入 prompt 文末的「引用与来源」段（保证 C5-11 机检信号恒在且口径同源）。 */
export function buildSourceSection(): string {
  return [
    '## 引用与来源',
    `- 本任务书判据同源引用：dsh-doc-review v${TB_C5_SOURCE_VERSION} task-prompt SKILL（${TB_C5_SOURCE_PATH}），锚点 C5-1～C5-11。`,
    '- 写作规则口径同源引用：技能 llm-doc-writing-standard R1–R55（关键条目见「规则口径」段）。',
    '- 未经核实的引用路径或事实必须打【待核实】标签，禁止写成事实断言。',
  ].join('\n')
}

/** 生成注入 prompt 的「规则口径（R1–R55 关键条目）」段。 */
export function buildRuleSection(): string {
  return [
    '## 规则口径（llm-doc-writing-standard R1–R55 关键条目）',
    '- R6 三要素：每条要求给「做法+条件+后果」，禁止只给动词不给判据。',
    '- R27/R28 分支穷尽：所有分支写尽并带保守兜底；分支入口必须可用客观信号判别。',
    '- R31 验证绑定客观信号：每步验收给可运行命令与正信号（退出码/输出行/文件存在）。',
    '- R38 量纲口径单点：单位、版本、阈值只在一处定义，其余引用该处。',
    '- R40 机器格式给真实样例：要求 JSON/文件名/命令时附真实样例，不描述结构就算讲清。',
    '- R47 待核实标签：查不到依据的内容标【待核实】，不得写成事实。',
    '- R53 判定性规则四要素：条件、动作、例外、后果齐备才允许进清单。',
    '- R54/R55 最小充分长度：不复述本任务书已有的口径，压缩不丢事实。',
  ].join('\n')
}
