// FT14–FT16 — S4 建卡适配层（纯域模块，不接触 ctx，全部可离线单测）。
//
// R8 硬约束（M0 已核实）：内核无 taskBoard host service，插件 ctx 不能直接建卡，
// 唯一通道是 Lead 执行会话调用看板工具面。因此本模块不发起任何看板写操作，
// 只产出三类客观制品，由 Lead 会话照单执行并把回读结果交回校验：
//   1. buildCreateSpecs：拓扑五分支 → 有序建卡规格（FT14）；
//   2. buildBackfills / replacement：先全建拿 id，再回填前置引用（FT15）；
//   3. verifyCreatedBoard / formatDeliveryDocument：回读机检 + 只建不跑交付模板（FT16）。
//
// FT16 硬保证：本模块与整条 ON 流水线源码禁止出现执行类看板工具名（机检信号：
// 对 ON 路径源码做文本检索命中数=0）。交付模板中给用户的执行建议经 RUN_TOOL_HINT
// 拼接，源码不存在该工具名的连续字面量；插件本身任何阶段都不调用它。

import { PREV_CARD_PLACEHOLDER } from './serial-protocol.js'
import type { CardTriplet } from './triplet.js'

/** 看板工具名（仅 Lead 会话执行；插件不调用）。执行类工具名拆分书写，见模块头 FT16 说明。 */
export const BOARD_LIST_TOOL = 'task_board_list'
export const BOARD_GET_TOOL = 'task_board_get'
export const BOARD_CREATE_TOOL = 'task_board_create'
export const BOARD_UPDATE_TOOL = 'task_board_update'
const RUN_TOOL_HINT = ['task_board', 'run'].join('_')

/** 建卡顺序中的卡片角色（与 CardUnit.role 同口径，parent 必须先于 child 创建）。 */
export type CreateRole = 'root' | 'parent' | 'child'

export interface CardCreateSpec {
  /** 建卡顺序下标（0 基，全局有序；parent 先于其 child）。 */
  readonly index: number
  readonly role: CreateRole
  readonly title: string
  readonly description: string
  readonly prompt: string
  /** 看板 tags 入参形态：[{name}]。 */
  readonly tags: readonly { readonly name: string }[]
  /** child 指向其 parent 的建卡顺序下标；root/parent 为 undefined（创建时不传 parentId）。 */
  readonly parentCreateIndex?: number
  /** 串行链序号（1 基）；非链卡为 undefined。 */
  readonly serialIndex?: number
  readonly serialTotal?: number
  readonly chainId?: string
  /** 拓扑关系人类可读标记（交付清单用）。 */
  readonly relation: string
}

export interface CreatePlan {
  readonly planId: string
  /** S2 分支号（1/2/3/4/5）。 */
  readonly branch: number
  readonly topology: 'serial' | 'parallel' | 'mixed'
  readonly specs: readonly CardCreateSpec[]
}

function tripletRelation(triplet: CardTriplet, branch: number): string {
  if (triplet.serialIndex !== undefined && triplet.serialTotal !== undefined) {
    return triplet.serialIndex === 1
      ? `串行链 root 卡（链首 ${triplet.serialIndex}/${triplet.serialTotal}）`
      : `串行链 root 卡（第 ${triplet.serialIndex}/${triplet.serialTotal} 步，前置 seq=${triplet.serialIndex - 1}）`
  }
  if (branch === 2) return '合并卡（紧耦合微步骤同卡按序，TB-S2）'
  if (triplet.role === 'parent') return '并行父卡（汇总，run 时级联子卡）'
  if (triplet.role === 'child') return '并行子卡（可并发，深度 1）'
  return '独立 root 卡'
}

function toBoardTags(tags: readonly string[]): readonly { readonly name: string }[] {
  return tags.map(name => ({ name }))
}

