/**
 * SuperAgent 管家 Host 入口。
 *
 * 只做装配：创建服务、提供 `superagent` 服务、挂 HTTP 路由和 `/superagent` 命令。
 * 业务逻辑在 service.ts 与 core/*；这里不 import 任何 dsh 运行时包。
 */
import { registerCommand } from './host/command.js'
import { registerRoutes } from './host/routes.js'
import { SuperagentService } from './service.js'

export const name = 'superagent-butler'

/**
 * 硬依赖：缺任何一个，管家都不能工作。
 * `connection` / `commands` / `workspaceRegistry` / `workingDirectory` 通过 `ctx.get()` 可选读取，
 * 这样同一个插件在 headless profile 里也能加载。
 */
export const inject = [
  'agents',
  'sessionController',
  'sessionQuery',
  'storageDomain',
  'systemPrompt',
  'tools',
  'userQuestions',
]

/**
 * 启动失败时的兜底服务。
 *
 * 关键约束：**`provide('superagent')` 必须执行**。管家 preset 的 inject 里有 `superagent`，
 * 一旦这里不 provide，管家会话会失去全部工具（2026-11-09 的 P0：来宾来源的一个坏 id
 * 让 create() 抛错，整个管家就"不会说话了"，而且界面上一句话都不解释）。
 *
 * 这个兜底把失败原因一路带到面板与工具返回里，让用户看得见、也让管家能回答
 * "我为什么用不了"。
 */
function degradedService(error: unknown): any {
  const message = `superagent 启动失败：${String((error as any)?.message ?? error)}`
  const snapshot = () => ({
    degraded: true,
    error: message,
    generatedAt: Date.now(),
    butler: { sessionId: null, title: 'SuperAgent 管家', status: 'unknown' },
    projects: [],
    sessions: [],
    blockers: [],
    blockerNotices: [],
    progressNotices: [],
    resolvedBlockers: [],
    plans: [],
    dispatches: [],
    approvals: [],
    audit: [],
    sources: [],
  })
  const fail = async () => ({ ok: false, error: message, message })
  const target: any = {
    degraded: true,
    degradedReason: message,
    snapshot: async () => snapshot(),
    handleAction: fail,
    subscribe: () => () => {},
    dispose: () => {},
    isButlerAgentSession: () => true,
  }
  return target
}

export async function apply(ctx: any, config: any): Promise<() => void> {
  let service: any
  let degraded = false
  try {
    service = await SuperagentService.create(ctx, config)
  } catch (error) {
    degraded = true
    console.error('[superagent-butler] startup failed; loading degraded service:', error)
    service = degradedService(error)
  }
  const disposeProvide = ctx.provide('superagent', service)
  // 面板路由/命令是增强能力：失败时只告警，不能让硬门禁和状态服务一起失效。
  for (const [label, register] of [
    ['routes', registerRoutes],
    ['command', registerCommand],
  ] as const) {
    try {
      register(ctx, service)
    } catch (error) {
      console.warn(`[superagent-butler] ${label} registration failed:`, error)
    }
  }
  if (degraded) {
    console.warn('[superagent-butler] running degraded: butler tools answer with the startup error')
  }
  return () => {
    try {
      disposeProvide()
    } catch {
      // ignore
    }
    try {
      service.dispose()
    } catch {
      // ignore
    }
  }
}
