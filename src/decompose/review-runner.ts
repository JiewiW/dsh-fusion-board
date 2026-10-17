// FT10/FT13 — S3 审查客户端（host 适配层）：消费 dsh-doc-review v0.2.1 的
// ctx service「docReview」.reviewPrompt，不感知 DSL/工具定义。
//
// 关键约束（计划书 §3.3 S3、M0 R5、doc-review v0.2.1 service.js 亲验）：
// - 服务名 "docReview"，经 cordis reflect 动态取用（scope.get('docReview')），
//   缺失即 §6 D2「service 不可用」：ON 流水线中止在 S3，不建卡；
// - service busy 互斥键=parentAgent.session.id，同 parent 并发第二发立即 {kind:'busy'}，
//   故 N 份初审在客户端物理串行（逻辑同时发起、逐一过服务）；
// - 子会话由 doc-review spawn 为全新独立会话（reviewer.js run.dispose() 幂等释放），
//   输入包仅含 targetContent+SKILL 框架，不含主会话历史；
// - AbortSignal 透传，总超时沿用 reviewer.js DEFAULT_TIMEOUT_MS=600_000；
// - 信封分类：report 放行解析；freeform=审查员拒审(D1)；timeout/start-error/busy/no-agent
//   按 §6 D1/D2 标记降级，绝不静默放行。

import {
  PromptReviewChain,
  type AdjudicationRow,
  type DegradationKind,
  type DegradationMark,
  type ReviewReport,
} from './review-gate.js'

/** doc-review v0.2.1 reviewPrompt 入参（仅列本客户端使用字段，完整契约见 service.js:115）。 */
export interface ReviewPromptParams {
  readonly targetContent: string
  readonly docType: 'task-prompt'
  readonly parentAgent: unknown
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly chain?: { readonly chainId: string; readonly round: number; readonly prevAdjudication?: readonly AdjudicationRow[] }
  readonly prevReport?: ReviewReport | null
  readonly references?: readonly string[]
  readonly workspaceRoot?: string
}

/** doc-review v0.2.1 判别信封（service.js:208-255，kind 闭合八态）。 */
export type ReviewPromptEnvelope =
  | { readonly kind: 'report'; readonly report: ReviewReport; readonly archivePath: string | null; readonly inputChars: number; readonly attempts: number }
  | { readonly kind: 'freeform'; readonly freeformText: string; readonly inputChars: number; readonly attempts: number }
  | { readonly kind: 'timeout'; readonly inputChars?: number; readonly attempts?: number }
  | { readonly kind: 'aborted'; readonly inputChars?: number; readonly attempts?: number }
  | { readonly kind: 'start-error'; readonly error: Error | string; readonly inputChars?: number; readonly attempts?: number }
  | { readonly kind: 'busy'; readonly docType?: string }
  | { readonly kind: 'no-agent'; readonly inputChars?: number }
  | { readonly kind: 'short-circuit'; readonly value?: unknown }

/** docReview ctx service 的最小结构契约（只取 reviewPrompt）。 */
export interface DocReviewService {
  reviewPrompt(params: ReviewPromptParams): Promise<ReviewPromptEnvelope>
}

/** §6 D2：service 缺失（插件未装/未激活）。 */
export class ReviewServiceMissingError extends Error {
  constructor() {
    super('docReview ctx service 不可用（dsh-doc-review 未安装或未激活），按 §6 D2 中止在 S3')
    this.name = 'ReviewServiceMissingError'
  }
}

/** 沿用 doc-review reviewer.js:29 DEFAULT_TIMEOUT_MS（600s 总超时口径）。 */
export const REVIEW_TIMEOUT_MS = 600_000

export interface InitialPromptInput {
  readonly unitIndex: number
  readonly title: string
  readonly prompt: string
  readonly chainId?: string
}

export interface RunInitialReviewsOptions {
  /** cordis reflect 取到的 docReview 实现；null/undefined 由调用方先拦截（D2）。 */
  readonly service: DocReviewService
  /** 工具闭包持有的 parent agent 句柄（#tools(scope, agent, role) 的 agent）。 */
  readonly parentAgent: unknown
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly workspaceRoot?: string
}

export type InitialReviewOutcome =
  | { readonly kind: 'report'; readonly chain: PromptReviewChain }
  | { readonly kind: 'degraded'; readonly chain: PromptReviewChain; readonly mark: DegradationMark }

function markForEnvelope(chain: PromptReviewChain, envelope: ReviewPromptEnvelope, detail: string): DegradationMark {
  const kindByEnvelope: Partial<Record<ReviewPromptEnvelope['kind'], DegradationKind>> = {
    freeform: 'refusal',
    'start-error': 'refusal',
    timeout: 'timeout',
    busy: 'busy',
    'no-agent': 'missing-service',
    aborted: 'refusal',
    'short-circuit': 'refusal',
  }
  const kind = kindByEnvelope[envelope.kind] ?? 'refusal'
  return { kind, unitIndex: chain.unitIndex, title: chain.title, detail }
}

