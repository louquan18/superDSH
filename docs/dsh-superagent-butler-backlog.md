# Backlog

## B-1 进度通知没有 UI 载体，且通知不会唤醒管家

**现象**（2026-11-09 真机）：P2 于 16:14 完成，系统生成了三条进度通知（里程碑「完成 5 项」、阶段结束、15 分钟无进展的 watchdog）。用户明确反馈：**界面上一条都没看见**。管家只有等用户主动发问，才知道 P2 已经完成并去推动 P3。

**已查证的事实**：
- 按通知内容（`environment_context`、`完成 5 项`）搜遍全部 session 存储，管家侧**没有任何消息记录** —— 这些通知不是作为消息投递的。
- 它们只走「inject 进模型提示词」这一条路：拼在用户每轮消息前面，只有模型能读到。
- 有结构化记录、有 `source.kind='superagent-notice'`、由客户端渲染成卡片的，只有「提醒」（`blockerNotices`）那一类。
- 待办条的唯一数据源是 `snapshot.blockerNotices`（只来自 open blocker），所以 progress 永远进不去。
- 「离线期间新增 N 条提醒」这种补发摘要是可见的，说明提醒通道本身是通的。

**初判（两层，需分别修；2026-11-09 已由下方「已确定的根因」修正）**：
1. **展示层缺失**：progress 通知没有 UI 载体，只 inject。A/B 把「进度事件化」做在了后端，最后的展示那一段没接。
2. **调度层缺失**：进度通知不唤醒管家。管家只在①用户开口 ②生成卡点 时有 turn，所以「通知」的读者是用户、行动权也留在用户手上，管家永远不知道要不要推动。

**修复要求**：
1. **progress 必须进 `snapshot`**：在快照里新增一个独立队列（例如 `progressNotices`，**不要混进 `blockerNotices`**，否则会污染待办条语义、也不该阻塞）。客户端靠现有 2 秒轮询 + SSE invalidate 就能实时看到。
2. **客户端需要实时渲染区**：卡片/时间线/进度条都行，但必须在不发消息的情况下也能自己出现。仍遵守：不进待办、不阻塞、不需要点击。
3. **inject 只保留为「给模型看的文本」**，不再是唯一载体；不要去改它的内容格式（模型侧依赖）。
4. 递送语义要幂等：同一条通知不可因为「进了快照 + 又做了注入」而让用户看到两遍。
5. **真机验证**：重启 dsh web 后，触发一次进度事件，**不主动发消息**，确认页面在 2 秒内自己刷新出卡片。这一条是验收硬标准 —— 之前三次都是「代码通过、真机没验」才漏掉的。
6. 防抖与唤醒：仍按原要求（只对阶段结束/完成/停滞唤醒，同签名一次，可配置可关）。

**已确定的根因（2026-11-09，用户答复后修正）**：

> 用户原话（2026-11-09）：「我能看到一种消息，类似于卡片一样的推送，但是这个只有在我主动询问你的时候，才会显示在页面上，而不是我实时都能看到。」

**卡片渲染是好的，坏的是投递时机 —— 通知根本没有实时推送通道。**

1. 现在的通知走的是 **`agent/pre-step` 注入**：文本被拼进**用户下一条消息**的内容里。所以：
   - 事件发生时（16:14）→ 不推送、页面无变化；
   - 用户开口（16:40）→ 注入完成 → 通知跟着用户这条消息一起上屏，客户端把它渲染成卡片。
   - 这解释了用户看到的现象：「只有我主动询问时才出现」，也解释了为什么它看起来「像卡片」。
2. 客户端唯一**实时**的数据源是 `/api/superagent/state` 的**每 2 秒轮询**（`/api/superagent/events` 的 SSE 只发 invalidate 帧，不携带内容）。而快照里的 `blockerNotices` **只来自 open blocker**，progress 不在其中 → 所以实时可见的只有「待办条」，进度类永远进不去。
3. 结论修正：**不是「没有 UI 载体」，而是「载体存在，但只在注入发生的那一刻（用户开口）才出现」**。前两版判断（「完全没有 UI 载体」）作废。

**排期**：**不要现在做**。它同时撞两条在跑的会话：`service.ts` 的 progress 段（正在改游标种子）、`client/index.ts`（P3 正在加徽标/筛选）。而且进度卡片应当排在 P3 之后实施，以便与来源徽标/卡片布局对齐，避免返工。

---

## 已完成（2026-11-09）

### P0（2026-11-09）打开 Claude 来源导致整个管家插件不加载 ✅ 2026-11-09

**根因（一句话）**：`ClaudeSource` 把子会话 id 拼成 `<root-uuid>:<agent-name>`（含冒号），`listSessions()` 把它当 per-record key 落库，`dsh-storage-json` 的 `assertSafeKey` 判 `not path-safe` 抛错 → `create()` 在 `init()` 里失败 → `apply()` 抛错 → `provide('superagent')` 没执行 → 管家 preset 的 inject 缺 `superagent` → 管家会话失去全部工具。

