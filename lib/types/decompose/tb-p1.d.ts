export declare const TB_P1_STEPS: readonly ["Step A 列块：把用户需求拆成候选工作块 blocks[]，每块给 id/title/deliverables/acceptance/inputs/touches/dependsOn。", "Step B 标依赖：逐块回答「本块的 inputs 是否来自其它块的 deliverables 或 touches」；是→把对方 id 写进 dependsOn；dependsOn 非空的块禁止标 parallelGroup。", "Step C 定拓扑：整图无任何依赖且存在≥2成员的并行组→parallel；无任何依赖且无并行组→serial；部分块有依赖且仍有并行组→mixed；全链首尾相接→serial。", "Step D 保守兜底：任一依赖关系无法从需求判定时，整图按串行处理、topology 声明 serial，并在 rationale 注明「依赖无法判定，保守串行」。"];
export declare const TB_P1_SELFCHECK_TABLE: string;
/** 组装 TB-P1 固定步骤 + 自检表文本（Lead 分解 prompt 内嵌段）。 */
export declare function buildTbP1Section(): string;
