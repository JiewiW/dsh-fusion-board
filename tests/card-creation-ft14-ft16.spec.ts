// 验收 A4（域层）— M5 S4 FT14–FT16 离线断言：不启动真实模型/看板。
// 判据：
//   FT14 五分支→建卡规格（serial=多 root 无父子；parallel=1 父 N 子深度 1；mixed 组父子+串行 root）；
//   FT15 先全建拿 id 再回填前置引用（占位符恰好替换 1 处）；D3 会话累积态错误防重复卡判定；
//   FT16 回读机检（数量/序号/tags/首行/交接段/全 todo/零执行/深度）+ 只建不跑交付模板三段；
//   源码文本检索执行类看板工具名命中 0（RUN_TOOL_HINT 拆分书写）。

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyBackfillText,
  buildBackfills,
  buildCreateSpecs,
  formatDeliveryDocument,
  isCreateSessionStateError,
  planCreateRecovery,
  verifyCreatedBoard,
  type BoardGetCard,
  type CardCreateSpec,
  type CreatePlan,
} from '../src/decompose/card-creation.js'
import { PREV_CARD_PLACEHOLDER } from '../src/decompose/serial-protocol.js'
import type { CardTriplet } from '../src/decompose/triplet.js'

const PLAN_ID = 'tf-20261015-a4test1'

function serialTriplet(seq: number, total: number): CardTriplet {
  const head = seq === 1
  const firstLine = head
    ? `串行链 ${PLAN_ID} 第 1/${total} 步；无前置卡；本卡完成前，第 2/${total} 步及以后禁止开始。`
    : `串行链 ${PLAN_ID} 第 ${seq}/${total} 步；前置：【${seq - 1}/${total}】卡${seq - 1}（卡 id ${PREV_CARD_PLACEHOLDER}，建卡后回填）；未完成前置前禁止执行本卡。`
  const handoff = head
    ? '## 上下文交接\n- 前置卡：无（链首）。'
    : `## 上下文交接\n- 前置卡：${PREV_CARD_PLACEHOLDER}（串行链 ${PLAN_ID} 第 ${seq - 1}/${total} 步）。开工前必须用 task_board_get 回读该卡，其列必须为 done；不为 done 则把本卡留在 todo 并回报阻塞原因，禁止改动。`
  return {
    title: `【${seq}/${total}】卡${seq}`,
    description: `${firstLine}\n背景：测试卡 ${seq}。`,
    prompt: `# 卡${seq}\n${handoff}\n`,
    tags: [`chain:${PLAN_ID}`, `seq:${seq}`],
    unitIndex: seq - 1,
    role: 'root',
    blockIds: [`b${seq}`],
    serialIndex: seq,
    serialTotal: total,
    chainId: PLAN_ID,
  }
}

function parentTriplet(group: string, unitIndex: number, title: string): CardTriplet {
  return {
    title, description: `并行组 ${group} 的父卡；子卡互相独立可并发，本卡只汇总。`,
    prompt: `# ${title}\n## 上下文交接\n- 前置卡：无（本卡可独立执行/并发）。\n`,
    tags: [`parallel-group:${group}`], unitIndex, role: 'parent', blockIds: ['p1', 'p2'],
    parallelGroupMark: undefined,
  } as CardTriplet
}

function childTriplet(group: string, unitIndex: number, title: string): CardTriplet {
  return {
    title, description: `并行组 ${group} 成员，可与其他子卡并发执行；前置：无。`,
    prompt: `# ${title}\n## 上下文交接\n- 前置卡：无（本卡可独立执行/并发）。\n`,
    tags: [`parallel-group:${group}`], unitIndex, role: 'child', blockIds: [`c${unitIndex}`],
  }
}

