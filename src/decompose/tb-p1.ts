// FT06 — TB-P1 路径分析内置为 Lead 分解 prompt 的固定步骤与自检表。
// 代码侧的同一口径在 topology.ts（analyzeTopology / 保守串行兜底），两处规则文本同源。

export const TB_P1_STEPS = [
  'Step A 列块：把用户需求拆成候选工作块 blocks[]，每块给 id/title/deliverables/acceptance/inputs/touches/dependsOn。',
  'Step B 标依赖：逐块回答「本块的 inputs 是否来自其它块的 deliverables 或 touches」；是→把对方 id 写进 dependsOn；dependsOn 非空的块禁止标 parallelGroup。',
  'Step C 定拓扑：整图无任何依赖且存在≥2成员的并行组→parallel；无任何依赖且无并行组→serial；部分块有依赖且仍有并行组→mixed；全链首尾相接→serial。',
  'Step D 保守兜底：任一依赖关系无法从需求判定时，整图按串行处理、topology 声明 serial，并在 rationale 注明「依赖无法判定，保守串行」。',
] as const

export const TB_P1_SELFCHECK_TABLE = [
  '| 自检项 | 判据 | 不满足时 |',
  '| --- | --- | --- |',
  '| P1-1 每块 acceptance 是客观命令+正信号 | 命令可直接运行、正信号可 grep/退出码判定 | 改写为客观口径，禁止"确保正确"式空话 |',
  '| P1-2 dependsOn 非空的块未标 parallelGroup | 逐块核对 | 去掉 parallelGroup 或去掉依赖（TB-P1：凡 dependsOn 非空即禁止标记 parallel） |',
  '| P1-3 topology 与依赖图一致 | 按 Step C 重推一遍 | 修正声明或改为保守 serial |',
  '| P1-4 依赖可判定性 | 每条 dependsOn 都能指出数据/文件来源 | 无法指出→整图保守 serial 并在 rationale 注明 |',
  '| P1-5 环与悬空引用 | 逐边检查引用存在、无自依赖、无回边 | 修正引用；改不动→保守 serial |',
].join('\n')

/** 组装 TB-P1 固定步骤 + 自检表文本（Lead 分解 prompt 内嵌段）。 */
export function buildTbP1Section(): string {
  return [
    '## TB-P1 路径分析（固定步骤，禁止跳过）',
    ...TB_P1_STEPS.map(step => `- ${step}`),
    '',
    '### TB-P1 自检表（产出 decomposition 前逐行核对，全部通过才允许输出）',
    TB_P1_SELFCHECK_TABLE,
  ].join('\n')
}
