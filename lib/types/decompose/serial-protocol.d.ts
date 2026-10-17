import type { CardUnit, DecompositionPlan } from './granularity.js';
export declare const PREV_CARD_PLACEHOLDER = "{{PREV_CARD_ID}}";
/** planId = tf-YYYYMMDD-<goal 内容短哈希>；同日不同目标得到不同链，同输入可复现（离线断言依赖）。 */
export declare function makePlanId(goal: string, dateIso?: string): string;
export interface SerialProtocolFields {
    readonly title: string;
    readonly tags: readonly string[];
    readonly descriptionFirstLine: string;
}
/** 串行链卡的三个协议字段（标题/tags/描述首行），非链卡返回 undefined 字段集。 */
export declare function serialProtocol(unit: CardUnit, chainTitleOf: (blockId: string) => string, predecessorTitle?: string): SerialProtocolFields | undefined;
/** 「上下文交接」段：跨卡依赖落成文件路径，执行者先回读前置卡状态再开工（§3.5 建议门）。 */
export declare function buildHandoffSection(plan: DecompositionPlan, unit: CardUnit, predecessor: CardUnit | undefined, handoffPaths: readonly string[]): string;
/** 找某张链卡的前置卡（同链 seq=k-1）。 */
export declare function predecessorOf(plan: DecompositionPlan, unit: CardUnit): CardUnit | undefined;
