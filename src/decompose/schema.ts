// FT05 — decomposition Schema（计划书 §3.3 S1）。
//
// 手写校验器（不依赖 cordis/zod），保证 S1 校验逻辑可在离线 vitest 与任何
// host 环境同口径运行；Lead 输出的强校验与「未通过不得进入 S2」由本文件的
// validateDecomposition 承担。

export const TOPOLOGY_VALUES = ['serial', 'parallel', 'mixed'] as const
export type Topology = (typeof TOPOLOGY_VALUES)[number]

export interface DecompositionBlock {
  readonly id: string
  readonly title: string
  readonly deliverables: readonly string[]
  readonly acceptance: readonly string[]
  readonly inputs: readonly string[]
  readonly touches: readonly string[]
  readonly dependsOn: readonly string[]
  readonly parallelGroup?: string
  readonly rationale?: string
}

export interface Decomposition {
  readonly goal: string
  readonly blocks: readonly DecompositionBlock[]
  readonly topology: Topology
  readonly rationale: string
}

export interface SchemaIssue {
  readonly code: string
  readonly path: string
  readonly message: string
}

export interface ValidationResult {
  readonly ok: boolean
  readonly value?: Decomposition
  readonly issues: readonly SchemaIssue[]
}

const MAX_BLOCKS = 20
const MAX_ITEMS_PER_LIST = 20
const MAX_ID_LENGTH = 40

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown, path: string, issues: SchemaIssue[]): string[] {
  if (!Array.isArray(value)) {
    issues.push({ code: 'TYPE_ARRAY', path, message: '必须是字符串数组（可为空数组）' })
    return []
  }
  if (value.length > MAX_ITEMS_PER_LIST) {
    issues.push({ code: 'ARRAY_TOO_LONG', path, message: `数组最多 ${MAX_ITEMS_PER_LIST} 项，实际 ${value.length} 项` })
  }
  const items: string[] = []
  value.forEach((entry, index) => {
    const text = trimmedString(entry)
    if (text === undefined) issues.push({ code: 'ITEM_NOT_NONEMPTY_STRING', path: `${path}[${index}]`, message: '元素必须是非空字符串' })
    else items.push(text)
  })
  return items
}

function validateBlock(raw: unknown, index: number, issues: SchemaIssue[]): DecompositionBlock | undefined {
  const path = `blocks[${index}]`
  if (!isRecord(raw)) {
    issues.push({ code: 'BLOCK_NOT_OBJECT', path, message: 'block 必须是对象' })
    return undefined
  }
  const id = trimmedString(raw.id)
  if (id === undefined) issues.push({ code: 'BLOCK_ID_REQUIRED', path: `${path}.id`, message: 'id 必须是非空字符串' })
  else if (id.length > MAX_ID_LENGTH) issues.push({ code: 'BLOCK_ID_TOO_LONG', path: `${path}.id`, message: `id 最长 ${MAX_ID_LENGTH} 字符` })
  const title = trimmedString(raw.title)
  if (title === undefined) issues.push({ code: 'BLOCK_TITLE_REQUIRED', path: `${path}.title`, message: 'title 必须是非空字符串' })
  const deliverables = stringArray(raw.deliverables, `${path}.deliverables`, issues)
  const acceptance = stringArray(raw.acceptance, `${path}.acceptance`, issues)
  const inputs = stringArray(raw.inputs, `${path}.inputs`, issues)
  const touches = stringArray(raw.touches, `${path}.touches`, issues)
  const dependsOn = stringArray(raw.dependsOn, `${path}.dependsOn`, issues)
  const parallelGroup = raw.parallelGroup === undefined || raw.parallelGroup === null
    ? undefined : trimmedString(raw.parallelGroup)
  if (raw.parallelGroup !== undefined && raw.parallelGroup !== null && parallelGroup === undefined) {
    issues.push({ code: 'PARALLEL_GROUP_EMPTY', path: `${path}.parallelGroup`, message: 'parallelGroup 给了就必须是非空字符串，否则省略该字段' })
  }
  const rationale = raw.rationale === undefined ? undefined : trimmedString(raw.rationale)
  if (rationale === undefined && raw.rationale !== undefined) {
    issues.push({ code: 'BLOCK_RATIONALE_EMPTY', path: `${path}.rationale`, message: 'block.rationale 若提供必须是非空字符串' })
  }
  if (id === undefined || title === undefined) return undefined
  return { id, title, deliverables, acceptance, inputs, touches, dependsOn, ...(parallelGroup ? { parallelGroup } : {}), ...(rationale ? { rationale } : {}) }
}

