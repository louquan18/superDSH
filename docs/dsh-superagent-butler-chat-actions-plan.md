# 【方案】SuperAgent 提醒改为对话内可交互消息 + 管家标签页改为「概览 + 日志」

- 状态：**已确认，已实现（2026-11-09）**；实施结果见文末 §8
- 日期：2026-11-06
- 宿主实测版本：**dsh 0.2.2-rc.1**（`dsh --version`）；设计文档 §1.1 写的 0.2.1-rc.2 已过时，需同步更正
- 插件：`dsh-superagent-butler`（`src/` 为源码，`lib/` 为编译产物，重启 `dsh web` 生效）

---

## 0. 结论先行

1. **可行，不用改 dsh core**。全部走 0.2.2-rc.1 已发布的公共扩展点。
2. **问题根源是一行代码**：`src/service.ts:718 injectMessage()` 把注入消息的 `source` 写死成 `{ kind: 'user' }`。chat 的 `messageDefinition` 判定 `source.kind === 'user'` → 渲染成右对齐的「用户气泡」。换成自定义 source 后，它天然不再是用户消息。
3. **按钮渲染有现成的同构先例**：`dsh-client-ui-user-questions` 的 `question-reply` 就是「抢注一条 `user/message`（`exclusive: true`）+ 注册自定义 node kind」。照抄这个形态。
4. **动作链路已经存在**：`POST /api/superagent/action`（owner Peer + same-origin cookie），支持 `blocker_action` / `plan_review` / `approval_decide` / `dispatch_mark`。点按钮不经过管家模型、不花 token、毫秒级返回。
5. **一个必须承认的硬限制**：`agent.inject` 在管家 idle 时只进 next-step inbox，**不落日志**，消息要等管家下一轮才出现。补一个「对话内待处理条」（`conversation.input.dock`，只在管家会话显示）兜底。
6. **触发侧必须同步改**：从「拼一段文本」改成「带结构化动作的 notice」，否则客户端无从知道该给哪些按钮。

---

## 1. 调研结论

### 1.1 提醒现在是哪段代码、什么机制注入的

| 位置 | 作用 |
|---|---|
| `src/service.ts:696 injectButlerNotice(text, butlerSessionId?)` | 统一出口：选定目标管家 session，live 就 inject，否则入队 |
| `src/service.ts:718 injectMessage(agent, text)` | **真正注入**：造 `{ id, role:'user', content:[text], source:{kind:'user'} }`，调 `agent.inject(message)` |
| `src/service.ts:711 queueButlerNotice` / `:732 flushButlerNotices` | 管家冷着时排队；下次上线补一条「期间新增 N 条」汇总 |
| `src/service.ts:988 maybeRemind(blocker)` → `:997-1001` | 拼 4 行纯文本：`【SuperAgent 提醒】/ summary / 需要你：neededAction / 在管家面板处理；这条只是通知` |
| `src/service.ts:851 noteProgress` → `:888` | 进度提醒，同一条 inject 通道 |
| `src/service.ts:2500`（`recover`） | 重启汇总「重启后仍有 N 个未处理卡点；在管家面板查看。」 |
| `src/blockers.ts:245` 等 | `summary` / `neededAction` 的业务文案来源 |

**机制**：`agent.inject(msg)` 在 dsh 里等于 `agent.send(msg, 'next-step', false)`（`dsh-agent-loop/lib/index.js:576`）——**只进 inbox、不唤醒模型**。消息落日志发生在下一个 step 开局：`session.append('user/message', message, { surfaceOp: 'append' })`（同文件 `:865`）。

**所以**：管家正在跑（最常见：用户刚给它发消息、它去查状态）时，提醒立刻出现在对话里；管家 idle 时，提醒要等下一轮才可见。这解释了为什么现在看到的是「贴进来的文本」。

### 1.2 可挂 UI 的消息类型 / attachment / slot

