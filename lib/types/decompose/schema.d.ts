export declare const TOPOLOGY_VALUES: readonly ["serial", "parallel", "mixed"];
export type Topology = (typeof TOPOLOGY_VALUES)[number];
export interface DecompositionBlock {
    readonly id: string;
    readonly title: string;
    readonly deliverables: readonly string[];
    readonly acceptance: readonly string[];
    readonly inputs: readonly string[];
    readonly touches: readonly string[];
    readonly dependsOn: readonly string[];
    readonly parallelGroup?: string;
    readonly rationale?: string;
}
export interface Decomposition {
    readonly goal: string;
    readonly blocks: readonly DecompositionBlock[];
    readonly topology: Topology;
    readonly rationale: string;
}
export interface SchemaIssue {
    readonly code: string;
    readonly path: string;
    readonly message: string;
}
export interface ValidationResult {
    readonly ok: boolean;
    readonly value?: Decomposition;
    readonly issues: readonly SchemaIssue[];
}
/** Schema 形状校验：只做可机检的硬约束，拓扑一致性交给 topology.ts。 */
export declare function validateDecomposition(input: unknown): ValidationResult;
export declare function parseDecompositionJson(text: string): {
    ok: boolean;
    value?: unknown;
    issues: readonly SchemaIssue[];
};