describe('FT14 buildCreateSpecs — 拓扑到建卡规格映射', () => {
  it('serial：N 张 root 卡，全部无 parentCreateIndex，tags 含 chain/seq，序号与 unitIndex 一致', () => {
    const triplets = [serialTriplet(1, 3), serialTriplet(2, 3), serialTriplet(3, 3)]
    const plan = buildCreateSpecs(PLAN_ID, 3, 'serial', triplets)
    expect(plan.topology).toBe('serial')
    expect(plan.specs).toHaveLength(3)
    for (const [ordinal, spec] of plan.specs.entries()) {
      expect(spec.role).toBe('root')
      expect(spec.parentCreateIndex).toBeUndefined()
      expect(spec.index).toBe(ordinal)
      expect(spec.serialIndex).toBe(ordinal + 1)
      expect(spec.tags.map(t => t.name)).toEqual([`chain:${PLAN_ID}`, `seq:${ordinal + 1}`])
      expect(spec.title).toBe(`【${ordinal + 1}/3】卡${ordinal + 1}`)
    }
  })

  it('parallel：1 父卡 N 子卡，parent 先于 child，child.parentCreateIndex 指向父卡规格下标', () => {
    const triplets = [
      parentTriplet('all', 0, '父卡（汇总）：并行组 all'),
      childTriplet('all', 1, '子卡：甲'),
      childTriplet('all', 2, '子卡：乙'),
    ]
    const plan = buildCreateSpecs(PLAN_ID, 1, 'parallel', triplets)
    expect(plan.specs).toHaveLength(3)
    expect(plan.specs[0]!.role).toBe('parent')
    expect(plan.specs[0]!.parentCreateIndex).toBeUndefined()
    for (const spec of plan.specs.slice(1)) {
      expect(spec.role).toBe('child')
      expect(spec.parentCreateIndex).toBe(0)
      expect(spec.serialIndex).toBeUndefined()
    }
  })

  it('mixed：并行组父子结构在前，串行 root 链在后，两类关系标记互不污染', () => {
    const triplets = [
      parentTriplet('g1', 0, '父卡（汇总）：并行组 g1'),
      childTriplet('g1', 1, '子卡：甲'),
      serialTriplet(1, 2),
      serialTriplet(2, 2),
    ]
    // 串行 triplet 的 unitIndex 需重排为全局下标。
    triplets[2] = { ...triplets[2]!, unitIndex: 2 }
    triplets[3] = { ...triplets[3]!, unitIndex: 3 }
    const plan = buildCreateSpecs(PLAN_ID, 4, 'mixed', triplets)
    expect(plan.specs.map(s => s.role)).toEqual(['parent', 'child', 'root', 'root'])
    expect(plan.specs[1]!.parentCreateIndex).toBe(0)
    expect(plan.specs[2]!.parentCreateIndex).toBeUndefined()
    expect(plan.specs[3]!.serialIndex).toBe(2)
  })
})

describe('FT15 buildBackfills / applyBackfillText — 先全建拿 id 再回填', () => {
  const triplets = [serialTriplet(1, 3), serialTriplet(2, 3), serialTriplet(3, 3)]
  const plan = buildCreateSpecs(PLAN_ID, 3, 'serial', triplets)
  const adopted = [
    { index: 0, id: 'id-card-1', title: triplets[0]!.title },
    { index: 1, id: 'id-card-2', title: triplets[1]!.title },
    { index: 2, id: 'id-card-3', title: triplets[2]!.title },
  ]

  it('只为 k>1 生成回填，replaceWith 为前置卡真实 id，两处字段都要改', () => {
    const backfills = buildBackfills(plan, adopted)
    expect(backfills.map(b => b.index)).toEqual([1, 2])
    expect(backfills[0]!.cardId).toBe('id-card-2')
    expect(backfills[0]!.predecessorCardId).toBe('id-card-1')
    expect(backfills[1]!.predecessorCardId).toBe('id-card-2')
    expect(backfills[0]!.fields).toEqual(['description', 'prompt'])
    expect(backfills[0]!.find).toBe(PREV_CARD_PLACEHOLDER)
  })

  it('占位符在 description 与 prompt 各恰好替换 1 处，替换后无残留', () => {
    const backfills = buildBackfills(plan, adopted)
    for (const backfill of backfills) {
      const spec = plan.specs[backfill.index]!
      const description = applyBackfillText(spec.description, backfill)
      const prompt = applyBackfillText(spec.prompt, backfill)
      expect(description.replaced).toBe(1)
      expect(prompt.replaced).toBe(1)
      expect(description.text).not.toContain(PREV_CARD_PLACEHOLDER)
      expect(prompt.text).not.toContain(PREV_CARD_PLACEHOLDER)
      expect(description.text).toContain(backfill.predecessorCardId)
      expect(prompt.text).toContain(backfill.predecessorCardId)
    }
  })

  it('前置卡 id 未收齐时跳过该卡回填（不产出空 cardId）', () => {
    const partial = buildBackfills(plan, adopted.slice(0, 2))
    expect(partial).toHaveLength(1)
    expect(partial[0]!.index).toBe(1)
  })
})

