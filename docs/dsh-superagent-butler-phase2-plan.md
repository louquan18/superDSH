# SuperAgent 管家 二期方案：接入 Claude Code / Codex 会话（只读优先）

> 状态：**待确认，未动代码**。对齐 `docs/dsh-superagent-butler-design.md` §9.1 / §9.2 / §9.4。
> 结论先行：**Claude Code 可以做到"读+状态+近似实时"，Codex 可以做到"读+状态（靠 sqlite turn 表）"，两者都做不到"可靠写入/审批代答"**。所以二期把外部来源定位成**只读旁路**：能列、能读、能算卡点、能派给"可写"来源，但**不往 claude/codex 里派任务、不代答它们的审批**。

---

## 1. 能力矩阵（先定边界，再谈实现）

| capability | dsh（现状） | claude | codex | 说明 |
|---|---|---|---|---|
| list | ✅ | ✅ | ✅ | 都有磁盘索引 |
| readEvents | ✅ | ✅ | ✅ | JSONL |
| readDigest | ✅ | ✅ | ✅ | 截断 + 脱敏 |
| subscribe | ✅(事件总线) | ⚠️ fs.watch 近似 | ⚠️ fs.watch 近似 | 无推送协议，只能监文件 |
| create | ✅ | ❌ | ❌ | 只能用 `claude -p` / `codex exec` 另起进程（二期不做） |
| resume | ✅ | ❌ | ❌ | 协议不公开 |
| send | ✅ | ❌（有 peer socket，实验性） | ❌（ipc.sock 私有） | 见 §6 |
| queue / cancel | ✅ | ❌ | ❌ | — |
| approvals | ✅ | ❌（**只能看见**等待授权） | ❌ | 只读观测，不代答 |
| questions | ✅ | ❌ | ❌ | — |
| plans | ✅ | ❌ | ❌ | Claude 的 plan mode 文件无协议 |
| hardStatus | ✅ | ✅ 活进程表 | ✅ sqlite turn 表 | 见 §5 |
| softStatusTool | ✅ | ❌ | ❌ | 只能 log digest |
| reassign | ✅ | ❌ | ❌ | — |

**降级原则**：capability=false 的一律"显示但不操作"，UI 置灰 + 「该来源不支持」，管家的派发候选里直接过滤掉，不能让模型选到。

---

## 2. 实测数据（本机真实路径与格式）

### 2.1 Claude Code — `~/.claude`

**会话文件**：`~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`
- `<cwd-slug>` = 绝对路径把 `/` 换成 `-`（`/Users/quanlou/Projects/acme` → `-Users-quanlou-Projects-acme`）。**反向不可靠**（真实路径里也有 `-`），cwd 一律从事件/活进程表读。
- 本机实测量：**189 个 jsonl / 185 MB**。

**每行一个事件**（CLI 2.1.293）：

```json
{"type":"user","message":{"role":"user","content":"..."},"uuid":"255085a7-…","parentUuid":null,
 "timestamp":"2026-11-04T03:31:26.714Z","cwd":"/Users/quanlou/Projects/acme/gcloud/svc",
 "sessionId":"78dc41c9-…","version":"2.1.293","gitBranch":"master","isSidechain":false,"isMeta":true}
```

事件类型（按出现频次）：`user` / `assistant` / `system`（`subtype: local_command`）/ `ai-title` / `last-prompt` / `mode` / `atis-latch` / `attachment` / `file-history-snapshot` / `file-history-delta`。

- **标题**：`{"type":"ai-title","aiTitle":"内部系统的权限申请范围","sessionId":"…"}`；退化顺序 = `ai-title` → `~/.claude/history.jsonl` 里该 sessionId 的首条 `display` → 首条 user 消息。
- **软状态线索**：`~/.claude/history.jsonl` 每行 `{display, timestamp, project, sessionId}`（用户提示词流水）。

**子会话**：`<project>/<root-uuid>/subagents/agent-<hash>.jsonl` + `agent-<hash>.meta.json`：

```json
{"agentType":"general-purpose","description":"/code-review high","name":"code-review","spawnDepth":1}
```

→ 判定：项目根目录下的 `*.jsonl` = root；`<uuid>/subagents/*.jsonl` = 子会话（默认不进路由候选，和 dsh 的 subagent session 一样处理）。

