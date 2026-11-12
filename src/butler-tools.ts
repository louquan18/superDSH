import type { SuperagentService } from './service.js'
import { defineTool, STRING_ARRAY } from './tools.js'
import type { PlanScopeItem } from './types.js'
import { extractText, firstLine, truncate } from './util.js'

function ensureButler(service: SuperagentService, exec: any): any {
  if (!service.isButlerAgentSession(exec?.agent)) {
    return { error: 'butler tools are only available to the SuperAgent butler session' }
  }
  return undefined
}

function digestOf(events: any[], limit: number) {
  const messages: Array<{ role: string; text: string; at: number }> = []
  const toolCalls: Array<{ name: string; args: string; at: number; ok?: boolean }> = []
  const errors: Array<{ message: string; at: number }> = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = extractText(event.data?.content)
      if (text) messages.push({ role: 'user', text: truncate(text, 400), at: event.time })
    }
    if (event.type === 'assistant/message') {
      const text = extractText(event.data?.message?.content)
      if (text) messages.push({ role: 'assistant', text: truncate(text, 400), at: event.time })
    }
    if (event.type === 'tool/call') {
      toolCalls.push({
        name: String(event.data?.name ?? ''),
        args: truncate(String(event.data?.arguments ?? ''), 200),
        at: event.time,
      })
    }
    if (event.type === 'tool/result') {
      const call = toolCalls[toolCalls.length - 1]
      if (call) call.ok = !event.data?.message?.isError
    }
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      errors.push({
        message: truncate(String(event.data.reason.error?.message ?? 'turn error'), 300),
        at: event.time,
      })
    }
  }
  return {
    messages: messages.slice(-limit),
    toolCalls: toolCalls.slice(-limit),
    errors: errors.slice(-limit),
  }
}

