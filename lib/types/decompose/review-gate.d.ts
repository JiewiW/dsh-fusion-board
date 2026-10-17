/** 审查报告四维度枚举（doc-review schema.js 闭合集）。 */
export type ReviewDimension = 'fact' | 'completeness' | 'necessity' | 'format';
/** 审查问题严重级（doc-review schema.js 闭合集）。 */
export type ReviewSeverity = 'high' | 'medium' | 'low';
/** doc-review v0.2.1 报告 issue 结构（schema.js:54-82）。 */
export interface ReviewIssue {
    readonly id: string;
    readonly dimension: ReviewDimension;
    readonly severity: ReviewSeverity;
    readonly location: string;
    readonly claim: string;
    readonly evidence: string;
    readonly suggestion: string;
}
/** doc-review v0.2.1 报告结构（service 会覆写 round/chainId/newIssueCount）。 */
export interface ReviewReport {
    readonly summary: string;
    readonly issues: readonly ReviewIssue[];
    readonly newIssueCount: number;
    readonly round: number;
    readonly chainId: string;
}
/** Lead 对单条 issue 的裁决（§3.3 S3：accept/partial/reject 各带理由）。 */
export type AdjudicationVerdict = 'accept' | 'partial' | 'reject';
export interface AdjudicationRow {
    readonly issueId: string;
    readonly verdict: AdjudicationVerdict;
    /** 裁决理由：accept=修订思路、partial=已修部分与遗留、reject=驳回依据。必填非空。 */
    readonly reason: string;
}
/** §6 四类降级（FT13）：refusal=审查员拒审/服务侧错误(D1)；missing-service/timeout/busy 为 D2。 */
export type DegradationKind = 'refusal' | 'missing-service' | 'timeout' | 'busy';
export interface DegradationMark {
    readonly kind: DegradationKind;
    /** 受影响 prompt 在分解链中的序号（CardTriplet.unitIndex）。 */
    readonly unitIndex: number;
    readonly title: string;
    readonly detail: string;
}
/** token 保守换算：字符数 / 1.2（cost.js CHARS_PER_TOKEN_CONSERVATIVE）。 */
export declare const CHARS_PER_TOKEN_CONSERVATIVE = 1.2;
/** 单轮预期输出 token（cost.js EXPECTED_OUTPUT_TOKENS）。 */
export declare const EXPECTED_OUTPUT_TOKENS = 1600;
/** 单轮重试上限（cost.js RETRY_LIMIT，最坏=单轮×(1+2)）。 */
export declare const REVIEW_RETRY_LIMIT = 2;
/** 链级确认阈值 token（cost.js CONFIRM_TOKEN_THRESHOLD）。 */
export declare const CONFIRM_TOKEN_THRESHOLD = 20000;
/** 整条分解链审查轮次硬上限（Q6 冻结：初审+复审合计 3 轮）。 */
export declare const MAX_REVIEW_ROUNDS = 3;
/**
 * 审查输入包固定开销字符数（实测 v0.2.1：SKILL 规则+四段框架，不含目标文本）。
 * inputChars = prompt.length + 6010。
 */
export declare const INPUT_PACKAGE_OVERHEAD_CHARS = 6010;
export interface RoundTokenEstimate {
    /** 单轮估算 token。 */
    readonly singleRoundTokens: number;
    /** 最坏口径 token = 单轮 ×(1+重试2次)。 */
    readonly worstCaseTokens: number;
}
/** 单份 prompt 单轮审查 token 预估（口径同 cost.js estimateRound）。 */
export declare function estimatePromptRound(promptChars: number): RoundTokenEstimate;
export interface ChainBudgetEstimate {
    /** 卡片 prompt 份数。 */
    readonly promptCount: number;
    /** 每份单轮最坏 token（与 promptCount 等长）。 */
    readonly perPromptWorstTokens: readonly number[];
    /** 整条链最坏轮次（Q6：3）。 */
    readonly maxRounds: number;
    /** 整条链最坏总 token = Σ每份单轮最坏 × 最坏轮次。 */
    readonly worstCaseTotalTokens: number;
    /** 是否超过链级确认阈值。 */
    readonly confirmationRequired: boolean;
}
/** 整条分解链审查预算汇总（FT12，最坏口径：重试×3、轮次×3）。 */
export declare function estimateChainBudget(promptCharsList: readonly number[], maxRounds?: number): ChainBudgetEstimate;
/**
 * 链级一次预算确认文本（FT12）：含 N 份数、最坏 token、最坏轮次；
 * Lead 必须原样转给用户，未获用户确认不得发起审查。
 */
export declare function formatBudgetConfirmation(budget: ChainBudgetEstimate): string;
/**
 * 裁决表结构化校验（FT11）：
 * ①每条 issue 恰好裁决一次；②verdict 闭合枚举；③reason 非空。
 * 返回错误描述列表（空数组=通过）。
 */