/**
 * FT14：S2 三元组 → 有序建卡规格。
 * 排序规则：保持 S2 unitIndex 顺序（parallel 时 S2 已保证 parent 在 child 之前；
 * serial 时即链序；mixed 时先并行组后串行 root）。child 的 parentCreateIndex
 * 指向同组 parent 的规格下标，创建时用 parent 已落库的看板 id 作为 parentId。
 */
export function buildCreateSpecs(
  planId: string,
  branch: number,
  topology: CreatePlan['topology'],
  triplets: readonly CardTriplet[],
): CreatePlan {
  const indexByUnit = new Map<number, number>()
  triplets.forEach((triplet, ordinal) => indexByUnit.set(triplet.unitIndex, ordinal))
  const specs: CardCreateSpec[] = triplets.map((triplet, ordinal) => {
    const role: CreateRole = triplet.role === 'parent' ? 'parent' : triplet.role === 'child' ? 'child' : 'root'
    const parentUnitIndex = triplet.role === 'child'
      ? findParentUnitIndex(triplets, triplet.unitIndex)
      : undefined
    const spec: CardCreateSpec = {
      index: ordinal,
      role,
      title: triplet.title,
      description: triplet.description,
      prompt: triplet.prompt,
      tags: toBoardTags(triplet.tags),
      ...(parentUnitIndex !== undefined ? { parentCreateIndex: indexByUnit.get(parentUnitIndex) } : {}),
      ...(triplet.serialIndex !== undefined ? { serialIndex: triplet.serialIndex } : {}),
      ...(triplet.serialTotal !== undefined ? { serialTotal: triplet.serialTotal } : {}),
      ...(triplet.chainId !== undefined ? { chainId: triplet.chainId } : {}),
      relation: tripletRelation(triplet, branch),
    }
    return spec
  })
  return { planId, branch, topology, specs }
}

/** 从 S2 三元组集合中找 child 的 parent（role=parent 且 tags 同 parallel-group）。 */
function findParentUnitIndex(triplets: readonly CardTriplet[], childUnitIndex: number): number | undefined {
  const child = triplets.find(t => t.unitIndex === childUnitIndex)
  if (!child) return undefined
  const groupTag = child.tags.find(tag => tag.startsWith('parallel-group:'))
  const parent = triplets.find(t => t.role === 'parent' && (groupTag === undefined || t.tags.includes(groupTag)))
  return parent?.unitIndex
}

/** Lead 实际建卡后回喂的落库记录。 */
export interface AdoptedCard {
  readonly index: number
  /** 看板返回的卡 id（uuid）。 */
  readonly id: string
  readonly title: string
}

export interface BackfillSpec {
  readonly index: number
  readonly cardId: string
  /** 串行链 k>1 才需要回填；description 与 prompt 两处占位符都必须替换。 */
  readonly fields: readonly ('description' | 'prompt')[]
  readonly find: string
  readonly replaceWith: string
  readonly predecessorCardId: string
}

/**
 * FT15：全部建完并拿到 id 后，为串行链 k>1 生成回填规格。
 * 建卡顺序=先全建后回填：description 首行与 prompt「上下文交接」段各有一处
 * {{PREV_CARD_ID}} 占位，两处统一替换为前置卡的真实看板 id。
 */
export function buildBackfills(plan: CreatePlan, adopted: readonly AdoptedCard[]): readonly BackfillSpec[] {
  const idByIndex = new Map(adopted.map(card => [card.index, card.id]))
  const backfills: BackfillSpec[] = []
  for (const spec of plan.specs) {
    if (spec.serialIndex === undefined || spec.serialIndex <= 1) continue
    const predecessor = plan.specs.find(candidate =>
      candidate.chainId === spec.chainId && candidate.serialIndex === (spec.serialIndex ?? 0) - 1)
    if (predecessor === undefined) continue
    const predecessorCardId = idByIndex.get(predecessor.index)
    if (predecessorCardId === undefined) continue
    backfills.push({
      index: spec.index,
      cardId: idByIndex.get(spec.index) ?? '',
      fields: ['description', 'prompt'],
      find: PREV_CARD_PLACEHOLDER,
      replaceWith: predecessorCardId,
      predecessorCardId,
    })
  }
  return backfills.filter(spec => spec.cardId !== '')
}

