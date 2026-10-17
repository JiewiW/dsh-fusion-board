import type { Decomposition } from './schema.js';
export interface ShortcircuitDecision {
    readonly shortcircuit: boolean;
    /** 短路时给用户的说明（D6：回复必须写明短路原因）。 */
    readonly reason: string;
}
/** S1 后的短路判定。单块且无独立验收 → 短路；其余一律继续 S2。 */
export declare function decideShortcircuit(decomposition: Decomposition): ShortcircuitDecision;
