// S1→S2 编排器（FT05–FT09 汇总入口）：Lead 文本 → 强校验 → 短路/降级 → 卡片三元组。
// LLM 调用以函数注入，离线测试用桩（固定 JSON），不启动真实模型。

import type { SchemaIssue } from './schema.js'
import { parseDecompositionJson, validateDecomposition, type Decomposition } from './schema.js'
import { DECOMPOSITION_MAX_ATTEMPTS, analyzeTopology, checkTopologyAgreement, validateStageOne } from './topology.js'
import { decideShortcircuit } from './shortcircuit.js'
import { buildCardPlan, type DecompositionPlan } from './granularity.js'
import { makePlanId } from './serial-protocol.js'
import { buildTriplets, type CardTriplet, type TripletOptions } from './triplet.js'
import { buildLeadDecompositionPrompt } from './lead-prompt.js'

export type LlmCall = (prompt: string) => Promise<string>

export interface StageOneResult {
  readonly ok: boolean
  readonly decomposition?: Decomposition
  readonly attempts: number
  readonly issues: readonly SchemaIssue[]
  readonly degraded: boolean
  readonly report: string
}

function formatIssues(issues: readonly SchemaIssue[]): string {
  return issues.map(issue => `- [${issue.code}] ${issue.path}: ${issue.message}`).join('\n')
}

/**
 * S1：Lead 文本 → decomposition。Schema/拓扑/一致性三类校验合并为一次判定；
 * 失败按既有重试口径最多 2 次修正（含首次共 3 次），仍失败按 §6 降级：回报用户、不建卡。
 * 重试时把 issues 清单回灌给 Lead（feedback 追加到 prompt 尾部）。
 */
export async function runStageOne(callLlm: LlmCall, goalText: string, maxAttempts = DECOMPOSITION_MAX_ATTEMPTS): Promise<StageOneResult> {
  const base = `${buildLeadDecompositionPrompt()}\n\n# 用户需求\n${goalText}`
  let feedback = ''
  let lastIssues: readonly SchemaIssue[] = []
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const text = await callLlm(base + feedback)
    const parsed = parseDecompositionJson(text)
    if (!parsed.ok) {
      lastIssues = parsed.issues
      feedback = `\n\n# 上一次输出未通过校验（第 ${attempt} 次），逐条修正后重发完整 JSON\n${formatIssues(lastIssues)}`
      continue
    }
    const stage = validateStageOne(parsed.value)
    if (!stage.ok || stage.decomposition === undefined) {
      lastIssues = stage.issues
      feedback = `\n\n# 上一次输出未通过校验（第 ${attempt} 次），逐条修正后重发完整 JSON\n${formatIssues(lastIssues)}`
      continue
    }
    return { ok: true, decomposition: stage.decomposition, attempts: attempt, issues: [], degraded: false, report: `S1 通过（第 ${attempt}/${maxAttempts} 次尝试）。` }
  }
  return {
    ok: false,
    attempts: maxAttempts,
    issues: lastIssues,
    degraded: true,
    report: [
      `S1 校验连续 ${maxAttempts} 次失败，按 §6 降级口径处理：回报用户、不建卡。`,
      '最后一轮 issues：',
      formatIssues(lastIssues),
      '请人工确认分解 JSON 是否符合 Schema（goal/blocks[]/topology/rationale），或改回 OFF 模式直派。',
    ].join('\n'),
  }
}

export interface StageTwoResult {
  readonly ok: boolean
  readonly planId: string
  readonly branch: 1 | 2 | 3 | 4 | 5
  readonly plan?: DecompositionPlan
  readonly triplets: readonly CardTriplet[]
  readonly issues: readonly SchemaIssue[]
  readonly report: string
}

/**
 * S2：短路判定优先（FT07）；否则拓扑→卡片粒度五分支（FT09）→三元组生成 + TB-C5 机检（FT08）。
 * 短路时不进入 S2、不建卡；三元组任一 prompt 缺 TB-C5 项时 ok=false（不得进入 S3）。
 */
export function runStageTwo(decomposition: Decomposition, options: TripletOptions, planId?: string): StageTwoResult {
  const shortcircuit = decideShortcircuit(decomposition)
  if (shortcircuit.shortcircuit) {
    return { ok: true, planId: '', branch: 5, triplets: [], issues: [], report: shortcircuit.reason }
  }
  const analysis = analyzeTopology(decomposition.blocks)
  const agreements: readonly SchemaIssue[] = checkTopologyAgreement(decomposition.topology, analysis)
  const id = planId ?? makePlanId(decomposition.goal)
  const plan = buildCardPlan(decomposition, analysis, id)
  const built = buildTriplets(plan, decomposition, options)
  const issues = [...plan.issues, ...agreements]
  const report = [
    `S2 完成：planId=${id}，分支=${plan.branch}，卡片单元=${plan.units.length}，三元组=${built.triplets.length}。`,
    ...(agreements.length > 0 ? agreements.map(issue => `拓扑声明与依赖图不一致：${issue.message}`) : []),
    ...(built.ok ? [] : ['TB-C5 机检存在缺项，不得进入 S3：', formatIssues(built.issues.filter(issue => !issue.code.startsWith('GRANULARITY_')))]),
  ].join('\n')
  return { ok: built.ok && agreements.length === 0, planId: id, branch: plan.branch, plan, triplets: built.triplets, issues, report }
}

