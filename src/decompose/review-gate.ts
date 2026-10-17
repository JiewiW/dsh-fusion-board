// FT10–FT13 — S3 卡片 prompt 审查门（纯域模块，不接触 ctx/service，全部可离线单测）。
//
// 口径单一来源：
// - 预算常量镜像 dsh-doc-review v0.2.1 lib/cost.js（CHARS_PER_TOKEN=1.2、输出 1600、
//   重试 2 次、确认阈值 20000、链硬上限 3 轮），禁止两套漂移口径；
// - 输入包固定开销 6010 字符实测自 v0.2.1 context-builder.buildReviewInput
//   （探针 D:\\dsh\\logs\\s3-probe-inputchars.mjs：target=0/2000/6000 → input=6010/8010/12010）；
// - 轮次裁决见计划书 §3.3 S3、§8 Q6（冻结）：初审 1 次 → Lead 修订 → 仅残留 high 复审，
//   整条链硬上限 3 轮，超限按 §6 D4 停止不建卡；
// - 放行门：每份 prompt 最新报告 high=0，或残留 high 全部经用户显式 accept-reject 留痕。

/** 审查报告四维度枚举（doc-review schema.js 闭合集）。 */
export type ReviewDimension = 'fact' | 'completeness' | 'necessity' | 'format'

/** 审查问题严重级（doc-review schema.js 闭合集）。 */
export type ReviewSeverity = 'high' | 'medium' | 'low'

/** doc-review v0.2.1 报告 issue 结构（schema.js:54-82）。 */
export interface ReviewIssue {
  readonly id: string
  readonly dimension: ReviewDimension
  readonly severity: ReviewSeverity
  readonly location: string
  readonly claim: string
  readonly evidence: string
  readonly suggestion: string
}

/** doc-review v0.2.1 报告结构（service 会覆写 round/chainId/newIssueCount）。 */
export interface ReviewReport {
  readonly summary: string
  readonly issues: readonly ReviewIssue[]
  readonly newIssueCount: number
  readonly round: number
  readonly chainId: string
}

/** Lead 对单条 issue 的裁决（§3.3 S3：accept/partial/reject 各带理由）。 */
export type AdjudicationVerdict = 'accept' | 'partial' | 'reject'

export interface AdjudicationRow {
  readonly issueId: string
  readonly verdict: AdjudicationVerdict
  /** 裁决理由：accept=修订思路、partial=已修部分与遗留、reject=驳回依据。必填非空。 */
  readonly reason: string
}

/** §6 四类降级（FT13）：refusal=审查员拒审/服务侧错误(D1)；missing-service/timeout/busy 为 D2。 */
export type DegradationKind = 'refusal' | 'missing-service' | 'timeout' | 'busy'

export interface DegradationMark {
  readonly kind: DegradationKind
  /** 受影响 prompt 在分解链中的序号（CardTriplet.unitIndex）。 */
  readonly unitIndex: number
  readonly title: string
  readonly detail: string
}

// ── 预算常量（镜像 dsh-doc-review v0.2.1 lib/cost.js，改动须双侧同步） ──────────────
/** token 保守换算：字符数 / 1.2（cost.js CHARS_PER_TOKEN_CONSERVATIVE）。 */
export const CHARS_PER_TOKEN_CONSERVATIVE = 1.2
/** 单轮预期输出 token（cost.js EXPECTED_OUTPUT_TOKENS）。 */
export const EXPECTED_OUTPUT_TOKENS = 1600
/** 单轮重试上限（cost.js RETRY_LIMIT，最坏=单轮×(1+2)）。 */
export const REVIEW_RETRY_LIMIT = 2
/** 链级确认阈值 token（cost.js CONFIRM_TOKEN_THRESHOLD）。 */
export const CONFIRM_TOKEN_THRESHOLD = 20000
/** 整条分解链审查轮次硬上限（Q6 冻结：初审+复审合计 3 轮）。 */
export const MAX_REVIEW_ROUNDS = 3
/**
 * 审查输入包固定开销字符数（实测 v0.2.1：SKILL 规则+四段框架，不含目标文本）。
 * inputChars = prompt.length + 6010。
 */
