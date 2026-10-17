// FT06 — TB-P1 路径分析在代码侧的落地：依赖图分析、拓扑推导、保守串行兜底。
// 与 lead-prompt.ts 里 prompt 侧的固定步骤/自检表同源，两处口径一致。

import { validateDecomposition } from './schema.js'
import type { Decomposition, DecompositionBlock, SchemaIssue, Topology } from './schema.js'

export interface TopologyAnalysis {
  /** 代码侧从 dependsOn/parallelGroup 推导出的拓扑（与 Lead 声明比对）。 */
  readonly derived: Topology
  readonly serialChain: readonly string[]
  readonly parallelGroups: readonly { readonly group: string; readonly memberIds: readonly string[] }[]
  readonly issues: readonly SchemaIssue[]
  /** true = 依赖无法判定（成环/悬空引用），按 TB-P1 保守口径强制串行。 */
  readonly forcedConservativeSerial: boolean
}

const MAX_ATTEMPTS = 2

/** Kahn 拓扑排序；返回 undefined 表示存在环（依赖无法判定）。 */
function topoOrder(blocks: readonly DecompositionBlock[]): string[] | undefined {
  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const block of blocks) {
    indegree.set(block.id, 0)
    outgoing.set(block.id, [])
  }
  for (const block of blocks) {
    for (const dep of new Set(block.dependsOn)) {
      if (!indegree.has(dep)) continue
      indegree.set(block.id, (indegree.get(block.id) ?? 0) + 1)
      outgoing.get(dep)!.push(block.id)
    }
  }
  // 同层按原序稳定输出，保证协议文本可复现。
  const ready = blocks.filter(block => indegree.get(block.id) === 0).map(block => block.id)
  const order: string[] = []
  while (ready.length > 0) {
    const current = ready.shift() as string
    order.push(current)
    for (const next of outgoing.get(current) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1)
      if (indegree.get(next) === 0) ready.push(next)
    }
  }
  return order.length === blocks.length ? order : undefined
}

export function analyzeTopology(blocks: readonly DecompositionBlock[]): TopologyAnalysis {
  const issues: SchemaIssue[] = []
  const ids = new Set(blocks.map(block => block.id))
  let dangling = false
  for (const block of blocks) {
    for (const dep of block.dependsOn) {
      if (!ids.has(dep)) dangling = true
    }
  }
  const order = dangling ? undefined : topoOrder(blocks)
  const forced = (dangling || order === undefined) && blocks.length > 1
  if (forced) {
    issues.push({
      code: 'CONSERVATIVE_SERIAL', path: '$.blocks',
      message: '依赖关系成环或存在悬空引用，无法判定；按 TB-P1 保守口径强制串行（粒度更粗只损失并发，误拆并发会破坏正确性）',
    })
  }
  const anyDependency = blocks.some(block => block.dependsOn.length > 0)
  const groups = new Map<string, string[]>()
  for (const block of blocks) {
    if (block.parallelGroup === undefined) continue
    const members = groups.get(block.parallelGroup) ?? []
    members.push(block.id)
    groups.set(block.parallelGroup, members)
  }
  const parallelGroups = [...groups.entries()].map(([group, memberIds]) => ({ group, memberIds }))
  // 只有「存在≥2成员的并行组且整图无任何依赖」才判 parallel；
  // 有依赖且并行组之外的块参与先后 → mixed；全链无并行 → serial。
  let derived: Topology
  if (forced) derived = 'serial'
  else if (!anyDependency) derived = parallelGroups.some(group => group.memberIds.length >= 2) ? 'parallel' : 'serial'
  else derived = parallelGroups.length > 0 ? 'mixed' : 'serial'
  const serialChain = order ?? blocks.map(block => block.id)
  return { derived, serialChain, parallelGroups, issues, forcedConservativeSerial: forced }
}

/** 校验 Lead 声明的 topology 与代码推导一致；不一致记 issue（prompt 与代码双侧口径）。 */
export function checkTopologyAgreement(declared: Topology, analysis: TopologyAnalysis): SchemaIssue[] {
  if (analysis.forcedConservativeSerial) {
    return declared === 'serial' ? [] : [{
      code: 'TOPOLOGY_MISMATCH', path: '$.topology',
      message: `依赖无法判定时必须保守声明 serial，实际声明 "${declared}"`,
    }]
  }
  if (declared === analysis.derived) return []
  return [{
    code: 'TOPOLOGY_MISMATCH', path: '$.topology',
    message: `Lead 声明 topology="${declared}" 与依赖图推导 "${analysis.derived}" 不一致；按推导结果修正 blocks/dependsOn 或改为保守 serial`,
  }]
}

/** S1 完整校验 = Schema 形状 + 拓扑分析 + 声明一致性；ok=false 不得进入 S2（§3.3 后果）。
 * CONSERVATIVE_SERIAL 是「可继续的保守出口」（§3.3：依赖无法判定按串行处理并在 rationale 注明），
 * 作 warning 返回不阻断；仅 TOPOLOGY_MISMATCH（声明与图不符）与 Schema 类 errors 退回 Lead 修正。 */
export function validateStageOne(value: unknown): { ok: boolean; decomposition?: Decomposition; analysis?: TopologyAnalysis; issues: readonly SchemaIssue[]; warnings: readonly SchemaIssue[] } {
  const shape = validateDecomposition(value)
  if (!shape.ok || shape.value === undefined) return { ok: false, issues: shape.issues, warnings: [] }
  const analysis = analyzeTopology(shape.value.blocks)
  const agreement = checkTopologyAgreement(shape.value.topology, analysis)
  const warnings = analysis.issues
  if (agreement.length > 0) return { ok: false, issues: agreement, warnings }
  return { ok: true, decomposition: shape.value, analysis, issues: [], warnings }
}

/** FT05 重试口径：Lead 输出最多 2 次修正重试（含首次共 3 次尝试），仍失败按 §6 降级。 */
export const DECOMPOSITION_MAX_ATTEMPTS = MAX_ATTEMPTS + 1
