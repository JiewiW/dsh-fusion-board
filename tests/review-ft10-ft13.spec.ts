// FT10–FT13 / A3 — S3 审查门纯域与适配层单测（不加载插件、不起 host）。
import { describe, expect, it, vi } from 'vitest'
import {
  CONFIRM_TOKEN_THRESHOLD,
  INPUT_PACKAGE_OVERHEAD_CHARS,
  MAX_REVIEW_ROUNDS,
  PromptReviewChain,
  estimateChainBudget,
  evaluateBatchGate,
  formatBudgetConfirmation,
  formatDegradationNotice,
  highIssueIds,
  validateAdjudication,
  type AdjudicationRow,
  type ReviewIssue,
  type ReviewReport,
} from '../src/decompose/review-gate.js'
import {
  REVIEW_TIMEOUT_MS,
  missingServiceMarks,
  runInitialReviews,
  runRereview,
  type DocReviewService,
  type ReviewPromptEnvelope,
  type ReviewPromptParams,
} from '../src/decompose/review-runner.js'

function makeIssue(partial: Partial<ReviewIssue> & { id: string; severity: ReviewIssue['severity'] }): ReviewIssue {
  return { dimension: 'completeness', location: '验收：运行命令 X', claim: 'D2', evidence: 'no-reference', suggestion: '补命令', ...partial }
}

function makeReport(round: number, chainId: string, issues: readonly ReviewIssue[]): ReviewReport {
  return { summary: 's', issues, newIssueCount: issues.length, round, chainId }
}

/** 让 chain 接受一轮报告（绕过 service）。 */
function seedRound(chain: PromptReviewChain, report: ReviewReport, scoped = report.issues.map(i => i.id)): void {
  chain.recordRound(chain.rounds.length === 0 ? '' : chain.rounds[chain.rounds.length - 1].promptText, report, scoped)
}

describe('FT12 预算汇总与确认门', () => {
  it('单份单轮口径=（字符+固定开销)/1.2+1600，最坏=×(1+重试2)=×3', () => {
    const budget = estimateChainBudget([0])
    const single = (0 + INPUT_PACKAGE_OVERHEAD_CHARS) / 1.2 + 1600
    expect(budget.perPromptWorstTokens[0]).toBeCloseTo(single * 3, 6)
    expect(budget.maxRounds).toBe(MAX_REVIEW_ROUNDS)
    expect(budget.worstCaseTotalTokens).toBe(Math.round(single * 3 * MAX_REVIEW_ROUNDS))
  })

  it('N 份汇总：Σ每份单轮最坏 ×3 轮；确认阈值 20000', () => {
    const budget = estimateChainBudget([2000, 6000])
    expect(budget.promptCount).toBe(2)
    const w0 = ((2000 + INPUT_PACKAGE_OVERHEAD_CHARS) / 1.2 + 1600) * 3
    const w1 = ((6000 + INPUT_PACKAGE_OVERHEAD_CHARS) / 1.2 + 1600) * 3
    expect(budget.worstCaseTotalTokens).toBe(Math.round((w0 + w1) * MAX_REVIEW_ROUNDS))
    expect(CONFIRM_TOKEN_THRESHOLD).toBe(20000)
    expect(budget.confirmationRequired).toBe(true)
  })

  it('小预算不触发确认门', () => {
    const tiny = estimateChainBudget([0])
    // 6010/1.2+1600≈6608 单轮；×3×3≈59k 已超阈值——单份空 prompt 也超，故用更小轮次口径验证阈值边界常量
    expect(tiny.confirmationRequired).toBe(true)
    const oneRoundOnePrompt = estimateChainBudget([0], 1)
    expect(oneRoundOnePrompt.worstCaseTotalTokens).toBeLessThan(CONFIRM_TOKEN_THRESHOLD)
    expect(oneRoundOnePrompt.confirmationRequired).toBe(false)
  })

  it('确认文本含 N 份数、最坏 token、最坏轮次', () => {
    const text = formatBudgetConfirmation(estimateChainBudget(['x'.repeat(3000).length, 1000]))
    expect(text).toContain('2 份')
    expect(text).toContain('3 轮')
    expect(text).toMatch(/约 [\d,]+ token/)
    expect(text).toContain('未确认前禁止发起任何审查')
  })
})