**运行中判定（关键，这是 Claude 的优势）**：`~/.claude/sessions/<pid>.json` 是**活的进程注册表**：

```json
{"pid":65844,"sessionId":"78dc41c9-…","cwd":"/Users/quanlou/Projects/acme/gcloud/svc",
 "startedAt":1793694453432,"version":"2.1.293","kind":"interactive","entrypoint":"cli",
 "status":"waiting","waitingFor":"permission prompt","updatedAt":1793959359450,
 "messagingSocketPath":"/tmp/cc-socks/65844.sock",
 "peerFeatures":["notify_idle","reply_across_default_dirs","artifact_yield"],"name":"svc-c0"}
```

实测本机 9 条，`status` 取值：`idle`(4) / `shell`(2) / `waiting`(2) / 缺失(1)；`waitingFor` 出现 `permission prompt`。

映射：`shell` → running；`idle` → idle；`waiting`+`waitingFor=permission prompt` → **awaiting_approval**；`updatedAt` 超过阈值或 `kill(pid,0)` 失败 → 视为已退出（清掉 running）。

### 2.2 Codex — `~/.codex`

**会话文件**：`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO时间>-<uuid>.jsonl`
- 本机实测：**20 个 rollout / 1.1 MB**。
- 行格式：`{"timestamp":"…","ordinal":N,"type":"…","payload":{…}}`

`type` 取值：`session_meta` / `event_msg` / `response_item` / `turn_context` / `world_state`。

```json
{"type":"session_meta","payload":{"session_id":"01a07a8f-…","cwd":"/Users/quanlou/learn/page",
 "originator":"codex_vscode","cli_version":"0.151.0-alpha.7.2","source":"vscode","thread_source":"user"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"01a07a8f-152f-…","started_at":1788762592}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[…]},"ordinal":5}
```

- **title**：`~/.codex/session_index.jsonl` = `{id, thread_name, updated_at}`。⚠️ 实测**只有 3 条，但有 20 个 rollout —— 索引不全**，不能当唯一来源。
- **状态（关键）**：`~/.codex/thread_history_1.sqlite` 的 `thread_turns` 表：

```sql
thread_turns(thread_id, turn_id, rollout_ordinal, status, error_json, started_at, completed_at, duration_ms, …)
```

实观测 23 行 / 18 个 thread，`status ∈ {completed?, inProgress, interrupted, failed}`（实测 `interrupted` 14、`failed` 8、`inProgress` 1）。`inProgress` 且 `completed_at IS NULL` = **running**；`failed` → error；`interrupted` → interrupted。
只读打开：`file:…?immutable=1` 可用（实测通过），但会忽略 WAL 的最新写入，配合 rollout 的 mtime 兜底。
- 其它 sqlite：`logs_2.sqlite`（11M 行调试日志，噪声大，不用）、`queue_1.sqlite`（排队项，本机 0 行）、`state_5.sqlite` / `memories_1.sqlite`（未使用）。
- **IPC**：`~/.codex/ipc/ipc.sock`（app-server 私有协议）——二期不碰。
- 子会话：实测 20 个 rollout 的 `thread_source` 全是 `user`（`source`=cli/vscode）。**没有发现子会话标记**，暂按 root 处理，并在 UI/文档注明"Codex 子会话可能与主会话并列"。

### 2.3 两者的共同约束

- 都只能**读文件**：`~/.claude/projects/**`、`~/.claude/sessions/*.json`、`~/.codex/sessions/**`、`~/.codex/*.sqlite`。
- **绝不读** `~/.claude/sessions/<pid>.key`（peer 鉴权密钥，0600）。
- **绝不写** `~/.claude`、`~/.codex`。

---

## 3. 现有代码的差距

`src/source.ts` 的 `DshSource` 是**直接实例化**的（`service.ts:127` `new DshSource({ctx})`），且类型是简化的 `SourceSessionLite`（无 `source`、无 `capabilities`）。文档定义的 `SessionSource / SourceKind / Capabilities` **从未落地**。
`this.source.*` 调用点共 **15 处**（list/observe/readDigest/prompt/create/rename/newRequestId/readUserMessages/findQueuedMessage/removeQueued），全部可以收敛到"按 sessionId 找 source"。