- **没有自定义「消息类型」可用**（第三方插件不能新增 session event type，这是已知红线，见设计文档 §1.4 第 1 条）。
- 但 **`MessageSource` 是 merge-extensible 的**（`dsh-llm/lib/types/message.d.ts:98-122`）：注释明确写「user messages carry any producer's kind, and consumers fall through unknown kinds」。
- **注入消息在 chat 里的分类**（`dsh-client-ui-chat/lib/client.js:11955` 的 `messageDefinition`）：
  - `source.kind === 'user'` → node kind `user` → 右对齐用户气泡；
  - `source.kind !== 'user'` → node kind `context`，带 `form` + `producer` 标签 → 折叠的「注入上下文」行。
- **`form` 是语义化的**（`ContextForm`：`instructions/catalog/snapshot/notice/relay/recall`）；`notice` 形态要求 `summary` 字段，且「通常不用展开就能读」（`ContextInjectionRow`，`client.js:5540-5700`）。
- **同构先例**：`dsh-repeat-tool-reminder/lib/index.js:2133-2145` 的 `REMINDER_SOURCE = { kind: 'repeat-tool-reminder' }` + `form:'notice'` + `summary`，注释写着「the label is load-bearing (an unlabeled context would render as a user prompt in derived history)」。
- **持久化安全**：`dsh-session-persistence` 只拒绝「未知**事件类型**」，不校验 `source.kind` 是否在封闭集（README §89/§108，代码里搜不到 `source.kind` 白名单）。`user-question-reply`、`repeat-tool-reminder` 都是自定义 source kind 并已持久化，先例充分。

### 1.3 客户端插件能不能在消息气泡内渲染自定义按钮

| 路径 | 结论 |
|---|---|
| `conversation.chat.user.before`（chain，`slots.d.ts:390-398`） | 只在 `user` 行生效，且只能加「气泡上方的装饰」，**无法替换/隐藏气泡**。先例：liveshare 的共享来源标注。不选。 |
| `conversation.chat.turnTail`（list，`slots.d.ts:436-444`） | 按 **turn** 渲染在回答之后，不绑定具体消息。适合「每轮回答后挂一张卡」，不适合「提醒消息本身可点」。只能当补充。 |
| **自定义 Conversation Definition + `conversation.chat.node` 新 key** | ✅ **选它**。`ctx.uiConversation.events.register(def)` 抢注 `user/message`（`exclusive:true`），再注册 `conversation.chat.node` 的 key `superagent-notice` 渲染整行。**先例：`dsh-client-ui-user-questions/lib/client.js:1555-1615` 的 `questionReplyDefinition` + key `question-reply`**，用法完全同构。 |
| 替换 `conversation.chat.node` 的 key `context` | ❌ 会接管**所有**注入上下文（含 tool-addition 等），风险不可接受。 |

**降级行为**（重要）：Definition 没加载/注册失败时，dsh 原生把该 source 渲染成 `context` notice 行（`producer.label = source.kind`）。消息不丢、不变回用户气泡，只是没有按钮。

> 附：`dsh-action-cards`（`propose_action` + 卡片）不适用——它要求模型调用工具、加载 skill、一张卡绑一个 turn、且只在回答之后出现；我们的提醒是 host 主动注入，没有模型调用。

### 1.4 按钮回调链路是否可行

