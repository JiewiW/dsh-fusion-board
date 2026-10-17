// FT09 — 串行顺序协议文本生成（计划书 §3.4「串行顺序协议」+ §3.5 顺序门 v1 建议门）。
//
// 固定字段（机检目标，缺一不可）：
//   标题   【k/N】<一句话标题>            k 从 1，N=该串行链卡数
//   tags   chain:<planId> 与 seq:<k>      planId 形如 tf-YYYYMMDD-<短哈希>
//   描述首行 串行链 <planId> 第 <k>/<N> 步；前置：【k-1/N】<标题>（卡 id 建卡后回填）；未完成前置前禁止执行本卡。
//   prompt 末尾「上下文交接」段：前置产物文件路径交接 + {{PREV_CARD_ID}} 占位 + task_board_get 回读前置列=done

import { createHash } from 'node:crypto'
import type { CardUnit, DecompositionPlan } from './granularity.js'

export const PREV_CARD_PLACEHOLDER = '{{PREV_CARD_ID}}'
const HANDOFF_HEADER = '## 上下文交接'

/** planId = tf-YYYYMMDD-<goal 内容短哈希>；同日不同目标得到不同链，同输入可复现（离线断言依赖）。 */
export function makePlanId(goal: string, dateIso?: string): string {
  const stamp = (dateIso ?? new Date().toISOString()).slice(0, 10).replace(/-/g, '')
  const hash = createHash('sha256').update(goal, 'utf8').digest('hex').slice(0, 8)
  return `tf-${stamp}-${hash}`
}

export interface SerialProtocolFields {
  readonly title: string
  readonly tags: readonly string[]
  readonly descriptionFirstLine: string
}

/** 串行链卡的三个协议字段（标题/tags/描述首行），非链卡返回 undefined 字段集。 */
export function serialProtocol(unit: CardUnit, chainTitleOf: (blockId: string) => string, predecessorTitle?: string): SerialProtocolFields | undefined {
  if (unit.serialIndex === undefined || unit.serialTotal === undefined || unit.chainId === undefined) return undefined
  const k = unit.serialIndex
  const n = unit.serialTotal
  const tags = [`chain:${unit.chainId}`, `seq:${k}`]
  if (unit.parallelGroup !== undefined) tags.push(`parallel-group:${unit.parallelGroup}`)
  const firstLine = k === 1
    ? `串行链 ${unit.chainId} 第 1/${n} 步；无前置卡；本卡完成前，第 2/${n} 步及以后禁止开始。`
    : `串行链 ${unit.chainId} 第 ${k}/${n} 步；前置：【${k - 1}/${n}】${predecessorTitle ?? chainTitleOf(unit.blockIds[0] ?? '')}（卡 id ${PREV_CARD_PLACEHOLDER}，建卡后回填）；未完成前置前禁止执行本卡。`
  return { title: `【${k}/${n}】`, tags, descriptionFirstLine: firstLine }
}

/** 「上下文交接」段：跨卡依赖落成文件路径，执行者先回读前置卡状态再开工（§3.5 建议门）。 */
export function buildHandoffSection(plan: DecompositionPlan, unit: CardUnit, predecessor: CardUnit | undefined, handoffPaths: readonly string[]): string {
  const lines: string[] = [HANDOFF_HEADER]
  if (unit.serialIndex !== undefined && unit.serialIndex > 1 && predecessor !== undefined) {
    lines.push(`- 前置卡：${PREV_CARD_PLACEHOLDER}（串行链 ${unit.chainId} 第 ${unit.serialIndex - 1}/${unit.serialTotal} 步）。开工前必须用 task_board_get 回读该卡，其列必须为 done；不为 done 则把本卡留在 todo 并回报阻塞原因，禁止改动。`)
  } else if (unit.serialIndex === 1) {
    lines.push('- 前置卡：无（链首）。完成后回报产物路径，供后继卡执行者核对。')
  } else {
    lines.push('- 前置卡：无（本卡可独立执行/并发）。')
  }
  if (handoffPaths.length > 0) {
    lines.push('- 交接文件路径（读取前置产物、交付本步产物均走文件，禁止依赖会话记忆）：')
    for (const path of handoffPaths) lines.push(`  - ${path}`)
  } else {
    lines.push('- 交接文件路径：无跨卡文件依赖（本卡 inputs/deliverables 见上文）。')
  }
  return lines.join('\n')
}

/** 找某张链卡的前置卡（同链 seq=k-1）。 */
export function predecessorOf(plan: DecompositionPlan, unit: CardUnit): CardUnit | undefined {
  const index = unit.serialIndex
  if (index === undefined || index <= 1 || unit.chainId === undefined) return undefined
  return plan.units.find(candidate =>
    candidate.chainId === unit.chainId && candidate.serialIndex === index - 1)
}
