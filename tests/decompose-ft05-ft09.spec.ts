// 验收 A2 — M3 六样例离线断言（计划书 §5 M3）：不启动真实模型，Lead 输出用固定 JSON 桩。
// 判据：拓扑判定与人工标注一致；串行卡协议字段 100% 齐全；每份 prompt 经 TB-C5 清单机检无缺项；
// 简单任务样例走短路（§6 D6）；S1 校验失败重试 ≤2 后降级（回报用户、不建卡）。

import { mkdir, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { runPipeline, runStageOne, runStageTwo } from '../src/decompose/pipeline.js'
import { buildLeadDecompositionPrompt } from '../src/decompose/lead-prompt.js'
import { checkPromptC5, TB_C5_ITEMS, TB_C5_SOURCE_VERSION } from '../src/decompose/tb-c5.js'
import { decideShortcircuit } from '../src/decompose/shortcircuit.js'
import { PREV_CARD_PLACEHOLDER } from '../src/decompose/serial-protocol.js'
import type { CardTriplet } from '../src/decompose/triplet.js'
import type { Decomposition } from '../src/decompose/schema.js'
import { analyzeTopology, validateStageOne } from '../src/decompose/topology.js'

const WORKSPACE = 'D:\\dsh\\demo-workspace'
const PLAN_ID = 'tf-20261014-a2test01'
const DUMP_PATH = 'D:\\dsh\\logs\\fusion-board-a2-serial-dump.json'

function block(input: Partial<Decomposition['blocks'][number]> & { id: string; title: string }): Decomposition['blocks'][number] {
  return {
    deliverables: [`D:\\dsh\\demo-workspace\\out\\${input.id}.md`],
    acceptance: [`node --check D:\\dsh\\demo-workspace\\src\\${input.id}.js 退出码 0`],
    inputs: [],
    touches: [`D:\\dsh\\demo-workspace\\src\\${input.id}.js`],
    dependsOn: [],
    rationale: '独立块',
    ...input,
  }
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

const stub = (text: string) => async () => text

describe('样例1 纯串行（b1→b2→b3，人工标注 serial）', () => {
  const sample = json({
    goal: '按序完成三步改造',
    blocks: [
      block({ id: 'b1', title: '打地基', deliverables: ['D:\\dsh\\demo-workspace\\out\\b1.md'] }),
      block({ id: 'b2', title: '接管道', dependsOn: ['b1'], inputs: ['D:\\dsh\\demo-workspace\\out\\b1.md'] }),
      block({ id: 'b3', title: '收出口', dependsOn: ['b2'], inputs: ['D:\\dsh\\demo-workspace\\out\\b2.md'] }),
    ],
    topology: 'serial',
    rationale: '每块验收依赖前块产物文件，必须串行',
  })

  it('S1 通过且拓扑判定与标注一致；S2 走分支 3（多张并列 root 卡）', async () => {
    const result = await runPipeline(stub(sample), '按序完成三步改造', { workspaceRoot: WORKSPACE }, undefined, PLAN_ID)
    expect(result.ok).toBe(true)
    expect(result.stageOne.ok).toBe(true)
    const stage = result.stageTwo!
    expect(stage.branch).toBe(3)
    expect(stage.plan!.topology).toBe('serial')
    expect(stage.triplets).toHaveLength(3)
    for (const triplet of stage.triplets) expect(triplet.role).toBe('root')
  })

  it('串行协议字段齐全率 100%（【k/N】/chain:/seq:/描述首行前置声明/交接段/前置卡占位）', async () => {
    const stage = runStageTwo(JSON.parse(sample), { workspaceRoot: WORKSPACE }, PLAN_ID)
    expect(stage.ok).toBe(true)
    const fields = stage.triplets.map((triplet: CardTriplet, index: number) => ({
      titleMark: triplet.title.includes(`【${index + 1}/3】`),
      chainTag: triplet.tags.includes(`chain:${PLAN_ID}`),
      seqTag: triplet.tags.includes(`seq:${index + 1}`),
      descriptionFirst: triplet.description.split('\n')[0]!.startsWith(`串行链 ${PLAN_ID} 第 ${index + 1}/3 步`),
      handoff: triplet.prompt.includes('## 上下文交接'),
      // 链首卡声明无前置并禁止后继先跑；k>1 卡必须带前置引用占位与禁止条款
      gate: index === 0
        ? triplet.description.includes('无前置卡')
        : triplet.description.includes(PREV_CARD_PLACEHOLDER) && triplet.description.includes('未完成前置前禁止执行本卡'),
    }))
    const completeRate = fields.every(entry => Object.values(entry).every(Boolean)) ? 1 : 0
    expect(completeRate).toBe(1)
    expect(stage.triplets[1]!.prompt.includes(PREV_CARD_PLACEHOLDER)).toBe(true)
    // k>1 卡的前置引用必须指向前一张卡的标题（不是本卡）
    expect(stage.triplets[1]!.description).toContain('前置：【1/3】打地基')
    expect(stage.triplets[2]!.description).toContain('前置：【2/3】接管道')
  })

  it('三份 prompt 经 TB-C5 十一项机检无缺项，并落盘供 grep 复核', async () => {
    const stage = runStageTwo(JSON.parse(sample), { workspaceRoot: WORKSPACE }, PLAN_ID)
    for (const triplet of stage.triplets) {
      expect(checkPromptC5(triplet.prompt).ok).toBe(true)
    }
    await mkdir('D:\\dsh\\logs', { recursive: true })
    await writeFile(DUMP_PATH, JSON.stringify(stage.triplets, null, 2), 'utf8')
  })
})

describe('样例2 纯并行（三块互不依赖，人工标注 parallel）', () => {
  const sample = json({
    goal: '三路独立补测试',
    blocks: [
      block({ id: 'p1', title: '路由A补测', parallelGroup: 'g1' }),
      block({ id: 'p2', title: '路由B补测', parallelGroup: 'g1' }),
      block({ id: 'p3', title: '路由C补测', parallelGroup: 'g1' }),
    ],
    topology: 'parallel',
    rationale: '三块无数据依赖且各有客观验收，可并发',
  })

  it('分支 1：1 父卡 + 每块一张子卡，深度 1，无串行标记', async () => {
    const stage = runStageTwo(JSON.parse(sample), { workspaceRoot: WORKSPACE }, PLAN_ID)
    expect(stage.ok).toBe(true)
    expect(stage.branch).toBe(1)
    const units = stage.plan!.units
    expect(units.filter(unit => unit.role === 'parent')).toHaveLength(1)
    expect(units.filter(unit => unit.role === 'child')).toHaveLength(3)
    for (const unit of units) expect(unit.serialIndex).toBeUndefined()
    expect(stage.triplets[0]!.title.startsWith('父卡（汇总）：')).toBe(true)
    expect(stage.triplets[1]!.title.startsWith('子卡：')).toBe(true)
    for (const triplet of stage.triplets) expect(checkPromptC5(triplet.prompt).ok).toBe(true)
  })
})

describe('样例3 mixed（g1 组两块并行 + b3 依赖全组，人工标注 mixed）', () => {
  const sample = json({
    goal: '两路并行后串行收尾',
    blocks: [
      block({ id: 'm1', title: '并行路一', parallelGroup: 'g1' }),
      block({ id: 'm2', title: '并行路二', parallelGroup: 'g1' }),
      block({ id: 'm3', title: '串行收尾', dependsOn: ['m1', 'm2'], inputs: ['D:\\dsh\\demo-workspace\\out\\m1.md', 'D:\\dsh\\demo-workspace\\out\\m2.md'] }),
    ],
    topology: 'mixed',
    rationale: '组内并发、组间串行',
  })

  it('分支 4：组内按 1（父+子），未分组块按 3（root 链）', async () => {
    const stage = runStageTwo(JSON.parse(sample), { workspaceRoot: WORKSPACE }, PLAN_ID)
    expect(stage.ok).toBe(true)
    expect(stage.branch).toBe(4)
    const units = stage.plan!.units
    expect(units.filter(unit => unit.role === 'parent')).toHaveLength(1)
    expect(units.filter(unit => unit.role === 'child')).toHaveLength(2)
    const tail = units.filter(unit => unit.role === 'root')
    expect(tail).toHaveLength(1)
    expect(tail[0]!.serialIndex).toBe(1)
    expect(stage.triplets.at(-1)!.title.includes('【1/1】')).toBe(true)
    for (const triplet of stage.triplets) expect(checkPromptC5(triplet.prompt).ok).toBe(true)
  })
})

describe('样例4 紧耦合微步骤（两块 rationale 标「微步骤=」）', () => {
  const sample = json({
    goal: '一次改造的两个不可拆微步骤',
    blocks: [
      block({ id: 's1', title: '改签名', rationale: '微步骤=不改签名则第二步编译失败，中间产物不独立交付' }),
      block({ id: 's2', title: '改调用点', dependsOn: ['s1'], rationale: '微步骤=与改签名同卡按序执行，拆开必缺上下文' }),
    ],
    topology: 'serial',
    rationale: '紧耦合同卡',
  })

  it('分支 2：合并为一张卡，卡内 Step 1..n，不建并发子卡', async () => {
    const stage = runStageTwo(JSON.parse(sample), { workspaceRoot: WORKSPACE }, PLAN_ID)
    expect(stage.ok).toBe(true)
    expect(stage.branch).toBe(2)
    expect(stage.triplets).toHaveLength(1)
    const prompt = stage.triplets[0]!.prompt
    expect(prompt).toContain('禁止并发拆卡')
    expect(prompt).toContain('Step 1')
    expect(prompt).toContain('Step 2')
    expect(checkPromptC5(prompt).ok).toBe(true)
  })
})

describe('样例5 无法判定（b1↔b2 成环，依赖不可判定）', () => {
  const sample = json({
    goal: '环依赖演示',
    blocks: [
      block({ id: 'c1', title: '块一', dependsOn: ['c2'], rationale: '依赖无法判定，保守按串行' }),
      block({ id: 'c2', title: '块二', dependsOn: ['c1'], rationale: '依赖无法判定，保守按串行' }),
    ],
    topology: 'serial',
    rationale: '无法判定先后，按 TB-P1 保守串行',
  })

  it('S1 以 warning 放行（保守串行出口），S2 走分支 5 兜底拆 root 卡', async () => {
    const stageOne = validateStageOne(JSON.parse(sample))
    expect(stageOne.ok).toBe(true)
    expect(stageOne.warnings.some(issue => issue.code === 'CONSERVATIVE_SERIAL')).toBe(true)
    const analysis = analyzeTopology(JSON.parse(sample).blocks)
    expect(analysis.forcedConservativeSerial).toBe(true)
    const stage = runStageTwo(stageOne.decomposition!, { workspaceRoot: WORKSPACE }, PLAN_ID)
    expect(stage.branch).toBe(5)
    expect(stage.plan!.units.every(unit => unit.conservative === true)).toBe(true)
    expect(stage.issues.some(issue => issue.code === 'GRANULARITY_CONSERVATIVE')).toBe(true)
    for (const triplet of stage.triplets) expect(checkPromptC5(triplet.prompt).ok).toBe(true)
  })

  it('声明与图不符（成环却声明 parallel）必须被拒并退回修正', async () => {
    const bad = JSON.parse(sample)
    bad.topology = 'parallel'
    const stageOne = validateStageOne(bad)
    expect(stageOne.ok).toBe(false)
    expect(stageOne.issues.some(issue => issue.code === 'TOPOLOGY_MISMATCH')).toBe(true)
  })
})

describe('样例6 单块简单任务（无独立验收信号）', () => {
  const sample = json({
    goal: '把 README 里的错别字改一下',
    blocks: [
      { ...block({ id: 't1', title: '改错别字' }), acceptance: ['确保文字通顺'] },
    ],
    topology: 'serial',
    rationale: '只有一个动作',
  })

  it('FT07 短路：不进 S2、不建卡，回报含 §6 D6 口径', async () => {
    const decision = decideShortcircuit(JSON.parse(sample))
    expect(decision.shortcircuit).toBe(true)
    expect(decision.reason).toContain('§6 D6')
    const result = await runPipeline(stub(sample), '把 README 里的错别字改一下', { workspaceRoot: WORKSPACE }, undefined, PLAN_ID)
    expect(result.shortcircuited).toBe(true)
    expect(result.stageTwo!.triplets).toHaveLength(0)
    expect(result.report).toContain('OFF 直派')
  })

  it('单块但有独立客观验收 → 不短路（保守继续）', () => {
    const decision = decideShortcircuit(JSON.parse(json({
      goal: '跑一次构建',
      blocks: [block({ id: 't2', title: '跑构建', acceptance: ['pnpm build 退出码 0'] })],
      topology: 'serial',
      rationale: '单块',
    })))
    expect(decision.shortcircuit).toBe(false)
  })
})

describe('FT05 重试与降级口径', () => {
  it('首次输出非法 JSON → 回灌 issues 修正，第 2 次成功（attempts=2 ≤ 首次+2）', async () => {
    const good = json({
      goal: '两步串行',
      blocks: [block({ id: 'r1', title: '甲' }), block({ id: 'r2', title: '乙', dependsOn: ['r1'] })],
      topology: 'serial',
      rationale: '乙依赖甲产物',
    })
    const responses = ['这不是JSON{{{', good]
    let call = 0
    const stageOne = await runStageOne(async () => responses[Math.min(call++, responses.length - 1)]!, '两步串行')
    expect(stageOne.ok).toBe(true)
    expect(stageOne.attempts).toBe(2)
  })

  it('连续 3 次失败 → 降级：回报用户、不建卡', async () => {
    const stageOne = await runStageOne(stub('坏输出'), '永远失败的分解')
    expect(stageOne.ok).toBe(false)
    expect(stageOne.degraded).toBe(true)
    expect(stageOne.attempts).toBe(3)
    expect(stageOne.report).toContain('不建卡')
    const result = await runPipeline(stub('坏输出'), '永远失败的分解', { workspaceRoot: WORKSPACE })
    expect(result.degraded).toBe(true)
    expect(result.stageTwo).toBeUndefined()
  })
})

describe('FT06 prompt 侧与代码侧口径一致 + TB-C5 单一来源', () => {
  it('Lead 分解 prompt 内置 TB-P1 固定步骤、自检表、三枚举与保守串行', () => {
    const prompt = buildLeadDecompositionPrompt()
    expect(prompt).toContain('TB-P1')
    expect(prompt).toContain('列块')
    expect(prompt).toContain('自检')
    expect(prompt).toContain('serial | parallel | mixed')
    expect(prompt).toContain('保守')
    expect(prompt).toContain('短路')
  })

  it('TB-C5 判据来自 dsh-doc-review v0.2.1 task-prompt SKILL，共十一项锚点', () => {
    expect(TB_C5_SOURCE_VERSION).toBe('0.2.1')
    expect(TB_C5_ITEMS).toHaveLength(11)
    expect(TB_C5_ITEMS.map(item => item.anchor)).toEqual(['C5-1', 'C5-2', 'C5-3', 'C5-4', 'C5-5', 'C5-6', 'C5-7', 'C5-8', 'C5-9', 'C5-10', 'C5-11'])
  })

  it('机检能真抓缺项（负向样例：删掉禁令清单段应报 C5-9）', () => {
    const stage = runStageTwo(JSON.parse(json({
      goal: '两步串行',
      blocks: [block({ id: 'n1', title: '甲' }), block({ id: 'n2', title: '乙', dependsOn: ['n1'] })],
      topology: 'serial',
      rationale: '串行',
    })), { workspaceRoot: WORKSPACE }, PLAN_ID)
    const broken = stage.triplets[0]!.prompt.replace(/## 禁令清单[\s\S]*?\n(?=## )/, '')
    const check = checkPromptC5(broken)
    expect(check.ok).toBe(false)
    expect(check.issues.some(issue => issue.code === 'TB_C5_C5_9_MISSING')).toBe(true)
  })
})