| 关注点 | 现状 |
|---|---|
| 通道 | `POST /api/superagent/action`（`src/host/routes.ts:100-135`），`connection.fetch.register`，**只允许 owner Peer**，与 Web UI cookie 同源 |
| 鉴权 | 已有；客户端 `credentials: 'same-origin'`（`src/client/index.ts:1046`） |
| 已有动作 | `blocker_action`(approve/reject/answer/dismiss/retry) → `resolveBlocker`（`service.ts:2104`）；`plan_review` → `reviewPlan`（`:1562`，非 pending 直接返回错误，天然幂等）；`approval_decide`；`dispatch_mark` → `markDispatch`；`project_mode` |
| 会话归属 | 动作只带 blockerId/planId/dispatchId，服务端自己查归属，不依赖客户端声明 |
| 幂等 | 服务端已有状态门：重复批准返回「计划已是 approved」；blocker 不存在返回「卡点不存在」。客户端再加「飞行中禁用」 |
| 失败回显 | 路由把业务错误放在 `value.message`，客户端已解包成 Error（`client/index.ts:1046-1060`） |
| 立刻更新气泡状态 | 需要新增**已处理状态来源**：现在 `snapshot.blockers` 只含 open/notified，处理完就消失，历史消息行无法判断自己是否已处理 → **新增 `snapshot.resolvedBlockers`** |

### 1.5 管家标签页现在是什么、在哪注册

| 位置 | 内容 |
|---|---|
| `src/client/index.ts:1101` | `sidebar.panellist` 注册「管家」图标（id `superagent`） |
| `src/client/index.ts:1113` | `main` 注册 `key: 'superagent'` 的整页面板 |
| `src/client/index.ts:839-845` | `TABS`：收件箱 / 计划审查 / 派发 / 审计 / 项目模式 |
| `src/client/index.ts:847-955` | `Panel()`：头部 + tab 栏 + 分支渲染 |
| `:284 BlockerCard` / `:418 InboxView` / `:445 PlansView` / `:563 DispatchesView` / `:667 AuditView` / `:729 ModesView` / `:796 Composer` | 各视图；**交互动作都在这些里** |
| `:1124` / `:1136` | `sidebar.session.row.leading` / `sidebar.session.row.hover`（原生侧栏徽标，保留） |

改「日志 + 概览」只需要动这一个文件（+ 快照字段），不用碰 host 结构。

---

## 2. 改造方案

### 2.1 数据协议（落到 `src/types.ts`）

```ts
/** 提醒消息的 source。写进 session 日志，客户端只靠它就能渲染整张卡。 */
export interface ButlerNoticeSource {
  kind: 'superagent-notice'
  form: 'notice'          // 让 dsh 原生也能降级成 notice 行
  summary: string         // ≤120 字，折叠行一行话
  notice: ButlerNotice
}

export interface ButlerNotice {
  id: string
  at: number
  kind: 'blocker' | 'progress' | 'summary'
  category: BlockerKind | 'dispatch' | 'restart' | 'milestone'
  severity: 'info' | 'warning' | 'critical'
  sessionId?: string
  sessionTitle?: string
  title: string           // 「repo-a · 等审批」
  detail?: string         // 证据摘要 / 计划标题 / 新完成的条目标题
  neededAction?: string   // 「需要你：允许/拒绝 git push」
  blockerId?: string
  planId?: string
  approvalId?: string
  dispatchId?: string
  callId?: string
  options?: string[]      // question 的候选项
  actions: ButlerNoticeAction[]
}

export interface ButlerNoticeAction {
  verb: 'approve' | 'reject' | 'answer' | 'dismiss' | 'retry'
      | 'dispatch_completed' | 'dispatch_failed' | 'open_session'
  label: string
  style?: 'primary' | 'danger' | 'plain'
  requiresText?: boolean
  placeholder?: string
}
```

`Snapshot` 增加：

```ts
resolvedBlockers: Array<Pick<Blocker,
  'id'|'status'|'resolution'|'resolvedAt'|'summary'|'kind'|'sessionId'>>
```

### 2.2 动作矩阵（提醒里给哪些按钮）

