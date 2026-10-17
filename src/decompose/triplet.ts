// FT08 — S2 三元组生成器：为每个卡片单元生成 {title, description, prompt}。
//
// 口径单一来源：TB-C5 十一项与 R1–R55 关键规则内嵌于 prompt 文本（见 tb-c5.ts），
// 判据复制自 dsh-doc-review v0.2.1 task-prompt SKILL 并注明来源版本，禁止两套漂移口径。
// §3.3 S2：title=序号前缀+一句话；description=背景与验收速览；
// prompt=执行指令，必须满足 TB-C5 十一项（生成后由 checkPromptC5 机检，缺项不得进 S3）。

import type { Decomposition, DecompositionBlock } from './schema.js'
import type { CardUnit, DecompositionPlan } from './granularity.js'
import { buildRuleSection, buildSourceSection, checkPromptC5 } from './tb-c5.js'
import { buildHandoffSection, predecessorOf, serialProtocol } from './serial-protocol.js'
import type { SchemaIssue } from './schema.js'

export interface CardTriplet {
  readonly title: string
  readonly description: string
  readonly prompt: string
  /** 建卡透传字段：tags（chain/seq/parallel-group）、parentId 关系（子卡指向父卡标题）。 */
  readonly tags: readonly string[]
  readonly unitIndex: number
  readonly role: CardUnit['role']
  readonly blockIds: readonly string[]
  readonly serialIndex?: number
  readonly serialTotal?: number
  readonly chainId?: string
}

export interface TripletOptions {
  readonly workspaceRoot: string
  /** 供交接段列出的跨卡文件路径（block.inputs ∪ 前置 deliverables）。 */
  readonly handoffPaths?: readonly string[]
  /** 追加禁令（如用户级红线），逐条进入「禁令清单」。 */
  readonly extraProhibitions?: readonly string[]
}

function uniqueLines(lines: readonly string[]): string[] {
  return [...new Set(lines.filter(line => line.trim() !== ''))]
}

/** 标题行：链卡带【k/N】前缀，其余为普通一句话（TB-C1）。 */
function composeTitle(unit: CardUnit, base: string, protocolTags: readonly string[] | undefined): string {
  void protocolTags
  if (unit.serialIndex !== undefined && unit.serialTotal !== undefined) {
    return `【${unit.serialIndex}/${unit.serialTotal}】${base}`
  }
  if (unit.role === 'parent') return `父卡（汇总）：${base}`
  if (unit.role === 'child') return `子卡：${base}`
  return base
}

function blockTitles(plan: DecompositionPlan, unit: CardUnit, decomposition: Decomposition): string {
  const byId = new Map(decomposition.blocks.map(block => [block.id, block.title]))
  return unit.blockIds.map(id => byId.get(id) ?? id).join('、')
}

/** 分支 2 合并卡的按序步骤段（TB-S2：同一 prompt 内 Step 1..n，禁止拆成会并发的子卡）。 */
function mergedStepsSection(unit: CardUnit, decomposition: Decomposition): string[] {
  const byId = new Map(decomposition.blocks.map(block => [block.id, block]))
  const lines: string[] = ['## 执行步骤（按序完成，禁止并发拆卡）']
  const steps = unit.steps ?? []
  steps.forEach((step, index) => {
    const block = byId.get(step.blockId)
    lines.push(`Step ${index + 1}：${step.title}`)
    for (const deliverable of step.deliverables) lines.push(`  - 交付：${deliverable}`)
    if (block) {
      for (const acceptanceLine of block.acceptance) lines.push(`  - 本步验收：${acceptanceLine}`)
    }
  })
  return lines
}

function singleStepSection(block: DecompositionBlock): string[] {
  const lines: string[] = ['## 执行步骤（有序）', `Step 1：完成本卡目标「${block.title}」`]
  for (const touch of block.touches) lines.push(`  - 在 ${touch} 内实施`)
  lines.push('Step 2：逐项运行「验收信号」中的命令并核对正信号')
  lines.push('Step 3：按「投递闭合」输出结果')
  return lines
}

