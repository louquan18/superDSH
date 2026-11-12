import type { HardStatus, SoftStatus } from './types.js'
import { hash, normalizeError, safeJson, truncate } from './util.js'

export interface ToolCallRecord {
  callId: string
  name: string
  args: any
  at: number
  result?: {
    isError: boolean
    text: string
    code?: string
    at: number
  }
}

export interface FailureEntry {
  signature: string
  at: number
  toolName: string
  subkind?: 'test' | 'error' | 'edit_thrash' | 'loop'
  summary: string
}

export interface PendingApproval {
  id: string
  toolName: string
  callId?: string
  reason?: string
  at: number
}

export interface PendingQuestion {
  callId: string
  questions: any[]
  at: number
  state: 'open' | 'continued'
}

export interface EditEntry {
  path: string
  at: number
}

export interface LastTurnEnd {
  kind: string
  at: number
  error?: string
  errorCode?: string
}

export interface SessionRuntime {
  sessionId: string
  running: boolean
  lastEventAt: number
  lastActivityAt: number
  eventCount: number
  openTurnStartSeq: number | null
  lastTurnEnd: LastTurnEnd | null
  approvals: Map<string, PendingApproval>
  questions: Map<string, PendingQuestion>
  failureRing: FailureEntry[]
  editRing: EditEntry[]
  toolCalls: Map<string, ToolCallRecord>
  softStatus?: SoftStatus
  lastTestSuccessAt?: number
}

export function createRuntime(sessionId: string): SessionRuntime {
  return {
    sessionId,
    running: false,
    lastEventAt: 0,
    lastActivityAt: 0,
    eventCount: 0,
    openTurnStartSeq: null,
    lastTurnEnd: null,
    approvals: new Map(),
    questions: new Map(),
    failureRing: [],
    editRing: [],
    toolCalls: new Map(),
    softStatus: undefined,
  }
}

function isTestCommand(command: string): boolean {
  const text = command.toLowerCase()
  return /(^|\s)(test|pytest|vitest|jest|go test|cargo test|npm test|pnpm test|yarn test|make test)\b/.test(
    text,
  )
}

