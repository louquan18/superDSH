import type { SuperagentService } from '../service.js'

const HELP = [
  '/superagent status — 会话、卡点、队列摘要',
  '/superagent inbox — 未处理的卡点/审批/计划',
  '/superagent mode — 列出项目模式',
  '/superagent mode <projectKey> <plan_review|gate_confirm> — 切换项目模式',
  '/superagent dispatch <sessionId> <任务文本> — 直接派活给指定 session',
  '/superagent butler — 确保管家 session 存在并返回 id',
].join('\n')

function line(text: string): { kind: 'success'; text: string } {
  return { kind: 'success', text }
}

function fail(text: string): { kind: 'error'; text: string } {
  return { kind: 'error', text }
}

/**
 * `/superagent …`：给不想开面板时用的命令行入口。
 * handler 直接拿到 agent 与 rawInput；结果只回到本次命令输出，不写 session 事件。
 */
export function registerCommand(ctx: any, service: SuperagentService): void {
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : ctx.commands
  if (!commands?.register) return
  ctx.effect(
    () =>
      commands.register({
        name: 'superagent',
        description: 'SuperAgent 管家：状态、卡点、项目模式、派发',
        input: { hint: 'status | inbox | mode | dispatch | butler' },
        async handler(invocation: any) {
          const raw = String(invocation?.rawInput ?? '').trim()
          const [head, ...rest] = raw.split(/\s+/)
          const sub = (head ?? '').toLowerCase()
          try {
            if (!sub || sub === 'help') return line(HELP)
            if (sub === 'status') {
              const snapshot = await service.snapshot()
              const openBlockers = snapshot.blockers.length
              const pendingPlans = snapshot.plans.filter(
                (plan) => plan.status === 'pending_review',
              ).length
              const running = snapshot.sessions.filter((session) => session.running).length
              const text = [
                `管家：${snapshot.butler.sessionId ?? '（未创建）'} ${snapshot.butler.status}`,
                `会话 ${snapshot.sessions.length} 个，运行中 ${running} 个`,
                `未处理卡点 ${openBlockers} 个，待审计划 ${pendingPlans} 个`,
                `未决审批 ${snapshot.approvals.length} 个`,
              ].join('\n')
              return line(text)
            }
            if (sub === 'inbox') {
              const snapshot = await service.snapshot()
              if (snapshot.blockers.length === 0) return line('收件箱是空的。')
              const text = snapshot.blockers
                .slice(0, 20)
                .map(
                  (blocker, index) =>
                    `${index + 1}. [${blocker.kind}] ${blocker.summary} → ${blocker.neededAction}`,
                )
                .join('\n')
              return line(text)
            }
            if (sub === 'mode') {
              if (rest.length === 0) {
                const snapshot = await service.snapshot()
                if (snapshot.projects.length === 0) return line('还没有项目记录。')
                return line(
                  snapshot.projects
                    .map((project) => `${project.key}  ${project.mode}  ${project.title}`)
                    .join('\n'),
                )
              }
              const [projectKey, mode] = rest
              if (mode !== 'plan_review' && mode !== 'gate_confirm') {
                return fail('模式只能是 plan_review 或 gate_confirm')
              }
              const result = await service.setMode(projectKey, mode)
              return result?.ok === false ? fail(String(result.message)) : line('已切换')
            }
            if (sub === 'dispatch') {
              const [sessionId, ...textParts] = rest
              const text = textParts.join(' ').trim()
              if (!sessionId || !text) return fail('用法：/superagent dispatch <sessionId> <任务文本>')
              const result = await service.dispatchExecute(
                { kind: 'reuse', sessionId, reason: '用户用 /superagent dispatch 指定' },
                text,
                // 在某个管家会话里执行的命令：提醒回到这个管家；在别处执行则广播给所有管家
                service.isButlerAgentSession(invocation?.agent) ? String(invocation.agent.id) : undefined,
              )
              if (result?.kind === 'clarify') {
                return fail(`派发未完成：${result.reason ?? '目标不明确'}`)
              }
              return line(
                `已派发到 ${result.sessionId}（dispatch ${result.dispatchId}，${result.delivery}）`,
              )
            }
            if (sub === 'butler') {
              const id = await service.ensureButler()
              return line(`管家 session：${id}`)
            }
            if (sub === 'refresh') {
              const snapshot = await service.snapshot()
              return line(`已刷新，生成于 ${new Date(snapshot.generatedAt).toLocaleTimeString()}`)
            }
            return fail(`未知子命令：${sub}\n${HELP}`)
          } catch (error) {
            return fail(String((error as any)?.message ?? error))
          }
        },
      }),
    'superagent:command',
  )
}