**堆栈关键行**：
```
superagent-butler (@local/dsh-superagent-butler): Error: unit 'superagent':
per-record key '383818a7-…:agent-af9dd79c8fac1fe25' is not path-safe (must match /^[a-zA-Z0-9_-]+$/)
  at assertSafeKey (dsh-storage-json/lib/index.js:608)
  at PerRecordJsonUnit.putRecord (dsh-storage-json/lib/index.js:479)
```

**为什么单测测不出来**：258 条测试全绿，但没有一条真正启动一次 dsh 并启用来宾来源；`list()` 的错误隔离当时只覆盖"取列表"，不覆盖"落库"。

**修复（四层）**：
1. 子会话 id 分隔符 `:` → `-`（根因）；
2. `store.putSession()` 入口校验 key，非法就跳过持久化而不是抛（会话照常展示）；
3. `listSessions()` 单条写库失败只告警，不中断整次扫描；
4. 来宾来源注册（构造 + `start()`）整体 try/catch，失败只标记 `available=false + error`，快照新增 `sources` 健康状态；`apply()` 再包一层 try/catch，失败时提供**降级服务**并照常 `provide('superagent')`（管家还能说话、能报告原因）。

**防回归**：`npm run verify` 增加 `smoke:cold-start` —— 真实 `dsh web` 冷启动 + claude/codex 双开（fixture 含子会话），断言无激活错误、`/api/superagent/state` 200、两个来源 `available=true`、会话 id 全部 path-safe；把 `:` 改回去这条冒烟会红。

### B-1 进度通知没有 UI 载体，且通知不会唤醒管家 ✅ 2026-11-09

- **投递通道**：新增持久化队列 `ProgressNoticeRecord`（存 `meta` 表的 `notices` 键，避免动 STORAGE_SPEC 的 version 触发 version-mismatch），快照新增 `progressNotices`（与 `blockerNotices` 严格分开：不进待办、不阻塞、不需要点击）。客户端靠现有 2 秒轮询就能实时看到，不再依赖用户先开口。
- **状态机**：`open` → 过期后 `expired`（`progress.ttlMs`，默认 24h）；队列上限 `progress.queueLimit`（默认 50）；同签名去重。
- **幂等**：进度注入保留（模型侧格式不变），但 `ButlerNoticeSource` 增加 `modelOnly: true` 标记，客户端不再把这类注入渲染成对话卡片——否则面板与对话会各显示一遍。
- **有界唤醒**：`decideWake` 四道闸——类型闸（只 `stage_end`/`watchdog`）、签名闸（同 dispatch 同签名一次，落盘 `dispatch.progress.woke`）、配额闸（`wake.maxPerDispatch`，默认 2）、节流闸（`wake.minGapMs` 默认 120s，且管家 running 时不唤醒）。先落盘签名再发 prompt，prompt 失败也不会变成二次唤醒。配置整段可关（`progress.wake.enabled`）。
- **真机验收**（唯一有效的那种）：隔离开启真实服务 + 面板，**不发送任何消息**（`composed: 0`），触发一次进度事件后 **1.5 秒内**卡片自己出现；`snapshot.progressNotices = 1`、`blockerNotices = 0`；刷新后卡片仍在。
- 测试：单测 8 条（唤醒四道闸 + 连续 10 次事件最多唤醒 2 次）+ 集成 4 条（快照隔离、去重/裁剪/过期、唤醒有界与关闭静默、running 不唤醒）。

### B-2 `job_kill` 按归属免审批 ✅ 2026-11-09

- 宿主 `ctx.jobs.get(job_id, sessionId)` 自带 owner 围栏（别人的/不存在的 job 抛错），无需自己维护 job→session 表。
- `owner === 当前 session` 的 job 直接放行，不再逐次审批；别人的/不存在的 job 仍 `ask`，reason 写明「该 job 不属于本会话」；读不到 job registry 时失败关闭（`ask`）。
- 只放行 `job_kill`，`bash`/`write` 等其它工具不受影响。
- 测试：集成 1 条（本会话 allow、别人的/不存在 ask、registry 缺失 ask）。

### B-3 watchdog 无进展口径 ✅ 2026-11-09

- 无进展时长改为 `now - max(lastProgressAt, lastActivityAt, acceptedAt/createdAt)`；`lastActivityAt` 只取 `runtime.lastActivityAt`，不用每次扫描都会刷新的 `managed.lastSeenAt`（否则 watchdog 永不触发）。
- 真停滞仍然报；分桶 1x / 3x 与签名「同一安静期只问一次」的语义不变。
- 测试：单测 4 条（有活动不报、彻底不动报、上报后静止按 poll 报一次且 3 倍再报一次、老 dispatch 无 watchdog 跳过）+ 集成 1 条（活动新→不报、活动也停→报一次、重复扫描不刷屏）。
- 文档：设计文档配置表、§6.4 watchdog 口径、§7.1 风险表、§7 白名单已同步。