function normalizeFailureText(text: string): string {
  return String(text || '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.+-]+Z?\b/g, '<time>')
    .replace(/\b(at|line)\s+\d+(:\d+)?\b/gi, '$1 <n>')
    .replace(/\/[\w./-]*?\/([\w.-]+)/g, '<path>/$1')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

function toolResultText(event: any): string {
  const message = event?.data?.message
  const content = message?.content
  if (Array.isArray(content)) {
    return content
      .map((block: any) => (block?.type === 'text' ? String(block.text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return String(content ?? '')
}

export function addFailure(
  runtime: SessionRuntime,
  entry: Omit<FailureEntry, 'at'> & { at?: number },
): void {
  runtime.failureRing.push({ ...entry, at: entry.at ?? runtime.lastEventAt })
  const cutoff = (entry.at ?? runtime.lastEventAt) - 30 * 60_000
  if (runtime.failureRing.length > 80) {
    runtime.failureRing = runtime.failureRing.slice(-80)
  }
  runtime.failureRing = runtime.failureRing.filter((item) => item.at >= cutoff)
}

export function applySessionEvent(
  runtime: SessionRuntime,
  event: any,
  options: { now?: number } = {},
): void {
  const at = Number(event?.time ?? options.now ?? Date.now())
  runtime.lastEventAt = at
  runtime.lastActivityAt = at
  runtime.eventCount += 1
  const type = event?.type
  const data = event?.data ?? {}

  if (type === 'turn/start') {
    runtime.openTurnStartSeq = Number(event.seq ?? 0)
    return
  }

  if (type === 'turn/end') {
    runtime.openTurnStartSeq = null
    const reason = data?.reason ?? {}
    const kind = String(reason?.kind ?? 'completed')
    const error = reason?.error
    runtime.lastTurnEnd = {
      kind,
      at,
      error: error ? truncate(normalizeError(error), 500) : undefined,
      errorCode: error?.code,
    }
    if (kind === 'error') {
      addFailure(runtime, {
        signature: `turn:${hash(`${error?.code ?? ''}:${normalizeFailureText(normalizeError(error))}`)}`,
        toolName: 'turn',
        subkind: 'error',
        summary: truncate(normalizeError(error), 180),
        at,
      })
    }
    return
  }

  if (type === 'tool/call') {
    const callId = String(data?.callId ?? '')
    if (!callId) return
    const name = String(data?.name ?? '')
    const args = safeJson(String(data?.arguments ?? '')) ?? {}
    runtime.toolCalls.set(callId, { callId, name, args, at })
    if (name === 'butler_report_status') {
      const soft = parseReportStatus(args, at)
      if (soft) runtime.softStatus = soft
    }
    if (name === 'ask_user_question') {
      const questions = Array.isArray(args?.questions) ? args.questions : []
      if (questions.length > 0) {
        runtime.questions.set(callId, { callId, questions, at, state: 'open' })
      }
    }
    if (name === 'write' || name === 'edit' || name === 'str_replace_editor') {
      const file = String(args?.file_path ?? args?.path ?? '')
      if (file) {
        runtime.editRing.push({ path: file, at })
        runtime.editRing = runtime.editRing.filter((item) => item.at >= at - 15 * 60_000)
      }
    }
    return
  }

  if (type === 'tool/result') {
    const callId = String(data?.message?.toolCallId ?? '')
    const call = callId ? runtime.toolCalls.get(callId) : undefined
    const text = toolResultText(event)
    const isError = Boolean(data?.message?.isError || data?.error)
    const code = data?.error?.code
    if (call) {
      call.result = { isError, text, code, at }
      if (call.name === 'ask_user_question') {
        runtime.questions.delete(callId)
      }
      const bashExit = /\[exit code:\s*(\d+)\]/i.exec(text)
      if (call.name === 'bash' || call.name === 'pwsh') {
        const command = String(call.args?.command ?? '')
        if (bashExit && bashExit[1] !== '0') {
          const signature = `bash:${hash(command)}:${bashExit[1]}:${hash(normalizeFailureText(text.slice(-800)))}`
          addFailure(runtime, {
            signature,
            toolName: call.name,
            subkind: isTestCommand(command) ? 'test' : undefined,
            summary: truncate(`${command} -> exit ${bashExit[1]}`, 180),
            at,
          })
        } else if (!isError && isTestCommand(command)) {
          runtime.lastTestSuccessAt = at
          runtime.editRing = []
        }
      }
      if (isError) {
        const signature = `tool:${call.name}:${code ?? ''}:${hash(normalizeFailureText(text))}`
        addFailure(runtime, {
          signature,
          toolName: call.name,
          subkind: 'error',
          summary: truncate(text, 180),
          at,
        })
      }
    }
    return
  }

  if (type === 'approval/asked') {
    const id = String(data?.id ?? '')
    if (id) {
      runtime.approvals.set(id, {
        id,
        toolName: String(data?.toolName ?? ''),
        callId: data?.callId ? String(data.callId) : undefined,
        reason: data?.reason ? String(data.reason) : undefined,
        at,
      })
    }
    return
  }

  if (type === 'approval/decided') {
    const id = String(data?.id ?? '')
    if (id) runtime.approvals.delete(id)
    return
  }
}

export function foldSession(
  sessionId: string,
  events: any[],
  options: { now?: number } = {},
): SessionRuntime {
  const runtime = createRuntime(sessionId)
  for (const event of events) applySessionEvent(runtime, event, options)
  return runtime
}

export function parseReportStatus(args: any, at = Date.now()): SoftStatus | undefined {
  if (!args || typeof args !== 'object') return undefined
  const goal = typeof args.goal === 'string' ? truncate(args.goal, 1000) : ''
  const strings = (value: any): string[] =>
    Array.isArray(value)
      ? value
          .filter((item) => typeof item === 'string')
          .map((item) => truncate(item, 500))
          .slice(0, 20)
      : []
  if (!goal && !Array.isArray(args.done) && !Array.isArray(args.next)) return undefined
  return {
    goal,
    done: strings(args.done),
    next: strings(args.next),
    blockers: strings(args.blockers),
    decisions: strings(args.decisions),
    reportedAt: at,
    source: 'tool',
  }
}

export function deriveHardStatus(
  runtime: SessionRuntime | undefined,
  live: { available: boolean; running: boolean },
): HardStatus {
  if (!runtime) return live.running ? 'running' : 'idle'
  const running = Boolean(live.running)
  if (runtime.approvals.size > 0 && running) return 'awaiting_approval'
  if (runtime.questions.size > 0) return 'awaiting_answer'
  if (!live.available && runtime.openTurnStartSeq !== null) return 'interrupted'
  if (runtime.lastTurnEnd?.kind === 'interrupted' && !running) return 'interrupted'
  if (runtime.lastTurnEnd?.kind === 'error' && !running) return 'error'
  if (running) return 'running'
  if (runtime.approvals.size > 0) return 'interrupted'
  return 'idle'
}

export function recentFailureGroups(
  runtime: SessionRuntime,
  windowMs: number,
  threshold: number,
  at = Date.now(),
): Array<{ signature: string; count: number; latest: FailureEntry }> {
  const cutoff = at - windowMs
  const groups = new Map<string, FailureEntry[]>()
  for (const entry of runtime.failureRing) {
    if (entry.at < cutoff) continue
    const list = groups.get(entry.signature) ?? []
    list.push(entry)
    groups.set(entry.signature, list)
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length >= threshold)
    .map(([signature, list]) => ({
      signature,
      count: list.length,
      latest: list[list.length - 1],
    }))
}

export function repeatedToolCalls(
  runtime: SessionRuntime,
  windowMs: number,
  threshold: number,
  at = Date.now(),
): Array<{ signature: string; count: number; call: ToolCallRecord }> {
  const cutoff = at - windowMs
  const groups = new Map<string, ToolCallRecord[]>()
  for (const call of runtime.toolCalls.values()) {
    if (call.at < cutoff) continue
    if (call.result && !call.result.isError) continue
    const signature = `${call.name}:${hash(JSON.stringify(call.args ?? {}))}`
    const list = groups.get(signature) ?? []
    list.push(call)
    groups.set(signature, list)
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length >= threshold)
    .map(([signature, list]) => ({ signature, count: list.length, call: list[list.length - 1] }))
}