export const INPUT_PACKAGE_OVERHEAD_CHARS = 6010

export interface RoundTokenEstimate {
  /** 单轮估算 token。 */
  readonly singleRoundTokens: number
  /** 最坏口径 token = 单轮 ×(1+重试2次)。 */
  readonly worstCaseTokens: number
}

/** 单份 prompt 单轮审查 token 预估（口径同 cost.js estimateRound）。 */
export function estimatePromptRound(promptChars: number): RoundTokenEstimate {
  const safeChars = Math.max(0, Math.trunc(promptChars))
  const inputPackageChars = safeChars + INPUT_PACKAGE_OVERHEAD_CHARS
  const singleRoundTokens = inputPackageChars / CHARS_PER_TOKEN_CONSERVATIVE + EXPECTED_OUTPUT_TOKENS
  return { singleRoundTokens, worstCaseTokens: singleRoundTokens * (1 + REVIEW_RETRY_LIMIT) }
}

export interface ChainBudgetEstimate {
  /** 卡片 prompt 份数。 */
  readonly promptCount: number
  /** 每份单轮最坏 token（与 promptCount 等长）。 */
  readonly perPromptWorstTokens: readonly number[]
  /** 整条链最坏轮次（Q6：3）。 */
  readonly maxRounds: number
  /** 整条链最坏总 token = Σ每份单轮最坏 × 最坏轮次。 */
  readonly worstCaseTotalTokens: number
  /** 是否超过链级确认阈值。 */
  readonly confirmationRequired: boolean
}

/** 整条分解链审查预算汇总（FT12，最坏口径：重试×3、轮次×3）。 */
export function estimateChainBudget(promptCharsList: readonly number[], maxRounds = MAX_REVIEW_ROUNDS): ChainBudgetEstimate {
  const perPromptWorstTokens = promptCharsList.map(chars => estimatePromptRound(chars).worstCaseTokens)
  const oneRoundWorst = perPromptWorstTokens.reduce((sum, tokens) => sum + tokens, 0)
  const worstCaseTotalTokens = oneRoundWorst * maxRounds
  return {
    promptCount: promptCharsList.length,
    perPromptWorstTokens,
    maxRounds,
    worstCaseTotalTokens: Math.round(worstCaseTotalTokens),
    confirmationRequired: worstCaseTotalTokens > CONFIRM_TOKEN_THRESHOLD,
  }
}

/**
 * 链级一次预算确认文本（FT12）：含 N 份数、最坏 token、最坏轮次；
 * Lead 必须原样转给用户，未获用户确认不得发起审查。
 */
export function formatBudgetConfirmation(budget: ChainBudgetEstimate): string {
  return [
    '【S3 审查预算确认（整条分解链一次确认，覆盖全部轮次）】',
    `- 待审查卡片 prompt 份数：${budget.promptCount} 份`,
    `- 最坏口径：每份 prompt 单轮审查 token ×(1+重试 ${REVIEW_RETRY_LIMIT} 次)，整条链最多 ${budget.maxRounds} 轮审查（初审 1 次 + 复审 ${budget.maxRounds - 1} 次）`,
    `- 预估总消耗上限：约 ${budget.worstCaseTotalTokens.toLocaleString('zh-CN')} token（单轮合计约 ${Math.round(budget.perPromptWorstTokens.reduce((s, x) => s + x, 0)).toLocaleString('zh-CN')} token）`,
    `- 确认阈值：${CONFIRM_TOKEN_THRESHOLD.toLocaleString('zh-CN')} token（已超出，须用户显式确认）`,
    '请向用户出示以上预算并取得明确同意；未确认前禁止发起任何审查子会话。',
  ].join('\n')
}

const VERDICTS: readonly AdjudicationVerdict[] = ['accept', 'partial', 'reject']

/**
 * 裁决表结构化校验（FT11）：
 * ①每条 issue 恰好裁决一次；②verdict 闭合枚举；③reason 非空。
 * 返回错误描述列表（空数组=通过）。
 */