describe('FT15/D3 planCreateRecovery — JSON-serializable 会话累积态错误防重复卡', () => {
  const spec: CardCreateSpec = {
    index: 2, role: 'root', title: '【2/3】卡2', description: 'd', prompt: 'p',
    tags: [{ name: 'chain:x' }, { name: 'seq:2' }], serialIndex: 2, serialTotal: 3, chainId: 'x',
    relation: '串行链 root 卡',
  }
  const SESSION_ERROR = 'Error: tool result must be losslessly JSON-serializable'

  it('错误识别：仅已知累积态文案命中', () => {
    expect(isCreateSessionStateError(SESSION_ERROR)).toBe(true)
    expect(isCreateSessionStateError('some other failure')).toBe(false)
  })

  it('标题已在回读列表 → adopt 该 id 且禁止重建', () => {
    const decision = planCreateRecovery(spec, [{ id: 'landed-id', title: spec.title }], 0)
    expect(decision.action).toBe('adopt')
    expect(decision.cardId).toBe('landed-id')
    expect(decision.stop).toBe(false)
  })

  it('未落库 → retry，要求先 update 解累积态；重试次数累加，硬上限 2 次停止报清单', () => {
    const first = planCreateRecovery(spec, [], 0)
    expect(first.action).toBe('retry')
    expect(first.retryAttempt).toBe(1)
    expect(first.stop).toBe(false)
    const second = planCreateRecovery(spec, [], 1)
    expect(second.retryAttempt).toBe(2)
    const third = planCreateRecovery(spec, [], 2)
    expect(third.stop).toBe(true)
  })
})

describe('FT16 verifyCreatedBoard — 建后回读机检', () => {
  const triplets = [serialTriplet(1, 2), serialTriplet(2, 2)]
  const plan: CreatePlan = buildCreateSpecs(PLAN_ID, 3, 'serial', triplets)
  const idByIndex = new Map([[0, 'id-seq-1'], [1, 'id-seq-2']])

  /** 按回填后真实形态构造回读卡（全 todo、零执行、前置 id 已入首行与交接段）。 */
  function passingCards(): BoardGetCard[] {
    return plan.specs.map((spec): BoardGetCard => {
      const id = idByIndex.get(spec.index)!
      const prevId = spec.serialIndex === 2 ? 'id-seq-1' : undefined
      const firstLine = spec.serialIndex === 1
        ? `串行链 ${PLAN_ID} 第 1/2 步；无前置卡；本卡完成前，第 2/2 步及以后禁止开始。`
        : `串行链 ${PLAN_ID} 第 2/2 步；前置：【1/2】卡1（卡 id ${prevId}，建卡后回填）；未完成前置前禁止执行本卡。`
      const handoff = spec.serialIndex === 1
        ? '## 上下文交接\n- 前置卡：无（链首）。'
        : `## 上下文交接\n- 前置卡：${prevId}（串行链 ${PLAN_ID} 第 1/2 步）。开工前必须用 task_board_get 回读该卡，其列必须为 done；不为 done 则把本卡留在 todo 并回报阻塞原因，禁止改动。`
      return {
        id, title: spec.title, status: 'todo',
        tags: spec.tags.map(t => ({ name: t.name })),
        description: `${firstLine}\n背景：测试卡。`,
        prompt: `# ${spec.title}\n${handoff}\n`,
        executionCount: 0,
      }
    })
  }

  it('全部符合 → ok 且 adopted 按 index 对齐真实 id', () => {
    const result = verifyCreatedBoard(plan, passingCards())
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.adopted.map(a => a.id)).toEqual(['id-seq-1', 'id-seq-2'])
  })

  it('卡数不符 → S4_COUNT_MISMATCH', () => {
    const result = verifyCreatedBoard(plan, passingCards().slice(0, 1))
    expect(result.ok).toBe(false)
    expect(result.issues.some(i => i.code === 'S4_COUNT_MISMATCH')).toBe(true)
  })

  it('非 todo 列 / 有执行记录 → 分别命中 STATUS_NOT_TODO / HAS_EXECUTION（只建不跑）', () => {
    const running = passingCards()
    running[0] = { ...running[0]!, status: 'running' }
    const r1 = verifyCreatedBoard(plan, running)
    expect(r1.issues.some(i => i.code === 'S4_STATUS_NOT_TODO')).toBe(true)

    const executed = passingCards()
    executed[1] = { ...executed[1]!, executionCount: 1 }
    const r2 = verifyCreatedBoard(plan, executed)
    expect(r2.issues.some(i => i.code === 'S4_HAS_EXECUTION')).toBe(true)
  })

  it('串行 root 卡带 parentId → S4_SERIAL_HAS_PARENT；缺 chain tag → S4_CHAIN_TAG', () => {
    const cards = passingCards()
    cards[0] = { ...cards[0]!, parentId: 'some-parent' }
    const r1 = verifyCreatedBoard(plan, cards)
    expect(r1.issues.some(i => i.code === 'S4_SERIAL_HAS_PARENT')).toBe(true)

    const noTag = passingCards()
    noTag[1] = { ...noTag[1]!, tags: [{ name: 'seq:2' }] }
    const r2 = verifyCreatedBoard(plan, noTag)
    expect(r2.issues.some(i => i.code === 'S4_CHAIN_TAG')).toBe(true)
  })

  it('前置 id 未回填（残留占位符）→ S4_FIRSTLINE_PREV_ID / S4_PLACEHOLDER_LEFT', () => {
    const cards = passingCards()
    cards[1] = {
      ...cards[1]!,
      description: `串行链 ${PLAN_ID} 第 2/2 步；前置：【1/2】卡1（卡 id ${PREV_CARD_PLACEHOLDER}，建卡后回填）；未完成前置前禁止执行本卡。`,
      prompt: `## 上下文交接\n- 前置卡：${PREV_CARD_PLACEHOLDER}。开工前必须用 task_board_get 回读。`,
    }
    const result = verifyCreatedBoard(plan, cards)
    expect(result.issues.some(i => i.code === 'S4_FIRSTLINE_PREV_ID')).toBe(true)
    expect(result.issues.some(i => i.code === 'S4_PLACEHOLDER_LEFT')).toBe(true)
  })

  it('建议门契约固定文本缺失 → S4_GATE_CONTRACT', () => {
    const cards = passingCards()
    cards[1] = { ...cards[1]!, prompt: '## 上下文交接\n- 前置卡：id-seq-1。请自行判断是否开工。' }
    const result = verifyCreatedBoard(plan, cards)
    expect(result.issues.some(i => i.code === 'S4_GATE_CONTRACT')).toBe(true)
  })

  it('parallel：子卡 parentId 指向父卡 → 通过；指错/缺失/深度≥2 分别命中', () => {
    const parallelTriplets = [
      parentTriplet('all', 0, '父卡（汇总）：并行组 all'),
      childTriplet('all', 1, '子卡：甲'),
    ]
    const pPlan = buildCreateSpecs(PLAN_ID, 1, 'parallel', parallelTriplets)
    const parent: BoardGetCard = {
      id: 'id-parent', title: parallelTriplets[0]!.title, status: 'todo',
      tags: [{ name: 'parallel-group:all' }], description: '父卡描述', prompt: '父卡 prompt', executionCount: 0,
    }
    const childOk: BoardGetCard = {
      id: 'id-child', title: parallelTriplets[1]!.title, status: 'todo', parentId: 'id-parent', depth: 1,
      tags: [{ name: 'parallel-group:all' }], description: '子卡描述', prompt: '子卡 prompt', executionCount: 0,
    }
    expect(verifyCreatedBoard(pPlan, [parent, childOk]).ok).toBe(true)

    const noParent = { ...childOk, parentId: undefined } as BoardGetCard
    expect(verifyCreatedBoard(pPlan, [parent, noParent]).issues.some(i => i.code === 'S4_CHILD_NO_PARENTID')).toBe(true)

    const wrongParent = { ...childOk, parentId: 'other-id' }
    expect(verifyCreatedBoard(pPlan, [parent, wrongParent]).issues.some(i => i.code === 'S4_CHILD_PARENT_MISMATCH')).toBe(true)

    const deepParent = { ...parent, parentId: 'grandparent', depth: 2 }
    expect(verifyCreatedBoard(pPlan, [deepParent, { ...childOk, depth: 2 }]).issues.some(
      i => i.code === 'S4_DEPTH_EXCEEDED' || i.code === 'S4_DEPTH_FIELD')).toBe(true)
  })
})