| 卡点类型 | 按钮 | 落到哪个已有 action |
|---|---|---|
| `approval` | 允许一次 / 拒绝 / 忽略 | `blocker_action` approve｜reject｜dismiss |
| `plan_review` | 批准 / 提修改意见(需文本) / 驳回(需文本) / 忽略 | `blocker_action` approve｜answer｜reject｜dismiss |
| `question` | 选项按钮（evidence 里有 options 时）/ 回答(需文本) / 忽略 | `blocker_action` answer｜dismiss |
| `decision` | 回答(需文本) / 忽略 | `blocker_action` answer｜dismiss |
| `repeated_failure` / `stall` / `interrupted` | 重试 / 忽略 | `blocker_action` retry｜dismiss |
| `progress` / `milestone` | 打开会话（+ 若有进行中 dispatch：标记完成 / 放弃） | `open_session`（客户端 `uiWorkspace.openSession`）/ `dispatch_mark` |
| `summary`（重启汇总） | 打开管家会话 / 无 | `open_session` |

### 2.3 渲染协议（客户端）

在 `src/client/index.ts` 里新增：

**a) Definition（抢注消息）**

```js
ctx.uiConversation.events.register({
  kind: 'superagent-notice',
  target: 'chat',
  match: (event) => event.type === 'user/message' && event.surfaceOp === 'append'
    && event.data.source?.kind === 'superagent-notice'
    ? { id: String(event.data.id), role: 'start', exclusive: true } : null,
  start: (_c, m) => ({ seq: m.event.seq, time: m.event.time,
                       content: m.event.data.content, source: m.event.data.source }),
  update: (c) => c.state,
  buildViewNode: (c) => c.state ? {
    key: c.key, id: c.id, kind: 'superagent-notice', target: 'chat',
    anchorSeq: c.state.seq,
    location: c.start?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
    data: c.state,
  } : null,
})
```

> `groupTree` 不设——对齐原生 `context` 行的定位方式（`dsh-client-ui-chat/lib/client.js:11996-12006` 里非 human、非 waking 的 context 节点就是 `groupTree: undefined`）。

**b) Node renderer**

```js
ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
  name: 'conversation.chat.node', key: 'superagent-notice',
  inject: () => ({ store, api, nav }),
}, NoticeRow))
```

**c) `NoticeRow` / `NoticeCard`**

从 `source.notice` 读标题、正文、按钮；从全局 store 的 snapshot 派生**实时状态**：

- blocker 仍在 `snapshot.blockers` → 可点；
- 出现在 `snapshot.resolvedBlockers` → 显示「已处理：原因 · 时间」，按钮全部禁用；
- plan / dispatch / approval 按 `snapshot.plans|dispatches|approvals` 的状态显示；
- 本地乐观态：点击后立刻 `pending`（按钮禁用 + 文案「处理中…」），成功后写入本地 `outcome`，失败则显示错误原文并 refresh 快照。

**d) 立即可见兜底**

`conversation.input.dock`（session 级、输入框上方整宽，`dsh-client-ui-conversation` slots `:330-334`）只在 `session.sessionId === snapshot.butler.sessionId` 时渲染一条「待处理 N 条 · 展开」。展开后列前 3 条同样的卡（复用 `NoticeCard`）。数据来自 `snapshot.blockers`，所以 idle 时也能处理。

### 2.4 交互流程

```
worker 卡住
  → service.maybeRemind() 造 ButlerNotice（带 actions）
  → injectButlerNotice({ text, source })
      → agent.inject(结构化消息)                 # 不唤醒
          ├─ 管家正在跑 → 下一 step 落日志 → 对话里出现卡片（可点）
          └─ 管家 idle   → 只进 inbox → 「待处理条」兜底可见
  → 用户在卡片上点「允许一次」
      → 本地 pending → POST /api/superagent/action {blocker_action, approve}
      → service.resolveBlocker → decideApproval → worker 继续
      → 返回 ok → 卡片就地变「已允许 · 刚刚」，按钮禁用
      → SSE invalidate → snapshot 刷新 → resolvedBlockers 出现该条（刷新页面后仍显示已处理）
      → 面板「概览」计数 -1，「日志」多一条 audit
  → 失败（陈旧计划/网络）→ 卡片显示错误原文 + 「重试」；同时 refresh 纠正状态
```

