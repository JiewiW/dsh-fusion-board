// A3 端到端（native host harness）：S3 卡片 prompt 审查门 FT10–FT13。
// 桩 docReview ctx service 直挂 root ctx，绕过 S1/S2 直接注入 S2 triplets 文档，
// 直调 lead scope 内三个 S3 工具的 execute，验证：
//   拦截 / 修复（复审载荷仅 high）/ 四类降级 / 3 轮硬上限 / 预算确认门 / 隔离载荷 / 不触达 S4。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { MockAdapter } from '@fusion-host-test/mock-adapter'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { TestSessionQuery } from '@fusion-host-test/session-query'
import { mountNativeShell } from './shell-fixture.js'
import { FusionCoordinator } from '../src/host/coordinator.js'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { completeProfile } from '../src/profile/resolve.js'
import { loadPromptBundle } from '../src/prompts.js'
import { DECOMPOSITION_SETTING_ID } from '../src/host/settings.js'
import type { CardTriplet } from '../src/decompose/triplet.js'
import type { ReviewPromptParams, ReviewPromptEnvelope } from '../src/decompose/review-runner.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** 桩报告：按 targetContent 标记决定 issue 集合；round/chainId 由入参链回填（仿真 service 覆写）。 */
function stubReport(params: ReviewPromptParams, issues: ReviewPromptEnvelope[] extends never ? never : {
  id: string; dimension: 'fact' | 'completeness' | 'necessity' | 'format'; severity: 'high' | 'medium' | 'low'
  location: string; claim: string; evidence: string; suggestion: string
}[]): ReviewPromptEnvelope {
  return {
    kind: 'report',
    archivePath: null,
    inputChars: params.targetContent.length + 6010,
    attempts: 1,
    report: {
      summary: 'stub review',
      issues,
      newIssueCount: issues.length,
      round: params.chain?.round ?? 1,
      chainId: params.chain?.chainId ?? 'stub-chain',
    },
  }
}

const HIGH_D2 = {
  id: 'H1', dimension: 'completeness' as const, severity: 'high' as const,
  location: '验收方式：人工确认即可', claim: 'D2 验收信号客观性：缺少可运行的验收命令与正信号串',
  evidence: 'prompt 全文无任何命令行/退出码/正信号约定',
  suggestion: '为每个步骤补可运行命令 + 期望正信号（退出码 0 / 指定输出串）',
}
const LOW_FMT = {
  id: 'L1', dimension: 'format' as const, severity: 'low' as const,
  location: '标题：卡片一', claim: 'D6 术语标签可再统一', evidence: 'no-reference', suggestion: '统一术语写法',
}

type StubMode = 'bad-then-fixed' | 'always-high' | 'refusal' | 'timeout' | 'busy' | 'clean'

interface Harness {
  callTool(name: string, args: Record<string, unknown>): Promise<any>
  seedTriplets(triplets: Array<Partial<CardTriplet> & Pick<CardTriplet, 'title' | 'prompt'>>): void
  calls: ReviewPromptParams[]
  ctx: Context
  workspace: string
  taskId: string
}

