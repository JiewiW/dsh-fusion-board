// A4 S4 端到端（native host harness）：FT14–FT16 建卡适配层四工具接缝。
// 桩 docReview 直挂 root ctx，绕过 S1/S2 直接注入符合串行/并行协议的 S2 triplets 文档，
// 经 S3 放行后直调 lead scope 内四个 S4 工具的 execute，验证：
//   serial 全链 plan→backfill→verify（FT14/15/16）/ parallel 1父N子深度1 /
//   gate 未放行阻断 S4 / D3 建卡累积态恢复三分支 / 交付文档只建不跑。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { PREV_CARD_PLACEHOLDER } from '../src/decompose/serial-protocol.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

type StubMode = 'always-high' | 'clean'

interface Harness {
  callTool(name: string, args: Record<string, unknown>): Promise<any>
  seedResult(planId: string, branch: number, triplets: readonly CardTriplet[]): void
}

/** 桩审查：clean=零 issue 直接放行；always-high=每份恒出一条 high（S3 阻断）。 */
async function setupHarness(mode: StubMode): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'fusion-s4-'))
  const workspace = join(root, 'project')
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
  const parent = (await ctx.agents.create({ sessionId: SessionId('lead-s4'), meta: { cwd: workspace },
    agentOptions: { provider: 'test-native', model: 'ordinary', maxTokens: 8000 } })).agent
  installModelSelection(parent.ctx, { current: { provider: 'test-native', model: 'ordinary' }, assembled: undefined })

  const service = {
    reviewPrompt: async (params: ReviewPromptParams): Promise<ReviewPromptEnvelope> => ({
      kind: 'report',
      archivePath: null,
      inputChars: params.targetContent.length + 6010,
      attempts: 1,
      report: {
        summary: 'stub review',
        issues: mode === 'always-high' ? [{
          id: 'H1', dimension: 'completeness' as const, severity: 'high' as const,
          location: '验收', claim: 'D2 缺客观验收命令', evidence: 'no-command',
          suggestion: '补可运行验收命令',
        }] : [],
        newIssueCount: mode === 'always-high' ? 1 : 0,
        round: params.chain?.round ?? 1,
        chainId: params.chain?.chainId ?? 'stub-chain',
      },
    }),
  }
  ctx.provide('docReview', service)

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
    const outcome = await ctx.tools.execute({ name, callId: ToolCallId(`s4-${callSerial++}`),
      agent: parent, signal: new AbortController().signal, arguments: args })
    if (outcome.isError) throw new Error(`${name} failed: ${JSON.stringify(outcome.value)}`)
    const raw = typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value)
    return JSON.parse(raw)
  }
  const seedResult: Harness['seedResult'] = (planId, branch, triplets) => {
    store.writeDocument(`decompose:result:${taskId}`, 0,
      { schemaVersion: 1, planId, branch, triplets, at: new Date().toISOString() })
  }
  return { callTool, seedResult }
}

const SERIAL_PLAN = 'tf-20261015-s4serial'
const SERIAL_TITLE_1 = '【1/2】第一步建模块'
const SERIAL_TITLE_2 = '【2/2】第二步接线'
const GATE_SENTENCE = '开工前必须用 task_board_get 回读该卡，其列必须为 done；不为 done 则把本卡留在 todo 并回报阻塞原因，禁止改动。'