export function validateAdjudication(issues: readonly ReviewIssue[], rows: readonly AdjudicationRow[]): readonly string[] {
  const errors: string[] = []
  const issueIds = new Set(issues.map(issue => issue.id))
  const seen = new Set<string>()
  for (const row of rows) {
    if (typeof row.issueId !== 'string' || row.issueId.length === 0) {
      errors.push('裁决表存在空 issueId')
      continue
    }
    if (!issueIds.has(row.issueId)) errors.push(`裁决 ${row.issueId} 不对应本轮报告中的任何 issue`)
    if (seen.has(row.issueId)) errors.push(`issue ${row.issueId} 被重复裁决`)
    seen.add(row.issueId)
    if (!VERDICTS.includes(row.verdict)) errors.push(`issue ${row.issueId} 的 verdict 非法：${String(row.verdict)}`)
    if (typeof row.reason !== 'string' || row.reason.trim().length === 0) {
      errors.push(`issue ${row.issueId} 缺少裁决理由`)
    }
  }
  for (const issue of issues) {
    if (!seen.has(issue.id)) errors.push(`issue ${issue.id} 未被裁决（accept/partial/reject 三选一且带理由）`)
  }
  return errors
}

export function isHigh(issue: ReviewIssue): boolean {
  return issue.severity === 'high'
}

export function highIssueIds(report: ReviewReport): readonly string[] {
  return report.issues.filter(isHigh).map(issue => issue.id)
}

/** 用户显式 accept-reject 留痕（§3.3 放行门例外）。 */
export interface DismissedHigh {
  readonly issueId: string
  /** 用户原话引用或可核验的留痕说明；空字符串拒绝登记。 */
  readonly reason: string
}

export interface ChainRoundRecord {
  /** 审查轮次（1=初审，2/3=复审）。 */
  readonly round: number
  /** 本轮送审 prompt 全文。 */
  readonly promptText: string
  /** 本轮结构化报告。 */
  readonly report: ReviewReport
  /** 本轮复审载荷实际包含的 issue id（初审=全部；复审=上轮 high 子集），供机检。 */
  readonly scopedIssueIds: readonly string[]
  /** Lead 对本轮报告的裁决表（初审后必有；末轮之后可为空）。 */
  adjudication: readonly AdjudicationRow[]
}

export type ChainGateState =
  | 'awaiting-initial-review'
  | 'awaiting-adjudication'
  | 'awaiting-rereview'
  | 'released'
  | 'blocked-high-remain'
  | 'degraded'

/**
 * 单份卡片 prompt 的审查链状态机（FT11）。
 * 流转：初审报告 → Lead 裁决+修订 → 仅 high 复审 →（可再一轮）→ 放行 / D4 阻断。
 */
export class PromptReviewChain {
  readonly chainId: string
  readonly unitIndex: number
  readonly title: string
  readonly rounds: ChainRoundRecord[] = []
  /** 用户显式驳回的 high issue（issueId → 留痕理由）。 */
  readonly dismissedHigh = new Map<string, string>()
  /**
   * Lead 最近一次裁决时提交的修订稿全文（FT11）。当修订后已无 high（无需复审）
   * 时该稿即 S4 建卡定稿；有复审时以最后一轮送审稿（rounds[-1].promptText）为准。
   */
  finalPromptText: string | undefined
  degradation: DegradationMark | undefined

  constructor(unitIndex: number, title: string, chainId?: string) {
    this.unitIndex = unitIndex
    this.title = title
    this.chainId = chainId ?? `s3-${unitIndex}-${Date.now().toString(36)}`
  }

  get state(): ChainGateState {
    if (this.degradation) return 'degraded'
    const last = this.rounds[this.rounds.length - 1]
    if (!last) return 'awaiting-initial-review'
    const remaining = this.remainingHighIds()
    if (remaining.length === 0) return 'released'
    // 已达硬上限且仍有 high：无论末轮是否已填裁决表，都不再有下一轮，直接 D4 阻断。
    if (this.rounds.length >= MAX_REVIEW_ROUNDS) return 'blocked-high-remain'
    if (last.adjudication.length === 0) return 'awaiting-adjudication'
    return 'awaiting-rereview'
  }