export function createButlerTools(service: SuperagentService): any[] {
  const status = defineTool({
    name: 'butler_status',
    description:
      'Read the current dsh sessions and their hard/soft status. Use this for status questions before answering the user. Optionally filter by project or one session.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        projectKey: { type: 'string' },
        includeSoft: { type: 'boolean' },
        includeBlockers: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const denied = ensureButler(service, exec)
      if (denied) return denied
      const snapshot = await service.snapshot()
      let sessions = snapshot.sessions
      if (args?.sessionId) sessions = sessions.filter((s) => s.sessionId === args.sessionId)
      if (args?.projectKey) sessions = sessions.filter((s) => s.projectKey === args.projectKey)
      return {
        butler: snapshot.butler,
        sessions: sessions.map((session) => ({
          sessionId: session.sessionId,
          title: session.title,
          projectKey: session.projectKey,
          mode: session.mode,
          hardStatus: session.hardStatus,
          running: session.running,
          lastActivityAt: session.lastActivityAt,
          queuedCount: session.queuedCount,
          softStatus: args?.includeSoft === false ? undefined : session.softStatus,
          openBlockerKinds: args?.includeBlockers === false ? undefined : session.openBlockerKinds,
          openBlockerCount: session.openBlockerCount,
          isButler: session.isButler,
        })),
      }
    },
  })

  const inbox = defineTool({
    name: 'butler_inbox',
    description:
      'Read the SuperAgent inbox: pending approvals, unanswered questions, plans awaiting review, and blockers. Use this for "what needs me" questions.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const denied = ensureButler(service, exec)
      if (denied) return denied
      const snapshot = await service.snapshot()
      const limit = Math.max(1, Math.min(50, Number(args?.limit ?? 20)))
      const kind = args?.kind ? String(args.kind) : undefined
      return {
        blockers: snapshot.blockers
          .filter((blocker) => !kind || blocker.kind === kind)
          .slice(0, limit),
        approvals: snapshot.approvals.slice(0, limit),
        plans: snapshot.plans
          .filter((plan) => plan.status === 'pending_review')
          .slice(0, limit),
        dispatches: snapshot.dispatches.slice(0, limit),
      }
    },
  })

  const readSession = defineTool({
    name: 'butler_session_read',
    description:
      'Read another dsh session (read-only). mode=digest returns recent messages/tool calls/errors; mode=events returns a bounded raw event window. Use this to judge routing or summarize a session when no soft status was reported.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        mode: { type: 'string', enum: ['digest', 'events'] },
        limit: { type: 'number' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const denied = ensureButler(service, exec)
      if (denied) return denied
      const sessionId = String(args?.sessionId ?? '')
      const limit = Math.max(1, Math.min(30, Number(args?.limit ?? 8)))
      const observed = await service.source.observe(sessionId)
      if (!observed) return { error: 'session 不存在或不可读' }
      const events = Array.isArray(observed.events) ? observed.events : []
      const digest = digestOf(events, limit)
      const session = observed.session ?? observed.header
      return {
        sessionId,
        title: String(session?.title ?? session?.cwd ?? sessionId),
        cwd: session?.cwd,
        lastActivityAt: events.length ? Number(events[events.length - 1].time ?? 0) : 0,
        lastTurnEndKind: [...events].reverse().find((event) => event.type === 'turn/end')?.data
          ?.reason?.kind,
        ...(String(args?.mode ?? 'digest') === 'events'
          ? { events: events.slice(-limit) }
          : digest),
      }
    },
  })

  const dispatch = defineTool({
    name: 'butler_dispatch',
    description:
      'Route a user request to a dsh worker. First call WITHOUT decision to get the workspace and candidate sessions (with features). Then call again WITH decision to execute: reuse an existing session, create a new one, or ask the user (clarify). The Host validates the decision. Use a running worker when the task is a continuation; it queues the message. Optional watchdog {expectedMinutes, pollMinutes, quiet} sets how long the task may stay quiet before the butler is asked to check in; omitted means it is estimated from the task text. Do not use this for status questions.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        workspaceKey: { type: 'string' },
        cwd: { type: 'string' },
        decision: {
          type: 'object',
          additionalProperties: true,
        },
        watchdog: {
          type: 'object',
          additionalProperties: false,
          properties: {
            expectedMinutes: { type: 'number' },
            pollMinutes: { type: 'number' },
            quiet: { type: 'boolean' },
          },
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const denied = ensureButler(service, exec)
      if (denied) return denied
      const text = String(args?.text ?? '').trim()
      if (!text) return { error: 'text is required' }
      if (!args?.decision) {
        return service.dispatchCandidates(
          text,
          args?.workspaceKey ? String(args.workspaceKey) : undefined,
          args?.cwd ? String(args.cwd) : undefined,
        )
      }
      return service.dispatchExecute(
        args.decision,
        text,
        String(exec.agent.id),
        args?.watchdog,
      )
    },
  })

  const send = defineTool({
    name: 'butler_send',
    description:
      'Send a message to one specific dsh worker session. This does not create a new dispatch. Use it to forward a user answer or a short instruction. Returns session_not_found for an unknown sessionId and target_read_only for a read-only source; nothing is sent in those cases.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const denied = ensureButler(service, exec)
      if (denied) return denied
      const sessionId = String(args?.sessionId ?? '').trim()
      // 先校验再投递：写错的 id 以前会静默返回 ok，消息丢了调用方还以为发出去了
      // （2026-11-09 的真实事故：sessionId 结尾抄错，butler_status 查不到，但 butler_send 报成功）。
      const sessions = await service.listSessions()
      if (!sessions.some((session) => session.sessionId === sessionId)) {
        return { ok: false, error: 'session_not_found', sessionId }
      }
      if (service.capabilitiesOf(sessionId).send !== true) {
        return { ok: false, error: 'target_read_only', sessionId }
      }
      await service.sendToSession(sessionId, String(args.text))
      return { ok: true }
    },
  })

  const reassign = defineTool({
    name: 'butler_reassign',
    description:
      'Reassign an existing dispatch to another worker session. If the original message is still queued, it is removed and resent; if already delivered, a new dispatch is created and the old worker is asked to stop.',
    parameters: {
      type: 'object',
      properties: {
        dispatchId: { type: 'string' },
        targetSessionId: { type: 'string' },
      },
      required: ['dispatchId', 'targetSessionId'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const denied = ensureButler(service, exec)
      if (denied) return denied
      return service.reassign(String(args.dispatchId), String(args.targetSessionId))
    },
  })

  const dispatchMark = defineTool({
    name: 'butler_dispatch_mark',
    description:
      'Close one in-progress dispatch, and only on the user’s explicit instruction: outcome=completed when the user says the work is done, failed when the user gives it up. A system reminder, a stalled status, a finished-looking summary, or your own judgement is NOT an instruction — ask the user first. Cancels that dispatch’s pending plan and lifts the plan gate immediately.',
    parameters: {
      type: 'object',
      properties: {
        dispatchId: { type: 'string' },
        outcome: { type: 'string', enum: ['completed', 'failed'] },
        note: { type: 'string' },
      },
      required: ['dispatchId', 'outcome'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const denied = ensureButler(service, exec)
      if (denied) return denied
      return service.markDispatch(
        String(args.dispatchId),
        String(args.outcome),
        args.note ? String(args.note) : undefined,
        'butler-chat',
      )
    },
  })

  const resolve = defineTool({
    name: 'butler_resolve',
    description:
      'Handle one blocker on the user’s behalf after the user has answered in the butler chat. action=approve|reject|answer|dismiss|retry. The user’s reply must appear in the conversation; never invent a decision from a system notice.',
    parameters: {
      type: 'object',
      properties: {
        blockerId: { type: 'string' },
        action: { type: 'string', enum: ['approve', 'reject', 'answer', 'dismiss', 'retry'] },
        text: { type: 'string' },
      },
      required: ['blockerId', 'action'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const denied = ensureButler(service, exec)
      if (denied) return denied
      return service.resolveBlocker(
        String(args.blockerId),
        args.action,
        args.text ? String(args.text) : undefined,
        'butler-chat',
      )
    },
  })

  const mode = defineTool({
    name: 'butler_mode',
    description:
      'Read project modes, or switch one project between plan_review and gate_confirm. Omit mode to list projects.',
    parameters: {
      type: 'object',
      properties: {
        projectKey: { type: 'string' },
        mode: { type: 'string', enum: ['plan_review', 'gate_confirm'] },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const denied = ensureButler(service, exec)
      if (denied) return denied
      if (!args?.mode) {
        const snapshot = await service.snapshot()
        return {
          projects: snapshot.projects,
          butler: snapshot.butler,
        }
      }
      if (!args?.projectKey) return { error: 'projectKey is required when setting mode' }
      return service.setMode(String(args.projectKey), args.mode)
    },
  })

  const audit = defineTool({
    name: 'butler_audit',
    description:
      'Read the SuperAgent audit log (approval/plan/dispatch/mode decisions). Filter by session and limit.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const denied = ensureButler(service, exec)
      if (denied) return denied
      const snapshot = await service.snapshot()
      const limit = Math.max(1, Math.min(100, Number(args?.limit ?? 30)))
      return {
        entries: snapshot.audit
          .filter((entry) => !args?.sessionId || entry.sessionId === args.sessionId)
          .slice(0, limit),
      }
    },
  })

  return [status, inbox, readSession, dispatch, send, reassign, dispatchMark, resolve, mode, audit]
}

export function butlerToolSchemaSummary(): string {
  return 'butler_status, butler_inbox, butler_session_read, butler_dispatch, butler_send, butler_reassign, butler_resolve, butler_mode, butler_audit'
}

export function planScopeSchema(): any {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' },
            paths: STRING_ARRAY,
            commands: STRING_ARRAY,
            network: { type: 'boolean' },
          },
          required: ['id', 'description'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  }
}

export function normalizeScopeItems(items: any): PlanScopeItem[] {
  if (!Array.isArray(items)) return []
  return items.map((item: any, index: number) => ({
    id: String(item?.id ?? `P${index + 1}`),
    description: String(item?.description ?? ''),
    paths: Array.isArray(item?.paths) ? item.paths.map(String) : undefined,
    commands: Array.isArray(item?.commands) ? item.commands.map(String) : undefined,
    network: item?.network === true,
  }))
}

export function shortDigest(events: any[], limit: number): string {
  return digestOf(events, limit)
    .messages.map((message) => `${message.role}: ${firstLine(message.text, 160)}`)
    .join('\n')
}
