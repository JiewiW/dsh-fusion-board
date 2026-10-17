// FT07 — 简单任务短路（计划书 §3.3 S1 条件 + §6 D6）。
//
// 判据：Lead 分解结果只有 1 个块，且该块没有独立验收信号（acceptance 为空，
// 或全部条目主观不可机检）时，ON 模式允许短路回 OFF 直派路径，
// 不进入 S2、不建卡，并向用户说明短路原因（R27 兜底，防简单任务被流程税拖垮）。

import type { Decomposition } from './schema.js'

export interface ShortcircuitDecision {
  readonly shortcircuit: boolean
  /** 短路时给用户的说明（D6：回复必须写明短路原因）。 */
  readonly reason: string
}

/**
 * acceptance 是否为"独立可机检验收信号"：至少一条非空，且含客观信号关键词
 * （命令/退出码/输出等，与 TB-C5-7 口径一致）。主观句（"确保正确"类）不算。
 */
function hasIndependentAcceptance(entry: Decomposition['blocks'][number]): boolean {
  return entry.acceptance.some(line => /(退出码|exit|命令|vitest|test|grep|Get-|node |pnpm|npm|build|运行|输出|存在|非空|401|200)/i.test(line))
}

/** S1 后的短路判定。单块且无独立验收 → 短路；其余一律继续 S2。 */
export function decideShortcircuit(decomposition: Decomposition): ShortcircuitDecision {
  const single = decomposition.blocks.length === 1
  if (!single) return { shortcircuit: false, reason: '' }
  const block = decomposition.blocks[0] as (typeof decomposition.blocks)[number]
  if (hasIndependentAcceptance(block)) {
    return { shortcircuit: false, reason: '' }
  }
  return {
    shortcircuit: true,
    reason: `简单任务短路（§6 D6）：分解仅 1 个块「${block.title}」且无独立可机检验收信号，继续走 OFF 直派路径（fusion_delegate），不进入 S2、不建卡。`,
  }
}