/** Schema 形状校验：只做可机检的硬约束，拓扑一致性交给 topology.ts。 */
export function validateDecomposition(input: unknown): ValidationResult {
  const issues: SchemaIssue[] = []
  if (!isRecord(input)) {
    return { ok: false, issues: [{ code: 'ROOT_NOT_OBJECT', path: '$', message: 'decomposition 必须是 JSON 对象' }] }
  }
  const goal = trimmedString(input.goal)
  if (goal === undefined) issues.push({ code: 'GOAL_REQUIRED', path: '$.goal', message: 'goal 必须是非空字符串（用户目标复述）' })
  const rationale = trimmedString(input.rationale)
  if (rationale === undefined) issues.push({ code: 'RATIONALE_REQUIRED', path: '$.rationale', message: 'rationale 必须是非空字符串（每块不可再合并/必须串行的依据）' })
  const topology = trimmedString(input.topology)
  if (topology === undefined || !(TOPOLOGY_VALUES as readonly string[]).includes(topology)) {
    issues.push({ code: 'TOPOLOGY_ENUM', path: '$.topology', message: `topology 必须是 ${TOPOLOGY_VALUES.join(' | ')} 之一` })
  }
  if (!Array.isArray(input.blocks)) {
    issues.push({ code: 'BLOCKS_REQUIRED', path: '$.blocks', message: 'blocks 必须是非空数组' })
    return { ok: false, issues }
  }
  if (input.blocks.length === 0) issues.push({ code: 'BLOCKS_EMPTY', path: '$.blocks', message: 'blocks 至少 1 个块' })
  if (input.blocks.length > MAX_BLOCKS) issues.push({ code: 'BLOCKS_TOO_MANY', path: '$.blocks', message: `blocks 最多 ${MAX_BLOCKS} 个块，实际 ${input.blocks.length}，请合并或缩减` })
  const blocks: DecompositionBlock[] = []
  input.blocks.forEach((raw, index) => {
    const block = validateBlock(raw, index, issues)
    if (block) blocks.push(block)
  })
  const seen = new Map<string, number>()
  blocks.forEach((block, index) => {
    const prior = seen.get(block.id)
    if (prior !== undefined) issues.push({ code: 'DUPLICATE_BLOCK_ID', path: `blocks[${index}].id`, message: `block id "${block.id}" 与 blocks[${prior}].id 重复` })
    else seen.set(block.id, index)
  })
  const ids = new Set(blocks.map(block => block.id))
  blocks.forEach((block, index) => {
    for (const dep of block.dependsOn) {
      if (!ids.has(dep)) issues.push({ code: 'UNKNOWN_DEPENDENCY', path: `blocks[${index}].dependsOn`, message: `dependsOn 引用了不存在的 block id "${dep}"` })
      if (dep === block.id) issues.push({ code: 'SELF_DEPENDENCY', path: `blocks[${index}].dependsOn`, message: 'dependsOn 不得包含自身' })
    }
    if (block.dependsOn.length > 0 && block.parallelGroup !== undefined) {
      const groupMembers = blocks.filter(other => other.parallelGroup === block.parallelGroup && other.id !== block.id)
      const withinGroup = block.dependsOn.filter(dep => groupMembers.some(member => member.id === dep))
      if (withinGroup.length > 0) {
        issues.push({
          code: 'SAME_GROUP_DEPENDENCY', path: `blocks[${index}].dependsOn`,
          message: `同并行组内禁止互相依赖（TB-P1：dependsOn 非空即不得标并行）；请只保留跨组依赖或去掉 parallelGroup="${block.parallelGroup}"`,
        })
      }
    }
  })
  if (issues.length > 0) return { ok: false, issues }
  const value: Decomposition = {
    goal: goal as string,
    blocks,
    topology: topology as Topology,
    rationale: rationale as string,
  }
  return { ok: true, value, issues: [] }
}

export function parseDecompositionJson(text: string): { ok: boolean; value?: unknown; issues: readonly SchemaIssue[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, issues: [{ code: 'JSON_PARSE', path: '$', message: `输出不是合法 JSON：${detail}` }] }
  }
  return { ok: true, value: parsed, issues: [] }
}
