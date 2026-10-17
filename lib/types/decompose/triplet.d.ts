import type { Decomposition } from './schema.js';
import type { CardUnit, DecompositionPlan } from './granularity.js';
import type { SchemaIssue } from './schema.js';
export interface CardTriplet {
    readonly title: string;
    readonly description: string;
    readonly prompt: string;
    /** 建卡透传字段：tags（chain/seq/parallel-group）、parentId 关系（子卡指向父卡标题）。 */
    readonly tags: readonly string[];
    readonly unitIndex: number;
    readonly role: CardUnit['role'];
    readonly blockIds: readonly string[];
    readonly serialIndex?: number;
    readonly serialTotal?: number;
    readonly chainId?: string;
}
export interface TripletOptions {
    readonly workspaceRoot: string;
    /** 供交接段列出的跨卡文件路径（block.inputs ∪ 前置 deliverables）。 */
    readonly handoffPaths?: readonly string[];
    /** 追加禁令（如用户级红线），逐条进入「禁令清单」。 */
    readonly extraProhibitions?: readonly string[];
}
/** 为一个卡片单元生成三元组。 */
export declare function buildTriplet(plan: DecompositionPlan, decomposition: Decomposition, unitIndex: number, options: TripletOptions): CardTriplet;
export interface TripletSetResult {
    readonly ok: boolean;
    readonly triplets: readonly CardTriplet[];
    readonly issues: readonly SchemaIssue[];
}
/** S2 全量生成 + TB-C5 机检（缺项即 fail，不得进入 S3）。 */
export declare function buildTriplets(plan: DecompositionPlan, decomposition: Decomposition, options: TripletOptions): TripletSetResult;