  /** 登记一轮审查报告（初审或复审）。 */
  recordRound(promptText: string, report: ReviewReport, scopedIssueIds: readonly string[]): void {
    const expectedRound = this.rounds.length + 1
    if (report.round !== expectedRound) {
      throw new Error(`chain ${this.chainId} 第 ${expectedRound} 轮收到 round=${report.round} 的报告`)
    }
    this.rounds.push({ round: expectedRound, promptText, report, scopedIssueIds: [...scopedIssueIds], adjudication: [] })
  }

  /** 最新一轮仍未清零、且未经用户驳回的 high issue。 */
  remainingHighIds(): readonly string[] {
    const last = this.rounds[this.rounds.length - 1]
    if (!last) return []
    return highIssueIds(last.report).filter(id => !this.dismissedHigh.has(id))
  }

  /**
   * 登记 Lead 裁决表并产生下一轮复审请求（FT11）。
   * 复审仅覆盖上轮 high 中 verdict=accept/partial 的 issue（reject 的 high 须走用户驳回）。
   */
  submitAdjudication(rows: readonly AdjudicationRow[], revisedPrompt: string): {
    readonly nextRound: number
    readonly targetContent: string
    readonly scopedIssueIds: readonly string[]
    readonly prevReport: ReviewReport
  } {
    const last = this.rounds[this.rounds.length - 1]
    if (!last) throw new Error(`chain ${this.chainId} 尚无初审报告，不能裁决`)
    const errors = validateAdjudication(last.report.issues, rows)
    if (errors.length > 0) throw new Error(`chain ${this.chainId} 裁决表不合法：\n${errors.join('\n')}`)
    if (typeof revisedPrompt !== 'string' || revisedPrompt.trim().length === 0) {
      throw new Error(`chain ${this.chainId} 修订后 prompt 不能为空`)
    }
    last.adjudication = rows
    this.finalPromptText = revisedPrompt
    const rejectedHigh = new Set(
      rows.filter(row => row.verdict === 'reject').map(row => row.issueId)
        .filter(id => highIssueIds(last.report).includes(id)),
    )
    for (const issueId of rejectedHigh) {
      if (!this.dismissedHigh.has(issueId)) {
        throw new Error(`chain ${this.chainId} high issue ${issueId} 被 reject：须先取得用户显式 accept-reject 留痕（dismissHigh）`)
      }
    }
    if (this.rounds.length >= MAX_REVIEW_ROUNDS) {
      throw new Error(`chain ${this.chainId} 已达硬上限 ${MAX_REVIEW_ROUNDS} 轮，不得再发起复审`)
    }
    const scopedIssueIds = highIssueIds(last.report)
      .filter(id => !this.dismissedHigh.has(id))
      .filter(id => rows.some(row => row.issueId === id && row.verdict !== 'reject'))
    const prevReport: ReviewReport = {
      summary: last.report.summary,
      issues: last.report.issues.filter(issue => scopedIssueIds.includes(issue.id)),
      newIssueCount: scopedIssueIds.length,
      round: last.round,
      chainId: this.chainId,
    }
    return { nextRound: this.rounds.length + 1, targetContent: revisedPrompt, scopedIssueIds, prevReport }
  }

  /** 序列化为 store 文档纯数据。 */
  serialize(): {
    readonly chainId: string
    readonly unitIndex: number
    readonly title: string
    readonly rounds: readonly ChainRoundRecord[]
    readonly dismissedHigh: Readonly<Record<string, string>>
    readonly finalPromptText: string | undefined
    readonly degradation: DegradationMark | undefined
  } {
    return {
      chainId: this.chainId,
      unitIndex: this.unitIndex,
      title: this.title,
      rounds: this.rounds,
      dismissedHigh: Object.fromEntries(this.dismissedHigh),
      finalPromptText: this.finalPromptText,
      degradation: this.degradation,
    }
  }

