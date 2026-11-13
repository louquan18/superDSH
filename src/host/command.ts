import { stat } from 'node:fs/promises'
import type { SuperagentService } from '../service.js'

const HELP = [
  '/superagent status — 会话、卡点、队列摘要',
  '/superagent inbox — 未处理的卡点/审批/计划',
  '/superagent mode — 列出项目模式',
  '/superagent mode <projectKey> <plan_review|gate_confirm> — 切换项目模式',
  '/superagent dispatch <sessionId> <任务文本> — 直接派活给指定 session',
  '/superagent butler — 确保管家 session 存在并返回 id',
  '/superagent doctor — 只读自检：配置是否生效、来源可用性、版本（不改任何东西）',
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
        input: { hint: 'status | inbox | mode | dispatch | butler | doctor' },
        async handler(invocation: any) {
          const raw = String(invocation?.rawInput ?? '').trim()
          const [head, ...rest] = raw.split(/\s+/)
          const sub = (head ?? '').toLowerCase()
          try {
            if (!sub || sub === 'help') return line(HELP)
            if (sub === 'doctor') {
              // I-22(a)：只读自检。目的不是"修配置"，而是让「配置到底生效没有」这件事
              // 不用为了看一眼就去改 ~/.dsh（那正是历史上提权挂起 turn 的来源）。
              // 降级服务（启动失败）里没有 config/diagnostics/sourceStatus——
              // 而"启动失败"恰恰是最需要自检的时候，所以这里必须先认出来。
              if ((service as any).degraded) {
                return line(
                  [
                    '【SuperAgent 自检（只读）】',
                    '状态：插件降级运行（启动失败）',
                    `原因：${String((service as any).degradedReason ?? '未知')}`,
                    '配置没有加载成功：请检查 profile 的 cordis.patch.yml 后重启 dsh。',
                  ].join('\n'),
                )
              }
              const config = service.config
              const diagnostics = service.diagnostics()
              const sources = service.sourceStatus()
              const cwd = config.butler.cwd ?? '（未配置，用 dsh 默认工作区）'
              let cwdNote = ''
              if (config.butler.cwd) {
                try {
                  cwdNote = (await stat(config.butler.cwd)).isDirectory()
                    ? '存在'
                    : '不是目录'
                } catch {
                  cwdNote = '不存在或不可读'
                }
              }
              const sourceLines = sources.map(
                (item) =>
                  `${item.kind}: ${item.enabled ? (item.available ? '可用' : `不可用（${item.error ?? '未知原因'}）`) : '未启用'}`,
              )
              const text = [
                '【SuperAgent 自检（只读）】',
                `版本：${diagnostics.version.codeVersion}｜配置指纹 ${diagnostics.version.configHash}`,
                `启动：${new Date(diagnostics.version.startedAt).toISOString()}`,
                `管家：${diagnostics.butlerSessionId ?? '（未创建）'}｜门禁与 worker 工具已装载 ${diagnostics.installedCount} 个会话`,
                `管家工作区：${cwd}${cwdNote ? `（${cwdNote}）` : ''}`,
                `来源：${sourceLines.length ? sourceLines.join('；') : '（无）'}`,
                '生效配置（本插件实际读到的值）：',
                `  scanIntervalMs=${config.scanIntervalMs} recoveryScanDays=${config.recoveryScanDays} statusRefreshLimit=${config.statusRefreshLimit}`,
                `  planReview.allowReadOnlyBash=${config.planReview.allowReadOnlyBash} auditAllLowRisk=${config.auditAllLowRisk}`,
                `  policy=${config.policy.enabled ? 'on' : 'off'} shadowRules=[${config.policy.shadowRules.join(', ')}] minSamples=${config.policy.minSamples}`,
                `  thread=${config.thread.enabled ? 'on' : 'off'} mcp.batchApprove=${config.mcp.batchApprove}`,
                `  settleSuggest=${config.settleSuggest.enabled ? 'on' : 'off'} settleTtl=${config.settleTtl.enabled ? `on(${config.settleTtl.minutes}min)` : 'off'}`,
                `  watchdog=${config.watchdog.enabled ? 'on' : 'off'} progress.wake=${config.progress.wake.enabled ? 'on' : 'off'} bashReview=${config.bashReview.enabled ? 'on' : 'off'}`,
                `  sources.claude=${config.sources.claude.enabled ? 'on' : 'off'} sources.codex=${config.sources.codex.enabled ? 'on' : 'off'}`,
                '说明：本命令只读。要改配置仍需编辑 profile 的 cordis.patch.yml 并重启 dsh（插件在启动时组装）。',
              ].join('\n')
              return line(text)
            }
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