### 2.5 触发侧改造（`src/service.ts`）

- `injectMessage(agent, text)` → `injectMessage(agent, { text, source })`；`source` 由调用方给。
- `injectButlerNotice(text, butlerSessionId?)` → `injectButlerNotice(payload: { text, source, butlerSessionId? })`；`text` 保持格式不变（仍以 `【SuperAgent 提醒】` 开头——管家提示词依赖这个前缀）。
- `maybeRemind` / `noteProgress` / `flushButlerNotices` / `recover` 各造结构化 notice；`blockers.ts` 加 `buildBlockerNotice(blocker)` + `noticeActionsFor(blocker)` 纯函数（可单测）。
- `snapshot()` 增加 `resolvedBlockers`。
- **模型侧不变**：content 文本原样给模型看，只是 `source` 变了。

### 2.6 提示词（`src/butler/index.ts`）

补一段：提醒消息现在带可点按钮，用户会直接在对话里处理；**管家不得代为决策、不得复述提醒内容**；需要细节时调 `butler_status` / `butler_inbox`。原有「不要因提醒而自行派发」保留。

### 2.7 管家标签页 → 概览 + 日志

| 新 tab | 内容 | 交互 |
|---|---|---|
| **概览** | 管家状态、待处理卡点按类分组计数、待审计划数、进行中派发、最近 5 条日志、项目与模式分布、会话列表（标题/状态/卡点数/最近活动） | 只读；仅「打开会话」「打开管家会话」「刷新」 |
| **日志** | audit 全量倒序表（时间/来源会话/类型/动作/决策/by/备注），按类型与会话过滤；最近已处理卡点时间线 | 只读 |
| **明细**（可选保留） | 卡点 / 计划 / 派发 三张只读列表（原卡片去掉所有动作按钮，改一行「在对话里处理 →」跳管家会话） | 只读 |

移除：`InboxView` 的批准/驳回/回答/改派按钮、`PlansView` 的审批区、`DispatchesView` 的改派/标记完成、`ModesView` 的模式切换、`Composer` 的发消息输入框。`Composer` 的位置换成「打开管家会话去处理」。

> 保留一个「在对话里处理」的桥：`nav.openSession(butlerSessionId)`。它不改变状态，只是导航。

---

## 3. 涉及文件

| 文件 | 改动 |
|---|---|
| `docs/dsh-superagent-butler-chat-actions-plan.md` | **新增**：本方案 |
| `src/types.ts` | `ButlerNotice` / `ButlerNoticeSource` / `ButlerNoticeAction`；`Snapshot.resolvedBlockers` |
| `src/service.ts` | `injectMessage` 签名、`injectButlerNotice`、`maybeRemind`、`noteProgress`、`flushButlerNotices`、`recover`、`snapshot` |
| `src/blockers.ts` | `noticeActionsFor(blocker)` + `buildBlockerNotice(blocker)` |
| `src/butler/index.ts` | 提示词补一段 |
| `src/client/index.ts` | Definition、`NoticeRow`/`NoticeCard`、`input.dock` 待处理条、`TABS`/`Panel` 重写、删动作按钮 |
| `package.json` | `dsh.client.inject` += `@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-chat` |
| `scripts/check-client.mjs` | 注册清单断言更新；fake ctx 补 `uiConversation` / `locale` / `sessions` |
| `test/unit/notices.test.ts`（新增） | 动作矩阵、source 形状、summary 截断 |
| `test/integration/service.test.ts` | 断言注入消息的 `source.kind` 与 `notice` 结构；原有文本断言保留 |
| `README.md` / `docs/dsh-superagent-butler-design.md` | §6.3 / §6.4 / §8 改成新协议；宿主版本更正为 0.2.2-rc.1 |
| `lib/**` | `npm run build` 产物（重启 `dsh web` 生效） |

---

## 4. 风险与缓解