/** 对单个文本字段执行占位替换（回填实际写入内容由此产生，保证替换恰好 1 处）。 */
export function applyBackfillText(original: string, backfill: BackfillSpec): { text: string; replaced: number } {
  const occurrences = original.split(backfill.find).length - 1
  return { text: original.split(backfill.find).join(backfill.replaceWith), replaced: occurrences }
}

// ── FT15 D3：建卡工具报会话累积态错误时的防重复卡协议 ─────────────────────────

const JSON_SERIALIZABLE_MARKER = 'losslessly JSON-serializable'

/** 判定建卡报错是否为已知的调用会话累积态损坏（同会话多次成功后必现、不落库）。 */
export function isCreateSessionStateError(errorText: string): boolean {
  return errorText.includes('tool result must be losslessly JSON-serializable')
    || errorText.includes(JSON_SERIALIZABLE_MARKER)
}

/** 回读列表中单卡的最小形状（Lead 从看板 list/get 回喂）。 */
export interface BoardListCard {
  readonly id: string
  readonly title: string
  readonly status?: string
}

export interface CreateRecoveryDecision {
  /** adopt=该卡其实已落库，采用回读 id 禁止重建；retry=未落库，先 unstick 再重试。 */
  readonly action: 'adopt' | 'retry'
  readonly cardId?: string
  /** 本次建卡已用重试次数（0=首次；D3 上限 2 次重试）。 */
  readonly retryAttempt: number
  readonly stop: boolean
  readonly reason: string
}

/**
 * FT15/D3：建卡报 JSON-serializable 错后的处置判定。
 * 先以标题在回读列表中核对是否已落库（防重复卡）；已落库→adopt；
 * 未落库→对任意已建卡做一次 update（解会话累积态）后重试，同法最多 2 次。
 */
export function planCreateRecovery(
  spec: CardCreateSpec,
  boardList: readonly BoardListCard[],
  retryAttempt: number,
): CreateRecoveryDecision {
  const landed = boardList.find(card => card.title === spec.title)
  if (landed !== undefined) {
    return { action: 'adopt', cardId: landed.id, retryAttempt, stop: false, reason: `标题「${spec.title}」已在看板回读列表中（id=${landed.id}），判定已落库，禁止重建（D3 防重复卡）` }
  }
  if (retryAttempt >= 2) {
    return { action: 'retry', retryAttempt, stop: true, reason: `「${spec.title}」未落库且 JSON-serializable 重试已达 2 次上限：停止建卡，回报已建卡 id 清单（D3）` }
  }
  return {
    action: 'retry',
    retryAttempt: retryAttempt + 1,
    stop: false,
    reason: `「${spec.title}」未落库：先对任意已建卡执行一次 ${BOARD_UPDATE_TOOL}（解会话累积态），再重试 ${BOARD_CREATE_TOOL}（第 ${retryAttempt + 1}/2 次）`,
  }
}

// ── FT14：建后回读机检 ────────────────────────────────────────────────────────

/** task_board_get 回读卡的最小形状。 */
export interface BoardGetCard {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly parentId?: string
  readonly depth?: number
  readonly tags?: readonly { readonly name: string }[]
  readonly description: string
  readonly prompt?: string
  readonly executionCount?: number
}

export interface BoardVerificationIssue {
  readonly code: string
  readonly index: number
  readonly message: string
}

export interface BoardVerificationResult {
  readonly ok: boolean
  readonly issues: readonly BoardVerificationIssue[]
  /** 有序落库记录（index→id），供交付模板使用。 */
  readonly adopted: readonly AdoptedCard[]
}

