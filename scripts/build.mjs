// Self-contained build for the dsh-fusion-board fork.
//
// Upstream built via the rc.2 monorepo-only adapter
// tools/dshx/src/client-build.js (externalClientBundle), which is not
// published to npm and absent from the locally available checkouts. This
// script reproduces that adapter's two tsdown configs (host ESM + browser CJS
// wrapped in window.__ModuleLoader__.load) using the tsdown resolved from a
// host checkout (DSHX_HARNESS, optional) or the vendored fallback below.
//
// Steps:
//   1. tsc -p tsconfig.build.json  -> lib/types/*.d.ts (declarations only)
//   2. tsdown host bundle (esm/node, @deepseek-ai + node: external)
//   3. tsdown client bundle (cjs/browser + ModuleLoader shell)

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isBuiltin } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Locate tsdown: $TSDOWN_PATH wins, then a host checkout's node_modules, then
// the known local 0.2.1-alpha checkout (read-only tool source).
const candidateRoots = [
  process.env.TSDOWN_PATH && resolve(process.env.TSDOWN_PATH, '..'),
  process.env.DSHX_HARNESS,
  'D:/dsh/third-party/deepseek-harness',
].filter(Boolean)

let bundlerPath
for (const candidate of candidateRoots) {
  const requireFromCandidate = createRequire(resolve(candidate, 'package.json'))
  try {
    bundlerPath = requireFromCandidate.resolve('tsdown')
    break
  } catch {
    // try next candidate
  }
}
if (!bundlerPath) throw new Error('Cannot resolve tsdown; set TSDOWN_PATH or DSHX_HARNESS')
const { build } = await import(pathToFileURL(bundlerPath).href)

const PLUGIN_ID = 'dsh-fusion-board'

// 1. Type declarations (host + client share one src tree).
execFileSync(
  process.execPath,
  [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  { cwd: root, stdio: 'inherit' },
)

mkdirSync(resolve(root, 'lib'), { recursive: true })

// Remove stale upstream-named artifacts so the renamed outputs are the only
// host bundle left in lib/ (client.js is overwritten by the client build).
for (const stale of [
  'lib/dsh-model-fusion.js',
  'lib/dsh-model-fusion.js.map',
  'lib/types/dsh-model-fusion.d.ts',
]) {
  const stalePath = resolve(root, stale)
  if (existsSync(stalePath)) rmSync(stalePath, { force: true })
}

// 2. Host bundle: ESM, node platform; all @deepseek-ai packages and node
// builtins stay external (resolved by the running dsh host), everything else
// is inlined. Mirrors the rc.2 host/node preset.
await build({
  config: false,
  cwd: root,
  entry: { [PLUGIN_ID]: 'src/dsh-fusion-board.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  sourcemap: false,
  clean: false,
  external: (id) => id.startsWith('@deepseek-ai/') || id.startsWith('node:') || isBuiltin(id),
  outputOptions: {
    entryFileNames: 'dsh-fusion-board.js',
    chunkFileNames: 'dsh-fusion-board.[name].js',
  },
})

// 3. Client bundle: CJS for the browser, wrapped in the ModuleLoader factory
// shell. Baseline externals are exactly the three bare requires the upstream
// artifact carries (React + ui-primitives); all other code is inlined.
const loaderBanner =
  `window.__ModuleLoader__.load({\n` +
  `\tid: ${JSON.stringify(PLUGIN_ID)},\n` +
  `\tfactory: (require) => {`
const loaderIntro = `\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;`
const loaderFooter = `\t\treturn module.exports;\n\t}\n});`

await build({
  config: false,
  cwd: root,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  external: (id) =>
    id === 'react' ||
    id.startsWith('react/') ||
    id === '@deepseek-ai/dsh-client-ui-primitives',
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',
    banner: loaderBanner,
    intro: loaderIntro,
    footer: loaderFooter,
  },
})