/** 构造符合 §3.4/§3.5 串行协议的 2 张 S2 triplet（branch=3，全 root）。 */
function serialTriplets(): CardTriplet[] {
  const description1 =
    `串行链 ${SERIAL_PLAN} 第 1/2 步；无前置卡；本卡完成前，第 2/2 步及以后禁止开始。\n背景：第一步。`
  const description2 =
    `串行链 ${SERIAL_PLAN} 第 2/2 步；前置：【1/2】第一步建模块（卡 id ${PREV_CARD_PLACEHOLDER}，建卡后回填）；未完成前置前禁止执行本卡。\n背景：第二步。`
  const prompt1 =
    `# ${SERIAL_TITLE_1}\n\n## 目标（自包含）\n完成第一步。\n\n## 上下文交接\n- 前置卡：无（链首）。完成后回报产物路径，供后继卡执行者核对。`
  const prompt2 =
    `# ${SERIAL_TITLE_2}\n\n## 目标（自包含）\n完成第二步。\n\n## 上下文交接\n- 前置卡：${PREV_CARD_PLACEHOLDER}（串行链 ${SERIAL_PLAN} 第 1/2 步）。${GATE_SENTENCE}`
  return [
    { title: SERIAL_TITLE_1, description: description1, prompt: prompt1,
      tags: [`chain:${SERIAL_PLAN}`, 'seq:1'], unitIndex: 0, role: 'root', blockIds: [],
      serialIndex: 1, serialTotal: 2, chainId: SERIAL_PLAN },
    { title: SERIAL_TITLE_2, description: description2, prompt: prompt2,
      tags: [`chain:${SERIAL_PLAN}`, 'seq:2'], unitIndex: 1, role: 'root', blockIds: [],
      serialIndex: 2, serialTotal: 2, chainId: SERIAL_PLAN },
  ]
}

const PARALLEL_PLAN = 'tf-20261015-s4paral'
const PARENT_TITLE = '父卡（汇总）：并行组 g1：模块A、模块B'
const CHILD_TITLE_A = '子卡：模块A'
const CHILD_TITLE_B = '子卡：模块B'

/** 构造 branch=1 并行拓扑的 1父2子 S2 triplet。 */
function parallelTriplets(): CardTriplet[] {
  const promptParent = `# ${PARENT_TITLE}\n\n## 目标（自包含）\n汇总两子卡。`
  const promptA = `# ${CHILD_TITLE_A}\n\n## 目标（自包含）\n完成模块A。`
  const promptB = `# ${CHILD_TITLE_B}\n\n## 目标（自包含）\n完成模块B。`
  const make = (unitIndex: number, role: CardTriplet['role'], title: string, prompt: string): CardTriplet => ({
    title, description: `并行组 g1 成员（${role}）。`, prompt,
    tags: ['parallel-group:g1'], unitIndex, role, blockIds: [],
  })
  return [
    { ...make(0, 'parent', PARENT_TITLE, promptParent) },
    make(1, 'child', CHILD_TITLE_A, promptA),
    make(2, 'child', CHILD_TITLE_B, promptB),
  ]
}