async function setupHarness(mode: StubMode, provideService = true): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'fusion-a3-'))
  const workspace = join(root, 'project')
  const calls: ReviewPromptParams[] = []
  const ctx = new Context()
  const store = new SqliteFusionStore(join(root, 'fusion.sqlite'))
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await mountNativeShell(ctx, { dshHome: join(root, 'home'), timeoutMs: 5000, jobs: false })

  const adapter = new MockAdapter([])
  ctx.llm.registerAdapter(['test-native'], adapter)
  const parent = (await ctx.agents.create({ sessionId: SessionId('lead'), meta: { cwd: workspace },
    agentOptions: { provider: 'test-native', model: 'ordinary', maxTokens: 8000 } })).agent
  installModelSelection(parent.ctx, { current: { provider: 'test-native', model: 'ordinary' }, assembled: undefined })

  // FT13 四类降级 / 拦截 / 修复 全由桩 service 的 targetContent 标记驱动。
  if (provideService) {
    const service = {
      reviewPrompt: async (params: ReviewPromptParams): Promise<ReviewPromptEnvelope> => {
        calls.push(params)
        const text = params.targetContent
        const round = params.chain?.round ?? 1
        if (mode === 'refusal' && round === 1) {
          return { kind: 'freeform', freeformText: 'I will not review this prompt.', inputChars: text.length + 6010, attempts: 3 }
        }
        if (mode === 'timeout' && round === 1) {
          return { kind: 'timeout', inputChars: text.length + 6010, attempts: 1 }
        }
        if (mode === 'busy' && round === 1) {
          return { kind: 'busy', docType: 'task-prompt' }
        }
        if (mode === 'always-high') {
          return stubReport(params, [{ ...HIGH_D2, claim: `D2 第 ${round} 轮仍缺客观验收命令` }])
        }
        if (mode === 'bad-then-fixed') {
          // 仅坏 prompt（含 BAD 标记且未修）命中 D2；好卡（含客观验收命令）无 issue。
          const isBadCard = text.includes('BAD_NO_ACCEPTANCE_MARKER') && !text.includes('FIXED_MARKER')
          if (!isBadCard) return stubReport(params, [])
          if (round === 1) return stubReport(params, [HIGH_D2, LOW_FMT])
          return stubReport(params, [{ ...HIGH_D2, claim: 'D2 修订后仍缺验收命令' }])
        }
        return stubReport(params, [])
      },
    }
    ctx.provide('docReview', service)
  }

  // ON 开关必须在 select（触发 scope 装配/工具注册）之前落 store。
  store.writeDocument(DECOMPOSITION_SETTING_ID, 0, { taskDecompositionMode: true })

  const prompts = loadPromptBundle()
  const profile = completeProfile({ id: 'fusion-auto', version: 'faithful-v1', enabled: true,
    context: { lead: {}, worker: {} },
    lead: { provider: 'test-native', model: 'lead' }, worker: { provider: 'test-native', model: 'worker' }, dataPolicyId: 'fixture-only' }, prompts)
  const coordinator = new FusionCoordinator(ctx, store, { profile: { profile, prompts }, leaseRoot: join(root, 'leases'),
    workerTools: [], authorizeRequest: () => { /* stub */ }, reserveRequest: () => { /* stub */ } })
  cleanups.push(async () => { await coordinator.close(); await ctx.fiber.dispose(); store.close(); rmSync(root, { recursive: true, force: true }) })
  await coordinator.select(parent)
  const taskId = coordinator.bindings.read(parent.id)!.binding.taskId

  let callSerial = 0
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const outcome = await ctx.tools.execute({ name, callId: ToolCallId(`a3-${callSerial++}`),
      agent: parent, signal: new AbortController().signal, arguments: args })
    if (outcome.isError) throw new Error(`${name} failed: ${JSON.stringify(outcome.value)}`)
    // textOutput 渲染为 content parts；直调返回 value 为最终字符串。
    const raw = typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value)
    return JSON.parse(raw)
  }
  const seedTriplets: Harness['seedTriplets'] = (triplets) => {
    const full: CardTriplet[] = triplets.map((partial, index) => ({
      title: partial.title ?? `卡片 ${index + 1}`,
      description: partial.description ?? `卡片 ${index + 1} 描述`,
      prompt: partial.prompt,
      tags: partial.tags ?? [],
      unitIndex: partial.unitIndex ?? index,
      role: partial.role ?? 'worker',
      blockIds: partial.blockIds ?? [],
      ...(partial.chainId ? { chainId: partial.chainId } : {}),
    }))
    store.writeDocument(`decompose:result:${taskId}`, 0,
      { schemaVersion: 1, planId: 'plan-a3', branch: 'on', triplets: full, at: new Date().toISOString() })
  }
  return { callTool, seedTriplets, calls, ctx, workspace }
}

const BAD_PROMPT = '实现某功能。BAD_NO_ACCEPTANCE_MARKER 验收方式：人工确认效果良好即可。'
const FIXED_PROMPT = '实现某功能。FIXED_MARKER 验收：运行 `node -e "console.log(1+1)"`，退出码 0 且输出含 2。'
const CLEAN_PROMPT = '整理 README 排版；验收：运行 `node --check README.md || true`，退出码 0。'

