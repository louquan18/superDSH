import type {
  Approval,
  AuditEntry,
  Blocker,
  Dispatch,
  ManagedSession,
  Meta,
  Plan,
  ProgressNoticeRecord,
  Project,
} from './types.js'
import { now, shortId } from './util.js'

/** per-record 键只允许这些字符（dsh-storage-json 的 assertSafeKey 规则）。 */
const SAFE_KEY = /^[a-zA-Z0-9_-]+$/

/** 判断一个外部来源的会话 id 能不能安全落库。 */
export function isSafeRecordKey(key: string): boolean {
  return SAFE_KEY.test(String(key ?? ''))
}

/**
 * storageDomain 的 valueSchema 只要求运行时有一个 parse 方法。
 * 这里不引入 zod，避免插件在 profile 里解析额外依赖。
 */
function schema<T>(check: (value: any) => boolean) {
  return {
    parse(value: unknown): T {
      if (!check(value)) throw new Error('invalid superagent record')
      return value as T
    },
  }
}

const isObject = (value: any) =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const hasString = (value: any, key: string) =>
  isObject(value) && typeof value[key] === 'string'

export const STORAGE_SPEC: any = {
  name: 'superagent',
  version: 1,
  layout: 'per-record',
  tables: {
    meta: {
      valueSchema: schema<Meta>(
        (value) => isObject(value) && typeof value.schemaVersion === 'number',
      ),
    },
    projects: {
      valueSchema: schema<Project>(
        (value) =>
          hasString(value, 'key') &&
          hasString(value, 'cwd') &&
          (value.mode === 'plan_review' || value.mode === 'gate_confirm'),
      ),
    },
    sessions: {
      valueSchema: schema<ManagedSession>(
        (value) => hasString(value, 'sessionId') && typeof value.isButler === 'boolean',
      ),
    },
    dispatches: {
      valueSchema: schema<Dispatch>(
        (value) =>
          hasString(value, 'id') &&
          hasString(value, 'targetSessionId') &&
          typeof value.status === 'string',
      ),
    },
    plans: {
      valueSchema: schema<Plan>(
        (value) =>
          hasString(value, 'id') &&
          hasString(value, 'sessionId') &&
          hasString(value, 'dispatchId') &&
          typeof value.status === 'string',
      ),
    },
    blockers: {
      valueSchema: schema<Blocker>(
        (value) =>
          hasString(value, 'id') &&
          hasString(value, 'sessionId') &&
          typeof value.kind === 'string' &&
          typeof value.status === 'string',
      ),
    },
    approvals: {
      valueSchema: schema<Approval>(
        (value) =>
          hasString(value, 'id') &&
          hasString(value, 'sessionId') &&
          typeof value.status === 'string',
      ),
    },
    audit: {
      valueSchema: schema<AuditEntry>(
        (value) => hasString(value, 'id') && typeof value.at === 'number',
      ),
    },
  },
}

type Table<T> = {
  get(key: string): T | undefined
  entries(): IterableIterator<[string, T]>
  keys(): IterableIterator<string>
  readonly size: number
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  update(key: string, fn: (current: T) => T): Promise<T>
}

export class Store {
  private constructor(private readonly domain: any) {}

  static async open(ctx: any): Promise<Store> {
    const domain = await ctx.storageDomain.open(STORAGE_SPEC)
    return new Store(domain)
  }

  close(): Promise<void> {
    return this.domain.close()
  }

  private table<T>(name: string): Table<T> {
    return this.domain.table(name) as Table<T>
  }

  private list<T>(name: string): T[] {
    return [...this.table<T>(name).entries()].map(([, value]) => value)
  }

  async getMeta(): Promise<Meta> {
    const table = this.table<Meta>('meta')
    const existing = table.get('state')
    if (existing) return existing
    const created: Meta = {
      schemaVersion: 1,
      butlerSessionId: null,
      butlerPresetId: 'superagent-butler',
      lastRecoveryAt: null,
      lastReminderAt: null,
      createdAt: now(),
      updatedAt: now(),
    }
    await table.put('state', created)
    return created
  }

  async saveMeta(meta: Meta): Promise<void> {
    meta.updatedAt = now()
    await this.table<Meta>('meta').put('state', meta)
  }

  /**
   * 进度通知的持久化队列。
   *
   * 存在 `meta` 表的 `notices` 键下（而不是新增表）：新增表要动 STORAGE_SPEC 的 version，
   * 而 version 不匹配会让已有用户的 domain 直接打不开（version-mismatch 是 fail-loud 的），
   * 这里用同一张表的不同 key 就能持久化，零迁移风险。
   */
  listProgressNotices(): ProgressNoticeRecord[] {
    const table = this.table<any>('meta')
    const existing = table.get('notices')
    const items = Array.isArray(existing?.items) ? existing.items : []
    return items as ProgressNoticeRecord[]
  }

