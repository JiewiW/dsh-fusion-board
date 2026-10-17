import type { Decomposition, DecompositionBlock, SchemaIssue, Topology } from './schema.js';
import type { TopologyAnalysis } from './topology.js';
export type CardBranch = 1 | 2 | 3 | 4 | 5;
export interface MicroStep {
    readonly blockId: string;
    readonly title: string;
    readonly deliverables: readonly string[];
}
export interface CardUnit {
    /** parent/child 属于分支 1/4 的父子结构；root 是独立卡（分支 3/5 串行链、分支 2 合并卡）。 */
    readonly role: 'root' | 'parent' | 'child';
    readonly blockIds: readonly string[];
    /** 分支 2：合并卡内的按序微步骤。 */
    readonly steps?: readonly MicroStep[];
    /** 串行链序号（1 基）；undefined = 不在链上（可并发）。 */
    readonly serialIndex?: number;
    readonly serialTotal?: number;
    readonly chainId?: string;
    /** child 指向其 parent 单元在 units 数组中的下标；深度硬约束 ≤1。 */
    readonly parentUnitIndex?: number;
    /** 并行组名（分支 4 的组内卡）。 */
    readonly parallelGroup?: string;
    /** true = 由分支 5 保守兜底产生（粒度更粗只损失并发）。 */
    readonly conservative?: boolean;
}
export interface DecompositionPlan {
    readonly goal: string;
    readonly topology: Topology;
    readonly branch: CardBranch;
    readonly planId: string;
    readonly units: readonly CardUnit[];
    readonly issues: readonly SchemaIssue[];
}
/** 分支 2 信号：Lead 在 block.rationale 写明「微步骤=」或「不可拆」（§3.3 rationale 字段的约定用法）。 */
export declare function isMicroStepBlock(block: DecompositionBlock): boolean;
/**
 * 五分支判定入口。analysis.forcedConservativeSerial=true 时一律走分支 5（按 3 拆 root 卡），
 * 并记一条 GRANULARITY_CONSERVATIVE issue（仅记录，不阻断——兜底本身就是可继续的出口）。
 */
export declare function buildCardPlan(decomposition: Decomposition, analysis: TopologyAnalysis, planId: string): DecompositionPlan;
