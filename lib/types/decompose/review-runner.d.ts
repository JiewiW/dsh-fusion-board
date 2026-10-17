import { PromptReviewChain, type AdjudicationRow, type DegradationMark, type ReviewReport } from './review-gate.js';
/** doc-review v0.2.1 reviewPrompt 入参（仅列本客户端使用字段，完整契约见 service.js:115）。 */
export interface ReviewPromptParams {
    readonly targetContent: string;
    readonly docType: 'task-prompt';
    readonly parentAgent: unknown;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly chain?: {
        readonly chainId: string;
        readonly round: number;
        readonly prevAdjudication?: readonly AdjudicationRow[];
    };
    readonly prevReport?: ReviewReport | null;
    readonly references?: readonly string[];
    readonly workspaceRoot?: string;
}
/** doc-review v0.2.1 判别信封（service.js:208-255，kind 闭合八态）。 */
export type ReviewPromptEnvelope = {
    readonly kind: 'report';
    readonly report: ReviewReport;
    readonly archivePath: string | null;
    readonly inputChars: number;
    readonly attempts: number;
} | {
    readonly kind: 'freeform';
    readonly freeformText: string;
    readonly inputChars: number;
    readonly attempts: number;
} | {
    readonly kind: 'timeout';
    readonly inputChars?: number;
    readonly attempts?: number;
} | {
    readonly kind: 'aborted';
    readonly inputChars?: number;
    readonly attempts?: number;
} | {
    readonly kind: 'start-error';
    readonly error: Error | string;
    readonly inputChars?: number;
    readonly attempts?: number;
} | {
    readonly kind: 'busy';
    readonly docType?: string;
} | {
    readonly kind: 'no-agent';
    readonly inputChars?: number;
} | {
    readonly kind: 'short-circuit';
    readonly value?: unknown;
};
/** docReview ctx service 的最小结构契约（只取 reviewPrompt）。 */
export interface DocReviewService {
    reviewPrompt(params: ReviewPromptParams): Promise<ReviewPromptEnvelope>;
}
/** §6 D2：service 缺失（插件未装/未激活）。 */
export declare class ReviewServiceMissingError extends Error {
    constructor();
}
/** 沿用 doc-review reviewer.js:29 DEFAULT_TIMEOUT_MS（600s 总超时口径）。 */
export declare const REVIEW_TIMEOUT_MS = 600000;
export interface InitialPromptInput {
    readonly unitIndex: number;
    readonly title: string;
    readonly prompt: string;
    readonly chainId?: string;
}
export interface RunInitialReviewsOptions {
    /** cordis reflect 取到的 docReview 实现；null/undefined 由调用方先拦截（D2）。 */
    readonly service: DocReviewService;
    /** 工具闭包持有的 parent agent 句柄（#tools(scope, agent, role) 的 agent）。 */
    readonly parentAgent: unknown;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly workspaceRoot?: string;
}
export type InitialReviewOutcome = {
    readonly kind: 'report';
    readonly chain: PromptReviewChain;
} | {
    readonly kind: 'degraded';
    readonly chain: PromptReviewChain;
    readonly mark: DegradationMark;
};
/**
 * FT10：N 份卡片 prompt 初审。
 * 逻辑上并发发起，物理上按 parent session 串行过 service（防 busy 立即返回）；
 * 任一 prompt 失败只标记该链 degraded，不影响其余 prompt 审查（但批次门最终 fail-closed）。
 */
export declare function runInitialReviews(inputs: readonly InitialPromptInput[], options: RunInitialReviewsOptions): Promise<readonly InitialReviewOutcome[]>;
export interface RereviewOptions {
    readonly service: DocReviewService;
    readonly parentAgent: unknown;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly workspaceRoot?: string;
}
/**
 * FT11：按链顺序发起复审。复审载荷仅含上轮残留 high 项（prevReport.issues 已由
 * PromptReviewChain.submitAdjudication 裁剪为 high 子集），机检点=scopedIssueIds。
 */
export declare function runRereview(chain: PromptReviewChain, next: {
    readonly nextRound: number;
    readonly targetContent: string;
    readonly scopedIssueIds: readonly string[];
    readonly prevReport: ReviewReport;
}, options: RereviewOptions): Promise<InitialReviewOutcome>;
/** 为整条链的每份 prompt 生成 D2「service 缺失」降级标记（未发起任何审查时使用）。 */
export declare function missingServiceMarks(inputs: readonly InitialPromptInput[]): readonly DegradationMark[];
