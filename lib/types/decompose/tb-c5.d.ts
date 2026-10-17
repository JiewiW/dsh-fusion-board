import type { SchemaIssue } from './schema.js';
/** 来源版本标注：机检口径所属的 doc-review 发布版本。 */
export declare const TB_C5_SOURCE_VERSION = "0.2.1";
export declare const TB_C5_SOURCE_PATH = "D:\\dsh\\dsh-doc-review\\skills\\doc-review-task-prompt\\SKILL.md";
export interface TbC5Item {
    readonly anchor: string;
    readonly title: string;
    /** 机检信号：在 prompt 全文中能命中该正则即视为"有对应段落"（缺项判前已含同义段落匹配面）。 */
    readonly pattern: RegExp;
    readonly hint: string;
}
export declare const TB_C5_ITEMS: readonly TbC5Item[];
export interface TbC5CheckResult {
    readonly ok: boolean;
    readonly issues: readonly SchemaIssue[];
}
/** 逐条机检 prompt 的 TB-C5 覆盖；一条缺项一个 issue（同源 SKILL 的机检纪律）。 */
export declare function checkPromptC5(prompt: string): TbC5CheckResult;
/** 生成注入 prompt 文末的「引用与来源」段（保证 C5-11 机检信号恒在且口径同源）。 */
export declare function buildSourceSection(): string;
/** 生成注入 prompt 的「规则口径（R1–R55 关键条目）」段。 */
export declare function buildRuleSection(): string;