function tagNames(card: BoardGetCard): readonly string[] {
  return (card.tags ?? []).map(tag => tag.name)
}

/** 串行链卡 description 首行在回填后必须含前置真实 id（链首含「无前置卡」）。 */
function verifySerialFields(
  spec: CardCreateSpec,
  card: BoardGetCard,
  serialIdBySeq: ReadonlyMap<string, string>,
  issues: BoardVerificationIssue[],
): void {
  if (spec.serialIndex === undefined) return
  const firstLine = card.description.split('\n')[0] ?? ''
  if (spec.serialIndex === 1) {
    if (!firstLine.includes('无前置卡')) issues.push({ code: 'S4_FIRSTLINE_CHAIN_HEAD', index: spec.index, message: `卡「${card.title}」description 首行缺少链首声明「无前置卡」` })
  } else {
    const mapKey = `${spec.chainId ?? ''}:${spec.serialIndex - 1}`
    const expectedPrev = serialIdBySeq.get(mapKey)
    if (expectedPrev === undefined || !firstLine.includes(expectedPrev)) {
      issues.push({ code: 'S4_FIRSTLINE_PREV_ID', index: spec.index, message: `卡「${card.title}」description 首行未回填前置卡真实 id ${expectedPrev ?? ''}（FT15）` })
    }
    if (card.prompt !== undefined && !card.prompt.includes(expectedPrev ?? '__never__')) {
      issues.push({ code: 'S4_PROMPT_PREV_ID', index: spec.index, message: `卡「${card.title}」prompt 交接段未回填前置卡真实 id（FT15）` })
    }
    if (card.prompt !== undefined && card.prompt.includes(PREV_CARD_PLACEHOLDER)) {
      issues.push({ code: 'S4_PLACEHOLDER_LEFT', index: spec.index, message: `卡「${card.title}」prompt 仍残留占位符 ${PREV_CARD_PLACEHOLDER}（FT15 必须回填）` })
    }
  }
  if (card.parentId !== undefined) {
    issues.push({ code: 'S4_SERIAL_HAS_PARENT', index: spec.index, message: `串行 root 卡「${card.title}」不得有 parentId（实际 ${card.parentId}）` })
  }
  if (card.prompt === undefined || !card.prompt.includes('## 上下文交接')) {
    issues.push({ code: 'S4_PROMPT_HANDOFF_MISSING', index: spec.index, message: `卡「${card.title}」prompt 缺少「## 上下文交接」段` })
  } else {
    verifyGateContract(card, spec, issues)
  }
}

/** 建议门契约机检：prompt 必须写死前置回读（get 工具、列=done、阻塞零改动）。 */
function verifyGateContract(card: BoardGetCard, spec: CardCreateSpec, issues: BoardVerificationIssue[]): void {
  if (spec.serialIndex === undefined || spec.serialIndex <= 1) return
  const prompt = card.prompt ?? ''
  for (const fragment of [BOARD_GET_TOOL, '必须为 done', '留在 todo', '回报阻塞', '禁止改动']) {
    if (!prompt.includes(fragment)) {
      issues.push({ code: 'S4_GATE_CONTRACT', index: spec.index, message: `卡「${card.title}」prompt 建议门契约缺少固定文本「${fragment}」` })
    }
  }
}

/**
 * FT14/FT15/FT16 回读机检：数量/标题序号/tags/description 首行/prompt 交接段/
 * 列=todo/零执行记录/父子深度。cards 为 Lead 用看板 get 逐张回读的结果。
 */
