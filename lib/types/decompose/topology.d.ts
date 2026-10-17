import type { Decomposition, DecompositionBlock, SchemaIssue, Topology } from './schema.js';
export interface TopologyAnalysis {
    /** 代码侧从 dependsOn/parallelGroup 推导出的拓扑（与 Lead 声明比对）。 */
    readonly derived: Topology;
    readonly serialChain: readonly string[];
    readonly parallelGroups: readonly {
        readonly group: string;
        readonly memberIds: readonly string[];
    }[];
    readonly issues: readonly SchemaIssue[];
    /** true = 依赖无法判定（成环/悬空引用），按 TB-P1 保守口径强制串行。 */
    readonly forcedConservativeSerial: boolean;
}
export declare function analyzeTopology(blocks: readonly DecompositionBlock[]): TopologyAnalysis;
/** 校验 Lead 声明的 topology 与代码推导一致；不一致记 issue（prompt 与代码双侧口径）。 */
export declare function checkTopologyAgreement(declared: Topology, analysis: TopologyAnalysis): SchemaIssue[];
/** S1 完整校验 = Schema 形状 + 拓扑分析 + 声明一致性；ok=false 不得进入 S2（§3.3 后果）。
 * CONSERVATIVE_SERIAL 是「可继续的保守出口」（§3.3：依赖无法判定按串行处理并在 rationale 注明），
 * 作 warning 返回不阻断；仅 TOPOLOGY_MISMATCH（声明与图不符）与 Schema 类 errors 退回 Lead 修正。 */
export declare function validateStageOne(value: unknown): {
    ok: boolean;
    decomposition?: Decomposition;
    analysis?: TopologyAnalysis;
    issues: readonly SchemaIssue[];
    warnings: readonly SchemaIssue[];
};
/** FT05 重试口径：Lead 输出最多 2 次修正重试（含首次共 3 次尝试），仍失败按 §6 降级。 */
export declare const DECOMPOSITION_MAX_ATTEMPTS: number;