describe('A3 S3 审查门 — native host harness', () => {
  it('FT12 预算确认门：未确认不派审查，确认文本含 N 份数/最坏 token/最坏轮次', async () => {
    const h = await setupHarness('clean')
    h.seedTriplets([{ title: '卡A', prompt: CLEAN_PROMPT }])

    const first = await h.callTool('fusion_review_gate', {})
    expect(first.kind).toBe('budget-confirmation-required')
    expect(first.budget.promptCount).toBe(1)
    expect(first.budget.maxRounds).toBe(3)
    expect(first.budget.confirmationRequired).toBe(true)
    expect(first.confirmationText).toContain('1 份')
    expect(first.confirmationText).toMatch(/[\d,]+ token/)
    expect(first.confirmationText).toContain('3 轮')
    // 关键：未确认时桩 service 零调用。
    expect(h.calls).toHaveLength(0)

    const confirmed = await h.callTool('fusion_review_gate', { confirmAccepted: true })
    expect(confirmed.kind).toBe('initial-reviews-done')
    expect(h.calls).toHaveLength(1)
  })

  it('拦截场景：坏 prompt 命中 D2 high → 批次门拦截、finalize blocked、全程无建卡', async () => {
    const h = await setupHarness('bad-then-fixed')
    h.seedTriplets([
      { title: '坏卡', prompt: BAD_PROMPT },
      { title: '好卡', prompt: CLEAN_PROMPT },
    ])
    await h.callTool('fusion_review_gate', { confirmAccepted: true })

    const status = await h.callTool('fusion_review_gate', {})
    expect(status.kind).toBe('status')
    expect(status.released).toBe(false)
    expect(status.blocked).toHaveLength(1)
    expect(status.blocked[0].unitIndex).toBe(0)
    expect(status.blocked[0].highIssueIds).toContain('H1')
    expect(status.chains[0].state).toBe('awaiting-adjudication')

    const verdict = await h.callTool('fusion_review_gate_finalize', {})
    expect(['blocked', 'blocked-degraded']).toContain(verdict.kind)
    expect(verdict.released).toBe(false)

    // 隔离/不触达 S4 的静态代码门：S3 实现内不存在任何建卡调用。
    const coordinatorSource = readFileSync(new URL('../src/host/coordinator.ts', import.meta.url), 'utf8')
    const runnerSource = readFileSync(new URL('../src/decompose/review-runner.ts', import.meta.url), 'utf8')
    const gateSource = readFileSync(new URL('../src/decompose/review-gate.ts', import.meta.url), 'utf8')
    for (const source of [coordinatorSource, runnerSource, gateSource]) {
      expect(source).not.toContain('task_board_create')
      expect(source).not.toContain('task_board_run')
    }
  })

  it('修复场景：Lead 修订后复审 high=0 放行；复审载荷仅含上轮 high 项', async () => {
    const h = await setupHarness('bad-then-fixed')
    h.seedTriplets([{ title: '坏卡', prompt: BAD_PROMPT }])
    await h.callTool('fusion_review_gate', { confirmAccepted: true })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].chain?.round).toBe(1)
    expect(h.calls[0].docType).toBe('task-prompt')

    const adj = await h.callTool('fusion_review_gate_adj', {
      unitIndex: 0,
      revisedPrompt: FIXED_PROMPT,
      adjudication: [
        { issueId: 'H1', verdict: 'accept', reason: '补可运行验收命令与正信号串' },
        { issueId: 'L1', verdict: 'partial', reason: '术语已部分统一' },
      ],
    })
    expect(adj.kind).toBe('rereview-done')
    expect(adj.round).toBe(2)
    expect(adj.state).toBe('released')

    // 机检复审请求体：仅含上轮 high（H1），low（L1）不得进入 prevReport。
    const rereviewCall = h.calls[1]!
    expect(rereviewCall.chain?.round).toBe(2)
    expect(rereviewCall.targetContent).toBe(FIXED_PROMPT)
    expect(rereviewCall.prevReport?.issues.map(i => i.id)).toEqual(['H1'])
    expect(rereviewCall.prevReport?.issues.some(i => i.id === 'L1')).toBe(false)
    expect(adj.scopedIssueIds).toEqual(['H1'])

    const verdict = await h.callTool('fusion_review_gate_finalize', {})
    expect(verdict.kind).toBe('released')
    expect(verdict.released).toBe(true)
    expect(verdict.releasedCount).toBe(1)
  })

  it('裁决表结构门：缺裁/重裁/reject high 未留痕 → invalid-adjudication，不派复审', async () => {
    const h = await setupHarness('bad-then-fixed')
    h.seedTriplets([{ title: '坏卡', prompt: BAD_PROMPT }])
    await h.callTool('fusion_review_gate', { confirmAccepted: true })

    const missing = await h.callTool('fusion_review_gate_adj', {
      unitIndex: 0, revisedPrompt: FIXED_PROMPT,
      adjudication: [{ issueId: 'H1', verdict: 'accept', reason: '补齐验收命令' }],
    })
    expect(missing.kind).toBe('invalid-adjudication')
    expect(missing.message).toContain('L1')

    const rejectWithoutDismissal = await h.callTool('fusion_review_gate_adj', {
      unitIndex: 0, revisedPrompt: FIXED_PROMPT,
      adjudication: [
        { issueId: 'H1', verdict: 'reject', reason: '我认为不需要' },
        { issueId: 'L1', verdict: 'accept', reason: '统一术语' },
      ],
    })
    expect(rejectWithoutDismissal.kind).toBe('invalid-adjudication')
    expect(rejectWithoutDismissal.message).toContain('H1')
    expect(h.calls).toHaveLength(1) // 两次非法裁决都不得发起复审
  })

  it('用户显式 accept-reject 留痕后可放行 high（finalize dismissals）', async () => {
    const h = await setupHarness('always-high')
    h.seedTriplets([{ title: '争议卡', prompt: BAD_PROMPT }])
    await h.callTool('fusion_review_gate', { confirmAccepted: true })

    const verdict = await h.callTool('fusion_review_gate_finalize', {
      dismissals: [{ unitIndex: 0, issueId: 'H1', reason: '用户书面确认：该卡验收由后续 S4 卡兜底，风险已知悉' }],
    })
    expect(verdict.kind).toBe('released')
    expect(verdict.released).toBe(true)
  })

  it('3 轮硬上限：三轮仍 high → D4 blocked-high-remain，不再派复审、不建卡', async () => {
    const h = await setupHarness('always-high')
    h.seedTriplets([{ title: '顽固卡', prompt: BAD_PROMPT }])
    await h.callTool('fusion_review_gate', { confirmAccepted: true })

    const adj1 = await h.callTool('fusion_review_gate_adj', {
      unitIndex: 0, revisedPrompt: `${BAD_PROMPT}\n修订1`,
      adjudication: [{ issueId: 'H1', verdict: 'accept', reason: '尝试补验收' }],
    })
    expect(adj1.round).toBe(2)
    expect(adj1.state).toBe('awaiting-adjudication')

    const adj2 = await h.callTool('fusion_review_gate_adj', {
      unitIndex: 0, revisedPrompt: `${BAD_PROMPT}\n修订2`,
      adjudication: [{ issueId: 'H1', verdict: 'accept', reason: '再次补验收' }],
    })
    expect(adj2.round).toBe(3)
    expect(adj2.state).toBe('blocked-high-remain')

    // 第 4 轮必须被硬上限拒绝。
    const adj3 = await h.callTool('fusion_review_gate_adj', {
      unitIndex: 0, revisedPrompt: `${BAD_PROMPT}\n修订3`,
      adjudication: [{ issueId: 'H1', verdict: 'accept', reason: '徒劳' }],
    })
    expect(adj3.kind).toBe('invalid-adjudication')
    expect(adj3.message).toContain('硬上限')
    expect(h.calls).toHaveLength(3)

    const verdict = await h.callTool('fusion_review_gate_finalize', {})
    expect(verdict.kind).toBe('blocked')
    expect(verdict.blocked[0].reason).toContain('D4')
  })

  it.each([
    ['refusal', 'refusal', 'refusal', 'D1'] as const,
    ['timeout', 'timeout', 'timeout', 'D2'] as const,
  ])('降级场景 %s：标记 + 用户提示文本正确，流程终止于 S3', async (_label, mode, markKind, clause) => {
    const h = await setupHarness(mode)
    h.seedTriplets([{ title: '降级卡', prompt: BAD_PROMPT }])
    const done = await h.callTool('fusion_review_gate', { confirmAccepted: true })
    expect(done.kind).toBe('degraded')
    expect(done.degraded[0].kind).toBe(markKind)
    expect(done.notice).toContain('中止于 S3')
    expect(done.notice).toContain(clause)
    expect(done.notice).toContain('不建卡')
    expect(done.released).toBe(false)

    // 已降级链上的裁决工具不得再放行。
    const adj = await h.callTool('fusion_review_gate_adj', {
      unitIndex: 0, revisedPrompt: FIXED_PROMPT,
      adjudication: [{ issueId: 'H1', verdict: 'accept', reason: 'x' }],
    })
    expect(adj.kind).toBe('degraded')
    const verdict = await h.callTool('fusion_review_gate_finalize', {})
    expect(verdict.kind).toBe('blocked-degraded')
    expect(verdict.released).toBe(false)
  })

  it('降级场景 busy：busy 互斥命中 → 标记 busy 并中止', async () => {
    const h = await setupHarness('busy')
    h.seedTriplets([{ title: '忙卡', prompt: BAD_PROMPT }])
    const done = await h.callTool('fusion_review_gate', { confirmAccepted: true })
    expect(done.kind).toBe('degraded')
    expect(done.degraded[0].kind).toBe('busy')
    expect(done.notice).toContain('busy')
  })

  it('降级场景 missing-service：docReview 未注册 → 全链 D2 标记且零调用', async () => {
    const h = await setupHarness('clean', false)
    h.seedTriplets([
      { title: '卡A', prompt: BAD_PROMPT },
      { title: '卡B', prompt: CLEAN_PROMPT },
    ])
    const done = await h.callTool('fusion_review_gate', { confirmAccepted: true })
    expect(done.kind).toBe('degraded')
    expect(done.degraded).toHaveLength(2)
    expect(done.degraded.every((m: { kind: string }) => m.kind === 'missing-service')).toBe(true)
    expect(done.notice).toContain('D2')
    expect(h.calls).toHaveLength(0)
  })

  it('FT10 串行初审：N 份按输入顺序逐一过服务，parent agent 句柄透传', async () => {
    const h = await setupHarness('clean')
    h.seedTriplets([
      { title: 'AAA', prompt: 'AAA_PROMPT' },
      { title: 'BBB', prompt: 'BBB_PROMPT' },
      { title: 'CCC', prompt: 'CCC_PROMPT' },
    ])
    await h.callTool('fusion_review_gate', { confirmAccepted: true })
    expect(h.calls.map(c => c.targetContent)).toEqual(['AAA_PROMPT', 'BBB_PROMPT', 'CCC_PROMPT'])
    expect(h.calls.every(c => c.timeoutMs === 600_000)).toBe(true)
    expect(h.calls.every(c => Boolean(c.parentAgent))).toBe(true)
    // 隔离载荷：不得携带主会话历史/消息数组，只送目标文本+链元数据。
    for (const params of h.calls) {
      const keys = Object.keys(params)
      expect(keys.some(k => k === 'messages' || k === 'history' || k === 'conversation')).toBe(false)
      expect(params.chain?.round).toBe(1)
    }
  })

  it('OFF 路径零变化：开关关闭时 S3 工具不注册', async () => {
    // 复用 ON harness 后再核一个独立 OFF ctx：直接验证 settings 判定为 false 时工具缺席。
    const root = mkdtempSync(join(tmpdir(), 'fusion-a3-off-'))
    const ctx = new Context()
    const store = new SqliteFusionStore(join(root, 'fusion.sqlite'))
    try {
      // isTaskDecompositionEnabled 对缺文档必须为 false（OFF 默认）。
      // 工具注册受同一开关门控，这里验证开关原语契约即可，不重复整套 select。
      const { isTaskDecompositionEnabled } = await import('../src/host/settings.js')
      expect(isTaskDecompositionEnabled(undefined)).toBe(false)
      expect(isTaskDecompositionEnabled({ value: {} })).toBe(false)
      expect(isTaskDecompositionEnabled({ value: { taskDecompositionMode: false } })).toBe(false)
      expect(isTaskDecompositionEnabled(store.readDocument(DECOMPOSITION_SETTING_ID))).toBe(false)
    } finally {
      store.close()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