---

## 4. 数据模型改动（"与 dsh 区分开"怎么落地）

**原则**：`source` 是**记录属性**，不是文件名前缀；旧记录缺字段一律按 `'dsh'` 解释，**不做迁移、不改 schemaVersion**（现有 `valueSchema` 是自定义断言，加可选字段天然兼容）。

| 位置 | 改动 | 理由 |
|---|---|---|
| `SourceKind = 'dsh' \| 'claude' \| 'codex' \| 'remote'` | 文档写 `ducc`，本方案用 `claude`；**保留 `ducc` 作为别名**（`ducc`→`claude` 归一化） | 对齐文档但别造新词，落地时以文档为准需你点头 |
| `ManagedSession.source?: SourceKind` | 新增，默认 `'dsh'` | 会话主档，UI/路由都从这里取 |
| `Dispatch.source?: SourceKind` | 新增（= 目标会话来源） | 改派/投递前先看能力 |
| `Blocker.source?: SourceKind` | 新增 | 收件箱要能按来源分组/打标 |
| `Plan.source?: SourceKind` | 新增 | 计划列表要标来源（外部来源永远没有自动批准） |
| `AuditEntry.source?: SourceKind` | 新增 | 审计要能回答"这条是谁家的会话" |
| `SessionView.source`（snapshot） | 新增（必填，`'dsh'` 兜底） | 前端分组/筛选 |
| `RouterSession.source` + `capabilities` | 新增 | 候选过滤（见 §6） |

**兼容性**：`sourceOf(record) = record.source ?? 'dsh'`；读取时归一化，写入时总是显式写。旧 store 记录、旧 dispatch、旧 blocker 全部按 dsh 处理，行为不变。
**要不要迁移**：不迁移。唯一的语义变化是"新记录会带 source 字段"，旧记录读时兜底。

---

## 5. 状态与软状态推断

| 来源 | hardStatus 来源 | 置信度 |
|---|---|---|
| dsh | 现状（事件折叠 + live agent） | 高 |
| claude | `sessions/<pid>.json` 的 `status`/`waitingFor` + pid 存活 + `updatedAt` 新鲜度 | 高（进程活着时）→ 进程不在则回落到"文件 mtime + last event" |
| codex | `thread_history_1.sqlite` 的 `thread_turns.status`（inProgress/failed/interrupted） + rollout tail（`task_started` 无 `task_complete`） | 中（sqlite 有 WAL 滞后）/ 中 |

推断规则（新增 `src/sources/status.ts`，纯函数、可测）：

1. 有 live 记录（claude pid 活着）→ 用它。
2. 否则看最后事件：最后是 user+assistant 结束且无未闭合 turn → idle；有 `task_started` 无 `task_complete`/`turn_aborted` → running；最后是 error/turn_aborted → interrupted/error。
3. 都判断不了 → `unknown`（**允许 unknown，不猜**）。

**SoftStatus**：外部来源永远 `source: 'log-digest'`。`digestExternal(session)` = 取最近 N 条 user/assistant 文本 → `goal` = 首条 user（截断 120）；`done`/`next` 不做语义抽取（**只填 `done: []`、`next: []`**，避免编造）；`blockers` 用规则匹配（末尾 assistant 含 "error/failed/需要确认/permission" 等）。宁可空，不要假。

**轮询 vs watch**：
- 目录级 `fs.watch`（`~/.claude/projects/*`、`~/.codex/sessions/**`）+ 1s 去抖 → 触发增量重扫；`fs.watch` 在 macOS 上对深层新目录可能漏，所以**必须配 60s 兜底轮询**。
- 成本控制：只 tail 读（末尾 ≤256 KB）、按 `(path, mtime, size)` 缓存解析结果、单文件 >20 MB 跳过内容只取头部 meta、外部会话默认只扫最近 14 天（`recoveryScanDays`）。
- 量级：Claude 189 文件全量首扫 ≈ 读若干 MB 头部（不读全文），增量靠 mtime；Codex 20 文件更小。**首扫要懒加载**（列表先返回 meta，digest 点开才算）。

---

## 6. 派发语义（能不能给外部会话发消息）

**结论：二期不能，也不假装能。**