  /** 登记用户对 high issue 的显式 accept-reject 留痕（放行门例外通道）。 */
  dismissHigh(dismissed: readonly DismissedHigh[]): void {
    const known = new Set(this.rounds.flatMap(record => highIssueIds(record.report)))
    for (const item of dismissed) {
      if (!known.has(item.issueId)) throw new Error(`chain ${this.chainId} 未知 high issue：${item.issueId}`)
      if (typeof item.reason !== 'string' || item.reason.trim().length === 0) {
        throw new Error(`chain ${this.chainId} 驳回 ${item.issueId} 缺少用户留痕理由`)
      }
      this.dismissedHigh.set(item.issueId, item.reason.trim())
    }
  }
}

export interface BatchGateResult {
  /** 全部门禁通过（每份链 released）才为真；为假时绝不允许进入 S4。 */
  readonly released: boolean
  readonly releasedCount: number
  readonly blocked: readonly { unitIndex: number; title: string; highIssueIds: readonly string[]; reason: string }[]
  readonly degraded: readonly DegradationMark[]
}

/** 汇总 N 份链的放行判定（FT11 放行门 + FT13 降级汇总）。 */
export function evaluateBatchGate(chains: readonly PromptReviewChain[]): BatchGateResult {
  const blocked: NonNullable<BatchGateResult['blocked'][number]>[] = []
  const degraded: DegradationMark[] = []
  let releasedCount = 0
  for (const chain of chains) {
    if (chain.state === 'degraded' && chain.degradation) {
      degraded.push(chain.degradation)
      continue
    }
    const remaining = chain.remainingHighIds()
    if (remaining.length === 0 && chain.rounds.length > 0) {
      releasedCount += 1
      continue
    }
    const reason = chain.state === 'blocked-high-remain'
      ? `复审达硬上限 ${MAX_REVIEW_ROUNDS} 轮仍有 high（§6 D4：停止不建卡，输出争议清单请用户裁决）`
      : `仍有 ${remaining.length} 条 high 未清零（状态 ${chain.state}）`
    blocked.push({ unitIndex: chain.unitIndex, title: chain.title, highIssueIds: remaining, reason })
  }
  return { released: blocked.length === 0 && degraded.length === 0 && releasedCount === chains.length, releasedCount, blocked, degraded }
}

/** 链状态的可持久化纯数据形态（coordinator 存 store 文档用）。 */
export type SerializedReviewChain = ReturnType<PromptReviewChain['serialize']>

/** 从 store 文档恢复链状态机（乐观锁文档读出后重建）。 */
export function restoreReviewChain(data: SerializedReviewChain): PromptReviewChain {
  const chain = new PromptReviewChain(data.unitIndex, data.title, data.chainId)
  for (const record of data.rounds) chain.rounds.push({ ...record })
  for (const [issueId, reason] of Object.entries(data.dismissedHigh)) chain.dismissedHigh.set(issueId, reason)
  chain.finalPromptText = data.finalPromptText
  chain.degradation = data.degradation
  return chain
}

/** §6 降级用户提示文本（FT13：明确、不静默放行）。 */
export function formatDegradationNotice(marks: readonly DegradationMark[]): string {
  const lines: string[] = ['【S3 审查降级 — ON 流水线中止于 S3，不建卡】']
  for (const mark of marks) {
    const kindText: Record<DegradationKind, string> = {
      refusal: `审查员拒审/审查侧错误（§6 D1）：卡片 #${mark.unitIndex + 1}「${mark.title}」`,
      'missing-service': `审查服务不可用（docReview service 缺失，§6 D2）：卡片 #${mark.unitIndex + 1}「${mark.title}」`,
      timeout: `审查超时（§6 D2，600s 总超时）：卡片 #${mark.unitIndex + 1}「${mark.title}」`,
      busy: `审查服务忙（busy 互斥）：卡片 #${mark.unitIndex + 1}「${mark.title}」`,
    }
    lines.push(`- ${kindText[mark.kind]}；${mark.detail}`)
  }
  lines.push('受影响 prompt 已标记 degraded，high 疑点未清零前禁止进入 S4 建卡。')
  lines.push('可选出口：①用户确认后由 Lead 同会话自审并清单留痕；②回 OFF 模式直派。禁止静默跳过 S3。')
  return lines.join('\n')
}
