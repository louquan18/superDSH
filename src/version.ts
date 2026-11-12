/**
 * 运行期版本标识：回答「这条决策是哪版代码、哪版配置下产生的」。
 *
 * 三条纪律（对齐开发计划 P0）：
 * 1. **只算一次**：模块级缓存，热路径上不再调 git；
 * 2. **有超时**：git 调用 1.5s 超时，防止 .git 异常（网络盘、坏索引）阻塞插件启动；
 * 3. **失败不抛**：拿不到版本就降级成 `pkg@<version>+unknown`，绝不因为版本问题让插件起不来
 *    （对齐 I-15：启动异常不能拖垮整个插件）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stableStringify } from './util.js'

export interface VersionInfo {
  /** `git describe --tags --always --dirty` 的结果，或 `pkg@x.y.z+unknown` 降级串。 */
  codeVersion: string
  /** 有效配置的指纹（sha256 前 12 位）。 */
  configHash: string
  /** 进程启动时间。 */
  startedAt: number
}

const PKG_NAME = '@local/dsh-superagent-butler'

/**
 * 定位插件根目录。
 *
 * 不能简单用 `../`：源码编译到 `lib/` 时父目录就是根，但测试编译到
 * `test-dist/src/` 时父目录是 `test-dist/`。所以向上找带本包名的 package.json，
 * 找不到再退回 `../`。
 */
function findRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
      if (pkg?.name === PKG_NAME) return dir
    } catch {
      // 这一层没有 package.json，继续往上
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(start, '..')
}

const ROOT = findRoot(dirname(fileURLToPath(import.meta.url)))

function pkgVersion(): string {
  try {
    const raw = readFileSync(resolve(ROOT, 'package.json'), 'utf8')
    const version = JSON.parse(raw)?.version
    return typeof version === 'string' && version ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * 读代码版本。
 *
 * 插件通常以 `link:` 方式安装，目录即 git 仓库，所以 `git describe` 可用；
 * 从别处拷贝安装（没有 .git）或 git 不可用时返回降级串。
 */
export function readCodeVersion(): string {
  try {
    const out = execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out) return out
  } catch {
    // git 不存在 / 不是仓库 / 超时：都走降级
  }
  return `pkg@${pkgVersion()}+unknown`
}

/**
 * 有效配置的指纹，取 sha256 前 12 位（够区分，又短到能塞进面板和审计）。
 *
 * 用 `util.stableStringify` 而不是 `JSON.stringify`：配置键的书写顺序不该改变指纹，
 * 否则在 yaml 里换个键顺序就会让所有历史审计看起来来自不同版本。
 */
export function readConfigHash(config: unknown): string {
  return createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 12)
}

let cached: VersionInfo | null = null

/**
 * 启动时调一次，之后所有审计、快照、诊断复用同一份。
 * 这样「同一次运行里产生的所有决策」一定带同一个版本戳。
 */
export function resolveVersion(config: unknown): VersionInfo {
  if (!cached) {
    cached = {
      codeVersion: readCodeVersion(),
      configHash: readConfigHash(config),
      startedAt: Date.now(),
    }
  }
  return cached
}

/** 已算过则返回，否则 null。 */
export function currentVersion(): VersionInfo | null {
  return cached
}

/** 仅测试用：清掉缓存，让下一次 resolveVersion 重新计算。 */
export function resetVersionForTest(): void {
  cached = null
}