- `capabilities.send = false`（claude 的 `messagingSocketPath` 是内部 peer 协议，`peerFeatures` 未文档化、版本相关；codex 是 app-server 私有协议。写进去一旦出问题会污染别人的会话，风险 > 收益）。
- **派发候选过滤**：`buildCandidates` 增加 `capabilities.send === true` 过滤（外部会话直接不会出现）；`validateDecision` 增加同款校验（模型硬塞也拒绝，返回 `target_not_writable`）。
- **管家提示词**：新增一段——"候选里只会有可写来源（dsh）；外部来源（Claude/Codex）只能读和报状态，**不要**尝试派发或改派到它们；如果用户要求给某个 Claude/Codex 会话派活，告诉用户该来源只读"。
- **改派**：`reassign` 目标同样过滤。
- 三期若要做，可加"spawn 模式"：用 `claude -p` / `codex exec` **新建**一个 headless 会话（create=true 但 resume=false），这属于新进程而非消息注入，风险可控，单独评估。

---

## 7. UI 方案

- **会话列表/候选**：每行加来源徽标 `dsh` / `Claude` / `Codex`（颜色区分，沿用现有 chip）；面板顶部加来源筛选（全部 / dsh / claude / codex）。
- **unsupported 动作**：外部会话行上"改派/派发/批准/回答"按钮置灰，`title`/tooltip 与点击 toast 都是「该来源不支持」。
- **收件箱**：外部来源的卡点只读展示——可以显示"Claude 正在等权限确认"，但**不给批准按钮**（给了也执行不了），改为「去 Claude Code 处理」的说明。
- **管家标签页**：按来源分组（dsh 组在上），组内保持现有排序；标题带来源前缀。
- **提醒联动**：只有 dsh 派发的任务才有进度/完成提醒；外部来源**不发提醒**（否则用户会被噪音淹没，也无法处理）。

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 外部格式随版本变（Claude 2.1.293 / Codex 0.151.0-alpha） | 解析器**防御式**：坏行跳过、未知 `type` 忽略并计数、记录 `version` 字段；连续解析失败超阈值 → 该 source 自动降级为 `list-only` 并在面板提示"解析异常，已降级" |
| 子会话/孤儿文件误判 | Claude 用 `subagents/` 目录判定；Codex 无标记 → 文档标注为已知限制，UI 提供"标记为非 root"的手动覆盖（仅本地 Memory） |
| 性能/IO | tail 读 + mtime 缓存 + 14 天窗口 + 懒加载 digest + 单文件大小上限 |
| 权限 | 只读 `projects/`、`sessions/*.json`、`sessions/**`、`*.sqlite`；**不读 `.key`**；文件权限不足时该会话标 `unreadable` 而不是报错中断 |
| 隐私（会话含代码/token/内部数据） | 复用现有 `redact()`；digest 截断 400 字/条、最多 20 条；**不外发**、不上报；日志只写 sessionId 不写内容；面板默认只显示标题+状态，点开才展示 digest |
| sqlite 读取锁/WAL | 用 `immutable=1` 只读打开（实测可用）；失败则降级为 rollout tail 推断，标 `unknown` |
| 与 dsh 混淆 | `source` 字段贯穿 + UI 徽标 + 审计带 source，四道保险 |

---

## 9. 文件清单与接口边界

**新增**

```
src/sources/types.ts      SourceKind / SourceCapabilities / SourceSession / SessionSource（照文档 §9.2）
src/sources/registry.ts   SourceRegistry：list() 聚合、sourceFor(sessionId)、capabilitiesFor(kind)
src/sources/claude.ts     ClaudeSource（读 ~/.claude）
src/sources/codex.ts      CodexSource（读 ~/.codex，含 sqlite turn 表）
src/sources/jsonl.ts      tail 读、逐行安全解析、mtime 缓存
src/sources/paths.ts      路径/uid 规整（slug 反解禁用、pid 存活检查）
```

**改动（尽量小）**