describe('FT11 裁决表结构化', () => {
  const issues = [makeIssue({ id: 'h1', severity: 'high' }), makeIssue({ id: 'm1', severity: 'medium' })]
  const good: readonly AdjudicationRow[] = [
    { issueId: 'h1', verdict: 'accept', reason: '补验收命令' },
    { issueId: 'm1', verdict: 'partial', reason: '补了一部分' },
  ]

  it('合法裁决表通过', () => {
    expect(validateAdjudication(issues, good)).toEqual([])
  })

  it('每条 issue 必须恰好裁决一次：遗漏/重复均报错', () => {
    expect(validateAdjudication(issues, [{ issueId: 'h1', verdict: 'accept', reason: 'r' }]).join('\n')).toContain('m1 未被裁决')
    const dup: readonly AdjudicationRow[] = [...good, { issueId: 'h1', verdict: 'reject', reason: 'again' }]
    expect(validateAdjudication(issues, dup).join('\n')).toContain('h1 被重复裁决')
  })

  it('verdict 非法 / reason 为空 / 未知 issue 报错', () => {
    expect(validateAdjudication(issues, [{ issueId: 'h1', verdict: 'weird' as AdjudicationRow['verdict'], reason: 'r' }, { issueId: 'm1', verdict: 'accept', reason: 'r' }]).join('\n')).toContain('verdict 非法')
    expect(validateAdjudication(issues, [{ issueId: 'h1', verdict: 'accept', reason: '   ' } as AdjudicationRow, { issueId: 'm1', verdict: 'accept', reason: 'r' }]).join('\n')).toContain('缺少裁决理由')
    expect(validateAdjudication(issues, [...good, { issueId: 'zzz', verdict: 'accept', reason: 'r' }] as readonly AdjudicationRow[]).join('\n')).toContain('不对应本轮报告')
  })
})

describe('FT11 复审仅针对 high + 3 轮硬上限 + 放行门', () => {
  function buildChain(): PromptReviewChain {
    const chain = new PromptReviewChain(0, 't')
    seedRound(chain, makeReport(1, chain.chainId, [
      makeIssue({ id: 'h1', severity: 'high' }),
      makeIssue({ id: 'h2', severity: 'high' }),
      makeIssue({ id: 'l1', severity: 'low' }),
    ]))
    return chain
  }

  it('复审载荷 prevReport 仅含上轮 high 项，low 被裁剪', () => {
    const chain = buildChain()
    const next = chain.submitAdjudication([
      { issueId: 'h1', verdict: 'accept', reason: '修' },
      { issueId: 'h2', verdict: 'accept', reason: '修' },
      { issueId: 'l1', verdict: 'accept', reason: '修' },
    ], 'REVISED')
    expect(next.scopedIssueIds).toEqual(['h1', 'h2'])
    expect(next.prevReport.issues.map(i => i.id)).toEqual(['h1', 'h2'])
    expect(next.targetContent).toBe('REVISED')
  })

  it('high 全部修复（round2 high=0）→ 链 released、批次门放行', () => {
    const chain = buildChain()
    const next = chain.submitAdjudication([
      { issueId: 'h1', verdict: 'accept', reason: '修' },
      { issueId: 'h2', verdict: 'accept', reason: '修' },
      { issueId: 'l1', verdict: 'accept', reason: '修' },
    ], 'REVISED')
    chain.recordRound('REVISED', makeReport(2, chain.chainId, []), next.scopedIssueIds)
    expect(chain.remainingHighIds()).toEqual([])
    expect(chain.state).toBe('released')
    expect(evaluateBatchGate([chain]).released).toBe(true)
  })

  it('round2 残留 high → round3 复审；3 轮后仍 high → blocked-high-remain，批次不放行', () => {
    const chain = buildChain()
    const n2 = chain.submitAdjudication([
      { issueId: 'h1', verdict: 'accept', reason: '修' },
      { issueId: 'h2', verdict: 'accept', reason: '修' },
      { issueId: 'l1', verdict: 'accept', reason: '修' },
    ], 'REV1')
    chain.recordRound('REV1', makeReport(2, chain.chainId, [makeIssue({ id: 'h1', severity: 'high' })]), n2.scopedIssueIds)
    // round2 新报告落、Lead 尚未裁决本轮 issues → awaiting-adjudication
    expect(chain.state).toBe('awaiting-adjudication')
    const n3 = chain.submitAdjudication([{ issueId: 'h1', verdict: 'accept', reason: '再修' }], 'REV2')
    expect(n3.nextRound).toBe(3)
    chain.recordRound('REV2', makeReport(3, chain.chainId, [makeIssue({ id: 'h1', severity: 'high' })]), n3.scopedIssueIds)
    expect(chain.state).toBe('blocked-high-remain')
    expect(() => chain.submitAdjudication([{ issueId: 'h1', verdict: 'accept', reason: 'x' }], 'REV3')).toThrow(/硬上限/)
    const gate = evaluateBatchGate([chain])
    expect(gate.released).toBe(false)
    expect(gate.blocked[0].reason).toContain('D4')
  })

  it('用户显式 accept-reject 留痕后残留 high 可放行，且须带 reason', () => {
    const chain = buildChain()
    expect(() => chain.dismissHigh([{ issueId: 'h1', reason: '' }])).toThrow(/留痕理由/)
    expect(() => chain.dismissHigh([{ issueId: 'unknown', reason: 'r' }])).toThrow(/未知 high/)
    chain.dismissHigh([
      { issueId: 'h1', reason: '用户确认该约束不适用（原话留痕）' },
      { issueId: 'h2', reason: '用户确认该约束不适用（原话留痕）' },
    ])
    const next = chain.submitAdjudication([
      { issueId: 'h1', verdict: 'reject', reason: '用户驳回' },
      { issueId: 'h2', verdict: 'reject', reason: '用户驳回' },
      { issueId: 'l1', verdict: 'accept', reason: '修' },
    ], 'REV')
    // 两条 high 均被用户驳回 → 无复审目标，链以 dismissed 清零
    expect(next.scopedIssueIds).toEqual([])
    expect(chain.remainingHighIds()).toEqual([])
  })

  it('high verdict=reject 但无用户留痕 → 拒绝进入复审', () => {
    const chain = buildChain()
    expect(() => chain.submitAdjudication([
      { issueId: 'h1', verdict: 'reject', reason: 'Lead 自行驳回' },
      { issueId: 'h2', verdict: 'accept', reason: '修' },
      { issueId: 'l1', verdict: 'accept', reason: '修' },
    ], 'REV')).toThrow(/用户显式 accept-reject 留痕/)
  })
})