export declare function validateAdjudication(issues: readonly ReviewIssue[], rows: readonly AdjudicationRow[]): readonly string[];
export declare function isHigh(issue: ReviewIssue): boolean;
export declare function highIssueIds(report: ReviewReport): readonly string[];
/** 用户显式 accept-reject 留痕（§3.3 放行门例外）。 */
export interface DismissedHigh {
    readonly issueId: string;
    /** 用户原话引用或可核验的留痕说明；空字符串拒绝登记。 */
    readonly reason: string;
}
export interface ChainRoundRecord {
    /** 审查轮次（1=初审，2/3=复审）。 */
    readonly round: number;
    /** 本轮送审 prompt 全文。 */
    readonly promptText: string;
    /** 本轮结构化报告。 */
    readonly report: ReviewReport;
    /** 本轮复审载荷实际包含的 issue id（初审=全部；复审=上轮 high 子集），供机检。 */
    readonly scopedIssueIds: readonly string[];
    /** Lead 对本轮报告的裁决表（初审后必有；末轮之后可为空）。 */
    adjudication: readonly AdjudicationRow[];
}
export type ChainGateState = 'awaiting-initial-review' | 'awaiting-adjudication' | 'awaiting-rereview' | 'released' | 'blocked-high-remain' | 'degraded';
/**
 * 单份卡片 prompt 的审查链状态机（FT11）。
 * 流转：初审报告 → Lead 裁决+修订 → 仅 high 复审 →（可再一轮）→ 放行 / D4 阻断。
 */
export declare class PromptReviewChain {
    readonly chainId: string;
    readonly unitIndex: number;
    readonly title: string;
    readonly rounds: ChainRoundRecord[];
    /** 用户显式驳回的 high issue（issueId → 留痕理由）。 */
    readonly dismissedHigh: Map<string, string>;
    /**
     * Lead 最近一次裁决时提交的修订稿全文（FT11）。当修订后已无 high（无需复审）
     * 时该稿即 S4 建卡定稿；有复审时以最后一轮送审稿（rounds[-1].promptText）为准。
     */
    finalPromptText: string | undefined;
    degradation: DegradationMark | undefined;
    constructor(unitIndex: number, title: string, chainId?: string);
    get state(): ChainGateState;
    /** 登记一轮审查报告（初审或复审）。 */
    recordRound(promptText: string, report: ReviewReport, scopedIssueIds: readonly string[]): void;
    /** 最新一轮仍未清零、且未经用户驳回的 high issue。 */
    remainingHighIds(): readonly string[];
    /**
     * 登记 Lead 裁决表并产生下一轮复审请求（FT11）。
     * 复审仅覆盖上轮 high 中 verdict=accept/partial 的 issue（reject 的 high 须走用户驳回）。
     */
    submitAdjudication(rows: readonly AdjudicationRow[], revisedPrompt: string): {
        readonly nextRound: number;
        readonly targetContent: string;
        readonly scopedIssueIds: readonly string[];
        readonly prevReport: ReviewReport;
    };
    /** 序列化为 store 文档纯数据。 */
    serialize(): {
        readonly chainId: string;
        readonly unitIndex: number;
        readonly title: string;
        readonly rounds: readonly ChainRoundRecord[];
        readonly dismissedHigh: Readonly<Record<string, string>>;
        readonly finalPromptText: string | undefined;
        readonly degradation: DegradationMark | undefined;
    };
    /** 登记用户对 high issue 的显式 accept-reject 留痕（放行门例外通道）。 */
    dismissHigh(dismissed: readonly DismissedHigh[]): void;
}
export interface BatchGateResult {
    /** 全部门禁通过（每份链 released）才为真；为假时绝不允许进入 S4。 */
    readonly released: boolean;
    readonly releasedCount: number;
    readonly blocked: readonly {
        unitIndex: number;
        title: string;
        highIssueIds: readonly string[];
        reason: string;
    }[];
    readonly degraded: readonly DegradationMark[];
}
/** 汇总 N 份链的放行判定（FT11 放行门 + FT13 降级汇总）。 */
export declare function evaluateBatchGate(chains: readonly PromptReviewChain[]): BatchGateResult;
/** 链状态的可持久化纯数据形态（coordinator 存 store 文档用）。 */
export type SerializedReviewChain = ReturnType<PromptReviewChain['serialize']>;
/** 从 store 文档恢复链状态机（乐观锁文档读出后重建）。 */
export declare function restoreReviewChain(data: SerializedReviewChain): PromptReviewChain;
/** §6 降级用户提示文本（FT13：明确、不静默放行）。 */
export declare function formatDegradationNotice(marks: readonly DegradationMark[]): string;