```
src/source.ts     DshSource 实现新接口（保持现有方法，加 capabilities/source/kind）
src/service.ts    15 处 this.source.* → this.sources.for(sessionId).*；listSessions 聚合多源
src/types.ts      SourceKind + 各记录的 source?: 字段
src/router.ts     candidate 增加 source/capabilities，过滤不可写来源
src/store.ts      （无 schema 变更，只加可选字段的读写透传）
src/client/index.ts  徽标/筛选/置灰（等 8e93ebcc 先落地再动）
src/butler-tools.ts  butler_status/inbox 输出带 source；dispatch 拒绝不可写目标
src/config.ts & types.ts  sources.{claude,codex}.{enabled,sessionScanDays,maxFileBytes}
```

**接口边界**：核心（router / blockers / plans / risk / audit）**只 import `src/sources/types.ts`**，不得 import `claude.ts`/`codex.ts` 或任何 dsh 类型。用一个 `import/no-restricted-paths` 式的单测保证（扫描 import 语句）。

---

## 10. 分步实施（每步独立可回滚）

| 步骤 | 内容 | 交付/验收 |
|---|---|---|
| **P0 抽象**（不改行为） | 落地 `sources/types.ts`、registry；`DshSource` 实现接口；service 改走 registry；`source` 字段写入 + 读取兜底 | 现有 122 个测试全绿；新增"默认 dsh、旧记录兼容"测试；**不动提醒与面板** |
| **P1 Claude 只读** | `ClaudeSource`：list/title/cwd/root-vs-subagent/status(活进程表)/digest；`fs.watch`+60s 兜底 | fixture 驱动的解析测试（含坏行/未知 type/大文件/权限不足）；本机 189 session 实跑一遍不超时；**默认关闭**，配置开启 |
| **P2 Codex 只读** | `CodexSource`：rollout 扫描 + `thread_turns` 状态 + `session_index` 标题兜底 | fixture 测试（含 `inProgress`/`interrupted`/`failed`/WAL 滞后）；本机 20 rollout 实跑 |
| **P3 UI + 降级** | 徽标/筛选/置灰/只读卡点文案；`router` 过滤不可写；管家提示词 | 前端快照测试 + 手工验证；能力矩阵逐项对照（不允许 UI 出现能点但无效的按钮） |

每步都带 `npm run verify`，P0 之后原有行为必须逐字节不变（snapshot 对比）。

---

## 11. 明确不做

1. **不写** `~/.claude` / `~/.codex`（不改文件、不建会话、不删记录）。
2. **不接** claude peer socket / codex ipc.sock —— 除非单独立项并做故障演练。
3. **不代答**外部来源的审批/提问，**不设**外部计划门禁（门禁只对 dsh worker 有意义）。
4. **不做** remote/云端、ducc 专有协议（本期只 claude/codex）。
5. **不改** dsh core，不给外部来源装 worker 工具。
6. **不做**跨来源迁移/合并、不把 Claude 会话"导入"成 dsh 会话。
7. **不自动开启**：默认 `sources.claude.enabled=false`、`sources.codex.enabled=false`，用户显式打开才扫描（隐私兜底）。

---

## 12. 与 session-8e93ebcc 的冲突声明

我这边会改到：`src/service.ts`（listSessions/snapshot/dispatch 相关，**不碰 700–870 行的提醒注入区**）、`src/client/index.ts`（会话列表与卡点的来源徽标/置灰）、`src/butler-tools.ts`、`src/types.ts`、`src/router.ts`、`src/source.ts`（+ 新增 `src/sources/**`）。

对方在改「提醒交互形态（消息注入 + 面板）」，大概率落在 `src/service.ts` 的 `injectMessage/queueProgress/maybeRemind`（≈700–870 行）和 `src/client/index.ts` 的 `InboxView`。

**冲突点**：同两个文件、不同区域。建议：P0/P1/P2 **完全避开**那两个区域（P0 只动 `listSessions`/`this.source` 调用点），**P3（UI）等 8e93ebcc 合入后再做**；如果对方要同时改 `InboxView`，我先只做"来源徽标"一个小组件，等对方合并后再接线。

---

## 待你拍板

1. `SourceKind` 用文档的 `ducc` 还是 `claude`？（我建议 `claude`，`ducc` 做别名归一化）
2. 外部来源默认关闭（推荐）还是一装上就扫描？
3. Codex 无根/子会话标记，能否接受"不区分"这一限制？
4. 确认二期**不做派发/审批代理**（只读旁路），三期再评估 spawn 模式？
5. UI 部分是否等 8e93ebcc 合入后再动？