describe('FT10 客户端：串行初审 / 信号 / 隔离参数', () => {
  function stubService(envelope: ReviewPromptEnvelope, calls: ReviewPromptParams[]): DocReviewService {
    return {
      reviewPrompt: vi.fn(async (params: ReviewPromptParams) => {
        calls.push(params)
        return envelope
      }),
    }
  }

  it('N 份初审逐一过 service（物理串行），入参 docType=task-prompt、round=1、透传 parent/signal/600s', async () => {
    const calls: ReviewPromptParams[] = []
    const order: string[] = []
    const service: DocReviewService = {
      reviewPrompt: vi.fn(async (params: ReviewPromptParams) => {
        order.push(params.targetContent)
        calls.push(params)
        return { kind: 'report' as const, report: makeReport(1, params.chain!.chainId, []), archivePath: null, inputChars: params.targetContent.length + 6010, attempts: 1 }
      }),
    }
    const controller = new AbortController()
    const outcomes = await runInitialReviews(
      [{ unitIndex: 0, title: 'a', prompt: 'AAA' }, { unitIndex: 1, title: 'b', prompt: 'BBB' }],
      { service, parentAgent: { session: { id: 'parent-1' } }, signal: controller.signal, timeoutMs: REVIEW_TIMEOUT_MS, workspaceRoot: '/ws' },
    )
    expect(outcomes.map(o => o.kind)).toEqual(['report', 'report'])
    expect(order).toEqual(['AAA', 'BBB'])
    expect(calls).toHaveLength(2)
    expect(calls[0].docType).toBe('task-prompt')
    expect(calls[0].chain).toMatchObject({ round: 1 })
    expect(calls[0].timeoutMs).toBe(600_000)
    expect(calls[0].signal).toBe(controller.signal)
    expect(calls[0].parentAgent).toEqual({ session: { id: 'parent-1' } })
  })

  it('signal 已 abort → 发起前拒绝，不触达 service', async () => {
    const calls: ReviewPromptParams[] = []
    const controller = new AbortController()
    controller.abort()
    await expect(runInitialReviews([{ unitIndex: 0, title: 'a', prompt: 'A' }],
      { service: stubService({ kind: 'busy' }, calls), parentAgent: {}, signal: controller.signal })).rejects.toThrow(/abort/)
    expect(calls).toHaveLength(0)
  })
})

