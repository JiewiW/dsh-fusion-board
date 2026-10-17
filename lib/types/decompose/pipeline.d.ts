import type { SchemaIssue } from './schema.js';
import { validateDecomposition, type Decomposition } from './schema.js';
import { type DecompositionPlan } from './granularity.js';
import { type CardTriplet, type TripletOptions } from './triplet.js';
export type LlmCall = (prompt: string) => Promise<string>;
export interface StageOneResult {
    readonly ok: boolean;
    readonly decomposition?: Decomposition;
    readonly attempts: number;
    readonly issues: readonly SchemaIssue[];
    readonly degraded: boolean;
    readonly report: string;
}
/**
 * S1：Lead 文本 → decomposition。Schema/拓扑/一致性三类校验合并为一次判定；
 * 失败按既有重试口径最多 2 次修正（含首次共 3 次），仍失败按 §6 降级：回报用户、不建卡。
 * 重试时把 issues 清单回灌给 Lead（feedback 追加到 prompt 尾部）。
 */
export declare function runStageOne(callLlm: LlmCall, goalText: string, maxAttempts?: number): Promise<StageOneResult>;
export interface StageTwoResult {
    readonly ok: boolean;
    readonly planId: string;
    readonly branch: 1 | 2 | 3 | 4 | 5;
    readonly plan?: DecompositionPlan;
    readonly triplets: readonly CardTriplet[];
    readonly issues: readonly SchemaIssue[];
    readonly report: string;
}
/**
 * S2：短路判定优先（FT07）；否则拓扑→卡片粒度五分支（FT09）→三元组生成 + TB-C5 机检（FT08）。
 * 短路时不进入 S2、不建卡；三元组任一 prompt 缺 TB-C5 项时 ok=false（不得进入 S3）。
 */
export declare function runStageTwo(decomposition: Decomposition, options: TripletOptions, planId?: string): StageTwoResult;
export interface PipelineResult {
    readonly ok: boolean;
    readonly shortcircuited: boolean;
    readonly degraded: boolean;
    readonly attempts: number;
    readonly stageOne: StageOneResult;
    readonly stageTwo?: StageTwoResult;
    readonly report: string;
}
/** S1→S2 一次跑通（冒烟与测试用）。 */
export declare function runPipeline(callLlm: LlmCall, goalText: string, options: TripletOptions, maxAttempts?: number, planId?: string): Promise<PipelineResult>;
export interface S1S2OutcomeBase {
    readonly issues: readonly SchemaIssue[];
    readonly report: string;
}
export interface S1S2IssuesOutcome extends S1S2OutcomeBase {
    readonly kind: 'issues';
}
export interface S1S2DegradedOutcome extends S1S2OutcomeBase {
    readonly kind: 'degraded';
}
export interface S1S2ShortcircuitOutcome extends S1S2OutcomeBase {
    readonly kind: 'shortcircuit';
}
export interface S1S2OkOutcome extends S1S2OutcomeBase {
    readonly kind: 'ok';
    readonly planId: string;
    readonly branch: 1 | 2 | 3 | 4 | 5;
    readonly triplets: readonly CardTriplet[];
}
export type S1S2Outcome = S1S2IssuesOutcome | S1S2DegradedOutcome | S1S2ShortcircuitOutcome | S1S2OkOutcome;
/**
 * fusion_decompose 工具的服务端口径（同步、纯函数）：Lead 每次重发算一次尝试，
 * attemptsSoFar 为已累计的失败次数；超 DECOMPOSITION_MAX_ATTEMPTS 走 §6 降级。
 * 短路（FT07）返回 D6 说明文本、不建卡；S2 三元组任一 prompt 缺 TB-C5 项返回 issues。
 */
export declare function runS1S2FromJson(decompositionText: string, options: TripletOptions, attemptsSoFar: number): S1S2Outcome;
export { validateDecomposition };
