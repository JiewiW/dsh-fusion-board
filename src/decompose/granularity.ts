// FT09 — 卡片粒度判定五分支（计划书 §3.4），把 S1 的 decomposition 映射为卡片单元。
//
// 分支编号与计划书一致：
//   1 独立块 → 1 父卡 + 每块一张子卡（深度 1，子卡不得再嵌子卡）
//   2 紧耦合串行微步骤 → 合并为一张卡按 Step 1..n（信号：block.rationale 以「微步骤=」开头或含「不可拆」）
//   3 串行大块 → 多个并列 root 卡 + 顺序协议（chain/seq）表达先后
//   4 mixed → 并行组按 1、组间/未分组块按 3
//   5 兜底 → 无法判定（依赖成环/悬空，拓扑被保守强制串行）时按 3 处理并在 issues 标注

import type { Decomposition, DecompositionBlock, SchemaIssue, Topology } from './schema.js'
import type { TopologyAnalysis } from './topology.js'

export type CardBranch = 1 | 2 | 3 | 4 | 5

export interface MicroStep {
  readonly blockId: string
  readonly title: string
  readonly deliverables: readonly string[]
}

export interface CardUnit {
  /** parent/child 属于分支 1/4 的父子结构；root 是独立卡（分支 3/5 串行链、分支 2 合并卡）。 */
  readonly role: 'root' | 'parent' | 'child'
  readonly blockIds: readonly string[]
  /** 分支 2：合并卡内的按序微步骤。 */
  readonly steps?: readonly MicroStep[]
  /** 串行链序号（1 基）；undefined = 不在链上（可并发）。 */
  readonly serialIndex?: number
  readonly serialTotal?: number
  readonly chainId?: string
  /** child 指向其 parent 单元在 units 数组中的下标；深度硬约束 ≤1。 */
  readonly parentUnitIndex?: number
  /** 并行组名（分支 4 的组内卡）。 */
  readonly parallelGroup?: string
  /** true = 由分支 5 保守兜底产生（粒度更粗只损失并发）。 */
  readonly conservative?: boolean
}

export interface DecompositionPlan {
  readonly goal: string
  readonly topology: Topology
  readonly branch: CardBranch
  readonly planId: string
  readonly units: readonly CardUnit[]
  readonly issues: readonly SchemaIssue[]
}

const MICRO_STEP_PREFIX = '微步骤='
const TIGHT_COUPLING_MARKER = '不可拆'

function blockById(blocks: readonly DecompositionBlock[], id: string): DecompositionBlock | undefined {
  return blocks.find(block => block.id === id)
}

/** 分支 2 信号：Lead 在 block.rationale 写明「微步骤=」或「不可拆」（§3.3 rationale 字段的约定用法）。 */
export function isMicroStepBlock(block: DecompositionBlock): boolean {
  const rationale = block.rationale ?? ''
  return rationale.startsWith(MICRO_STEP_PREFIX) || rationale.includes(TIGHT_COUPLING_MARKER)
}

function microStepSummary(block: DecompositionBlock): MicroStep {
  const raw = block.rationale ?? ''
  const intent = raw.startsWith(MICRO_STEP_PREFIX) ? raw.slice(MICRO_STEP_PREFIX.length).trim() : raw.trim()
  return { blockId: block.id, title: `${block.title}（${intent || '按序微步骤'}）`, deliverables: block.deliverables }
}

/** 分支 3/5：把块按给定顺序铺成并列 root 卡并编号（单卡也出【1/1】，保证协议字段齐全）。 */
function chainUnits(ordered: readonly DecompositionBlock[], planId: string, conservative: boolean): CardUnit[] {
  const total = ordered.length
  return ordered.map((block, index): CardUnit => ({
    role: 'root',
    blockIds: [block.id],
    serialIndex: index + 1,
    serialTotal: total,
    chainId: planId,
    ...(conservative ? { conservative: true } : {}),
  }))
}

