import { DEFAULT_CONFIG, type Config } from './types.js'
import { deepMerge } from './util.js'

/**
 * 外部来源配置的键名归一。
 *
 * 设计文档/方案里写的是 `sessionScanDays` / `maxFileBytes`，早期实现用的是
 * `scanDays` / `tailBytes`。两者都接受，避免已经写好的配置失效。
 */
function normalizeSourceConfig(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw
  const out: any = { ...raw }
  if (out.sessionScanDays !== undefined && out.scanDays === undefined) {
    out.scanDays = out.sessionScanDays
  }
  if (out.maxFileBytes !== undefined && out.tailBytes === undefined) {
    out.tailBytes = out.maxFileBytes
  }
  if (out.maxSessions === undefined && out.sessionLimit !== undefined) {
    out.maxSessions = out.sessionLimit
  }
  delete out.sessionScanDays
  delete out.maxFileBytes
  delete out.sessionLimit
  return out
}

export function resolveConfig(input: any): Config {
  const merged = deepMerge(DEFAULT_CONFIG, input ?? {})
  if (input?.sources && typeof input.sources === 'object') {
    merged.sources = {
      ...merged.sources,
      claude: { ...merged.sources.claude, ...normalizeSourceConfig(input.sources.claude) },
      codex: { ...merged.sources.codex, ...normalizeSourceConfig(input.sources.codex) },
    }
  }
  return merged
}