describe('A4 S4 建卡适配层 — native host harness', () => {
  it('FT14/15/16 serial：plan 产 N 张 root 规格→backfill 回填前置 id→verify 全绿并出只建不跑交付文档', async () => {
    const h = await setupHarness('clean')
    h.seedResult(SERIAL_PLAN, 3, serialTriplets())
    // S3 放行（clean 初审零 issue）。
    const gate = await h.callTool('fusion_review_gate', { confirmAccepted: true })
    expect(gate.kind).toBe('initial-reviews-done')
    const verdict = await h.callTool('fusion_review_gate_finalize', {})
    expect(verdict.kind).toBe('released')

    // FT14：有序建卡规格。
    const plan = await h.callTool('fusion_card_plan', { goal: 'S4 serial 手测目标' })
    expect(plan.kind).toBe('plan-ready')
    expect(plan.topology).toBe('serial')
    expect(plan.branch).toBe(3)
    expect(plan.count).toBe(2)
    expect(plan.specs).toHaveLength(2)
    expect(plan.specs[0]!.role).toBe('root')
    expect(plan.specs[0]!.parentCreateIndex).toBeUndefined()
    expect(plan.specs[0]!.serialIndex).toBe(1)
    expect(plan.specs[1]!.role).toBe('root')
    expect(plan.specs[1]!.parentCreateIndex).toBeUndefined()
    expect(plan.specs[1]!.serialIndex).toBe(2)
    expect(plan.specs[0]!.tags.map((t: { name: string }) => t.name)).toEqual([`chain:${SERIAL_PLAN}`, 'seq:1'])
    expect(plan.specs[1]!.tags.map((t: { name: string }) => t.name)).toEqual([`chain:${SERIAL_PLAN}`, 'seq:2'])

    // FT15：先全建拿 id（模拟 Lead 建卡返回），再回填；仅 k=2 有 1 条回填。
    const id0 = '11111111-1111-4111-8111-111111111111'
    const id1 = '22222222-2222-4222-8222-222222222222'
    const adopted = [
      { index: 0, id: id0, title: SERIAL_TITLE_1 },
      { index: 1, id: id1, title: SERIAL_TITLE_2 },
    ]
    const backfill = await h.callTool('fusion_card_backfill', { adopted: JSON.stringify(adopted) })
    expect(backfill.kind).toBe('backfill-ready')
    expect(backfill.updates).toHaveLength(1)
    const update = backfill.updates[0]!
    expect(update.index).toBe(1)
    expect(update.cardId).toBe(id1)
    expect(update.descriptionReplaced).toBe(1)
    expect(update.promptReplaced).toBe(1)
    expect(update.fields.description).toContain(id0)
    expect(update.fields.description).not.toContain(PREV_CARD_PLACEHOLDER)
    expect(update.fields.prompt).toContain(id0)
    expect(update.fields.prompt).not.toContain(PREV_CARD_PLACEHOLDER)

    // FT14 回读机检：卡1 用原始协议文本，卡2 用回填后文本；全 todo、零执行、串行 root 无 parentId。
    const cards = [
      { id: id0, title: SERIAL_TITLE_1, status: 'todo', depth: 0,
        tags: [{ name: `chain:${SERIAL_PLAN}` }, { name: 'seq:1' }],
        description: serialTriplets()[0]!.description, prompt: serialTriplets()[0]!.prompt, executionCount: 0 },
      { id: id1, title: SERIAL_TITLE_2, status: 'todo', depth: 0,
        tags: [{ name: `chain:${SERIAL_PLAN}` }, { name: 'seq:2' }],
        description: update.fields.description, prompt: update.fields.prompt, executionCount: 0 },
    ]
    const verified = await h.callTool('fusion_card_verify', { cards: JSON.stringify(cards) })
    expect(verified.kind).toBe('verified')
    expect(verified.ok).toBe(true)
    expect(verified.issues).toEqual([])
    // 交付文档：有序清单 seq 顺序 + 审查 high=0 + 只建不跑提示。
    const doc = verified.deliveryDocument as string
    expect(doc.indexOf(id0)).toBeLessThan(doc.indexOf(id1))
    expect(doc).toContain('① 有序执行清单')
    expect(doc).toContain('未决 high issue=0')
    expect(doc).toContain('只建不跑')
  })

  it('FT14 parallel：plan 产 1父 N 子规格（child parentCreateIndex 指向 parent），verify 深度=1 全绿', async () => {
    const h = await setupHarness('clean')
    h.seedResult(PARALLEL_PLAN, 1, parallelTriplets())
    await h.callTool('fusion_review_gate', { confirmAccepted: true })
    await h.callTool('fusion_review_gate_finalize', {})

    const plan = await h.callTool('fusion_card_plan', { goal: 'S4 parallel 手测目标' })
    expect(plan.kind).toBe('plan-ready')
    expect(plan.topology).toBe('parallel')
    expect(plan.count).toBe(3)
    expect(plan.specs[0]!.role).toBe('parent')
    expect(plan.specs[0]!.parentCreateIndex).toBeUndefined()
    expect(plan.specs[1]!.role).toBe('child')
    expect(plan.specs[1]!.parentCreateIndex).toBe(0)
    expect(plan.specs[2]!.role).toBe('child')
    expect(plan.specs[2]!.parentCreateIndex).toBe(0)

    const idP = '33333333-3333-4333-8333-333333333333'
    const idA = '44444444-4444-4444-8444-444444444444'
    const idB = '55555555-5555-4555-8555-555555555555'
    const triplets = parallelTriplets()
    // parallel 无串行回填。
    const backfill = await h.callTool('fusion_card_backfill', {
      adopted: JSON.stringify([
        { index: 0, id: idP, title: PARENT_TITLE },
        { index: 1, id: idA, title: CHILD_TITLE_A },
        { index: 2, id: idB, title: CHILD_TITLE_B },
      ]),
    })
    expect(backfill.kind).toBe('backfill-ready')
    expect(backfill.updates).toHaveLength(0)

    const cards = [
      { id: idP, title: PARENT_TITLE, status: 'todo', depth: 0, tags: [{ name: 'parallel-group:g1' }],
        description: triplets[0]!.description, prompt: triplets[0]!.prompt, executionCount: 0 },
      { id: idA, title: CHILD_TITLE_A, status: 'todo', parentId: idP, depth: 1, tags: [{ name: 'parallel-group:g1' }],
        description: triplets[1]!.description, prompt: triplets[1]!.prompt, executionCount: 0 },
      { id: idB, title: CHILD_TITLE_B, status: 'todo', parentId: idP, depth: 1, tags: [{ name: 'parallel-group:g1' }],
        description: triplets[2]!.description, prompt: triplets[2]!.prompt, executionCount: 0 },
    ]
    const verified = await h.callTool('fusion_card_verify', { cards: JSON.stringify(cards) })
    expect(verified.kind).toBe('verified')
    expect(verified.ok).toBe(true)
    expect(verified.issues).toEqual([])
  })

  it('FT14 顺序门前置：S3 未放行（仍有 high）时 fusion_card_plan 返回 gate-blocked，不产建卡规格', async () => {
    const h = await setupHarness('always-high')
    h.seedResult(SERIAL_PLAN, 3, serialTriplets().slice(0, 1))
    await h.callTool('fusion_review_gate', { confirmAccepted: true })
    const blocked = await h.callTool('fusion_card_plan', { goal: '不应建卡' })
    expect(blocked.kind).toBe('gate-blocked')
    expect(blocked.specs).toBeUndefined()
  })

  it('FT15/D3 recover：累积态错按回读列表判 adopt/retry/stop，非累积态错不误判', async () => {
    const h = await setupHarness('clean')
    h.seedResult(SERIAL_PLAN, 3, serialTriplets())
    await h.callTool('fusion_review_gate', { confirmAccepted: true })
    await h.callTool('fusion_review_gate_finalize', {})
    const plan = await h.callTool('fusion_card_plan', { goal: 'recover 手测' })
    expect(plan.kind).toBe('plan-ready')
    const marker = 'Error: tool result must be losslessly JSON-serializable (proc_pre_x)'

    // 未落库 + 首次：unstick 后重试，retryAttempt 1/2，不停止。
    const first = await h.callTool('fusion_card_recover',
      { index: 1, errorText: marker, boardList: '[]', retryAttempt: 0 })
    expect(first.kind).toBe('recovery-decision')
    expect(first.action).toBe('retry')
    expect(first.retryAttempt).toBe(1)
    expect(first.stop).toBe(false)

    // 已落库（标题命中回读列表）：adopt 回读 id，禁止重建。
    const landedId = '66666666-6666-4666-8666-666666666666'
    const adoptedHit = await h.callTool('fusion_card_recover', {
      index: 1, errorText: marker,
      boardList: JSON.stringify([{ id: landedId, title: SERIAL_TITLE_2, status: 'todo' }]),
      retryAttempt: 1,
    })
    expect(adoptedHit.action).toBe('adopt')
    expect(adoptedHit.cardId).toBe(landedId)

    // 未落库且重试已达 2 次：停止并报清单。
    const giveUp = await h.callTool('fusion_card_recover',
      { index: 1, errorText: marker, boardList: '[]', retryAttempt: 2 })
    expect(giveUp.action).toBe('retry')
    expect(giveUp.stop).toBe(true)

    // 非累积态错误：不按 D3 恢复协议处理。
    const other = await h.callTool('fusion_card_recover',
      { index: 1, errorText: 'some unrelated failure', boardList: '[]', retryAttempt: 0 })
    expect(other.kind).toBe('not-session-state-error')
  })
})