/** 分支 1/4 的组内结构：1 张父卡 + 每成员一张子卡（parentUnitIndex 指向父卡下标）。 */
function groupUnits(members: readonly DecompositionBlock[], groupName: string): CardUnit[] {
  const parent: CardUnit = { role: 'parent', blockIds: members.map(member => member.id), parallelGroup: groupName }
  const children: CardUnit[] = members.map(member => ({
    role: 'child' as const,
    blockIds: [member.id],
    parentUnitIndex: 0,
    parallelGroup: groupName,
  }))
  return [parent, ...children]
}

/**
 * 五分支判定入口。analysis.forcedConservativeSerial=true 时一律走分支 5（按 3 拆 root 卡），
 * 并记一条 GRANULARITY_CONSERVATIVE issue（仅记录，不阻断——兜底本身就是可继续的出口）。
 */
export function buildCardPlan(decomposition: Decomposition, analysis: TopologyAnalysis, planId: string): DecompositionPlan {
  const blocks = decomposition.blocks
  const issues: SchemaIssue[] = []

  if (analysis.forcedConservativeSerial) {
    issues.push({
      code: 'GRANULARITY_CONSERVATIVE', path: '$.blocks',
      message: '依赖无法判定（成环/悬空），按 §3.4 分支 5 兜底：拆为并列 root 卡并用顺序协议表达（粒度更粗只损失并发，误拆并发会破坏正确性）',
    })
    return { goal: decomposition.goal, topology: decomposition.topology, branch: 5, planId, units: chainUnits(blocks, planId, true), issues }
  }

  if (blocks.length > 1 && blocks.every(block => isMicroStepBlock(block))) {
    // 分支 2：紧耦合微步骤合并为一张卡，卡内 Step 1..n（不分链、不建并发子卡）。
    const steps = blocks.map(microStepSummary)
    const unit: CardUnit = { role: 'root', blockIds: blocks.map(block => block.id), steps }
    return { goal: decomposition.goal, topology: decomposition.topology, branch: 2, planId, units: [unit], issues }
  }

  if (decomposition.topology === 'serial') {
    // 分支 3：串行大块 → 并列 root 卡 + 顺序协议（禁止建完即并发 run；顺序门 §3.5）。
    return { goal: decomposition.goal, topology: 'serial', branch: 3, planId, units: chainUnits(analysis.serialChain.map(id => blockById(blocks, id)!).filter(Boolean), planId, false), issues }
  }

  if (decomposition.topology === 'parallel') {
    // 分支 1：互相无依赖且各有客观验收 → 1 父卡 + 每块一张子卡（深度 1）。
    const groupName = 'all'
    const units = groupUnits(blocks, groupName)
    return { goal: decomposition.goal, topology: 'parallel', branch: 1, planId, units: units.map(unit => ({ ...unit, parentUnitIndex: unit.role === 'child' ? 0 : undefined })), issues }
  }

  // 分支 4：mixed — 并行组内按 1（父卡+子卡），未分组的串行块按 3（root 链）。
  const units: CardUnit[] = []
  const groupedIds = new Set<string>()
  for (const group of analysis.parallelGroups) {
    const members = group.memberIds
      .map(id => blockById(blocks, id))
      .filter((block): block is DecompositionBlock => block !== undefined)
    if (members.length === 0) continue
    for (const member of members) groupedIds.add(member.id)
    const offset = units.length
    for (const unit of groupUnits(members, group.group)) {
      units.push(unit.role === 'child' ? { ...unit, parentUnitIndex: offset } : unit)
    }
  }
  const remaining = analysis.serialChain
    .map(id => blockById(blocks, id))
    .filter((block): block is DecompositionBlock => block !== undefined && !groupedIds.has(block.id))
  for (const unit of chainUnits(remaining, planId, false)) units.push(unit)
  return { goal: decomposition.goal, topology: 'mixed', branch: 4, planId, units, issues }
}