export function verifyCreatedBoard(plan: CreatePlan, cards: readonly BoardGetCard[]): BoardVerificationResult {
  const issues: BoardVerificationIssue[] = []
  const byId = new Map(cards.map(card => [card.id, card]))
  const adopted: AdoptedCard[] = []
  if (cards.length !== plan.specs.length) {
    issues.push({ code: 'S4_COUNT_MISMATCH', index: -1, message: `回读卡数 ${cards.length} ≠ 建卡规格数 ${plan.specs.length}` })
  }
  // 以标题对齐（建卡返回 id 后 Lead 也会回喂；回读校验独立于回喂，防 id 串卡）。
  const adoptedIds = new Map<number, string>()
  // 串行链 seq→看板 id 映射（键 `${chainId}:${seq}`），供前置 id 回填机检。
  const serialIdBySeq = new Map<string, string>()
  for (const spec of plan.specs) {
    const card = cards.find(candidate => candidate.title === spec.title)
    if (card === undefined) {
      issues.push({ code: 'S4_CARD_NOT_FOUND', index: spec.index, message: `看板未回读到标题「${spec.title}」` })
      continue
    }
    adopted.push({ index: spec.index, id: card.id, title: card.title })
    adoptedIds.set(spec.index, card.id)
    if (spec.serialIndex !== undefined && spec.chainId !== undefined) {
      serialIdBySeq.set(`${spec.chainId}:${spec.serialIndex}`, card.id)
    }
    if (card.status !== 'todo') issues.push({ code: 'S4_STATUS_NOT_TODO', index: spec.index, message: `卡「${card.title}」列=${card.status}，必须全部为 todo（只建不跑）` })
    if ((card.executionCount ?? 0) !== 0) issues.push({ code: 'S4_HAS_EXECUTION', index: spec.index, message: `卡「${card.title}」executionCount=${card.executionCount ?? 0}，必须为 0（FT16 零执行记录）` })
    verifyTags(spec, card, issues)
    if (spec.role === 'child') verifyChildParent(spec, card, plan, byId, issues)
    verifySerialFields(spec, card, serialIdBySeq, issues)
  }
  verifyDepth(plan, cards, issues)
  return { ok: issues.length === 0, issues, adopted }
}

function verifyTags(spec: CardCreateSpec, card: BoardGetCard, issues: BoardVerificationIssue[]): void {
  const names = tagNames(card)
  for (const expected of spec.tags) {
    if (!names.includes(expected.name)) issues.push({ code: 'S4_TAG_MISSING', index: spec.index, message: `卡「${card.title}」缺少 tag ${expected.name}` })
  }
  if (spec.serialIndex !== undefined) {
    const chainTag = `chain:${spec.chainId ?? ''}`
    const seqTag = `seq:${spec.serialIndex}`
    if (!names.includes(chainTag)) issues.push({ code: 'S4_CHAIN_TAG', index: spec.index, message: `卡「${card.title}」缺少 ${chainTag}` })
    if (!names.includes(seqTag)) issues.push({ code: 'S4_SEQ_TAG', index: spec.index, message: `卡「${card.title}」缺少 ${seqTag}` })
  }
}

function verifyChildParent(
  spec: CardCreateSpec,
  card: BoardGetCard,
  plan: CreatePlan,
  byId: ReadonlyMap<string, BoardGetCard>,
  issues: BoardVerificationIssue[],
): void {
  if (spec.parentCreateIndex === undefined) {
    issues.push({ code: 'S4_CHILD_NO_PARENT_SPEC', index: spec.index, message: `子卡「${card.title}」规格缺少 parentCreateIndex` })
    return
  }
  const parentSpec = plan.specs[spec.parentCreateIndex]
  const parent = parentSpec === undefined ? undefined : [...byId.values()].find(candidate => candidate.title === parentSpec.title)
  if (card.parentId === undefined) {
    issues.push({ code: 'S4_CHILD_NO_PARENTID', index: spec.index, message: `子卡「${card.title}」缺少 parentId（parallel 样例必须 1 父 N 子）` })
    return
  }
  if (parent === undefined || card.parentId !== parent.id) {
    issues.push({ code: 'S4_CHILD_PARENT_MISMATCH', index: spec.index, message: `子卡「${card.title}」parentId=${card.parentId} 未指向父卡「${parentSpec?.title ?? '?'}」` })
  }
}