| # | 风险 | 缓解 |
|---|---|---|
| 1 | **第三方 Conversation Definition 首次使用**：装配器对未知 node kind 的 visibility/groupTree 处理可能与原生不同，行可能不显示或位置异常 | **第 2 步先做 20 行 spike**（定义 + 极简渲染）验证；失败则降级为「原生 context 行 + input.dock 待处理条 + 面板只读」 |
| 2 | `exclusive: true` 抢注与未来 dsh 版本自身 claim 冲突 → dispatch 抛错 | 升级宿主时复核；异常只影响该行渲染，不崩整个对话（真机验证） |
| 3 | **宿主版本漂移**：文档锁 0.2.1-rc.2，实际 0.2.2-rc.1 | 方案按 0.2.2-rc.1 写，文档同步更正；`engines.dsh` 改动前先在当前版本实测 |
| 4 | **idle 时注入不落日志**（架构限制，非 bug） | `input.dock` 待处理条兜底；文档写明「消息行是事件记录，待处理条是实时入口」 |
| 5 | 自定义 source 持久化 | 已有 `user-question-reply`、`repeat-tool-reminder` 先例；实测「处理完关掉页面再重开」行仍显示已处理 |
| 6 | 去掉面板操作后，若客户端渲染出问题就没有兜底入口 | 保留只读面板 + 「去对话处理」；HTTP 动作接口继续可用（README 记录 curl 用法） |
| 7 | 提醒消息堆积 | 冷却 30min + 每卡点最多 N 次（已实现）；旧卡自动显示「已处理/已过期」 |
| 8 | 「需要文本」的动作用户体验 | 行内 textarea + 提交；question 有 options 时优先按钮；无 options 走文本 |
| 9 | 同一审批重复提醒导致多张卡 | 全部按同一个 `blockerId` 派生状态，任一处点完所有同 id 的卡一起变已处理 |

---

## 5. 分步实施计划（每步可独立验证）

| 步 | 内容 | 验证 |
|---|---|---|
| **0** | 落盘本方案文档 | 你 review（已完成） |
| **1** | Host 侧协议：types + `injectMessage`/`injectButlerNotice` + builders + `resolvedBlockers`；**不动客户端** | 单测/集成测试；提醒不再以用户气泡出现，变成原生 notice 行（先无按钮） |
| **2** | 客户端 spike：Definition + `conversation.chat.node` key，极简渲染「标题 + 1 个按钮」，点按钮打 `blocker_action` | 真机截图确认行位置、按钮生效 |
| **3** | 正式 `NoticeCard`：完整动作矩阵、乐观态、失败回显、已处理态 | 手动跑审批/计划/问题/停滞四条链路 |
| **4** | `input.dock` 待处理条（只管家会话） | idle 场景：不唤醒管家也能在对话里处理 |
| **5** | 面板改「概览 + 日志 + 明细(只读)」 | 面板无任何改变状态的操作；SSE 下计数实时 |
| **6** | 提示词 + README + 设计文档同步；`npm run verify` | 全量测试 + `check-client` + 真机回归 |

---

## 6. 测试点

**单元**
- `buildBlockerNotice`：7 种卡点类型 → 正确 actions（数量/verb/style/requiresText）；
- `summary` ≤120 字、`title` 无换行；
- 进度/汇总 notice 的 `actions` 为空或仅 `open_session`；
- `resolvedBlockers` 只取最近 N 条、字段完整。

**集成**
- `injectButlerNotice` → `agent.inject` 收到的消息 `source.kind === 'superagent-notice'`、`source.form === 'notice'`、`source.notice.actions` 非空；
- 文本内容仍以 `【SuperAgent 提醒】` 开头（管家提示词兼容）；
- 管家冷着 → 入队 → 上线补汇总（notice kind = 'summary'）；
- `handleAction('blocker_action', approve)` 后 `resolvedBlockers` 含该条。