function parentStepSection(unit: CardUnit, titles: string): string[] {
  return [
    '## 执行步骤（有序）',
    `Step 1：确认所有子卡（${titles}）均已建卡并记录卡 id`,
    'Step 2：等全部子卡列为 done（用 task_board_get 逐张回读），收齐各子卡「投递闭合」输出',
    'Step 3：汇总为整体报告：每卡产物路径 + 验收命令实测结果 + 未决项',
  ]
}

function childStepSection(block: DecompositionBlock): string[] {
  const lines: string[] = ['## 执行步骤（有序）', `Step 1：完成本子卡目标「${block.title}」（父卡仅汇总，不做实现）`]
  for (const touch of block.touches) lines.push(`  - 在 ${touch} 内实施`)
  lines.push('Step 2：运行「验收信号」命令核对正信号')
  lines.push('Step 3：投递闭合：输出改动文件清单与验收结果，交父卡汇总')
  return lines
}

/** 为一个卡片单元生成三元组。 */
export function buildTriplet(plan: DecompositionPlan, decomposition: Decomposition, unitIndex: number, options: TripletOptions): CardTriplet {
  const unit = plan.units[unitIndex]!
  const byId = new Map(decomposition.blocks.map(block => [block.id, block]))
  // 描述首行的「前置：【k-1/N】<标题>」引用的是前置卡的块标题（不是本卡）。
  const predecessor = predecessorOf(plan, unit)
  const chainTitleOf = (blockId: string): string => byId.get(blockId)?.title ?? blockId
  const protocol = serialProtocol(unit, chainTitleOf, predecessor !== undefined ? chainTitleOf(predecessor.blockIds[0] ?? '') : undefined)

  const titles = blockTitles(plan, unit, decomposition)
  const base = unit.role === 'parent' ? `并行组 ${unit.parallelGroup ?? 'all'}：${titles}` : titles
  const title = composeTitle(unit, base, protocol?.tags)

  const descriptionLines: string[] = []
  if (protocol !== undefined) descriptionLines.push(protocol.descriptionFirstLine)
  else if (unit.role === 'parent') descriptionLines.push(`并行组 ${unit.parallelGroup ?? 'all'} 的父卡；子卡互相独立可并发，本卡只汇总。`)
  else if (unit.role === 'child') descriptionLines.push(`并行组 ${unit.parallelGroup ?? 'all'} 成员，可与其他子卡并发执行；前置：无。`)
  else descriptionLines.push('独立卡（无跨卡顺序约束）。')
  descriptionLines.push(`背景：总目标「${decomposition.goal}」拆分后的卡片单元，覆盖块：${titles}。`)
  const allAcceptance = uniqueLines(unit.blockIds.flatMap(id => byId.get(id)?.acceptance ?? []))
  if (allAcceptance.length > 0) descriptionLines.push('验收速览：')
  for (const line of allAcceptance) descriptionLines.push(`- ${line}`)

  const promptLines: string[] = []
  promptLines.push(`# ${title}`)
  promptLines.push('')
  promptLines.push('## 目标（自包含）')
  promptLines.push(`完成卡片单元「${titles}」，服务于总目标：${decomposition.goal}（用户目标复述，本卡可脱离会话历史独立开工）。`)
  promptLines.push('')
  promptLines.push('## 工作区')
  promptLines.push(`- 工作区绝对路径：${options.workspaceRoot}`)
  for (const touch of uniqueLines(unit.blockIds.flatMap(id => byId.get(id)?.touches ?? []))) {
    promptLines.push(`- 允许改动：${touch}`)
  }
  promptLines.push('')
  promptLines.push('## 输入物清单')
  const inputs = uniqueLines(unit.blockIds.flatMap(id => byId.get(id)?.inputs ?? []))
  if (inputs.length > 0) for (const line of inputs) promptLines.push(`- ${line}`)
  else promptLines.push('- 无外部输入物（本卡信息自包含于任务书）。')
  promptLines.push('')
  promptLines.push('## 产物及路径')
  const deliverables = uniqueLines(unit.blockIds.flatMap(id => byId.get(id)?.deliverables ?? []))
  if (deliverables.length > 0) for (const line of deliverables) promptLines.push(`- ${line}`)
  else promptLines.push(`- 汇总报告（父卡产物）：${options.workspaceRoot}\\REPORT-${plan.planId}.md`)
  promptLines.push('')
  if (unit.steps !== undefined && unit.steps.length > 0) promptLines.push(...mergedStepsSection(unit, decomposition))
  else if (unit.role === 'parent') promptLines.push(...parentStepSection(unit, titles))
  else if (unit.role === 'child') promptLines.push(...childStepSection(byId.get(unit.blockIds[0]!)!))
  else promptLines.push(...singleStepSection(byId.get(unit.blockIds[0]!)!))
  promptLines.push('')
  promptLines.push('```powershell')
  promptLines.push(`Set-Location ${options.workspaceRoot}; Write-Output "workspace-ready $LASTEXITCODE"`)
  promptLines.push('```')
  promptLines.push('')
  promptLines.push('## 验收信号（客观正信号，逐条给命令与结果）')
  if (allAcceptance.length > 0) for (const line of allAcceptance) promptLines.push(`- ${line}`)
  else promptLines.push('- 退出码 0 且上述「产物及路径」逐条存在非空（用 Get-Item 核对 Length）。')
  promptLines.push('')
  promptLines.push('## 边界')
  promptLines.push('- 只做本卡「目标（自包含）」所列工作；范围外改进标记为「可选优化」不做，除非另开卡。')
  promptLines.push('')
  promptLines.push('## 禁令清单')
  promptLines.push('- 禁止改动「工作区」小节未列出的路径；禁止越权操作。')
  promptLines.push('- 禁止对运行中的生产实例做任何写操作。')
  for (const line of options.extraProhibitions ?? []) promptLines.push(`- ${line}`)
  promptLines.push('')
  const handoffPaths = uniqueLines([
    ...(options.handoffPaths ?? []),
    ...(predecessor !== undefined ? predecessor.blockIds.flatMap(id => byId.get(id)?.deliverables ?? []) : []),
    ...inputs,
  ])
  promptLines.push(buildHandoffSection(plan, unit, predecessor, handoffPaths))
  promptLines.push('')
  promptLines.push('## 投递闭合')
  promptLines.push('- 最终回复必须包含：改动文件清单（文件:行号）、验收命令与实测结果、未决项（若有）。')
  promptLines.push('')
  promptLines.push(buildRuleSection())
  promptLines.push('')
  promptLines.push(buildSourceSection())

  const prompt = promptLines.join('\n')
  return {
    title,
    description: descriptionLines.join('\n'),
    prompt,
    tags: protocol?.tags ?? (unit.parallelGroup !== undefined ? [`parallel-group:${unit.parallelGroup}`] : []),
    unitIndex,
    role: unit.role,
    blockIds: unit.blockIds,
    ...(unit.serialIndex !== undefined ? { serialIndex: unit.serialIndex } : {}),
    ...(unit.serialTotal !== undefined ? { serialTotal: unit.serialTotal } : {}),
    ...(unit.chainId !== undefined ? { chainId: unit.chainId } : {}),
  }
}

export interface TripletSetResult {
  readonly ok: boolean
  readonly triplets: readonly CardTriplet[]
  readonly issues: readonly SchemaIssue[]
}

/** S2 全量生成 + TB-C5 机检（缺项即 fail，不得进入 S3）。 */
export function buildTriplets(plan: DecompositionPlan, decomposition: Decomposition, options: TripletOptions): TripletSetResult {
  const triplets: CardTriplet[] = []
  const issues: SchemaIssue[] = [...plan.issues]
  for (let index = 0; index < plan.units.length; index += 1) {
    const triplet = buildTriplet(plan, decomposition, index, options)
    triplets.push(triplet)
    for (const issue of checkPromptC5(triplet.prompt).issues) {
      issues.push({ ...issue, path: `$.units[${index}].prompt`, message: `${issue.message}（卡「${triplet.title}」）` })
    }
  }
  return { ok: issues.filter(issue => !issue.code.startsWith('GRANULARITY_')).length === 0, triplets, issues }
}