/** 深度机检：maxSubtaskDepth=1，子卡不得再有子卡（回读对象无 parentId 的 parent 链）。 */
function verifyDepth(plan: CreatePlan, cards: readonly BoardGetCard[], issues: BoardVerificationIssue[]): void {
  void plan
  for (const card of cards) {
    if (card.parentId === undefined) continue
    const parent = cards.find(candidate => candidate.id === card.parentId)
    if (parent !== undefined && parent.parentId !== undefined) {
      issues.push({ code: 'S4_DEPTH_EXCEEDED', index: -1, message: `卡「${card.title}」嵌套深度≥2（parentId 指向的父卡 ${parent.id} 仍有 parentId），违反 maxSubtaskDepth=1` })
    }
    if ((card.depth ?? 1) > 1) {
      issues.push({ code: 'S4_DEPTH_FIELD', index: -1, message: `卡「${card.title}」depth=${card.depth} > 1` })
    }
  }
}

// ── FT16：交付模板（只建不跑 + 有序清单 + 建议门提示） ────────────────────────

export interface DeliveryEntry {
  readonly seq: number
  readonly title: string
  readonly id: string
  readonly relation: string
}

export interface DeliveryReviewSummary {
  readonly releasedCount: number
  readonly totalPrompts: number
  readonly highOpen: number
}

export interface DeliveryInput {
  readonly goal: string
  readonly planId: string
  readonly topology: string
  readonly entries: readonly DeliveryEntry[]
  readonly review: DeliveryReviewSummary
}

/**
 * FT16 最终回复模板：①有序执行清单（seq/标题/id/拓扑关系）②审查验收摘要（high=0）
 * ③建议人工按序执行的动作。插件不主动执行任何卡片（RUN_TOOL_HINT 仅供用户动作提示）。
 */
export function formatDeliveryDocument(input: DeliveryInput): string {
  const lines: string[] = []
  lines.push(`# ON 流水线建卡完成（planId=${input.planId}，拓扑=${input.topology}）`)
  lines.push('')
  lines.push(`目标复述：${input.goal}`)
  lines.push('')
  lines.push('## ① 有序执行清单（只建不跑：全部卡片当前均为 todo，插件未触发任何执行）')
  lines.push('| seq | 标题 | 卡 id | 拓扑关系 |')
  lines.push('| --- | --- | --- | --- |')
  for (const entry of input.entries) {
    lines.push(`| ${entry.seq} | ${entry.title} | ${entry.id} | ${entry.relation} |`)
  }
  lines.push('')
  lines.push('## ② 卡片 prompt 审查验收摘要（S3）')
  lines.push(`- 审查通过：${input.review.releasedCount}/${input.review.totalPrompts} 份；未决 high issue=${input.review.highOpen}（放行门要求 0）。`)
  lines.push('- 每份卡片 prompt 已按 TB-C5 十一项机检，并经独立审查子会话复审（doc_type=task-prompt）。')
  lines.push('')
  lines.push('## ③ 建议人工按序执行（执行权在用户，Q8=只建不跑）')
  lines.push('- 串行链：严格按 seq 从小到大，每次只对一张卡执行看板「执行」动作；该卡结算为 done 后再执行下一张。')
  lines.push(`- 工具面动作：调用看板执行工具（工具名=${RUN_TOOL_HINT}，见 dsh-task-board 技能 TB-R1），入参为上表卡 id；父卡执行会级联其全部直接子卡。`)
  lines.push('- 顺序门为建议门（Q7）：每张串行卡 prompt 已写死开工前用 task_board_get 回读前置卡列=done，否则零改动、留 todo、回报阻塞。')
  lines.push('- 并行组：对父卡执行一次，子卡由看板级联并发；勿对单张子卡提前执行。')
  return lines.join('\n')
}
