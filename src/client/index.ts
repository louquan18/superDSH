/**
 * SuperAgent 管家 Web Client。
 *
 * 这个文件刻意写成单文件、无 import 的脚本：dsh 的 client 插件由 `__ModuleLoader__` 装载，
 * React 从平台模块表 `require('react')` 取；构建用 tsc（module: none），不需要打包器。
 *
 * 挂载点（6 个）：
 * - `sidebar.panellist` + `main`：管家的整页**只读**面板（概览 / 日志 / 明细）
 * - `sidebar.session.row.leading`：原生 session 行上的卡点徽标 / 管家派发标记
 * - `sidebar.session.row.hover`：原生行 hover 卡里的软状态摘要
 * - `conversation.chat.node`（key `superagent-notice`）：把带 `superagent-notice` source 的
 *   注入消息渲染成一张可点按钮的卡片——所有需要拍板的操作都在这里，不在面板里
 * - `conversation.input.dock`：管家会话输入框上方的「待处理」条（管家 idle 时的兜底入口）
 *
 * 同时向 `uiConversation.events` 注册一个 Definition，用 `exclusive: true` 抢注这些消息，
 * 否则 dsh 会把它们当普通注入上下文渲染（不带按钮）。
 */
;(function () {
  const PANEL_ID = 'superagent'
  const STATE_URL = '/api/superagent/state'
  const ACTION_URL = '/api/superagent/action'
  const EVENTS_URL = '/api/superagent/events'

  const CSS = `
.sab-root{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;min-width:0}
.sab-head{flex:none;display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex-wrap:wrap}
.sab-title{font-size:16px;font-weight:600;margin:0}
.sab-meta{color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sab-spacer{flex:1}
.sab-tabs{flex:none;display:flex;gap:4px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow-x:auto}
.sab-tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:6px 10px;font:inherit;cursor:pointer;white-space:nowrap}
.sab-tab:hover{background:var(--dsw-alias-bg-layer-2)}
.sab-tab[data-active=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.sab-body{flex:1;min-height:0;overflow:auto;padding:14px 18px 96px}
.sab-group{margin:0 0 16px}
.sab-group-title{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0 0 8px;letter-spacing:.04em}
.sab-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;margin:0 0 8px;display:flex;flex-direction:column;gap:6px}
.sab-card[data-sev=critical]{border-color:var(--dsw-alias-state-error-primary)}
.sab-card[data-sev=warning]{border-color:var(--dsw-alias-state-warn-primary)}
.sab-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sab-kicker{font-size:12px;color:var(--dsw-alias-label-secondary)}
.sab-strong{font-weight:600}
.sab-note{color:var(--dsw-alias-label-secondary);font-size:12px}
.sab-chip{font-size:11px;border-radius:999px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;white-space:nowrap}
.sab-chip[data-kind=critical]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.sab-chip[data-kind=warning]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.sab-chip[data-kind=ok]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.sab-src{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:1;border-radius:999px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.sab-src-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.sab-src[data-src=dsh]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.sab-src[data-src=claude]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}
.sab-src[data-src=codex]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.sab-src[data-src=remote]{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-border-l2)}
.sab-filters{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 10px}
.sab-filter{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.sab-filter:hover{background:var(--dsw-alias-bg-layer-2)}
.sab-filter[data-active=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}
.sab-limit{font-size:11px;color:var(--dsw-alias-label-secondary);margin:6px 0 0}
.sab-timeline{display:flex;flex-direction:column;gap:8px}
.sab-tl-item{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.sab-tl-item[data-kind=dispatch]{border-left:3px solid var(--dsw-alias-brand-primary)}
.sab-tl-item[data-kind=milestone]{border-left:3px solid var(--dsw-alias-state-success-primary)}
.sab-tl-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary);margin-top:6px;flex:none}
.sab-tl-body{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.sab-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
.sab-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sab-btn:disabled{opacity:.5;cursor:default}
.sab-btn[data-primary=true]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.sab-btn[data-danger=true]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.sab-pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px;margin:0;max-height:52vh;overflow:auto}
.sab-input,.sab-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px}
.sab-textarea{min-height:64px;resize:vertical}
.sab-table{width:100%;border-collapse:collapse;font-size:12px}
.sab-table th,.sab-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.sab-table th{color:var(--dsw-alias-label-secondary);font-weight:500;position:sticky;top:0;background:var(--dsw-alias-bg-base)}
.sab-empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:36px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.sab-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.sab-composer{position:sticky;bottom:0;background:var(--dsw-alias-bg-layer-1);border-top:1px solid var(--dsw-alias-border-l1);padding:10px 18px;display:flex;gap:8px;align-items:flex-end}
.sab-composer textarea{flex:1}
.sab-dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.sab-dot[data-tone=error]{background:var(--dsw-alias-state-error-primary)}
.sab-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}
.sab-dot[data-tone=info]{background:var(--dsw-alias-brand-primary)}
.sab-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;line-height:1;border-radius:999px;padding:2px 5px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);margin-right:4px}
.sab-hover{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.sab-notice-row{display:flex;justify-content:flex-start;padding:2px 0;min-width:0}
.sab-notice{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .92), 96%)}
.sab-notice[data-sev=critical]{border-color:var(--dsw-alias-state-error-primary)}
.sab-notice[data-sev=warning]{border-color:var(--dsw-alias-state-warn-primary)}
.sab-notice[data-settled=true]{opacity:.78}
.sab-notice-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.sab-notice-title{font-weight:600;font-size:13px;word-break:break-word}
.sab-notice-detail{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.sab-notice-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:2px}
.sab-notice-status{font-size:12px;color:var(--dsw-alias-state-success-primary)}
.sab-notice-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.sab-dock{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:8px 10px;margin:0 0 8px;display:flex;flex-direction:column;gap:6px;max-height:60vh}
.sab-dock-head{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:none;padding:0;font-family:inherit;text-align:left;width:100%}
.sab-dock-list{display:flex;flex-direction:column;gap:8px;overflow:auto;min-height:0}
.sab-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:0 0 16px}
.sab-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:2px}
.sab-stat-value{font-size:20px;font-weight:600;line-height:1.15}
.sab-stat-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.sab-section{margin:0 0 18px}
`

  // ---------------------------------------------------------------- helpers

  function fmtTime(ts: number | undefined): string {
    if (!ts) return '-'
    const date = new Date(ts)
    const now = Date.now()
    const diff = now - ts
    if (diff >= 0 && diff < 60_000) return '刚刚'
    if (diff >= 0 && diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
    return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(
      date.getHours(),
    ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }

  function truncate(text: string, max: number): string {
    const value = String(text ?? '')
    return value.length > max ? `${value.slice(0, max - 1)}…` : value
  }

  const KIND_LABEL: Record<string, string> = {
    approval: '等审批',
    question: '等回答',
    plan_review: '计划待审',
    repeated_failure: '反复失败',
    stall: '停滞',
    interrupted: '中断',
    decision: '待决策',
    error: '出错',
    milestone: '进度',
    dispatch: '派发',
  }

  const STATUS_LABEL: Record<string, string> = {
    running: '运行中',
    idle: '空闲',
    awaiting_approval: '等审批',
    awaiting_answer: '等回答',
    error: '出错',
    interrupted: '中断',
    unknown: '未知',
  }

  const DISPATCH_LABEL: Record<string, string> = {
    routing: '投递中',
    accepted: '已接受',
    delivered: '已投递',
    error: '上一轮出错',
    completed: '已完成',
    failed: '失败',
    superseded: '已被替代',
    reassigned: '已改派',
  }

  const RISK_LABEL: Record<string, string> = { low: '低', high: '高', unknown: '未知' }

  function chipKind(value: string): string {
    if (value === 'critical' || value === 'error') return 'critical'
    if (value === 'warning' || value === 'warn') return 'warning'
    if (value === 'ok' || value === 'success') return 'ok'
    return 'plain'
  }

  // ------------------------------------------------------------------ store

  interface ClientState {
    snapshot: any | null
    error: string | null
    loading: boolean
  }

  function createStore(api: any) {
    let state: ClientState = { snapshot: null, error: null, loading: true }
    const listeners = new Set<() => void>()
    let started = false
    let source: any = null
    let pollTimer: any = null
    let debounce: any = null
    let disposed = false

    function emit() {
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          // ignore
        }
      }
    }

    function set(patch: Partial<ClientState>) {
      state = { ...state, ...patch }
      emit()
    }

    async function refresh() {
      if (disposed) return
      try {
        const snapshot = await api.getState()
        if (disposed) return
        set({ snapshot, error: null, loading: false })
      } catch (error: any) {
        if (disposed) return
        set({ error: String(error?.message ?? error), loading: false })
      }
    }

    function schedule() {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = null
        void refresh()
      }, 200)
    }

    function startPolling() {
      if (pollTimer || disposed) return
      pollTimer = setInterval(() => void refresh(), 2000)
    }

    function start() {
      if (started || disposed) return
      started = true
      void refresh()
      try {
        if (typeof EventSource === 'function') {
          source = new EventSource(EVENTS_URL)
          source.onmessage = () => schedule()
          source.onerror = () => {
            if (source) {
              try {
                source.close()
              } catch {
                // ignore
              }
              source = null
            }
            startPolling()
            schedule()
          }
        } else {
          startPolling()
        }
      } catch {
        startPolling()
      }
    }

    function dispose() {
      disposed = true
      if (source) {
        try {
          source.close()
        } catch {
          // ignore
        }
        source = null
      }
      if (pollTimer) clearInterval(pollTimer)
      if (debounce) clearTimeout(debounce)
      pollTimer = null
      debounce = null
      listeners.clear()
    }

    return {
      start,
      dispose,
      refresh,
      schedule,
      get: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener)
        start()
        return () => {
          listeners.delete(listener)
        }
      },
    }
  }

  // 由 factory 注入：平台模块表里的 React。
  let React: any = null
  let h: any = null

  function useStore(store: any): ClientState {
    const [state, setState] = React.useState(store.get())
    React.useEffect(() => {
      const unsubscribe = store.subscribe(() => setState(store.get()))
      setState(store.get())
      return unsubscribe
    }, [store])
    return state
  }

  // ------------------------------------------------------------------- atoms

  function Button(props: any) {
    return h(
      'button',
      {
        type: 'button',
        className: 'sab-btn',
        disabled: props.disabled === true,
        'data-primary': props.primary === true ? 'true' : undefined,
        'data-danger': props.danger === true ? 'true' : undefined,
        'aria-label': props.ariaLabel ?? props.children,
        onClick: props.onClick,
        title: props.title,
      },
      props.children,
    )
  }

  function Chip(props: any) {
    return h('span', { className: 'sab-chip', 'data-kind': chipKind(props.kind ?? '') }, props.children)
  }

  function Empty(props: any) {
    return h('div', { className: 'sab-empty' }, props.children)
  }

  const SOURCE_LABEL = { dsh: 'dsh', claude: 'Claude', codex: 'Codex', remote: '远程' }
  const SOURCE_KINDS = ['dsh', 'claude', 'codex', 'remote']

  /** 来源徽标：彩色圆点 + 名字，色由 data-src 决定（一眼能分辨，不只靠文字）。 */
  function SourceBadge(props: any) {
    const source = String(props?.source ?? 'dsh')
    const kind = SOURCE_KINDS.includes(source) ? source : 'dsh'
    return h(
      'span',
      {
        className: 'sab-src',
        'data-src': kind,
        title: props?.title ?? `来源：${SOURCE_LABEL[kind] ?? kind}`,
      },
      h('span', { className: 'sab-src-dot' }),
      SOURCE_LABEL[kind] ?? kind,
    )
  }

  /** 按 id 找会话（拿来源与能力）；找不到时按 dsh 处理，和 backend 的兜底一致。 */
  function sessionOf(snapshot: any, sessionId: any): any {
    if (!snapshot || !sessionId) return undefined
    return (snapshot.sessions ?? []).find((item: any) => item.sessionId === sessionId)
  }

  /** 目标来源是否支持某个能力；后端没给 capabilities 时保守按不支持处理。 */
  function canDo(snapshot: any, sessionId: any, capability: string): boolean {
    const session = sessionOf(snapshot, sessionId)
    if (!session) return false
    return session.capabilities?.[capability] === true
  }

  /** 能力不能用的说明文案（统一口径）。 */
  const UNSUPPORTED = '该来源不支持'

  /** 只读降级的统一按钮：渲成 disabled，reason 放 title，绝不渲染成"看着能用"。 */
  function Unsupported(props: any) {
    return h(Button, {
      disabled: true,
      title: props?.reason ?? UNSUPPORTED,
      children: props?.label ?? UNSUPPORTED,
    })
  }

  /** 卡点能不能在这个来源上处理：审批/提问/计划各自的协议位。 */
  function blockerCapability(blocker: any): string | null {
    if (!blocker) return null
    if (blocker.kind === 'approval') return 'approvals'
    if (blocker.kind === 'question') return 'questions'
    if (blocker.kind === 'plan_review') return 'plans'
    return null // 其余是本地动作（忽略/刷新），不需要来源协议
  }

  function canHandleBlocker(snapshot: any, blocker: any): boolean {
    const capability = blockerCapability(blocker)
    if (!capability) return true
    return canDo(snapshot, blocker?.sessionId, capability)
  }

  function canHandlePlan(snapshot: any, plan: any): boolean {
    return canDo(snapshot, plan?.sessionId, 'plans')
  }

  function canHandleDispatch(snapshot: any, dispatch: any): boolean {
    return canDo(snapshot, dispatch?.targetSessionId, 'send')
  }

  // ------------------------------------------------------------------- views

  function BlockerCard(props: any) {
    const { api, blocker, onJump, openPlan, readOnly, onButler, capabilities } = props
    const supported = blockerCapability(blocker) === null || capabilities?.[blockerCapability(blocker)!] === true
    const [text, setText] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(null)

    async function run(action: string, payload: any) {
      setBusy(true)
      setError(null)
      try {
        await api.action(action, payload)
      } catch (cause: any) {
        setError(String(cause?.message ?? cause))
      } finally {
        setBusy(false)
      }
    }

    const kind = String(blocker.kind)
    const evidence = blocker.evidence ?? {}
    const actions: any[] = []
    if (kind === 'approval' && blocker.relatedApprovalId) {
      actions.push(
        h(Button, {
          key: 'allow',
          primary: true,
          disabled: busy,
          onClick: () =>
            void run('approval_decide', { approvalId: blocker.relatedApprovalId, decision: 'allow' }),
          children: '允许一次',
        }),
        h(Button, {
          key: 'deny',
          danger: true,
          disabled: busy,
          onClick: () =>
            void run('approval_decide', {
              approvalId: blocker.relatedApprovalId,
              decision: 'deny',
              note: text || undefined,
            }),
          children: '拒绝',
        }),
      )
    } else if (kind === 'question') {
      actions.push(
        h(Button, {
          key: 'answer',
          primary: true,
          disabled: busy || text.trim().length === 0,
          onClick: () =>
            void run('blocker_action', {
              blockerId: blocker.id,
              action: 'answer',
              text,
            }),
          children: '转发回答',
        }),
      )
    } else if (kind === 'plan_review' && blocker.relatedPlanId) {
      if (openPlan) {
        actions.push(
          h(Button, {
            key: 'plan',
            primary: true,
            onClick: () => openPlan(blocker.relatedPlanId),
            children: '去审查',
          }),
        )
      }
    } else {
      if (kind === 'interrupted' || kind === 'stall') {
        actions.push(
          h(Button, {
            key: 'retry',
            primary: true,
            disabled: busy,
            onClick: () => void run('blocker_action', { blockerId: blocker.id, action: 'retry', text }),
            children: '重试 / 催办',
          }),
        )
      }
      actions.push(
        h(Button, {
          key: 'dismiss',
          disabled: busy,
          onClick: () => void run('blocker_action', { blockerId: blocker.id, action: 'dismiss' }),
          children: '忽略',
        }),
      )
    }

    const needsText = kind === 'question' || kind === 'decision' || kind === 'approval'

    return h(
      'div',
      { className: 'sab-card', 'data-sev': blocker.severity },
      h(
        'div',
        { className: 'sab-row' },
        h(Chip, { kind: blocker.severity === 'critical' ? 'critical' : 'warning', children: KIND_LABEL[kind] ?? kind }),
        h(SourceBadge, { source: props.source ?? blocker.source }),
        h('span', { className: 'sab-strong' }, blocker.summary),
      ),
      h('div', { className: 'sab-kicker' }, `需要你：${blocker.neededAction}`),
      evidence && Object.keys(evidence).length > 0
        ? h(
            'div',
            { className: 'sab-note' },
            Object.keys(evidence)
              .slice(0, 6)
              .map((key) => `${key}=${truncate(JSON.stringify(evidence[key]), 120)}`)
              .join('  '),
          )
        : null,
      needsText && readOnly !== true
        ? h('textarea', {
            className: 'sab-textarea',
            value: text,
            placeholder: kind === 'question' ? '输入回答（会转发给该 session）' : '备注 / 拒绝原因（可选）',
            onChange: (event: any) => setText(event.target.value),
          })
        : null,
      h(
        'div',
        { className: 'sab-row' },
        h(Button, {
          onClick: () => onJump(String(blocker.sessionId)),
          children: '跳转 session',
        }),
        readOnly === true
          ? supported
            ? h(Button, { primary: true, onClick: onButler, children: '在对话里处理 →' })
            : h(Unsupported, { reason: `${UNSUPPORTED}：不能在对话里代答这个来源的审批/提问` })
          : null,
        ...(readOnly === true ? [] : actions),
        h('span', { className: 'sab-note' }, `${fmtTime(blocker.detectedAt)} · 已提醒 ${blocker.reminderCount} 次`),
        error ? h('span', { className: 'sab-error' }, error) : null,
      ),
    )
  }

  function PlansView(props: any) {
    const { snapshot, api, onJump, readOnly, onButler } = props
    const [selected, setSelected] = React.useState(null)
    const [feedback, setFeedback] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(null)
    if (!snapshot) return h(Empty, { children: '正在读取计划…' })
    const plans = snapshot.plans ?? []
    if (plans.length === 0) return h(Empty, { children: '没有待审或已批准的计划。' })
    const current = plans.find((plan: any) => plan.id === (selected ?? plans[0].id)) ?? plans[0]

    async function review(decision: string) {
      setBusy(true)
      setError(null)
      try {
        await api.action('plan_review', { planId: current.id, decision, feedback: feedback || undefined })
        setFeedback('')
      } catch (cause: any) {
        setError(String(cause?.message ?? cause))
      } finally {
        setBusy(false)
      }
    }

    return h(
      'div',
      { className: 'sab-row', style: { alignItems: 'flex-start', gap: '16px' } },
      h(
        'div',
        { style: { flex: '0 0 220px', display: 'flex', flexDirection: 'column', gap: '6px' } },
        ...plans.map((plan: any) =>
          h(
            Button,
            {
              key: plan.id,
              onClick: () => setSelected(plan.id),
              title: plan.title,
              children: `${PLAN_STATUS_LABEL[plan.status] ?? plan.status} · ${truncate(plan.title, 18)}`,
            },
          ),
        ),
      ),
      h(
        'div',
        { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px' } },
        h(
          'div',
          { className: 'sab-row' },
          h(SourceBadge, { source: sessionOf(snapshot, current.sessionId)?.source ?? current.sessionSource }),
          h('span', { className: 'sab-strong' }, current.title),
          h(Chip, { kind: current.status === 'approved' ? 'ok' : 'warning', children: current.status }),
          current.stale ? h(Chip, { kind: 'critical', children: '可能已失效' }) : null,
          h('span', { className: 'sab-note' }, `提交于 ${fmtTime(current.submittedAt)} · dispatch ${current.dispatchId}`),
        ),
        h('pre', { className: 'sab-pre' }, current.markdown || '（计划正文为空）'),
        h(
          'div',
          { className: 'sab-group' },
          h('h3', { className: 'sab-group-title' }, `scope · ${(current.scope?.items ?? []).length} 项`),
          h(
            'table',
            { className: 'sab-table' },
            h('thead', null, h('tr', null, h('th', null, 'id'), h('th', null, '说明'), h('th', null, 'paths'), h('th', null, 'commands'), h('th', null, 'network'))),
            h(
              'tbody',
              null,
              ...(current.scope?.items ?? []).map((item: any) =>
                h(
                  'tr',
                  { key: item.id },
                  h('td', null, item.id),
                  h('td', null, item.description),
                  h('td', null, (item.paths ?? []).join('\n')),
                  h('td', null, (item.commands ?? []).join('\n')),
                  h('td', null, item.network ? '是' : '否'),
                ),
              ),
            ),
          ),
        ),
        current.status === 'pending_review' && readOnly !== true
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('textarea', {
                className: 'sab-textarea',
                value: feedback,
                placeholder: '修改意见 / 驳回原因（驳回必填）',
                onChange: (event: any) => setFeedback(event.target.value),
              }),
              h(
                'div',
                { className: 'sab-row' },
                h(Button, { primary: true, disabled: busy, onClick: () => void review('approve'), children: '批准' }),
                h(Button, {
                  disabled: busy || feedback.trim().length === 0,
                  onClick: () => void review('changes'),
                  children: '提修改意见',
                }),
                h(Button, {
                  danger: true,
                  disabled: busy || feedback.trim().length === 0,
                  onClick: () => void review('reject'),
                  children: '驳回',
                }),
                h(Button, { onClick: () => onJump(String(current.sessionId)), children: '跳转 session' }),
                error ? h('span', { className: 'sab-error' }, error) : null,
              ),
            )
          : h(
              'div',
              { className: 'sab-row' },
              h(Button, { onClick: () => onJump(String(current.sessionId)), children: '跳转 session' }),
              readOnly === true && current.status === 'pending_review'
                ? canHandlePlan(snapshot, current)
                  ? h(Button, { primary: true, onClick: onButler, children: '在对话里处理 →' })
                  : h(Unsupported, { reason: `${UNSUPPORTED}：这个来源没有计划协议` })
                : null,
              h('span', { className: 'sab-note' }, current.feedback ? `意见：${current.feedback}` : ''),
            ),
      ),
    )
  }

  function DispatchesView(props: any) {
    const { snapshot, api, onJump, composer, readOnly, onButler } = props
    const [targets, setTargets] = React.useState({})
    const [busy, setBusy] = React.useState(null)
    const [error, setError] = React.useState(null)
    if (!snapshot) return h(Empty, { children: '正在读取派发…' })
    const dispatches = snapshot.dispatches ?? []
    return h(
      'div',
      null,
      dispatches.length === 0
        ? h(Empty, { children: '还没有管家派发的任务。用下面的输入框给管家发一句话。' })
        : null,
      ...dispatches.map((dispatch: any) => {
        const target = targets[dispatch.id] ?? ''
        async function reassign() {
          setBusy(dispatch.id)
          setError(null)
          try {
            await api.action('dispatch_reassign', {
              dispatchId: dispatch.id,
              targetSessionId: target.trim(),
            })
          } catch (cause: any) {
            setError(String(cause?.message ?? cause))
          } finally {
            setBusy(null)
          }
        }
        async function mark(outcome: string) {
          setBusy(dispatch.id)
          setError(null)
          try {
            await api.action('dispatch_mark', { dispatchId: dispatch.id, outcome })
          } catch (cause: any) {
            setError(String(cause?.message ?? cause))
          } finally {
            setBusy(null)
          }
        }
        const active =
          dispatch.status === 'accepted' ||
          dispatch.status === 'delivered' ||
          dispatch.status === 'error'
        return h(
          'div',
          { className: 'sab-card', key: dispatch.id },
          h(
            'div',
            { className: 'sab-row' },
            h(Chip, {
              kind: active ? 'ok' : dispatch.status === 'failed' ? 'critical' : 'plain',
              children: DISPATCH_LABEL[dispatch.status] ?? dispatch.status,
            }),
            h(SourceBadge, {
              source: sessionOf(snapshot, dispatch.targetSessionId)?.source ?? dispatch.source,
            }),
            h('span', { className: 'sab-strong' }, dispatch.targetTitle || truncate(dispatch.targetSessionId, 16)),
            h('span', { className: 'sab-note' }, `${dispatch.mode === 'new' ? '新开' : '复用'} · ${dispatch.modeAtDispatch} · ${fmtTime(dispatch.createdAt)}`),
          ),
          h('div', { className: 'sab-kicker' }, truncate(dispatch.text, 400)),
          dispatch.reason ? h('div', { className: 'sab-note' }, `理由：${dispatch.reason}`) : null,
          dispatch.error ? h('div', { className: 'sab-error' }, `错误：${dispatch.error}`) : null,
          h(
            'div',
            { className: 'sab-row' },
            h(Button, { onClick: () => onJump(String(dispatch.targetSessionId)), children: '跳转' }),
            active && readOnly === true
              ? canHandleDispatch(snapshot, dispatch)
                ? h(Button, { primary: true, onClick: onButler, children: '在对话里处理 →' })
                : h(Unsupported, { reason: `${UNSUPPORTED}：不能往这个来源派发或改派` })
              : null,
            active && readOnly !== true && canHandleDispatch(snapshot, dispatch)
              ? h('input', {
                  className: 'sab-input',
                  style: { flex: '0 0 240px', width: 'auto' },
                  value: target,
                  placeholder: '改派到 sessionId',
                  onChange: (event: any) =>
                    setTargets({ ...targets, [dispatch.id]: event.target.value }),
                })
              : null,
            active && readOnly !== true && canHandleDispatch(snapshot, dispatch)
              ? h(Button, {
                  disabled: busy === dispatch.id || target.trim().length === 0,
                  onClick: () => void reassign(),
                  children: '改派',
                })
              : null,
            active && readOnly !== true && canHandleDispatch(snapshot, dispatch)
              ? h(Button, {
                  disabled: busy === dispatch.id,
                  onClick: () => void mark('completed'),
                  title: '任务已经做完：结束这条派发、关掉它的待审计划并解除门禁',
                  children: '标记完成',
                })
              : null,
            active && readOnly !== true && canHandleDispatch(snapshot, dispatch)
              ? h(Button, {
                  disabled: busy === dispatch.id,
                  danger: true,
                  onClick: () => void mark('failed'),
                  title: '放弃这条任务：结束派发、关掉待审计划、解除门禁，并告诉 worker 不用继续',
                  children: '放弃',
                })
              : null,
            active ? null : h('span', { className: 'sab-note' }, '已结束的派发不能改派'),
            error ? h('span', { className: 'sab-error' }, error) : null,
          ),
        )
      }),
      composer,
    )
  }

  function AuditView(props: any) {
    const { snapshot } = props
    const [kind, setKind] = React.useState('')
    if (!snapshot) return h(Empty, { children: '正在读取审计…' })
    const entries = (snapshot.audit ?? []).filter((entry: any) => !kind || entry.kind === kind)
    const kinds = [...new Set((snapshot.audit ?? []).map((entry: any) => entry.kind))] as string[]
    return h(
      'div',
      null,
      h(
        'div',
        { className: 'sab-row', style: { marginBottom: '10px' } },
        h(Button, { onClick: () => setKind(''), children: '全部' }),
        ...kinds.map((item) => h(Button, { key: item, onClick: () => setKind(item), children: item })),
      ),
      entries.length === 0
        ? h(Empty, { children: '还没有审计记录。' })
        : h(
            'table',
            { className: 'sab-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, '时间'),
                h('th', null, 'kind'),
                h('th', null, 'action'),
                h('th', null, '工具'),
                h('th', null, '风险'),
                h('th', null, '决策'),
                h('th', null, 'by'),
                h('th', null, '依据 / 备注'),
              ),
            ),
            h(
              'tbody',
              null,
              ...entries.slice(0, 200).map((entry: any) =>
                h(
                  'tr',
                  { key: entry.id },
                  h('td', null, fmtTime(entry.at)),
                  h('td', null, entry.kind),
                  h('td', null, entry.action),
                  h('td', null, entry.toolName ?? '-'),
                  h('td', null, entry.risk ? RISK_LABEL[entry.risk] ?? entry.risk : '-'),
                  h('td', null, entry.decision ?? '-'),
                  h('td', null, entry.by ?? '-'),
                  h(
                    'td',
                    null,
                    [entry.planId, entry.planItemId, entry.note].filter(Boolean).join(' · ') || '-',
                  ),
                ),
              ),
            ),
          ),
    )
  }

  function ModesView(props: any) {
    const { snapshot, api, readOnly } = props
    const [busy, setBusy] = React.useState(null)
    const [error, setError] = React.useState(null)
    if (!snapshot) return h(Empty, { children: '正在读取项目…' })
    if ((snapshot.projects ?? []).length === 0) return h(Empty, { children: '还没有项目记录。' })
    async function toggle(project: any) {
      const next = project.mode === 'plan_review' ? 'gate_confirm' : 'plan_review'
      const note =
        next === 'gate_confirm'
          ? '切换到卡点确认：待审计划会被取消，门禁立即解除。继续？'
          : '切换到计划审查：从该项目的下一次派发开始要求计划；正在执行的任务不受影响。继续？'
      if (!window.confirm(note)) return
      setBusy(project.key)
      setError(null)
      try {
        await api.action('project_mode', { projectKey: project.key, mode: next })
      } catch (cause: any) {
        setError(String(cause?.message ?? cause))
      } finally {
        setBusy(null)
      }
    }
    return h(
      'div',
      null,
      ...(snapshot.projects ?? []).map((project: any) => {
        const active = (snapshot.dispatches ?? []).filter(
          (dispatch: any) =>
            dispatch.workspaceKey === project.key &&
            (dispatch.status === 'accepted' ||
              dispatch.status === 'delivered' ||
              dispatch.status === 'error'),
        ).length
        const blockers = (snapshot.blockers ?? []).filter((blocker: any) => {
          const session = (snapshot.sessions ?? []).find(
            (item: any) => item.sessionId === blocker.sessionId,
          )
          return session?.projectKey === project.key
        }).length
        return h(
          'div',
          { className: 'sab-card', key: project.key },
          h(
            'div',
            { className: 'sab-row' },
            h('span', { className: 'sab-strong' }, project.title),
            h(Chip, {
              kind: project.mode === 'plan_review' ? 'warning' : 'ok',
              children: project.mode === 'plan_review' ? '计划审查' : '卡点确认',
            }),
            h('span', { className: 'sab-note' }, project.cwd),
          ),
          h(
            'div',
            { className: 'sab-row' },
            h('span', { className: 'sab-note' }, `进行中派发 ${active} 个 · 未处理卡点 ${blockers} 个`),
            readOnly === true
              ? h('span', { className: 'sab-note' }, '模式切换请在管家对话里说一句')
              : h(Button, {
                  disabled: busy === project.key,
                  onClick: () => void toggle(project),
                  children: project.mode === 'plan_review' ? '切到卡点确认' : '切到计划审查',
                }),
          ),
        )
      }),
      error ? h('div', { className: 'sab-error' }, error) : null,
    )
  }

  // ------------------------------------------------------------------- panel

  const TABS = [
    { id: 'overview', label: '概览' },
    { id: 'log', label: '日志' },
    { id: 'details', label: '明细' },
  ]

  /** 明细：全部只读，交互一律回管家对话。 */
  function DetailsView(props: any) {
    const { snapshot, api, onJump, onButler } = props
    if (!snapshot) return h(Empty, { children: '正在读取管家状态…' })
    return h(
      'div',
      null,
      h(
        Section,
        { title: `卡点 · ${(snapshot.blockers ?? []).length}` },
        (snapshot.blockers ?? []).length === 0
          ? [h(Empty, { key: 'empty', children: '没有等你处理的卡点。' })]
          : (snapshot.blockers ?? []).map((blocker: any) =>
              h(BlockerCard, {
                key: blocker.id,
                api,
                blocker,
                onJump,
                readOnly: true,
                onButler,
                source: sessionOf(snapshot, blocker.sessionId)?.source ?? blocker.source,
                capabilities: sessionOf(snapshot, blocker.sessionId)?.capabilities,
              }),
            ),
      ),
      h(
        Section,
        { title: '计划' },
        [h(PlansView, { key: 'plans', snapshot, api, onJump, readOnly: true, onButler })],
      ),
      h(
        Section,
        { title: '派发' },
        [h(DispatchesView, { key: 'dispatches', snapshot, api, onJump, readOnly: true, onButler })],
      ),
      h(
        Section,
        { title: '项目模式' },
        [h(ModesView, { key: 'modes', snapshot, api, readOnly: true })],
      ),
    )
  }

  function Panel(props: any) {
    const { store, api, nav } = props
    const state = useStore(store)
    const [tab, setTab] = React.useState('overview')
    const snapshot = state.snapshot
    const openBlockers = snapshot ? (snapshot.blockers ?? []).length : 0
    const pendingPlans = snapshot
      ? (snapshot.plans ?? []).filter((plan: any) => plan.status === 'pending_review').length
      : 0
    const butlerId = snapshot?.butler?.sessionId

    function counts(id: string): string | null {
      if (id === 'overview') return openBlockers > 0 ? String(openBlockers) : null
      if (id === 'details') {
        const total = openBlockers + pendingPlans
        return total > 0 ? String(total) : null
      }
      return null
    }

    const onJump = (id: string) => nav.openSession(id)
    const onButler = () => {
      if (butlerId) nav.openSession(butlerId)
      else
        void api.action('ensure_butler', {}).then((value: any) => {
          const id = value?.value?.sessionId
          if (id) nav.openSession(id)
        })
    }

    return h(
      'div',
      { className: 'sab-root' },
      h(
        'header',
        { className: 'sab-head' },
        h('h2', { className: 'sab-title' }, 'SuperAgent 管家'),
        h(
          'span',
          { className: 'sab-meta' },
          snapshot
            ? `管家 ${STATUS_LABEL[snapshot.butler?.status] ?? snapshot.butler?.status ?? '未知'} · 同步 ${fmtTime(snapshot.generatedAt)}`
            : state.error
              ? '连接失败'
              : '加载中…',
        ),
        h('span', { className: 'sab-spacer' }),
        h(Button, {
          onClick: onButler,
          children: butlerId ? '打开管家会话' : '创建管家会话',
        }),
        h(Button, { onClick: () => void store.refresh(), children: '刷新' }),
      ),
      h(
        'div',
        { className: 'sab-meta', style: { padding: '0 18px 8px' } },
        '这里只读：批准、驳回、回答、标记完成都在管家对话里点按钮。',
      ),
      state.error
        ? h('div', { className: 'sab-error', style: { padding: '8px 18px' } }, `连接错误：${state.error}`)
        : null,
      h(
        'nav',
        { className: 'sab-tabs', role: 'tablist' },
        ...TABS.map((item) =>
          h(
            'button',
            {
              key: item.id,
              type: 'button',
              role: 'tab',
              className: 'sab-tab',
              'data-active': tab === item.id ? 'true' : 'false',
              'aria-selected': tab === item.id,
              onClick: () => setTab(item.id),
            },
            counts(item.id) ? `${item.label} ${counts(item.id)}` : item.label,
          ),
        ),
      ),
      h(
        'div',
        { className: 'sab-body' },
        tab === 'overview'
          ? h(OverviewView, { snapshot, onJump, onButler })
          : tab === 'log'
            ? h(AuditView, { snapshot })
            : h(DetailsView, { snapshot, api, onJump, onButler }),
      ),
    )
  }

  function PanelIcon(props: any) {
    const size = Number(props?.size ?? 18)
    return h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M4 13a8 8 0 0 1 16 0' }),
      h('path', { d: 'M2 13h20' }),
      h('path', { d: 'M12 5V3' }),
      h('circle', { cx: 8.5, cy: 17, r: 2.2 }),
      h('circle', { cx: 15.5, cy: 17, r: 2.2 }),
    )
  }

  function SessionBadge(props: any) {
    const { store, api } = props
    const state = useStore(store)
    const sessionId = String(props?.sessionId ?? props?.id ?? '')
    if (!state.snapshot || !sessionId) return null
    const session = (state.snapshot.sessions ?? []).find((item: any) => item.sessionId === sessionId)
    const blockers = (state.snapshot.blockers ?? []).filter(
      (blocker: any) => blocker.sessionId === sessionId,
    )
    const dispatch = (state.snapshot.dispatches ?? []).find(
      (item: any) =>
        item.targetSessionId === sessionId &&
        (item.status === 'accepted' || item.status === 'delivered'),
    )
    if (!session && blockers.length === 0 && !dispatch) return null
    const tone =
      blockers.some((blocker: any) => blocker.severity === 'critical')
        ? 'error'
        : blockers.length > 0
          ? 'warn'
          : dispatch
            ? 'info'
            : null
    if (!tone) return null
    const title = [
      blockers.length > 0 ? `${blockers.length} 个卡点：${blockers.map((b: any) => KIND_LABEL[b.kind] ?? b.kind).join('、')}` : '',
      dispatch ? `管家派发：${truncate(dispatch.text, 60)}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    return h(
      'span',
      { className: 'sab-badge', title, 'aria-label': title },
      h('span', { className: 'sab-dot', 'data-tone': tone }),
      blockers.length > 0 ? String(blockers.length) : '派',
    )
  }

  function SessionHover(props: any) {
    const { store } = props
    const state = useStore(store)
    const sessionId = String(props?.sessionId ?? props?.id ?? '')
    if (!state.snapshot || !sessionId) return null
    const session = (state.snapshot.sessions ?? []).find((item: any) => item.sessionId === sessionId)
    const soft = session?.softStatus
    const blockers = (state.snapshot.blockers ?? []).filter(
      (blocker: any) => blocker.sessionId === sessionId,
    )
    if (!soft && blockers.length === 0) return null
    return h(
      'div',
      { className: 'sab-hover' },
      soft ? h('div', null, `目标：${truncate(soft.goal, 80)}`) : null,
      soft?.done?.length ? h('div', null, `已完成 ${soft.done.length} 项`) : null,
      soft?.next?.length ? h('div', null, `下一步：${truncate(soft.next[0], 60)}`) : null,
      soft
        ? h('div', null, `软状态来源：${soft.source === 'tool' ? 'worker 上报' : '日志摘要'} · ${fmtTime(soft.reportedAt)}`)
        : null,
      blockers.length > 0
        ? h('div', null, `卡点：${blockers.map((b: any) => KIND_LABEL[b.kind] ?? b.kind).join('、')}`)
        : null,
    )
  }

  // --------------------------------------------------------------- 提醒卡片

  const DONE_LABEL: Record<string, string> = {
    approve: '已允许',
    reject: '已拒绝',
    answer: '已转发',
    dismiss: '已忽略',
    retry: '已催办',
    dispatch_completed: '已标记完成',
    dispatch_failed: '已放弃',
  }

  const RESOLVED_LABEL: Record<string, string> = {
    resolved: '已处理',
    // 用户点按钮、被代批、条件消失都会落到 auto_resolved；对用户来说都是「已处理」。
    auto_resolved: '已处理',
    dismissed: '已忽略',
    superseded: '已被替代',
  }

  const PLAN_STATUS_LABEL: Record<string, string> = {
    pending_review: '待审',
    approved: '已批准',
    changes_requested: '待修改',
    rejected: '已驳回',
    superseded: '已被替代',
    cancelled: '已取消',
    skipped: '无需审查',
  }

  /** 提醒卡片「还能不能点」，全部由快照派生：处理完的那一秒就不再可点。 */
  function noticeState(notice: any, snapshot: any): { settled: boolean; text: string } {
    if (!notice) return { settled: true, text: '' }
    if (notice.blockerId) {
      const open = (snapshot?.blockers ?? []).find((item: any) => item.id === notice.blockerId)
      if (open) return { settled: false, text: '' }
      const resolved = (snapshot?.resolvedBlockers ?? []).find(
        (item: any) => item.id === notice.blockerId,
      )
      if (resolved) {
        const label = RESOLVED_LABEL[resolved.status] ?? '已处理'
        return {
          settled: true,
          text: [
            label,
            resolved.resolution,
            resolved.resolvedAt ? fmtTime(resolved.resolvedAt) : '',
          ]
            .filter(Boolean)
            .join(' · '),
        }
      }
      return { settled: true, text: '已处理（记录已归档）' }
    }
    if (notice.planId) {
      const plan = (snapshot?.plans ?? []).find((item: any) => item.id === notice.planId)
      if (!plan) return { settled: true, text: '计划已归档' }
      return plan.status === 'pending_review'
        ? { settled: false, text: '' }
        : { settled: true, text: PLAN_STATUS_LABEL[plan.status] ?? plan.status }
    }
    if (notice.dispatchId) {
      const dispatch = (snapshot?.dispatches ?? []).find(
        (item: any) => item.id === notice.dispatchId,
      )
      if (!dispatch) return { settled: true, text: '' }
      if (
        dispatch.status === 'accepted' ||
        dispatch.status === 'delivered' ||
        dispatch.status === 'error'
      ) {
        return { settled: false, text: '' }
      }
      return { settled: true, text: DISPATCH_LABEL[dispatch.status] ?? dispatch.status }
    }
    return { settled: false, text: '' }
  }

  /**
   * 一条提醒的卡片。数据全部来自消息 source（持久、可回放），状态来自实时快照。
   * 点击后立刻落本地 settled 态，不等刷新；刷新失败也不会让按钮重新变可点。
   */
  function NoticeCard(props: any) {
    const { notice, snapshot, api, store, onJump } = props
    const [text, setText] = React.useState('')
    const [busy, setBusy] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [done, setDone] = React.useState(null)
    if (!notice) return null
    const derived = noticeState(notice, snapshot)
    const settled = Boolean(done) || derived.settled
    const actions: any[] = Array.isArray(notice.actions) ? notice.actions : []
    const inline = actions.filter((item: any) => item.verb !== 'open_session')
    const openers = actions.filter((item: any) => item.verb === 'open_session')
    const textAction = inline.find((item: any) => item.requiresText)

    async function act(action: any, override?: string) {
      if (action.verb === 'open_session') {
        if (notice.sessionId) onJump(String(notice.sessionId))
        return
      }
      const value = String(override ?? text).trim()
      if (action.requiresText && value.length === 0) {
        setError('请先填写内容')
        return
      }
      setBusy(action.verb)
      setError(null)
      try {
        if (action.verb === 'dispatch_completed' || action.verb === 'dispatch_failed') {
          await api.action('dispatch_mark', {
            dispatchId: notice.dispatchId,
            outcome: action.verb === 'dispatch_completed' ? 'completed' : 'failed',
            note: value || undefined,
          })
        } else {
          await api.action('blocker_action', {
            blockerId: notice.blockerId,
            action: action.verb,
            text: value || undefined,
          })
        }
        setDone(DONE_LABEL[action.verb] ?? '已处理')
        setText('')
        void store?.refresh?.()
      } catch (cause: any) {
        setError(String(cause?.message ?? cause))
        void store?.refresh?.()
      } finally {
        setBusy(null)
      }
    }

    const severity = String(notice.severity ?? 'info')
    const chip = severity === 'critical' ? 'critical' : severity === 'warning' ? 'warning' : 'plain'

    return h(
      'div',
      {
        className: 'sab-notice',
        'data-sev': severity,
        'data-settled': settled ? 'true' : undefined,
        'data-notice-kind': notice.kind,
      },
      h(
        'div',
        { className: 'sab-notice-head' },
        h(Chip, { kind: chip, children: KIND_LABEL[notice.category] ?? notice.category }),
        notice.source ? h(SourceBadge, { source: notice.source }) : null,
        h('span', { className: 'sab-notice-title' }, notice.title),
        h('span', { className: 'sab-note' }, fmtTime(notice.at)),
      ),
      notice.detail ? h('div', { className: 'sab-notice-detail' }, truncate(notice.detail, 400)) : null,
      notice.neededAction
        ? h('div', { className: 'sab-notice-detail' }, `需要你：${notice.neededAction}`)
        : null,
      (notice.options ?? []).length > 0 && !settled
        ? h(
            'div',
            { className: 'sab-notice-actions' },
            ...(notice.options as string[]).map((label) =>
              h(Button, {
                key: label,
                disabled: Boolean(busy),
                onClick: () => void act({ verb: 'answer', requiresText: false }, label),
                children: label,
              }),
            ),
          )
        : null,
      textAction && !settled
        ? h('textarea', {
            className: 'sab-textarea',
            value: text,
            placeholder: textAction.placeholder ?? '输入内容（会转发给该 session）',
            onChange: (event: any) => setText(event.target.value),
          })
        : null,
      h(
        'div',
        { className: 'sab-notice-actions' },
        ...(settled
          ? []
          : inline.map((action: any) =>
              h(Button, {
                key: action.verb,
                primary: action.style === 'primary',
                danger: action.style === 'danger',
                disabled: Boolean(busy) || (action.requiresText && text.trim().length === 0),
                onClick: () => void act(action),
                children: busy === action.verb ? '处理中…' : action.label,
              }),
            )),
        ...openers.map((action: any) =>
          h(Button, {
            key: action.verb,
            onClick: () => void act(action),
            children: action.label,
          }),
        ),
        done ? h('span', { className: 'sab-notice-status' }, `✓ ${done}`) : null,
        !done && settled && derived.text
          ? h('span', { className: 'sab-notice-status' }, `✓ ${derived.text}`)
          : null,
        error ? h('span', { className: 'sab-error' }, error) : null,
      ),
    )
  }

  /** 抢注后的消息行：整行由我们渲染，不再是用户气泡。 */
  function NoticeRow(props: any) {
    const { node, store, api, nav } = props
    const state = useStore(store)
    const source = node?.data?.source
    const notice = source?.notice
    if (!notice) return null
    // 进度类注入带 modelOnly：只给模型看，面板已经有实时载体，不再渲一次（幂等要求）
    if (source?.modelOnly === true) return null
    return h(
      'div',
      { className: 'sab-notice-row' },
      h(NoticeCard, {
        notice,
        snapshot: state.snapshot,
        api,
        store,
        onJump: (id: string) => nav.openSession(id),
      }),
    )
  }

  /**
   * 输入框上方的「待处理」条：管家 idle 时 inject 还没落日志，靠它在对话里兜底。
   * 只出现在管家会话。
   */
  function NoticeDock(props: any) {
    const { store, api, nav, sessionId } = props
    const state = useStore(store)
    const [open, setOpen] = React.useState(false)
    const snapshot = state.snapshot
    const butlerId = snapshot?.butler?.sessionId
    if (!butlerId || String(sessionId) !== String(butlerId)) return null
    const notices = (snapshot.blockerNotices ?? []).filter(
      (notice: any) =>
        Array.isArray(notice.actions) && notice.actions.some((action: any) => action.verb !== 'open_session'),
    )
    if (notices.length === 0) return null
    const shown = open ? notices.slice(0, 6) : notices.slice(0, 1)
    return h(
      'div',
      { className: 'sab-dock' },
      h(
        'button',
        {
          type: 'button',
          className: 'sab-dock-head',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen(!open),
        },
        h('span', { className: 'sab-strong' }, `管家待处理 ${notices.length} 条`),
        h('span', { className: 'sab-note' }, open ? '收起' : '展开'),
      ),
      h(
        'div',
        { className: 'sab-dock-list' },
        ...shown.map((notice: any) =>
          h(NoticeCard, {
            key: notice.id,
            notice,
            snapshot,
            api,
            store,
            onJump: (id: string) => nav.openSession(id),
          }),
        ),
      ),
    )
  }

  // ------------------------------------------------------------------ 概览

  function Stat(props: any) {
    return h(
      'div',
      { className: 'sab-stat' },
      h('span', { className: 'sab-stat-value' }, props.children),
      h('span', { className: 'sab-stat-label' }, props.label),
    )
  }

  function Section(props: any) {
    return h(
      'section',
      { className: 'sab-section' },
      h('h3', { className: 'sab-group-title' }, props.title),
      ...(props.children ?? []),
    )
  }

  function OverviewView(props: any) {
    const { snapshot, onJump, onButler } = props
    const [sourceFilter, setSourceFilter] = React.useState('all')
    if (!snapshot) return h(Empty, { children: '正在读取管家状态…' })
    const blockers = snapshot.blockers ?? []
    const pendingPlans = (snapshot.plans ?? []).filter((plan: any) => plan.status === 'pending_review')
    const active = (snapshot.dispatches ?? []).filter(
      (dispatch: any) =>
        dispatch.status === 'accepted' ||
        dispatch.status === 'delivered' ||
        dispatch.status === 'error',
    )
    const allSessions = snapshot.sessions ?? []
    const sourceCounts = new Map<string, number>()
    for (const session of allSessions) {
      const source = String(session.source ?? 'dsh')
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1)
    }
    const sessions =
      sourceFilter === 'all'
        ? allSessions
        : allSessions.filter((session: any) => String(session.source ?? 'dsh') === sourceFilter)
    const running = sessions.filter((session: any) => session.running).length
    const withBlockers = sessions.filter((session: any) => (session.openBlockerCount ?? 0) > 0).length
    const counts = new Map<string, number>()
    for (const blocker of blockers) {
      counts.set(blocker.kind, (counts.get(blocker.kind) ?? 0) + 1)
    }
    const recent = (snapshot.audit ?? []).slice(0, 8)
    const resolved = (snapshot.resolvedBlockers ?? []).slice(0, 6)

    return h(
      'div',
      null,
      h(
        'div',
        { className: 'sab-grid' },
        h(Stat, { label: '管家状态' }, STATUS_LABEL[snapshot.butler?.status] ?? '未知'),
        h(Stat, { label: '待处理卡点' }, String(blockers.length)),
        h(Stat, { label: '待审计划' }, String(pendingPlans.length)),
        h(Stat, { label: '进行中派发' }, String(active.length)),
        h(Stat, { label: '运行中会话' }, String(running)),
        h(Stat, { label: '有卡点会话' }, String(withBlockers)),
      ),
      h(
        Section,
        { title: '卡点分布' },
        counts.size === 0
          ? [h(Empty, { key: 'empty', children: '没有待处理卡点。' })]
          : [
              h(
                'div',
                { className: 'sab-row', key: 'chips' },
                ...[...counts.entries()].map(([kind, count]) =>
                  h(Chip, { key: kind, kind: 'warning', children: `${KIND_LABEL[kind] ?? kind} ${count}` }),
                ),
              ),
            ],
      ),
      h(
        Section,
        { title: `进度 · ${(snapshot.progressNotices ?? []).length}` },
        (snapshot.progressNotices ?? []).length === 0
          ? [h(Empty, { key: 'empty', children: '还没有进度通知。派发任务后，worker 上报进展时这里会自己出现。' })]
          : [
              h(
                'div',
                { className: 'sab-timeline', key: 'timeline' },
                ...(snapshot.progressNotices ?? []).slice(0, 20).map((notice: any) =>
                  h(
                    'div',
                    { className: 'sab-tl-item', key: notice.id, 'data-kind': notice.category },
                    h('span', { className: 'sab-tl-dot' }),
                    h(
                      'div',
                      { className: 'sab-tl-body' },
                      h(
                        'div',
                        { className: 'sab-row' },
                        h(SourceBadge, { source: notice.source }),
                        h('span', { className: 'sab-strong' }, notice.title),
                        h('span', { className: 'sab-note' }, fmtTime(notice.at)),
                      ),
                      notice.detail ? h('div', { className: 'sab-note' }, truncate(notice.detail, 220)) : null,
                      notice.sessionTitle
                        ? h('div', { className: 'sab-note' }, `会话：${notice.sessionTitle}`)
                        : null,
                    ),
                  ),
                ),
              ),
            ],
      ),
      h(
        Section,
        { title: `会话 · ${sessions.length}${sourceFilter === 'all' ? '' : ` / 共 ${allSessions.length}`}` },
        [
          h(
            'div',
            { className: 'sab-filters', key: 'filters' },
            ...[['all', '全部'], ...SOURCE_KINDS.filter((kind) => sourceCounts.has(kind)).map((kind) => [kind, SOURCE_LABEL[kind] ?? kind])].map(
              ([value, label]: any) =>
                h(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    className: 'sab-filter',
                    'data-active': sourceFilter === value ? 'true' : 'false',
                    onClick: () => setSourceFilter(value),
                  },
                  value === 'all' ? null : h(SourceBadge, { source: value }),
                  value === 'all' ? label : null,
                  h('span', { style: { opacity: 0.7 } }, String(value === 'all' ? allSessions.length : sourceCounts.get(value) ?? 0)),
                ),
            ),
          ),
          sessions.length === 0
            ? h(Empty, { key: 'empty', children: sourceFilter === 'all' ? '还没有会话记录。' : '这个来源还没有会话。' })
            : h(
                'table',
                { className: 'sab-table', key: 'table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, '来源'),
                    h('th', null, '会话'),
                    h('th', null, '状态'),
                    h('th', null, '卡点'),
                    h('th', null, '最近活动'),
                    h('th', null, ''),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  ...sessions.slice(0, 40).map((session: any) =>
                    h(
                      'tr',
                      { key: session.sessionId },
                      h('td', null, h(SourceBadge, { source: session.source ?? 'dsh' })),
                      h(
                        'td',
                        null,
                        session.isButler ? `🅑 ${session.title}` : session.title,
                        session.cwd ? h('div', { className: 'sab-note' }, session.cwd) : null,
                      ),
                      h(
                        'td',
                        null,
                        h(Chip, {
                          kind: chipKind(session.hardStatus),
                          children: STATUS_LABEL[session.hardStatus] ?? session.hardStatus,
                        }),
                      ),
                      h('td', null, String(session.openBlockerCount ?? 0)),
                      h('td', null, fmtTime(session.lastActivityAt)),
                      h(
                        'td',
                        null,
                        // 外部来源的会话打不开（dsh 没有它的 session），渲染成不可点
                        String(session.source ?? 'dsh') === 'dsh'
                          ? h(Button, {
                              onClick: () => onJump(String(session.sessionId)),
                              children: '打开',
                            })
                          : h(Unsupported, {
                              label: '打开',
                              reason: `${UNSUPPORTED}：只能看状态与摘要，会话在 ${SOURCE_LABEL[session.source] ?? session.source} 里`,
                            }),
                      ),
                    ),
                  ),
                ),
              ),
          sourceCounts.has('codex')
            ? h(
                'p',
                { className: 'sab-limit', key: 'codex-limit' },
                '已知限制：Codex 不区分主会话与子会话，这里列出的都按 root 处理；如需排除，可在本地把它标记为非 root。',
              )
            : null,
        ],
      ),
      h(
        Section,
        { title: '项目' },
        (snapshot.projects ?? []).length === 0
          ? [h(Empty, { key: 'empty', children: '还没有项目记录。' })]
          : [
              h(
                'div',
                { className: 'sab-row', key: 'projects' },
                ...(snapshot.projects ?? []).map((project: any) =>
                  h(Chip, {
                    key: project.key,
                    kind: project.mode === 'plan_review' ? 'warning' : 'ok',
                    children: `${project.title} · ${project.mode === 'plan_review' ? '计划审查' : '卡点确认'}`,
                  }),
                ),
              ),
            ],
      ),
      h(
        Section,
        { title: '最近日志' },
        recent.length === 0
          ? [h(Empty, { key: 'empty', children: '还没有日志。' })]
          : [
              h(
                'table',
                { className: 'sab-table', key: 'table' },
                h('thead', null, h('tr', null, h('th', null, '时间'), h('th', null, '类型'), h('th', null, '动作'), h('th', null, '决策'), h('th', null, '备注'))),
                h(
                  'tbody',
                  null,
                  ...recent.map((entry: any) =>
                    h(
                      'tr',
                      { key: entry.id },
                      h('td', null, fmtTime(entry.at)),
                      h('td', null, entry.kind),
                      h('td', null, entry.action),
                      h('td', null, entry.decision ?? '-'),
                      h('td', null, truncate(entry.note ?? entry.argsSummary ?? '-', 80)),
                    ),
                  ),
                ),
              ),
            ],
      ),
      h(
        Section,
        { title: '最近已处理' },
        resolved.length === 0
          ? [h(Empty, { key: 'empty', children: '还没有处理记录。' })]
          : resolved.map((item: any) =>
              h(
                'div',
                { className: 'sab-card', key: item.id },
                h(
                  'div',
                  { className: 'sab-row' },
                  h(Chip, { kind: chipKind(item.severity ?? 'plain'), children: KIND_LABEL[item.kind] ?? item.kind }),
                  h('span', { className: 'sab-note' }, truncate(item.summary, 160)),
                ),
                h(
                  'div',
                  { className: 'sab-note' },
                  `${RESOLVED_LABEL[item.status] ?? item.status}${item.resolution ? ` · ${item.resolution}` : ''} · ${fmtTime(item.resolvedAt)}`,
                ),
              ),
            ),
      ),
      h('div', { className: 'sab-row' }, h(Button, { onClick: onButler, children: '打开管家会话' })),
    )
  }

  // -------------------------------------------------------------------- apply

  const inject = ['slots', 'layout', 'uiWorkspace', 'uiConversation']

  function apply(ctx: any) {
    const api = {
      async getState() {
        const response = await fetch(STATE_URL, { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      },
      async action(action: string, payload: any) {
        const response = await fetch(ACTION_URL, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, payload }),
        })
        let body: any = null
        try {
          body = await response.json()
        } catch {
          body = null
        }
        if (!response.ok || body?.ok === false) {
          // 路由把业务错误放在 value.message 里；直接显示「HTTP 400」对用户没有意义。
          throw new Error(
            String(body?.message ?? body?.value?.message ?? `HTTP ${response.status}`),
          )
        }
        return body?.value ?? body
      },
    }

    const store = createStore(api)
    const nav = {
      openSession(sessionId: string) {
        try {
          ctx.layout.selectPanel(null)
        } catch {
          // panel switching is best effort
        }
        try {
          ctx.uiWorkspace.openSession(sessionId)
        } catch {
          // a missing or archived session leaves the panel in place
        }
      },
    }

    ctx.effect(() => {
      const style = document.createElement('style')
      style.setAttribute('data-superagent', 'styles')
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        try {
          document.head.removeChild(style)
        } catch {
          // ignore
        }
      }
    }, 'superagent:styles')

    ctx.effect(() => () => store.dispose(), 'superagent:store')

    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => '管家',
        },
        PanelIcon,
      ),
    )

    ctx.slots.inject('main', () =>
      ctx.slots.register(
        {
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ store, api, nav }),
        },
        Panel,
      ),
    )

    ctx.slots.inject('sidebar.session.row.leading', () =>
      ctx.slots.register(
        {
          name: 'sidebar.session.row.leading',
          id: 'superagent-mark',
          order: 12,
          inject: () => ({ store, api }),
        },
        SessionBadge,
      ),
    )

    ctx.slots.inject('sidebar.session.row.hover', () =>
      ctx.slots.register(
        {
          name: 'sidebar.session.row.hover',
          id: 'superagent-soft-status',
          order: 12,
          inject: () => ({ store }),
        },
        SessionHover,
      ),
    )

    // ① 抢注带 `superagent-notice` source 的 user/message：整行由我们渲染（不再是用户气泡）。
    //    降级路径：本插件没加载时，dsh 原生把它渲染成一条 notice 上下文行。
    const uiConversation = typeof ctx.get === 'function' ? ctx.get('uiConversation') : ctx.uiConversation
    try {
      if (!uiConversation?.events?.register) throw new Error('uiConversation service unavailable')
      uiConversation.events.register({
        kind: 'superagent-notice',
        target: 'chat',
        match(event: any) {
          if (event?.type !== 'user/message') return null
          if (event.surfaceOp !== 'append') return null
          const source = event?.data?.source
          if (!source || source.kind !== 'superagent-notice') return null
          return { id: String(event.data.id), role: 'start', exclusive: true }
        },
        start(_context: any, match: any) {
          const event = match.event
          return {
            seq: event.seq,
            time: event.time,
            content: event.data.content,
            source: event.data.source,
          }
        },
        update(context: any) {
          return context.state
        },
        buildViewNode(context: any) {
          if (!context?.state) return null
          return {
            key: context.key,
            id: context.id,
            kind: 'superagent-notice',
            target: 'chat',
            anchorSeq: context.state.seq,
            location: context.start?.location ?? { kind: 'unresolved' },
            visibility: 'visible',
            data: context.state,
          }
        },
      })
    } catch (error) {
      console.warn('[superagent-butler] notice definition registration failed:', error)
    }

    // ② 渲染这一行。
    try {
      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.node',
            key: 'superagent-notice',
            inject: () => ({ store, api, nav }),
          },
          NoticeRow,
        ),
      )
    } catch (error) {
      console.warn('[superagent-butler] notice row registration failed:', error)
    }

    // ③ 管家会话输入框上方的「待处理」条：管家 idle 时 inject 还没落日志，靠它兜底。
    try {
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'superagent-notices',
            order: 8,
            inject: (sessionId: string) => ({ store, api, nav, sessionId }),
          },
          NoticeDock,
        ),
      )
    } catch (error) {
      console.warn('[superagent-butler] notice dock registration failed:', error)
    }
  }

  ;(window as any).__ModuleLoader__.load({
    id: '@local/dsh-superagent-butler',
    factory(require: any) {
      React = require('react')
      h = React.createElement
      const module = { exports: {} as any }
      const exports = module.exports
      exports.apply = apply
      exports.inject = inject
      return module.exports
    },
  })
})()