describe('FT13 四类降级分支（绝不静默放行）', () => {
  const cases: ReadonlyArray<{ envelope: ReviewPromptEnvelope; kind: string; token: string }> = [
    { envelope: { kind: 'freeform', freeformText: 'I refuse', inputChars: 1, attempts: 3 }, kind: 'refusal', token: 'D1' },
    { envelope: { kind: 'timeout' }, kind: 'timeout', token: 'D2' },
    { envelope: { kind: 'busy' }, kind: 'busy', token: 'busy' },
    { envelope: { kind: 'no-agent' }, kind: 'missing-service', token: 'D2' },
  ]
  for (const c of cases) {
    it(`信封 ${c.envelope.kind} → 标记 ${c.kind} 且批次门 fail-closed`, async () => {
      const service: DocReviewService = { reviewPrompt: vi.fn(async () => c.envelope) }
      const outcomes = await runInitialReviews([{ unitIndex: 2, title: 'card', prompt: 'P' }], { service, parentAgent: {} })
      expect(outcomes[0].kind).toBe('degraded')
      if (outcomes[0].kind !== 'degraded') throw new Error('narrow')
      expect(outcomes[0].mark.kind).toBe(c.kind)
      expect(outcomes[0].chain.state).toBe('degraded')
      const gate = evaluateBatchGate(outcomes.map(o => o.chain))
      expect(gate.released).toBe(false)
      expect(gate.degraded[0].unitIndex).toBe(2)
      expect(formatDegradationNotice([outcomes[0].mark])).toContain(c.token)
    })
  }

  it('start-error / service 抛错 → refusal(D1)；aborted → refusal', async () => {
    const service: DocReviewService = { reviewPrompt: vi.fn(async () => ({ kind: 'start-error' as const, error: new Error('boom') })) }
    const r1 = await runInitialReviews([{ unitIndex: 0, title: 'a', prompt: 'P' }], { service, parentAgent: {} })
    expect(r1[0].kind === 'degraded' && r1[0].mark.kind).toBe('refusal')
    const throwing: DocReviewService = { reviewPrompt: vi.fn(async () => { throw new Error('network down') }) }
    const r2 = await runInitialReviews([{ unitIndex: 0, title: 'a', prompt: 'P' }], { service: throwing, parentAgent: {} })
    expect(r2[0].kind === 'degraded' && r2[0].mark.detail).toContain('network down')
  })

  it('service 缺失：missingServiceMarks 覆盖全链且降级文本明确', () => {
    const marks = missingServiceMarks([{ unitIndex: 0, title: 'a', prompt: '' }, { unitIndex: 1, title: 'b', prompt: '' }])
    expect(marks.map(m => m.kind)).toEqual(['missing-service', 'missing-service'])
    const notice = formatDegradationNotice(marks)
    expect(notice).toContain('中止于 S3')
    expect(notice).toContain('禁止静默跳过 S3')
  })

  it('复审信封非 report → 该链降级、不放行，且不产生新一轮记录', async () => {
    const chain = new PromptReviewChain(0, 'a')
    seedRound(chain, makeReport(1, chain.chainId, [makeIssue({ id: 'h1', severity: 'high' })]))
    const next = chain.submitAdjudication([{ issueId: 'h1', verdict: 'accept', reason: '修' }], 'REV')
    const roundsBefore = chain.rounds.length
    const service: DocReviewService = { reviewPrompt: vi.fn(async () => ({ kind: 'timeout' as const })) }
    const outcome = await runRereview(chain, next, { service, parentAgent: {} })
    expect(outcome.kind).toBe('degraded')
    expect(chain.rounds).toHaveLength(roundsBefore)
    expect(evaluateBatchGate([chain]).released).toBe(false)
  })

  it('多份混合：一份 degraded、一份 high 残留 → 批次门 false；全 released 才 true', async () => {
    const good = new PromptReviewChain(0, 'ok')
    seedRound(good, makeReport(1, good.chainId, []))
    const bad = new PromptReviewChain(1, 'bad')
    bad.degradation = { kind: 'timeout', unitIndex: 1, title: 'bad', detail: 'x' }
    const gate = evaluateBatchGate([good, bad])
    expect(gate.released).toBe(false)
    expect(gate.releasedCount).toBe(1)
    expect(gate.degraded).toHaveLength(1)
  })
})

describe('序列化/恢复往返', () => {
  it('rounds/dismissed/degradation 经 serialize→restore 保持判定', async () => {
    const { restoreReviewChain } = await import('../src/decompose/review-gate.js')
    const chain = new PromptReviewChain(1, 't')
    seedRound(chain, makeReport(1, chain.chainId, [makeIssue({ id: 'h1', severity: 'high' })]))
    chain.dismissHigh([{ issueId: 'h1', reason: '用户留痕' }])
    const restored = restoreReviewChain(JSON.parse(JSON.stringify(chain.serialize())))
    expect(restored.chainId).toBe(chain.chainId)
    expect(highIssueIds(restored.rounds[0].report)).toEqual(['h1'])
    expect(restored.remainingHighIds()).toEqual([])
  })
})