function envelopeDetail(envelope: ReviewPromptEnvelope): string {
  switch (envelope.kind) {
    case 'freeform':
      return `审查员输出散文而非结构化报告（连续 ${envelope.attempts ?? 3} 次不合规，§6 D1）：${String(envelope.freeformText).slice(0, 200)}`
    case 'timeout':
      return '审查子会话 600s 总超时（§6 D2）'
    case 'start-error':
      return `审查子会话启动失败（§6 D1）：${String(envelope.error instanceof Error ? envelope.error.message : envelope.error).slice(0, 200)}`
    case 'busy':
      return 'docReview busy 互斥命中（同一 parent session 已有在飞审查）'
    case 'no-agent':
      return 'service 返回 no-agent（parentAgent 句柄不可用，无法建立独立子会话）'
    case 'aborted':
      return '审查子会话被中止（aborted）'
    case 'short-circuit':
      return '审查被 beforeRun 钩子短路（本客户端未注册钩子，属异常）'
    default:
      return `未知信封：${String((envelope as { kind?: string }).kind)}`
  }
}

async function invokeOne(
  service: DocReviewService,
  params: ReviewPromptParams,
  chain: PromptReviewChain,
): Promise<InitialReviewOutcome> {
  const envelope = await service.reviewPrompt(params)
  if (envelope.kind === 'report') {
    chain.recordRound(params.targetContent, envelope.report, envelope.report.issues.map(issue => issue.id))
    return { kind: 'report', chain }
  }
  const mark = markForEnvelope(chain, envelope, envelopeDetail(envelope))
  chain.degradation = mark
  return { kind: 'degraded', chain, mark }
}

/**
 * FT10：N 份卡片 prompt 初审。
 * 逻辑上并发发起，物理上按 parent session 串行过 service（防 busy 立即返回）；
 * 任一 prompt 失败只标记该链 degraded，不影响其余 prompt 审查（但批次门最终 fail-closed）。
 */
export async function runInitialReviews(
  inputs: readonly InitialPromptInput[],
  options: RunInitialReviewsOptions,
): Promise<readonly InitialReviewOutcome[]> {
  const outcomes: InitialReviewOutcome[] = []
  for (const input of inputs) {
    if (options.signal?.aborted) throw new Error('S3 初审在发起前被 abort 取消')
    const chain = new PromptReviewChain(input.unitIndex, input.title, input.chainId)
    const params: ReviewPromptParams = {
      targetContent: input.prompt,
      docType: 'task-prompt',
      parentAgent: options.parentAgent,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? REVIEW_TIMEOUT_MS,
      chain: { chainId: chain.chainId, round: 1 },
      workspaceRoot: options.workspaceRoot,
    }
    try {
      outcomes.push(await invokeOne(options.service, params, chain))
    } catch (error) {
      // service 同步抛错（DocReviewArgumentError 等）按 D1 refusal 标记，不静默放行。
      const mark: DegradationMark = {
        kind: 'refusal',
        unitIndex: chain.unitIndex,
        title: chain.title,
        detail: `reviewPrompt 抛错（§6 D1）：${String(error instanceof Error ? error.message : error).slice(0, 200)}`,
      }
      chain.degradation = mark
      outcomes.push({ kind: 'degraded', chain, mark })
    }
  }
  return outcomes
}

export interface RereviewOptions {
  readonly service: DocReviewService
  readonly parentAgent: unknown
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly workspaceRoot?: string
}

/**
 * FT11：按链顺序发起复审。复审载荷仅含上轮残留 high 项（prevReport.issues 已由
 * PromptReviewChain.submitAdjudication 裁剪为 high 子集），机检点=scopedIssueIds。
 */
export async function runRereview(
  chain: PromptReviewChain,
  next: {
    readonly nextRound: number
    readonly targetContent: string
    readonly scopedIssueIds: readonly string[]
    readonly prevReport: ReviewReport
  },
  options: RereviewOptions,
): Promise<InitialReviewOutcome> {
  if (options.signal?.aborted) throw new Error('S3 复审在发起前被 abort 取消')
  const params: ReviewPromptParams = {
    targetContent: next.targetContent,
    docType: 'task-prompt',
    parentAgent: options.parentAgent,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? REVIEW_TIMEOUT_MS,
    chain: { chainId: chain.chainId, round: next.nextRound, prevAdjudication: chain.rounds[chain.rounds.length - 1]?.adjudication },
    prevReport: next.prevReport,
    workspaceRoot: options.workspaceRoot,
  }
  try {
    const envelope = await options.service.reviewPrompt(params)
    if (envelope.kind === 'report') {
      chain.recordRound(next.targetContent, envelope.report, next.scopedIssueIds)
      return { kind: 'report', chain }
    }
    const mark = markForEnvelope(chain, envelope, envelopeDetail(envelope))
    chain.degradation = mark
    return { kind: 'degraded', chain, mark }
  } catch (error) {
    const mark: DegradationMark = {
      kind: 'refusal',
      unitIndex: chain.unitIndex,
      title: chain.title,
      detail: `复审 reviewPrompt 抛错（§6 D1）：${String(error instanceof Error ? error.message : error).slice(0, 200)}`,
    }
    chain.degradation = mark
    return { kind: 'degraded', chain, mark }
  }
}

/** 为整条链的每份 prompt 生成 D2「service 缺失」降级标记（未发起任何审查时使用）。 */
export function missingServiceMarks(inputs: readonly InitialPromptInput[]): readonly DegradationMark[] {
  return inputs.map(input => ({
    kind: 'missing-service',
    unitIndex: input.unitIndex,
    title: input.title,
    detail: 'docReview ctx service 未注册：dsh-doc-review 插件未安装或未激活（§6 D2）',
  }))
}