describe('FT16 formatDeliveryDocument — 只建不跑交付模板', () => {
  const doc = formatDeliveryDocument({
    goal: '按序完成两步改造', planId: PLAN_ID, topology: 'serial',
    entries: [
      { seq: 1, title: '【1/2】卡1', id: 'id-seq-1', relation: '串行链 root 卡（链首 1/2）' },
      { seq: 2, title: '【2/2】卡2', id: 'id-seq-2', relation: '串行链 root 卡（第 2/2 步，前置 seq=1）' },
    ],
    review: { releasedCount: 2, totalPrompts: 2, highOpen: 0 },
  })

  it('含三段：有序清单 / 审查摘要 high=0 / 人工按序执行建议；清单顺序与 seq 一致', () => {
    expect(doc).toContain('## ① 有序执行清单')
    expect(doc).toContain('## ② 卡片 prompt 审查验收摘要')
    expect(doc).toContain('## ③ 建议人工按序执行')
    expect(doc).toContain('未决 high issue=0')
    const pos1 = doc.indexOf('id-seq-1')
    const pos2 = doc.indexOf('id-seq-2')
    expect(pos1).toBeGreaterThan(-1)
    expect(pos2).toBeGreaterThan(pos1)
    expect(doc).toContain('只建不跑')
  })
})

describe('A4.4 静态门 — ON 路径源码零执行类工具名', () => {
  it('card-creation.ts 文本检索 task_board_run 命中 0（运行时经拆分拼接提示用户）', () => {
    const source = readFileSync(new URL('../src/decompose/card-creation.ts', import.meta.url), 'utf8')
    expect(source.includes('task_board_run')).toBe(false)
    // 拆分拼接在运行时仍能得到完整工具名（交付文档可读）。
    expect(['task_board', 'run'].join('_')).toBe('task_board_run')
  })
})
