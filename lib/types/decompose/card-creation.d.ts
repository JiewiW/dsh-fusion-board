import type { CardTriplet } from './triplet.js';
/** 看板工具名（仅 Lead 会话执行；插件不调用）。执行类工具名拆分书写，见模块头 FT16 说明。 */
export declare const BOARD_LIST_TOOL = "task_board_list";
export declare const BOARD_GET_TOOL = "task_board_get";
export declare const BOARD_CREATE_TOOL = "task_board_create";
export declare const BOARD_UPDATE_TOOL = "task_board_update";
/** 建卡顺序中的卡片角色（与 CardUnit.role 同口径，parent 必须先于 child 创建）。 */
export type CreateRole = 'root' | 'parent' | 'child';
export interface CardCreateSpec {
    /** 建卡顺序下标（0 基，全局有序；parent 先于其 child）。 */
    readonly index: number;
    readonly role: CreateRole;
    readonly title: string;
    readonly description: string;
    readonly prompt: string;
    /** 看板 tags 入参形态：[{name}]。 */
    readonly tags: readonly {
        readonly name: string;
    }[];
    /** child 指向其 parent 的建卡顺序下标；root/parent 为 undefined（创建时不传 parentId）。 */
    readonly parentCreateIndex?: number;
    /** 串行链序号（1 基）；非链卡为 undefined。 */
    readonly serialIndex?: number;
    readonly serialTotal?: number;
    readonly chainId?: string;
    /** 拓扑关系人类可读标记（交付清单用）。 */
    readonly relation: string;
}
export interface CreatePlan {
    readonly planId: string;
    /** S2 分支号（1/2/3/4/5）。 */
    readonly branch: number;
    readonly topology: 'serial' | 'parallel' | 'mixed';
    readonly specs: readonly CardCreateSpec[];
}
/**
 * FT14：S2 三元组 → 有序建卡规格。
 * 排序规则：保持 S2 unitIndex 顺序（parallel 时 S2 已保证 parent 在 child 之前；
 * serial 时即链序；mixed 时先并行组后串行 root）。child 的 parentCreateIndex
 * 指向同组 parent 的规格下标，创建时用 parent 已落库的看板 id 作为 parentId。
 */
export declare function buildCreateSpecs(planId: string, branch: number, topology: CreatePlan['topology'], triplets: readonly CardTriplet[]): CreatePlan;
/** Lead 实际建卡后回喂的落库记录。 */
export interface AdoptedCard {
    readonly index: number;
    /** 看板返回的卡 id（uuid）。 */
    readonly id: string;
    readonly title: string;
}
export interface BackfillSpec {
    readonly index: number;
    readonly cardId: string;
    /** 串行链 k>1 才需要回填；description 与 prompt 两处占位符都必须替换。 */
    readonly fields: readonly ('description' | 'prompt')[];
    readonly find: string;
    readonly replaceWith: string;
    readonly predecessorCardId: string;
}
/**
 * FT15：全部建完并拿到 id 后，为串行链 k>1 生成回填规格。
 * 建卡顺序=先全建后回填：description 首行与 prompt「上下文交接」段各有一处
 * {{PREV_CARD_ID}} 占位，两处统一替换为前置卡的真实看板 id。
 */
export declare function buildBackfills(plan: CreatePlan, adopted: readonly AdoptedCard[]): readonly BackfillSpec[];
/** 对单个文本字段执行占位替换（回填实际写入内容由此产生，保证替换恰好 1 处）。 */
export declare function applyBackfillText(original: string, backfill: BackfillSpec): {
    text: string;
    replaced: number;
};
/** 判定建卡报错是否为已知的调用会话累积态损坏（同会话多次成功后必现、不落库）。 */
export declare function isCreateSessionStateError(errorText: string): boolean;
/** 回读列表中单卡的最小形状（Lead 从看板 list/get 回喂）。 */
export interface BoardListCard {
    readonly id: string;
    readonly title: string;
    readonly status?: string;
}
export interface CreateRecoveryDecision {
    /** adopt=该卡其实已落库，采用回读 id 禁止重建；retry=未落库，先 unstick 再重试。 */
    readonly action: 'adopt' | 'retry';
    readonly cardId?: string;
    /** 本次建卡已用重试次数（0=首次；D3 上限 2 次重试）。 */
    readonly retryAttempt: number;
    readonly stop: boolean;
    readonly reason: string;
}
/**
 * FT15/D3：建卡报 JSON-serializable 错后的处置判定。
 * 先以标题在回读列表中核对是否已落库（防重复卡）；已落库→adopt；
 * 未落库→对任意已建卡做一次 update（解会话累积态）后重试，同法最多 2 次。
 */
export declare function planCreateRecovery(spec: CardCreateSpec, boardList: readonly BoardListCard[], retryAttempt: number): CreateRecoveryDecision;
/** task_board_get 回读卡的最小形状。 */
export interface BoardGetCard {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly parentId?: string;
    readonly depth?: number;
    readonly tags?: readonly {
        readonly name: string;
    }[];
    readonly description: string;
    readonly prompt?: string;
    readonly executionCount?: number;
}
export interface BoardVerificationIssue {
    readonly code: string;
    readonly index: number;
    readonly message: string;
}
export interface BoardVerificationResult {
    readonly ok: boolean;
    readonly issues: readonly BoardVerificationIssue[];
    /** 有序落库记录（index→id），供交付模板使用。 */
    readonly adopted: readonly AdoptedCard[];
}
/**
 * FT14/FT15/FT16 回读机检：数量/标题序号/tags/description 首行/prompt 交接段/
 * 列=todo/零执行记录/父子深度。cards 为 Lead 用看板 get 逐张回读的结果。
 */
export declare function verifyCreatedBoard(plan: CreatePlan, cards: readonly BoardGetCard[]): BoardVerificationResult;
export interface DeliveryEntry {
    readonly seq: number;
    readonly title: string;
    readonly id: string;
    readonly relation: string;
}
export interface DeliveryReviewSummary {
    readonly releasedCount: number;
    readonly totalPrompts: number;
    readonly highOpen: number;
}
export interface DeliveryInput {
    readonly goal: string;
    readonly planId: string;
    readonly topology: string;
    readonly entries: readonly DeliveryEntry[];
    readonly review: DeliveryReviewSummary;
}
/**
 * FT16 最终回复模板：①有序执行清单（seq/标题/id/拓扑关系）②审查验收摘要（high=0）
 * ③建议人工按序执行的动作。插件不主动执行任何卡片（RUN_TOOL_HINT 仅供用户动作提示）。
 */
export declare function formatDeliveryDocument(input: DeliveryInput): string;
