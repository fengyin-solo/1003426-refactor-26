// 极简 TS runner：用 typescript（纯 JS）转译后直接跑，不依赖 esbuild 原生二进制。
// 用法：node scripts/ts-runner.js scripts/verify-equipment.ts
const ts = require('typescript')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const cache = new Map()

function loadTs(file) {
  const resolved = path.resolve(file)
  if (cache.has(resolved)) return cache.get(resolved)
  const src = fs.readFileSync(resolved, 'utf-8')
  const js = ts.transpileModule(src, {
    compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true },
  }).outputText
  const mod = { exports: {} }
  cache.set(resolved, mod.exports)
  const localRequire = (spec) => {
    if (spec.startsWith('@/')) return loadTs(path.join(ROOT, 'src', spec.slice(2)) + '.ts')
    if (spec.startsWith('.')) {
      let p = path.join(path.dirname(resolved), spec)
      if (!p.endsWith('.ts')) p += '.ts'
      return loadTs(p)
    }
    return require(spec)
  }
  new Function('require', 'module', 'exports', js)(localRequire, mod, mod.exports)
  return mod.exports
}

loadTs(path.resolve(ROOT, process.argv[2]))