  async saveProgressNotices(items: ProgressNoticeRecord[]): Promise<void> {
    await this.table<any>('meta').put('notices', { schemaVersion: 1, items })
  }

  listProjects(): Project[] {
    return this.list<Project>('projects')
  }

  getProject(key: string): Project | undefined {
    return this.table<Project>('projects').get(key)
  }

  async putProject(project: Project): Promise<void> {
    project.updatedAt = now()
    await this.table<Project>('projects').put(project.key, project)
  }

  listSessions(): ManagedSession[] {
    return this.list<ManagedSession>('sessions')
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.table<ManagedSession>('sessions').get(sessionId)
  }

  async putSession(session: ManagedSession): Promise<void> {
    // 外部来源的 id 千奇百怪（冒号、斜杠、空格），落库会直接抛 path-safe 错误，
    // 而这条异常会顺着 init() 把整个插件拖挂。这里静默跳过：会话照常展示，只是不持久化。
    if (!isSafeRecordKey(session?.sessionId)) return
    session.lastSeenAt = now()
    await this.table<ManagedSession>('sessions').put(session.sessionId, session)
  }

  listDispatches(): Dispatch[] {
    return this.list<Dispatch>('dispatches')
  }

  getDispatch(id: string): Dispatch | undefined {
    return this.table<Dispatch>('dispatches').get(id)
  }

  async putDispatch(dispatch: Dispatch): Promise<void> {
    await this.table<Dispatch>('dispatches').put(dispatch.id, dispatch)
  }

  findDispatchByRequestId(requestId: string): Dispatch | undefined {
    return this.listDispatches().find((dispatch) => dispatch.requestId === requestId)
  }

  currentDispatch(sessionId: string): Dispatch | undefined {
    return this.listDispatches()
      .filter(
        (dispatch) =>
          dispatch.targetSessionId === sessionId &&
          (dispatch.status === 'accepted' ||
            dispatch.status === 'delivered' ||
            // 上一轮报错但任务没结束：门禁、进度、巡检都还要继续。
            dispatch.status === 'error'),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  /** 这个 session 上最近的一条派发，不管状态（提交方案时用来兜底判定）。 */
  latestDispatch(sessionId: string): Dispatch | undefined {
    return this.listDispatches()
      .filter((dispatch) => dispatch.targetSessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  listPlans(): Plan[] {
    return this.list<Plan>('plans')
  }

  getPlan(id: string): Plan | undefined {
    return this.table<Plan>('plans').get(id)
  }

  async putPlan(plan: Plan): Promise<void> {
    await this.table<Plan>('plans').put(plan.id, plan)
  }

  pendingPlan(sessionId: string): Plan | undefined {
    return this.listPlans()
      .filter((plan) => plan.sessionId === sessionId && plan.status === 'pending_review')
      .sort((a, b) => b.submittedAt - a.submittedAt)[0]
  }

  approvedPlan(dispatchId: string): Plan | undefined {
    return this.listPlans()
      .filter((plan) => plan.dispatchId === dispatchId && plan.status === 'approved')
      .sort((a, b) => (b.reviewedAt ?? b.submittedAt) - (a.reviewedAt ?? a.submittedAt))[0]
  }

  listBlockers(): Blocker[] {
    return this.list<Blocker>('blockers')
  }

  getBlocker(id: string): Blocker | undefined {
    return this.table<Blocker>('blockers').get(id)
  }

  async putBlocker(blocker: Blocker): Promise<void> {
    await this.table<Blocker>('blockers').put(blocker.id, blocker)
  }

  findOpenBlocker(sessionId: string, signature: string): Blocker | undefined {
    return this.listBlockers().find(
      (blocker) =>
        blocker.sessionId === sessionId &&
        blocker.signature === signature &&
        (blocker.status === 'open' || blocker.status === 'notified'),
    )
  }

  listApprovals(): Approval[] {
    return this.list<Approval>('approvals')
  }

  getApproval(id: string): Approval | undefined {
    return this.table<Approval>('approvals').get(id)
  }

  async putApproval(approval: Approval): Promise<void> {
    await this.table<Approval>('approvals').put(approval.id, approval)
  }

  listAudit(): AuditEntry[] {
    return this.list<AuditEntry>('audit').sort((a, b) => b.at - a.at)
  }

  async appendAudit(entry: Omit<AuditEntry, 'id' | 'at'> & { at?: number }): Promise<AuditEntry> {
    const record: AuditEntry = {
      id: shortId('audit'),
      at: entry.at ?? now(),
      ...entry,
    } as AuditEntry
    await this.table<AuditEntry>('audit').put(record.id, record)
    return record
  }
}