export interface PipelineResult {
  readonly ok: boolean
  readonly shortcircuited: boolean
  readonly degraded: boolean
  readonly attempts: number
  readonly stageOne: StageOneResult
  readonly stageTwo?: StageTwoResult
  readonly report: string
}

/** S1→S2 一次跑通（冒烟与测试用）。 */
export async function runPipeline(callLlm: LlmCall, goalText: string, options: TripletOptions, maxAttempts = DECOMPOSITION_MAX_ATTEMPTS, planId?: string): Promise<PipelineResult> {
  const stageOne = await runStageOne(callLlm, goalText, maxAttempts)
  if (!stageOne.ok || stageOne.decomposition === undefined) {
    return { ok: false, shortcircuited: false, degraded: true, attempts: stageOne.attempts, stageOne, report: stageOne.report }
  }
  const stageTwo = runStageTwo(stageOne.decomposition, options, planId)
  return {
    ok: stageTwo.ok,
    shortcircuited: stageTwo.triplets.length === 0 && stageTwo.planId === '',
    degraded: false,
    attempts: stageOne.attempts,
    stageOne,
    stageTwo,
    report: `${stageOne.report}\n${stageTwo.report}`,
  }
}

export interface S1S2OutcomeBase {
  readonly issues: readonly SchemaIssue[]
  readonly report: string
}
export interface S1S2IssuesOutcome extends S1S2OutcomeBase { readonly kind: 'issues' }
export interface S1S2DegradedOutcome extends S1S2OutcomeBase { readonly kind: 'degraded' }
export interface S1S2ShortcircuitOutcome extends S1S2OutcomeBase { readonly kind: 'shortcircuit' }
export interface S1S2OkOutcome extends S1S2OutcomeBase {
  readonly kind: 'ok'
  readonly planId: string
  readonly branch: 1 | 2 | 3 | 4 | 5
  readonly triplets: readonly CardTriplet[]
}
export type S1S2Outcome = S1S2IssuesOutcome | S1S2DegradedOutcome | S1S2ShortcircuitOutcome | S1S2OkOutcome

function validationFailed(issues: readonly SchemaIssue[], attemptsSoFar: number): S1S2Outcome {
  const used = attemptsSoFar + 1
  if (used >= DECOMPOSITION_MAX_ATTEMPTS) {
    return { kind: 'degraded', issues, report: `S1 校验连续 ${DECOMPOSITION_MAX_ATTEMPTS} 次未通过，按 §6 降级口径：回报用户、不建卡。最后一轮 issues：\n${formatIssues(issues)}` }
  }
  return { kind: 'issues', issues, report: `S1 未通过校验（第 ${used}/${DECOMPOSITION_MAX_ATTEMPTS} 次尝试），逐条修正后重发完整 decomposition JSON：\n${formatIssues(issues)}` }
}

/**
 * fusion_decompose 工具的服务端口径（同步、纯函数）：Lead 每次重发算一次尝试，
 * attemptsSoFar 为已累计的失败次数；超 DECOMPOSITION_MAX_ATTEMPTS 走 §6 降级。
 * 短路（FT07）返回 D6 说明文本、不建卡；S2 三元组任一 prompt 缺 TB-C5 项返回 issues。
 */
export function runS1S2FromJson(decompositionText: string, options: TripletOptions, attemptsSoFar: number): S1S2Outcome {
  const parsed = parseDecompositionJson(decompositionText)
  if (!parsed.ok) return validationFailed(parsed.issues, attemptsSoFar)
  const stage = validateStageOne(parsed.value)
  if (!stage.ok || stage.decomposition === undefined) return validationFailed(stage.issues, attemptsSoFar)
  const shortcircuit = decideShortcircuit(stage.decomposition)
  if (shortcircuit.shortcircuit) return { kind: 'shortcircuit', issues: [], report: `FT07 短路（§6 D6，不进入 S2、不建卡）：${shortcircuit.reason}` }
  const stageTwo = runStageTwo(stage.decomposition, options)
  if (!stageTwo.ok) {
    return { kind: 'issues', issues: stageTwo.issues, report: `S2 未通过（TB-C5 机检缺项或拓扑声明不一致），不得进入 S3：\n${formatIssues(stageTwo.issues.filter(issue => !issue.code.startsWith('GRANULARITY_')))}` }
  }
  return { kind: 'ok', planId: stageTwo.planId, branch: stageTwo.branch, triplets: stageTwo.triplets, issues: stageTwo.issues, report: stageTwo.report }
}

export { validateDecomposition }
