import path from 'node:path'
import type { Plan, Risk } from './types.js'
import { MUTATING_TOOLS, READ_ONLY_TOOLS } from './types.js'
import { hasShellMeta, isInside, summarizeArgs } from './util.js'
import { matchPlanCommand, matchPlanNetwork, matchPlanPath } from './plans.js'

export interface RiskContext {
  projectRoot: string
  cwd?: string
  gated: boolean
  policy: 'plan' | 'whitelist'
  plan?: Plan
  allowReadOnlyBash?: boolean
}

export interface RiskResult {
  risk: Risk
  planId?: string
  planItemId?: string
  deny?: boolean
  reason?: string
  /**
   * 规则判不了的 bash，交给管家模型审查（`bash-review.ts`）：
   * `readonly` 只在命令只读时放行（计划审查、计划还没批准），
   * `danger` 只拦真正危险的命令（其余情况）。sandbox 升级不设这个字段，始终转用户。
   */
  review?: 'readonly' | 'danger'
  /** 命中的危险关键词，交给审查模型重点核对；不再直接转用户。 */
  flags?: string[]
}

const LOCAL_GIT_READ = [
  /^git\s+status(\s|$)/,
  /^git\s+diff(\s|$)/,
  /^git\s+log(\s|$)/,
  /^git\s+show(\s|$)/,
  /^git\s+branch\s+--list(\s|$)/,
]

const LOW_COMMANDS: RegExp[] = [
  /^npm\s+test(\s|$)/,
  /^npm\s+run\s+test(\s|$)/,
  /^pnpm\s+test(\s|$)/,
  /^pnpm\s+run\s+test(\s|$)/,
  /^yarn\s+test(\s|$)/,
  /^npm\s+run\s+build(\s|$)/,
  /^pnpm\s+(run\s+)?build(\s|$)/,
  /^yarn\s+build(\s|$)/,
  /^npm\s+run\s+lint(\s|$)/,
  /^pnpm\s+(run\s+)?lint(\s|$)/,
  /^yarn\s+lint(\s|$)/,
  /^eslint(\s|$)/,
  /^prettier\s+--check(\s|$)/,
  /^tsc\s+--noEmit(\s|$)/,
  /^ruff\s+check(\s|$)/,
  /^mypy(\s|$)/,
  /^pytest(\s|$)/,
  /^python(3)?\s+-m\s+pytest(\s|$)/,
  /^go\s+test(\s|$)/,
  /^cargo\s+test(\s|$)/,
  /^make\s+test(\s|$)/,
]

const READ_ONLY_BASH: RegExp[] = [
  /^git\s+status(\s|$)/,
  /^git\s+diff(\s|$)/,
  /^git\s+log(\s|$)/,
  /^git\s+show(\s|$)/,
  /^pwd(\s|$)/,
  /^ls(\s|$)/,
  /^wc(\s|$)/,
  /^head(\s|$)/,
  /^tail(\s|$)/,
]

const DANGEROUS: Array<[string, RegExp]> = [
  ['rm', /\brm\b/],
  ['rmdir', /\brmdir\b/],
  ['sudo', /\bsudo\b/],
  ['git push', /\bgit\s+push\b/],
  ['git clean', /\bgit\s+clean\b/],
  ['git reset --hard', /\bgit\s+reset\s+--hard\b/],
  ['curl', /\bcurl\b/],
  ['wget', /\bwget\b/],
  ['ssh', /\bssh\b/],
  ['scp', /\bscp\b/],
  ['nc', /\bnc\b/],
  ['npm publish', /\bnpm\s+publish\b/],
  ['docker push', /\bdocker\s+push\b/],
  ['kubectl', /\bkubectl\b/],
  ['terraform', /\bterraform\b/],
  ['deploy', /\bdeploy\b/],
]

function commandOf(args: any): string {
  return String(args?.command ?? '').trim()
}

function isLowCommand(command: string): boolean {
  if (!command || hasShellMeta(command)) return false
  if (LOCAL_GIT_READ.some((pattern) => pattern.test(command))) return true
  return LOW_COMMANDS.some((pattern) => pattern.test(command))
}

function dangerFlags(command: string): string[] {
  return DANGEROUS.filter(([, pattern]) => pattern.test(command)).map(([label]) => label)
}

function isDangerousCommand(command: string): boolean {
  return dangerFlags(command).length > 0
}