**客户端 smoke（`check-client.mjs`）**
- 注册清单新增 `conversation.chat.node`、`conversation.input.dock`；
- Definition 的 `match` 只对 `source.kind === 'superagent-notice'` 且 `surfaceOp === 'append'` 返回 `exclusive: true`，其余返回 null；
- `inject` 数组含 `uiConversation`。

**真机**
1. 造一个审批卡点 → 对话里出现卡片 → 点「允许一次」→ worker 继续，卡片变「已允许」；
2. 刷新页面 / 切走再回来 → 卡片仍是「已允许」（靠 `resolvedBlockers`）；
3. 管家 idle 时造卡点 → 输入框上方出现「待处理 1」→ 展开点「忽略」→ 消失；
4. 计划待审 → 点「提修改意见」→ 填文本 → worker 收到 followup；
5. 陈旧计划（另一路径已批）再点批准 → 卡片显示「计划已是 approved」并自动刷新为已批准；
6. 断网点击 → 卡片显示网络错误，恢复后重试成功；
7. 面板：三个 tab 均可打开，无任何改变状态的按钮；「日志」新条目实时出现。

---

## 7. 待确认（3 个点）

1. **面板是否完全去掉交互？** 建议：去掉全部状态变更操作，保留只读「明细」tab + 「在对话里处理」跳转。若更彻底，可只留「概览 + 日志」两个 tab。
2. **接受「输入框上方待处理条」作为 idle 兜底吗？** 这是 `agent.inject` 不落日志的必然补丁；不想要的话，idle 场景只能等管家下一轮才有卡片。
3. **「回答 / 提修改意见」用行内 textarea 可以吗？** 还是只在卡片上给「去对话说」并把文本转成普通消息（会多一次模型调用）。

确认后按第 5 节的 6 步出实现计划，再动代码。


---

## 8. 实施结果（2026-11-09）

三个决策点按确认执行：

| 决策 | 结论 | 落地 |
|---|---|---|
| 面板是否去掉交互 | 去掉；保留只读「明细」tab + 「在对话里处理 →」跳转 | `TABS` 改为 概览/日志/明细；`BlockerCard`/`PlansView`/`DispatchesView`/`ModesView` 增加 `readOnly`；删掉 `InboxView` 与 `Composer` |
| 输入框上方「待处理」条 | 接受 | `conversation.input.dock` + `NoticeDock`，只在管家会话渲染，数据来自 `snapshot.blockerNotices` |
| 行内 textarea | 可以 | `NoticeCard` 内嵌 textarea；`requiresText` 动作为空时禁用提交 |

实现要点（与原方案的差异都已说明）：

- Host：`service.ts:injectMessage(agent, text, source?)`、`injectButlerNotice(payload | string)`；`blockers.ts` 新增 `buildBlockerNotice` / `noticeActionsFor` / `noticeSource` / `questionOptionLabels`；`snapshot()` 新增 `blockerNotices` 与 `resolvedBlockers`。
- 额外修的一个真实缺口：`markDispatch` 收尾时现在会一起结束该 session 的 `stall` / `interrupted` / `repeated_failure` / `decision` 卡点（审批 / 提问 / 待审计划不动），否则「标记完成」之后卡片还会一直可点、待处理条也不会消。
- 客户端：`superagent-notice` Definition（`exclusive: true` 抢注 `user/message`）+ `conversation.chat.node` key + `conversation.input.dock`；`package.json` 的 `dsh.client.inject` 增加 `dsh-client-ui-conversation` / `dsh-client-ui-chat`。
- 验证从 4 个挂载点扩到 6 个，并新增 `scripts/check-notice-render.mjs`：用假 React 真渲染卡片/待处理条/面板，断言面板按钮只有「打开/刷新」，并真的点一次「允许一次」验证发出 `blocker_action/approve`。

**仍未验证**：真实浏览器里的最终观感、以及重启 `dsh web` 后 Host 侧新协议的实际效果（重启会关掉我当时所在的会话）。需要你重启后自己看一眼。