function pathOf(args: any): string | undefined {
  const value = args?.file_path ?? args?.path
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function applyPlan(
  result: RiskResult,
  plan: Plan | undefined,
  match: { item: { id: string } } | undefined,
): RiskResult {
  if (!plan || !match) return result
  return {
    ...result,
    risk: 'low',
    planId: plan.id,
    planItemId: match.item.id,
    reason: `命中计划条目 ${match.item.id}`,
  }
}

/**
 * §7.3：带 `sandbox_permissions` 的调用是在申请更宽的沙箱权限（bash、write/edit 都有这个参数），
 * 即使基础操作是低风险/计划内，也按 high 处理；门禁本身的 deny 保持不变。
 */
export function classifyTool(
  toolName: string,
  args: any,
  ctx: RiskContext,
): RiskResult {
  const result = classifyBase(toolName, args, ctx)
  if (args?.sandbox_permissions === undefined || result.deny) return result
  return {
    risk: 'high',
    reason: `申请把沙箱升级到 ${String(args.sandbox_permissions)}${
      args?.justification ? `（worker 的理由：${String(args.justification).slice(0, 120)}）` : ''
    }，会绕开沙箱的文件/网络限制`,
  }
}

function classifyBase(
  toolName: string,
  args: any,
  ctx: RiskContext,
): RiskResult {
  const name = String(toolName || '')
  const baseReason = summarizeArgs(name, args)

  if (READ_ONLY_TOOLS.has(name)) {
    return { risk: 'low', reason: baseReason }
  }

  if (name === 'write' || name === 'edit' || name === 'str_replace_editor') {
    const file = pathOf(args)
    if (!file) return { risk: 'high', reason: '缺少文件路径' }
    const absolute = path.isAbsolute(file) ? file : path.resolve(ctx.cwd ?? ctx.projectRoot, file)
    if (!isInside(ctx.projectRoot, absolute)) {
      return { risk: 'high', reason: `写工作区外：${absolute}` }
    }
    if (ctx.gated) {
      if (!ctx.plan) {
        return {
          risk: 'high',
          deny: true,
          reason: '计划审查模式：先交计划，再改文件',
        }
      }
      const match = matchPlanPath(ctx.plan, ctx.projectRoot, absolute)
      if (!match) {
        return { risk: 'high', reason: `计划外写操作：${absolute}` }
      }
      return applyPlan({ risk: 'low', reason: baseReason }, ctx.plan, match)
    }
    return { risk: 'low', reason: baseReason }
  }

  if (name === 'bash' || name === 'pwsh') {
    const command = commandOf(args)
    if (!command) return { risk: 'high', reason: '空命令' }
    // 关键词只是提示，不直接定罪：`grep deploy`、`rm -rf /tmp/x` 这类交给管家按实际效果判断。
    const flags = dangerFlags(command)
    const dangerous = flags.length > 0
    // 计划审查且计划未批准：只读命令可以过审，其余拒绝（要求先交计划，不打扰用户）。
    if (ctx.gated && !ctx.plan) {
      return {
        risk: 'high',
        deny: true,
        reason: '计划审查模式：先交计划，再执行命令',
        review: 'readonly',
        flags,
      }
    }
    const review = 'danger' as const
    if (dangerous) {
      return { risk: 'high', reason: `危险命令（命中关键词：${flags.join('、')}）`, review, flags }
    }
    if (hasShellMeta(command)) return { risk: 'high', reason: '命令含 shell 元字符', review }
    if (ctx.gated && ctx.plan) {
      const match = matchPlanCommand(ctx.plan, command)
      if (match && !isDangerousCommand(command)) {
        return applyPlan({ risk: 'low', reason: baseReason }, ctx.plan, match)
      }
      if (ctx.allowReadOnlyBash && READ_ONLY_BASH.some((pattern) => pattern.test(command))) {
        return { risk: 'low', reason: baseReason }
      }
      return { risk: 'high', reason: '计划外命令', review }
    }
    if (isLowCommand(command)) return { risk: 'low', reason: baseReason }
    return { risk: 'high', reason: '不在低风险命令白名单', review }
  }

  if (name === 'web_search') {
    if (ctx.gated) {
      if (!ctx.plan) {
        return { risk: 'high', deny: true, reason: '计划审查模式：先交计划，再联网' }
      }
      const match = matchPlanNetwork(ctx.plan)
      if (!match) return { risk: 'high', reason: '计划外联网搜索' }
      return applyPlan({ risk: 'low', reason: baseReason }, ctx.plan, match)
    }
    return { risk: 'low', reason: baseReason }
  }

  if (name === 'web_fetch') {
    if (ctx.gated) {
      if (!ctx.plan) {
        return { risk: 'high', deny: true, reason: '计划审查模式：先交计划，再联网' }
      }
      const match = matchPlanNetwork(ctx.plan)
      if (!match) return { risk: 'high', reason: '计划外网络请求' }
      return applyPlan({ risk: 'low', reason: baseReason }, ctx.plan, match)
    }
    return { risk: 'high', reason: '外部网络请求' }
  }

  if (MUTATING_TOOLS.has(name)) {
    if (ctx.gated && !ctx.plan) {
      return { risk: 'high', deny: true, reason: '计划审查模式：先交计划' }
    }
    return { risk: 'high', reason: `高风险工具：${name}` }
  }

  return { risk: 'unknown', reason: `未知工具：${name}：需要你确认` }
}

export function isMutating(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName)
}

export function isReadOnly(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName)
}
