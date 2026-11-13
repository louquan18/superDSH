# SuperAgent 管家 · 问题与优化清单

> ⚠️ 本文件是仓库内副本，**由 `docs/dsh-superagent-butler-issues.md` 同步而来**；请改那一份，再整份覆盖这里，不要直接编辑本文，否则两份会漂移。

> 最后更新：2026-11-13
> 维护方式：增量维护。新问题先入 `📥 待处理`；修完只改状态、补备注，不删条目、不复用编号。

## 使用说明

**用途**：先记下来，不急着修。任何发现的问题（bug、误报、体验问题、待验证疑点）先记进这份清单，避免遗忘；修不修、什么时候修、值不值得修，另说。

**怎么加新条目**：
1. 新问题默认进 `📥 待处理`，追加在该分区末尾；已经在修但没修完的进 `🔧 进行中`。
2. 编号取当前最大号 +1（**以「快速索引」表里的最大编号为准**，不要凭记忆）；作废的编号不复用（历史：I-27 曾用于重复条目，已并入 I-21）。`I-XX` 只增不减，删条目、复用旧号都不允许。
3. 复制四字段模板：`状态` / `现象` / `修复方法` / `备注`，四项必填。
4. 同步在顶部「快速索引」加一行（编号 / 标题 / 状态 / 优先级）。
5. 修完后：状态改成 ✅，修复方法补实际改动，备注补验证方式与时间；条目本身保留。

**状态流转**：`📥 待处理` → `🔧 进行中` → `✅ 已修复` / `⏸️ 待决策` / `🚫 不修（说明理由）`
- `⏸️ 待决策`：需要用户拍板；拍板后回到 `🔧` 或 `📥`。
- 任何状态都可以直接转 `🚫 不修`，但必须写明理由与已知影响。
- 已修复条目不删，保留历史；后来者看编号即可知道它存在过。

**写条目的要求**：
- 现象要能复现、能指认位置：文件/行号、工具名、命令、会话 id、请求参数。
- 不要写「优化一下」「体验不好」这种不可执行的描述。
- 修复方法写具体改动；没想好就写 a/b/c 选项和倾向。
- 备注写验证方式（单测/集成/真机）、相关条目、决策记录、日期。

**优先级**：

| 级别 | 含义 |
|---|---|
| P0 | 插件不可用 / 数据丢失 / 阻断主流程 |
| P1 | 错误结论、高频噪音、安全或权限问题 |
| P2 | 一般体验、待补充、低频率 |

## 快速索引

| 编号 | 标题 | 状态 | 优先级 |
|---|---|---|---|
| I-01 | 进度通知没有实时投递 | ✅ 已修复 | P1 |
| I-02 | 通知不会唤醒管家 | ✅ 已修复 | P1 |
| I-03 | 新派发把历史里程碑当成新进度补报 | ✅ 已修复 | P1 |
| I-04 | `butler_send` 给不存在的会话返回成功 | ✅ 已修复 | P1 |
| I-05 | `butler_reassign` 未校验只读目标 | ✅ 已修复 | P1 |
| I-06 | `decision` 类型卡点无法「回答」 | ✅ 已修复 | P1 |
| I-07 | 计划门禁静默降级 | ✅ 已修复 | P1 |
| I-08 | `submit_plan` 返回 not_required 时方案不落盘 | ✅ 已修复 | P1 |
| I-09 | 工具参数错误导致派发进入终态 failed | ✅ 已修复 | P1 |
| I-10 | `ask_user_question` 被中断时问题正文丢失 | ✅ 已修复 | P2 |
| I-11 | `job_kill` 反复弹审批 | ✅ 已修复 | P1 |
| I-12 | watchdog 把「闷头干活」误判成停滞 | ✅ 已修复 | P1 |
| I-13 | 打开 Claude 来源导致整个管家插件不加载 | ✅ 已修复 | P0 |
| I-14 | 来宾源失败隔离只覆盖 `list()` | ✅ 已修复 | P1 |
| I-15 | 启动异常会拖垮整个插件 | ✅ 已修复 | P1 |
| I-16 | 来源不可用无观测 | ✅ 已修复 | P2 |
| I-17 | 「代码通过、真机没验」反复发生 | ✅ 已修复 | P1 |
| I-18 | `butler_session_read` 读不了 claude/codex 内容 | ✅ 已修复 | P2 |
| I-19 | watchdog 把「等审批」误判为停滞 | ✅ 已修复 | P1 |
| I-20 | watchdog 不识别「疑似已完成」 | ✅ 已修复 | P1 |
| I-21 | 派发不销账导致 watchdog 反复产生假唤醒 | ✅ 已修复 | P1 |
| I-22 | 改配置文件必须跨沙箱提权 | ✅ 已修复 | P1 |
| I-23 | 老管家会话积压消息 | ✅ 已修复 | P2 |
| I-28 | 工作完成或卡点结束后没人销账，派发一直挂着 | ✅ 已修复 | P1 |
| I-29 | `butler_dispatch` 的决策字段名与工具说明不一致，传错时报错误导 | ✅ 已修复 | P2 |
| I-30 | 审批在界面上不可见，且审批路由不分层 | 📥 待处理 | P1 |
| I-31 | MCP 工具全走审批致自动化验证不可行 | ✅ 已修复 | P1 |
| I-32 | 审批链上没有主动方 | 📥 待处理 | P0 |
| I-33 | 计划只能去侧栏明细看，对话里无法审批 | ✅ 已修复 | P1 |
| I-34 | 提醒送达无持久化，管家离线即丢且同签名不重发 | ✅ 已修复 | P0 |
| I-35 | 计划 scope 绝对路径与匹配相对路径错位，计划内写入被误判计划外 | ✅ 已修复 | P1 |
| I-24 | Claude 的 running 是推断值 | 🚫 不修 / 已知限制 | P2 |
| I-25 | Codex 无法区分 root / 子会话 | 🚫 不修 / 已知限制 | P2 |
| I-26 | 外部来源只读 | 🚫 不修 / 已知限制 | P2 |

## 📥 待处理

### I-30 审批在界面上不可见，且审批路由不分层（该代审的代审，该人决策的要讲清楚）
- **状态**：📥 待处理
- **现象**：用户原话「我都看不见审批」。实测：2026-11-12 A 组派发 `dsp_62698bd1a59b42f0` 的收尾命令（`git commit` + `git tag v0.3.1` + `git push origin main` + `git push origin v0.3.1`）触发审批 `apv_594f87b1f1684e34` / 卡点 `blk_efc421da2c074b40`，风险判定 high、理由写得也算清楚，但用户在 GUI 上找不到这条审批，最后只能由管家在聊天里口头转述「它卡在等你允许 push」，才把决定做掉。同一现象还叠着一个路由问题：所有审批一律推给用户——本可由管家按既定规则直接判定的（例行 git 操作、清理自己起的 job、工作区内低频写入）也要用户点，而真正需要人拍板的（对外发布、跨仓库/跨沙箱写入、参数或配置变更）只有一条原始命令，没有「为什么需要你、需要你定什么、建议怎么定」的结构化说明。
- **修复方法**：分两层，建议 (a)+(b) —
  (a) **分层代审**：审批进来先过一条策略（单一事实来源，如 `approvalPolicy`），命中的由管家直接判定并写审计（`by = butler-auto` + 规则 id），同时留一条记录（可配置静默），不再打断用户；未命中的升级到 (b)。
  (b) **人决策的可读卡片**：升级的审批渲染成结构化卡片——`原因` / `需要你决策什么` / `建议决策（含理由）` / `备选与后果` / 一键「按建议放行 · 拒绝 · 我要看看命令原文」；复用现有 `superagent-notice` 卡片通道，或直接复用宿主原生审批 UI，二者选一但要能带按钮、能回流结果。
  (c) **兜底**：无论走哪层，审批对象在任何界面都必须可见可点；不能出现「审批存在但用户看不见」的状态（这正是本条的主症状）。
- **备注**：2026-11-12 A 组验收时由用户提出；与 I-11（job_kill 归属免审批，已修的其实是 (a) 的一个特例）同源，本条把它一般化；与 I-29（报错不可诊断）同属「宿主 ↔ 用户之间的信息断层」。优先级 P1：不阻塞代码执行，但会让人工审批变成瓶颈、并诱发盲点。

### I-32 审批链上没有主动方：worker 不告知、管家不提醒、用户看不见，只能靠人偶然发问
- **状态**：📥 待处理
- **现象**：用户原话（2026-11-13）：「管家管理的 worker 需要审批，用户侧看不见任何提示需要审批，管家也不会主动提醒用户，而且也只能通过管家对话进行审批。理想的应该是 worker 通知管家需要审批，然后管家拦截一部分自动放行，这里可以调用大模型思考权限安全，需要用户审批的由管家发消息给用户。」实测佐证：A 组真机验证派发 `dsp_0bf52c3be5f441e8` 自 2026-11-12 19:50 至 2026-11-13 11:33 前后产生 4 条审批卡点——`blk_590c348ae9414999`（`new_page`）、`blk_e3ab1bf8551044b1`（`take_snapshot`）、`blk_1ce25e0ee8604a76`（`fill`）、`blk_53d4c239d8514de5`（`take_snapshot`），**每一条都存在但界面上零提示**，全靠管家在聊天里口头转述才被发现，第一条挂了 14 小时。结构性缺陷：审批 → 管家 → 用户 这条链上**没有任何一步是主动的**——worker 遇审批不会告知管家，管家不运行就不会开口，用户不问就永远不知道。另有一个连带故障：审批挂起时 turn 被冻结，**队列里的新指令不会被消费**（本次管家连发 3 条「收尾」指令全部卡在 `queuedCount`，最后只能靠「拒绝审批」把 turn 撬开才读到）。
- **修复方法**：三层，建议按 (1)→(2)→(3) 推进 —
  (1) **主动上报**：worker 遇到审批时，插件必须产生一条**用户可见的提醒卡片**（复用 `superagent-notice` + `progressNotices` 通道），带「需要你审批」语义与 `dispatchId`，**不依赖管家是否在运行**。
  (2) **管家代审（LLM 判权）**：审批进来先交管家判断——把「命令原文 + 宿主给的风险原因 + 当前派发任务上下文」交给模型，输出 `allow / deny / escalate` 三选一。`allow` 直接放行并写审计（`by=butler-auto` + 判权理由 + 规则 id）；`deny` 拒绝并说明；`escalate` 走 (3)。
  (3) **人决策且由管家主动开口**：升级的由管家**主动**发消息给用户（原因 / 需要你决策什么 / 建议决策含理由 / 备选与后果 / 按钮），带 dispatchId 级去重与冷却，避免同一审批反复骚扰。
  **硬约束**：判权结果必须落审计并带理由，`allow` 要可枚举可回放；**不允许「判断不出来就默认放行」**（那是把风险从审批转移成静默）。
- **备注**：与 I-30、I-31 同源但**问的是三件不同的事**——I-30 问「审批看不看得见、该谁批」，I-31 问「每步都批导致自动化验证跑不完」，本条问「**审批链上没有主动方**：worker 不报、管家不问、用户不知」。与 I-31 叠加时后果最严重：一条自动化任务可以无限期停摆而无人知晓（本次 14 小时实例）。优先级 **P0**：不是体验问题，是「任务卡死且无人发现」的可靠性缺口。2026-11-13 记录。

> 待新增：发现即记，不要攒着。按上面的四字段模板追加到本节末尾，编号取当前最大 +1，并同步快速索引。

## 🔧 进行中

（暂无）

## ⏸️ 待决策

（暂无）

## ✅ 已修复

### I-01 进度通知没有实时投递（只能"搭用户的车"）
- **状态**：✅ 已修复
- **现象**：任务完成/阶段结束的提示只有用户主动发消息时才出现在界面上；管家也一样——用户不问就不知道。根因：progress 事件只走 `agent/pre-step` 注入（拼进用户下一条消息），没有进快照；客户端唯一实时源 `/api/superagent/state`（2 秒轮询）里只有 `blockerNotices`（仅来自 open blocker）。
- **修复方法**：快照新增独立队列 `progressNotices`（与 `blockerNotices` 严格隔离）；客户端新增「进度」时间线（带来源徽标、无任何可点动作）；事件落盘、`open→expired`（ttl 24h）、`queueLimit 50`、同签名去重；注入保留给模型并打 `modelOnly` 标记避免重复渲染。
- **备注**：真机验证——不发任何消息（`composed=0`），1.5 秒内卡片自己出现；刷新后仍在；`progressNotices=1` 且 `blockerNotices=0`。测试 246 → 258 全绿。2026-11-09。

### I-02 通知不会唤醒管家
- **状态**：✅ 已修复
- **现象**：进度事件发生时管家不运行，无法主动推动/追问。
- **修复方法**：`decideWake` 四道闸——事件类型（只对阶段结束/完成/停滞）、同 dispatch 同签名只唤醒一次、每 dispatch 配额、全局 `minGapMs` 节流；管家 running 时不唤醒；签名先落盘再发 prompt；可整段关闭。
- **备注**：连续触发有上界；关闭后完全静默。2026-11-09。

### I-03 新派发把历史里程碑当成新进度补报
- **状态**：✅ 已修复
- **现象**：新派发刚建好就收到「完成 5 项」，内容是目标会话上一轮任务的旧成果。根因：游标存在 `dispatch.progress`，新派发游标为空，首扫把已有 `done` 全当新里程碑。
- **修复方法**：`startDispatch` 时用目标会话当前 `softStatus.done` 预登记进 `progressKeys`/游标；`noteReport` 路径不重报历史；之后新增的里程碑照常推送。
- **备注**：3 条单测 + 2 条集成（3 条历史不推、新增 1 条只推 1 条、空历史等价初始游标）。2026-11-09。

### I-04 `butler_send` 给不存在的会话返回成功
- **状态**：✅ 已修复
- **现象**：传错 sessionId 仍返回 `{ok:true}`，消息静默丢失。
- **修复方法**：先校验 sessionId 在列表中存在，再校验 `capabilities.send === true`；失败返回 `session_not_found` / `target_read_only`，且不产生任何副作用（不写审计、不改派发状态）。
- **备注**：验证方式待补充。2026-11-09。

### I-05 `butler_reassign` 未校验只读目标
- **状态**：✅ 已修复
- **现象**：原文件未单列现象；标题即问题：`butler_reassign` 未校验只读目标（可把派发改到 claude/codex）。
- **修复方法**：补 `target_read_only` 校验，且校验发生在任何状态变更/审计/投递之前。
- **备注**：验证方式待补充。2026-11-09。

### I-06 `decision` 类型卡点无法「回答」
- **状态**：✅ 已修复
- **现象**：卡片上写着「回答这个决策；管家会转发」，但 `butler_resolve(action='answer')` 返回「不支持的操作」，只能 dismiss。根因：`resolveBlocker` 只有 `plan_review` 分支处理 `answer`。
- **修复方法**：decision + answer 分支——`【管家】用户答复：<text>` 转发给会话 → 卡点标 `resolved`、`resolution=text` → 审计 `kind:'blocker'`/`action:'answer'`；回答后把该条 decision 从软状态摘掉避免下轮复现；新增 `ANSWERABLE_KINDS` 作为「客户端按钮 ↔ 宿主能力」单一事实来源。
- **备注**：验证方式待补充。2026-11-09。

### I-07 计划门禁静默降级（方案交了却没人看得到）
- **状态**：✅ 已修复
- **现象**：派发因工具报错被标 `failed` → `butler_submit_plan` 返回 `not_required(manual_session)` → 方案一个字节没入库，`snapshot.plans` 为空，管家无感。
- **修复方法**：`planRequired` 抽成纯函数 `planRequiredFor`，**不看派发状态**；`submitPlan` 改用 `currentDispatch` 判定。
- **备注**：验证方式待补充。2026-11-09。

### I-08 `submit_plan` 返回 not_required 时方案不落盘
- **状态**：✅ 已修复
- **现象**：原文件未单列现象；标题即问题：`submit_plan` 返回 `not_required` 时方案没有落盘。
- **修复方法**：落盘为 `skipped` 并给管家发带 `planId` 的 notice；方案摘要进 blocker/notice（保全 `planExcerpt`）。绝不允许方案只存在于工具参数里。
- **备注**：验证方式待补充。2026-11-09。

### I-09 工具参数错误导致派发进入终态 failed
- **状态**：✅ 已修复
- **现象**：原文件未单列现象；标题即问题：工具参数错误导致派发进入终态 `failed`。
- **修复方法**：可恢复的 turn 错误改为 `error`（非终态），并产生带错误原文的 blocker；`markDispatch`/`maybeRemind`/`noteProgress` 等处同步把 `error` 视为活动状态。
- **备注**：验证方式待补充。2026-11-09。

### I-10 `ask_user_question` 被中断时问题正文丢失
- **状态**：✅ 已修复
- **现象**：卡点只显示「turn 被中断/崩溃」，看不到在问什么。
- **修复方法**：把待回答的问题写进 blocker 的 `evidence`/`neededAction`。
- **备注**：验证方式待补充。2026-11-09。

### I-11 `job_kill` 反复弹审批
- **状态**：✅ 已修复
- **现象**：worker 清理自己起的 job 也要用户逐次批准。
- **修复方法**：门禁新增 `job_kill` 专用分支——`owner === 当前会话 id` 直接放行；别人的/不存在的 job 仍要求审批并写明「该 job 不属于本会话」；**只放行 `job_kill`**，不动 `bash`/`write`。
- **备注**：验证方式待补充。2026-11-09。

### I-12 watchdog 把"闷头干活"误判成停滞
- **状态**：✅ 已修复
- **现象**：会话持续活动但没调 `butler_report_status`，被报「45 分钟没有进展」。
- **修复方法**：无进展时长改为 `now - max(lastProgressAt, lastActivityAt)`（用 `runtime.lastActivityAt`，**不用** `managed.lastSeenAt`——那会被扫描刷新导致永不触发）；分桶节流语义不变；老派发无 watchdog 字段仍整段跳过。
- **备注**：验证方式待补充。2026-11-09。

### I-13 打开 Claude 来源导致整个管家插件不加载（P0）
- **状态**：✅ 已修复
- **现象**：配置 `sources.claude.enabled=true` 并重启后，所有管家会话失去工具（`butler_status` 报 unknown tool），删掉配置重启即恢复。根因：Claude **子会话** id 被拼成 `<root-uuid>:<agent-名字>`，冒号不是合法文件名；落库时被 `assertSafeKey` 判定 not path-safe 抛错 → `create()` 在 `init()` 失败 → `provide('superagent')` 未执行 → 管家 preset 挂不上。为什么只有开 claude 才触发：这条路径只处理 `subagents/agent-*.jsonl`，dsh 与 codex 都不会产生带冒号的 id。
- **修复方法**：子会话 id 分隔符 `:` → `-`；`store.putSession` 入口校验 key（非法只跳过持久化、不抛）；单条写库失败只告警。
- **备注**：防回归——`npm run verify` 增加 `smoke:cold-start`（真实 dsh 冷启动 + claude/codex 双开含子会话）；已反向验证，把冒号改回去该冒烟会红。真实验证：真实 `~/.claude` 冷启动 48 个会话（含 11 个子会话）全部 path-safe；261 全绿。2026-11-09。

### I-14 来宾源失败隔离只覆盖 `list()`
- **状态**：✅ 已修复
- **现象**：原文件未单列现象；标题即问题：来宾源失败隔离只覆盖 `list()`，构造/启动/首次扫描失败仍可能拖垮插件。
- **修复方法**：`ClaudeSource`/`CodexSource` 的构造、`start()`、首次扫描都用自己的 source 边界 try/catch，失败只标「该来源不可用」，核心（dsh 会话/卡点/派发/审批）照常工作。
- **备注**：验证方式待补充。2026-11-09。

### I-15 启动异常会拖垮整个插件
- **状态**：✅ 已修复
- **现象**：原文件未单列现象；标题即问题：启动异常会拖垮整个插件。
- **修复方法**：`apply()` 兜底——`create()` 失败时仍 `provide('superagent')` 一个降级服务，管家至少能说话并报告原始错误，不再整体变哑。
- **备注**：验证方式待补充。2026-11-09。

### I-16 来源不可用无观测
- **状态**：✅ 已修复
- **现象**：原文件未单列现象；标题即问题：来源不可用时没有观测。
- **修复方法**：快照新增 `sources` 健康状态 `{kind, enabled, available, error, at}`，来源不可用不再静默。
- **备注**：验证方式待补充。2026-11-09。

### I-17 「代码通过、真机没验」反复发生
- **状态**：✅ 已修复
- **现象**：多次单测/`check-client` 全绿，但真实浏览器里功能不存在或崩溃。
- **修复方法**：新增 `smoke:cold-start`（真服务冷启动）与真机验收要求（P3、B-1 均按「真 Chrome + 不发消息」验收）；`check-client` 的假 React 渲染只作为补充，不作为验收依据。
- **备注**：该条是流程缓解，不是单点代码修复；2026-11-09。

### I-18 `butler_session_read` 读不了 claude/codex 会话内容（B-4）
- **状态**：✅ 已修复
- **现象**：`butler_session_read` 对 claude 会话返回「session 不存在或不可读」。管家能看见「它在跑」，看不见「它在做什么」，而且这句错误把「不存在」和「不支持读」混成一件事，管家无从判断下一步。
- **修复方法**：按选项 (a) 重写工具的读取路径（`src/butler-tools.ts` 的 `butler_session_read.execute`）：
  1. 先用 `service.sourceKindOf(sessionId)` 定位来源，再 `service.sources.get(kind)` 拿该来源；
  2. 按 `capabilities.readEvents / readDigest` 判定能不能读内容；
  3. **三种结果可区分**：`{error:'session_not_found'}` / `{error:'source_read_unsupported', source}` / 正常内容（带 `source` 字段）；
  4. dsh 仍走原来的 `service.source.observe()`（行为不变），来宾来源回退到它自己的 `observe()`（实测返回同形状 `{header, events}`）。
- **备注**：单测 3 条（`test/unit/butler-tools.test.ts`：能读 digest / 不支持读 → `source_read_unsupported` / 不存在 → `session_not_found`）。2026-11-12。

### I-19 watchdog 把「等审批」误判为停滞
- **状态**：✅ 已修复
- **现象**：会话 `awaiting_approval` / `awaiting_answer` 期间静止，watchdog 连续误报「N 分钟没有进展」。根因：`detectProgress` 只拿到 `lastActivityAt`，**根本不知道会话在等人**。
- **修复方法**：`src/progress.ts` 的 `DetectProgressInput` 新增 `hardStatus`，`src/service.ts` 在调用处透传 `this.hardStatusFor(sessionId)`；`awaiting_approval` / `awaiting_answer` 期间不产生 watchdog 事件（anchor 也不动，避免人一处理完就立刻炸一条）。`running` / `idle` 行为不变。
- **备注**：单测 1 条覆盖 4 种硬状态（`test/unit/progress.test.ts`）。**反向验证**：把排除条件改成 `const waitingHuman = false` → 该用例变红（298/299），还原后 299 全绿。2026-11-12。

### I-20 watchdog 不识别「疑似已完成」
- **状态**：✅ 已修复
- **现象**：任务早已干完、会话 idle、`softStatus.next` 为空，watchdog 仍问「做到哪了」，产生假唤醒。
- **修复方法**：两层。
  1. **换说法**：`dispatch.suspectDoneAt` 有值或 `cursor.stageEnds ≥ 1` 时，watchdog 文案从「N 分钟没有进展」改成「看起来已经干完了，要不要销账」，引导人做收尾而不是继续追问。
  2. **降频率**：`stageEnds ≥ 1` 的派发把巡检间隔退避为 2 倍（`pollMs * 2`），避免干完不收尾的派发被反复打扰。
- **备注**：单测 1 条（疑似完成时标题含「销账」不含「没有进展」；退避后 15 分钟不报、25 分钟报）。2026-11-12。

### I-21 派发不销账导致 watchdog 反复产生假唤醒
- **状态**：✅ 已修复
- **现象**：任务实际已完成，但派发记录仍是 `delivered`，watchdog 每隔 `pollMinutes` 唤醒一次；2026-11-09 当天产生 6+ 次误报。
- **修复方法**：与 I-28 同源，按三层落地（(1) 建议销账 + (2) 完成信号 + (3) TTL），并叠加 P2 的 Thread：`markDispatch(completed)` 现在会连带 `closeThread(done)`，活关掉后该 thread 的卡点统一归档，watchdog 也不再巡检已结束的派发。
- **备注**：见 I-28 的三层说明与验证；收敛后「假唤醒」的触发面从「任意未销账派发」缩到「仍在跑或仍挂着真实卡点的派发」。2026-11-12。

### I-28 工作完成或卡点结束后没人销账，派发一直挂着
- **状态**：✅ 已修复
- **现象**：worker 干完活（或卡点已 resolved），dispatch 仍停在 `delivered`，管家没有任何机制发现「这条可以关了」。实测 `dsp_a88320b41f4e4d91` 文档早已改完，状态至今仍是 delivered。
- **修复方法**：按清单建议 (1)→(2)→(3) 三层全部落地：
  1. **自动建议销账（不擅自销账）**：新增卡点类型 `settle_suggest`。判定条件「`hardStatus=idle` + `softStatus.next` 为空 + 有完成信号（`suspectDoneAt`）或 `stageEnds≥1` + 派发仍 open」，在 `src/service.ts` 的 `settleSuggestBlocker()` 里产出；提醒卡片**复用现有 `dispatch_completed` 按钮**（客户端带 `notice.dispatchId` 调 `dispatch_mark`），并另有「还在干，继续观察」→ dismiss，**冷却 6 小时**（`settleSuggest.cooldownMs`）不再提。
  2. **完成信号（事实而非推断）**：`Dispatch` 新增 `suspectDoneAt` / `suspectDoneReason: 'report'|'stage_end'`。worker 经 `butler_report_status` 报完（done 非空、next 空、无 blocker）时记录 `'report'`；检测到阶段结束时记录 `'stage_end'`；`markDispatch` 时清空。
  3. **TTL 兜底**：`Config.settleTtl`（默认 **`enabled:false`**、`minutes:1440`）。仅当「超时 + 无活动 + **无待审计划** + 无其它 open 卡点」时自动转 completed，`by='butler-auto'`，并写审计 `action:'settle_ttl'`。
- **备注**：集成用例 3 条（建议产出条件 / 卡片带 dispatchId 且点「确认完成」真的销账并连带关 thread / 忽略后冷却期内不再建议）+ 单测覆盖文案。**反向验证**：去掉「只在 idle 时建议」守卫 → 该用例变红（298/299），还原后 299 全绿。TTL 默认关闭，默认值待用户拍板。2026-11-12。

### I-29 `butler_dispatch` 的决策字段名与工具说明不一致，传错时报错误导
- **状态**：✅ 已修复
- **现象**：按工具说明「reuse / new / clarify」的措辞传 `{"mode":"new"}`，宿主连续 4 次返回 `{"kind":"clarify","reason":"target_ambiguous"}`，且**没有 message**，完全指不到真正原因；实际校验的是 `kind`（`service.ts` 的 `dispatchExecute`），新建会话还必须带 `cwd`。
- **修复方法**：三件一起做。
  - **(a) 说明写清契约**：`butler_dispatch` 的 description 写明 `decision.kind = 'new'|'reuse'|'clarify'`，给出最小可用示例（`{"kind":"new","cwd":"/abs/path"}`、`{"kind":"reuse","sessionId":"session-…"}`），并点明 reuse 用 `sessionId` 而非 `targetSessionId`、new 时 `cwd` 必填；`decision` 的 schema 也补了字段说明。
  - **(c) 报错可自我纠正**：新增 `normalizeDecision()`，非法 kind / 缺 cwd / 缺 sessionId 时返回 `reason:'invalid_decision'`，message 里带上**实际收到的键名**和最小示例；两处 `target_ambiguous` 也补了 message（分别说明「只接受 reuse/new」和「sessionId 不在候选里，请先拿候选」）。
  - **(b) 兼容旧写法**：`mode`→`kind`、`targetSessionId`→`sessionId` 归一化后**仍走原严格校验**，不放松任何判定。
- **备注**：单测 1 条（说明含契约与示例）+ 集成 2 条（旧写法 `mode`+`targetSessionId` 成功 / 写错字段时 message 含实际键名与示例）。2026-11-12。

### I-31 MCP 工具全部被判「未知工具」，每个调用都要人工审批，自动化真机验证实际上不可行
- **状态**：✅ 已修复
- **现象**：每次 MCP 调用都被判 `risk=unknown`，逐次弹审批（实测一条挂了 14 小时）。真机验证在 gate_confirm 下事实上跑不完。
- **修复方法**：按 (a)+(c) 落地。
  - **(a) 分级**（`src/risk.ts`）：新增 `mcpParts()` 解析 `mcp__<server>__<method>`，并按**方法名**分级，不再按 server 一刀切：
    - 只读（`MCP_READ_ONLY_METHODS`）= `low` 自动放行：`take_snapshot` / `list_pages` / `take_screenshot` / `list_console_messages` / `get_console_message` / `list_network_requests` / `get_network_request`；
    - 有副作用（`MCP_MUTATING_METHODS`）= `high` 需审批：`click` / `fill` / `form` / `navigate_page` / `new_page` / `close_page` / `press_key` / `type_text` / `hover` / `drag` / `upload_file` / `resize_page` / `handle_dialog` / `emulate` / `evaluate_script` / 性能追踪 / 堆快照 / lighthouse；
    - **表里没有的方法一律回落 `unknown`（要人确认），绝不默认放行**。
  - **(c) 同类批一次**（`src/service.ts` 的 `mcpAlreadyApproved()` + gate）：同会话、同 `server.method` 已有 `user_approved`/`auto_approved` 记录时直接放行，并写审计 `action:'mcp_batch_allow'`（`by=butler-auto`）。依据是**已落盘的审批记录**，重启后依然有效。配置：`mcp.batchApprove`（默认 `true`）。
- **备注**：`evaluate_script` **明确不算只读**——它能执行任意 JS（可读页面、可写 DOM、可发网络请求），放行等于绕过沙箱，故留在需审批。单测 3 条（只读放行 / evaluate_script 需审批 / 未知方法回落）+ 集成 1 条（批一次后不再问 + 留痕）。
  **反向验证**：把未知方法的 `risk: 'unknown'` 改成 `'low'` → 「未知方法回落」用例变红。2026-11-13。

### I-33 计划只能去管家侧栏「明细」里看，对话里没有审批入口，无法直接批
- **状态**：✅ 已修复（第 (3) 项「回复即批」未做，见备注）
- **现象**：worker 交方案后对话里既无摘要也无按钮，要看方案必须切侧栏「明细」。
- **修复方法**：复用现有通道，未新造通道。
  - **(1)(2) 待审计划进对话 + 带按钮**：`src/blockers.ts` 的计划卡点 `evidence` 补 `planStats`（几条计划 / 几条路径 / 几条命令）与 `planTitle`；`buildBlockerNotice` 把统计拼进卡片正文（`detail`），摘要仍是截断版；动作在原有「批准 / 提修改意见 / 驳回」之后新增只读的 **「查看完整方案」**（`verb: 'open_plan'`）。动作仍走现有 plan review 回传，与侧栏明细等价、状态同步。
  - **查看完整方案**：新增只读动作 `plan_detail`（`src/service.ts` 的 `handleAction`）按需返回 `{planId,title,status,summary,markdown,scope}`；客户端（`src/client/index.ts` 的 `NoticeCard`）点开后把正文内联展开在卡片下方。**刻意不把整篇方案塞进快照**：快照每 2 秒轮询一次，塞进去会把 payload 放大且与轮询频率相乘。
  - **(4) gate_confirm 也要可见**：`recordSkippedPlan` 的通知改成开头即写「本次不阻塞」，并给出 `planSummary`（规模）、摘要与 `planId`（侧栏明细可看全文），不再只留一句系统提示。
- **备注**：**第 (3) 项「在对话里回一句『通过』即视为审批」未做**——需要把用户自由文本匹配到具体 planId（多计划并存时易误判），成本与风险都明显高于收益，留给下一轮或单独拍板。单测 1 条（卡片带统计 + 入口）+ 集成 2 条（待审计划进卡片且 `plan_detail` 可取正文 / gate_confirm 文案含「本次不阻塞」与 planId）。
  **反向验证**：删掉 `open_plan` 按钮那行 → 两条 I-33 用例 + 通知动作集用例共 3 条变红。2026-11-13。

### I-34 提醒送达没有持久化投递：管家离线时通知进内存队列，重启即丢，同签名永不重发
- **状态**：✅ 已修复
- **现象**：管家离线期间产生的提醒进内存队列（`pendingButlerNotices`），重启即丢；又因「同签名只唤醒一次」，同一签名的提醒此后不再重发——`settle_suggest` 等新功能只要赶上管家不在线就永远看不见，且不报错、不留痕。
- **修复方法**：按 (a)(b)(c) 全部落地。
  - **(a) 落盘再投递**：`Store` 新增 `listPendingNotices()` / `savePendingNotices()`（存 `meta` 表的 `pendingNotices` 键，不新增表、不动 STORAGE_SPEC 版本）；`queueButlerNotice()` 每次入队即落盘；`init()` 调 `restorePendingNotices()` 从存储重建未读队列——重启不再丢。
  - **(b) 去重语义分开**：`wake` 的同签名去重（`dispatch.progress.woke`）原样保留（防自激）；**卡片展示与它无关**——blocker 状态停在 `open`/`notified` 就一直在 `snapshot.blockerNotices` 里，重启后照常渲染（通道 C 不依赖管家运行）。
  - **(c) 投递失败可观测**：`injectButlerNotice()` 现在返回 `{delivered, queued, targets}`；`maybeRemind()` 改成**先投递、拿到结果再记账**：只在「已注入」或「已进持久化队列」时把 blocker 记成 `notified`、`reminderCount++`；两者都不成立时不记账，保持 `open` 等下一轮重试，并写审计 `action:'notify_deferred'`（原来是无条件先记账，内容丢了账还在，于是既不重发也不重算）。
  - **文案**：`flushButlerNotices()` 的「重启/离线期间新增 N 条提醒」在落盘之后**终于成立**，故保留原文案并补一句「（已落盘，重启不丢）」，不再是描述不存在的能力。
- **备注**：集成 1 条：管家离线 → 提醒落盘 → 清空内存模拟重启 → 从存储重建 → 卡片仍在快照里。
  **反向验证**：把 `queueButlerNotice()` 里那句 `this.persistPendingNotices()` 去掉（退回纯内存）→ 该用例变红。2026-11-13。

### I-35 计划 scope 绝对路径与匹配用的相对路径错位，计划内文件写操作被误判「计划外写操作」
- **状态**：✅ 已修复
- **现象**：已批准计划里明明写了 `PageServiceImpl.java`（绝对路径），worker 不带 `sandbox_permissions` 的 `edit` 却被判「计划外写操作」并弹审批。根因：`matchPlanPath()` 把目标转成**相对 projectRoot** 再与**绝对** scope pattern 做 glob，恒不命中。
- **修复方法**：按 (a)+(b)。
  - **(a) 归一化**（`src/plans.ts`）：新增 `scopePatternToRelative()`——绝对规则先 `toRelative` 到项目根，落在项目根外的规则忽略（`..` 开头），相对规则原样保留并去掉 `./` 前缀；`matchPlanPath()` 改为「归一化后的规则 vs 相对目标」比较。评分改用归一化后的规则长度，避免绝对规则因为前缀长而误胜。
  - **(b) 可观测**：新增 `explainPlanMiss()`，命中失败时 `src/risk.ts` 的原因里同时给出**目标相对路径**与**计划里实际声明的规则**（最多列 5 条，项目外规则标注「已忽略」），不再只有一句「计划外写操作」。
- **备注**：单测 3 条（绝对 scope 命中 / 相对规则照常 + 项目外规则不放宽 / 失败时给 relPath 与规则）+ risk 层 2 条（绝对 scope 的计划内 edit 判 low；**真·计划外写入仍判 high**）。第二条是防过度放宽的护栏。
  **反向验证**：把 `scopePatternToRelative()` 的调用改成直接用原 pattern → 两条用例变红。2026-11-13。

### I-22 改配置文件必须跨沙箱提权，路径不可靠
- **状态**：✅ 已修复（(a) 已实现；(b) 结论：宿主无受支持的写入通道，配置修改仍需手改 + 重启）
- **现象**：`~/.dsh/profiles/web/cordis.patch.yml` 在工作区外，worker 写入需 `danger-full-access`；审批一挂起 turn 即挂起，改动丢失（历史失败 3 次，最终用户手改）。
- **修复方法**：
  - **(a) `/superagent doctor`（只读自检，已实现）**：`src/host/command.ts`。报告：插件版本（`codeVersion` + `configHash` + 启动时间）、管家会话与「门禁/worker 工具已装载的会话数」、管家工作区（含是否存在）、各来源（dsh/claude/codex）是否启用与不可用原因、以及**关键配置项的实际生效值**（扫描间隔、计划门禁、policy/shadowRules、thread、mcp.batchApprove、settleSuggest/settleTtl、watchdog、progress.wake、bashReview、两个外部来源开关）。**纯只读**：不写 `~/.dsh`、不写审计、不做任何状态变更（有单测断言「零写入」）。启动失败时进入降级分支，直接说明降级原因并提示检查 `cordis.patch.yml`——那正是最需要自检的时刻。
  - **(b) 配置写入通道（只评估，未实现）**：结论是**没有**受支持通道，见下方评估。
- **备注**：`(b)` 评估证据（2026-11-13 查本机 dsh 0.2.2-rc.1）。**只查代码与宿主 API，未读任何配置内容或凭据文件**：
  0. **插件侧（本插件自身）无写入口**：`src/host/command.ts` 现有 7 个子命令（help/doctor/status/inbox/mode/dispatch/butler/refresh）都不写配置；`src/host/routes.ts` 不直接写文件；全 `src/` 里 `writeFile` / `profiles/` / `cordis.patch` 只剩一句提示文案，没有任何持久化代码。
  1. `dsh --dump-config` / `--dump-config-schema`：只读，只能看组合后的配置树与 schema；
  2. `dsh plugin`：把参数**原样转发给 pnpm**（add/remove 包），没有 `config set`；
  3. `dsh-plugin-manager`：会用 `writeFileAtomic` 写 `package.json` / `pnpm-workspace.yaml` / run 记录，但对 `cordis.patch.yml` **只读**（`diskState()` 读取用于判变更），无写入 API；
  4. `dsh-settings` + `dsh-api-settings-controller`：**确有**受支持写入 API（`settings.update(ns, patch)` 带 revision 冲突检测、credentials `set/unset`），插件可用 `ctx.get('settings')` 取得；但它持久化的是**settings 命名空间（应用/用户设置）**，不是插件加载配置；
  4.1 `cordis-plugin-loader`：**没有任何 `writeFile` 调用**（只做装载/解析/组合），不持久化配置；
  4.2 `dsh-app-boot` 的 `loader.*` 只有 `entries()/await()/create()/import()/resolveSync()` 这类装载操作，写文件只出现在版本豁免等内部状态上，无 patch 写入路径。
  5. 因此改插件配置**目前只能**手改 patch 文件 + 重启。
  6. 若要接：可让插件声明 settings 命名空间（如 `superagent`），在 `resolveConfig()` 后合并进生效配置，配 `/superagent config set`。限制：只对运行时读取的阈值/开关有效；**影响插件挂载的项**（如 sources 是否注册）仍需重启；属新功能，本轮未做。
  **验证**：单测 3 条（正常自检内容 + 零写入断言 + 降级分支）。**反向验证**：给 doctor 注入一次 `appendAudit` → 「只读」用例变红，按单行改回。2026-11-13。

### I-23 老管家会话积压消息
- **状态**：✅ 已修复（复核无积压，无需清理）
- **现象**：2026-11-09 记录 `session-fc0f4e6f`（旧 ontology 项目）`queuedCount=31`、`session-6385aa8d` 为 9；都是 idle，怀疑队列不会自己消化。
- **修复方法**：**复核后确认无需处理**，未做任何清理（那是用户会话数据）。
- **备注**：2026-11-13 复核证据 —
  1. 两个会话仍在磁盘上：`~/.dsh/sessions/--…baidu-gcloud-ontology--/session-fc0f4e6f-…`（最后写入 11-09 19:11）与 `--…default-workspace--/session-6385aa8d-…`（最后写入 11-13 11:21）；
  2. 两者会话文档里**只有一条 header 记录**，不含任何 `queue`/`queued` 事件；
  3. 全盘 `~/.dsh` 下**没有任何队列文件**（`find -iname '*queue*'` 为空）→ 队列是 session controller 的内存态，**dsh 重启即清零**；这期间为验证 P0/P1/P2 已重启多次，故 11-09 的 31/9 不会留存；
  4. 结论：症状已消失，队列无需消化也不需清理。**若要看实时数字**：重启后在管家面板或 `butler_status` 里看 `queuedCount`（该项来自活进程的 session controller，只有运行时才有值）。2026-11-13。

## 🚫 不修 / 已知限制

### I-24 Claude 的 running 是推断值
- **状态**：🚫 不修 / 已知限制
- **现象**：Claude 的 running 是推断值——依据活进程表 + `~/.claude/sessions/*.json` 的 status 推断，可能滞后（进程退出但状态文件未刷新）或把「等待输入」判为运行中。
- **修复方法**：不修（推断值没有可靠数据源）。UI 与文档标注为推断值；需要确定时以 Claude Code 自身为准。
- **备注**：原 L-01；2026-11-09。

### I-25 Codex 无法区分 root / 子会话
- **状态**：🚫 不修 / 已知限制
- **现象**：Codex 的数据里没有可靠的 root / 子会话分级，无法区分。
- **修复方法**：不修。UI 标注为已知限制；保留「手动标记为非 root」的本地覆盖。
- **备注**：原 L-02；2026-11-09。

### I-26 外部来源只读
- **状态**：🚫 不修 / 已知限制
- **现象**：外部来源（claude/codex）只读：不进派发候选；显式指定返回 `target_read_only`；不支持代答审批/提问、不设计划门禁、不写 `~/.claude`/`~/.codex`。
- **修复方法**：不修（设计如此）。UI 对不支持的操作置灰并显示「该来源不支持」；`ANSWERABLE_KINDS` 保证「渲了按钮就必须能用」。
- **备注**：原 L-03；2026-11-09。

## 附录 A：已完成的功能（对照）

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | `SessionSource` 抽象、registry、`source` 字段 | ✅ |
| P1 | Claude 只读适配器（189 会话 / 首扫 90ms） | ✅ |
| P2 | Codex 只读适配器（20 rollout / 9–15ms，含合成消息过滤） | ✅ |
| P3 | UI 来源徽标 / 筛选 / 只读置灰 / 已知限制标注 | ✅ |
| B-1 | 进度实时可见 + 有界唤醒 | ✅ |
| B-2 | `job_kill` 归属免审批 | ✅ |
| B-3 | watchdog 活动口径 | ✅ |
| P0-hotfix | 子会话 id 冒号导致插件不加载 | ✅ |

## 附录 B：变更记录

| 日期 | 内容 |
|---|---|
| 2026-11-09 | 首次建立；汇总当日 17 项修复、6 项待决策、3 项已知限制 |
| 2026-11-09 | 重写为增量维护清单：按状态分区、统一四字段、加快速索引；D-01~D-06 → I-18~I-23，L-01~L-03 → I-24~I-26，新增 I-27 |
| 2026-11-09 | 合并重复条目：I-27 并入 I-21，I-27 作废不复用；正文/索引同步为 26 条，最大编号 I-26 |
| 2026-11-12 | 新增 I-28（工作完成或卡点结束后没人销账，派发一直挂着，⏸️ 待决策 / P1）；清单共 27 条 |
| 2026-11-12 | 新增 I-29（`butler_dispatch` 决策字段名与工具说明不一致，⏸️ 待决策 / P2）；「使用说明」编号表述改为不写死具体数字；清单共 28 条 |
| 2026-11-12 | A 组修复完成：I-18/I-19/I-20/I-21/I-28/I-29 → ✅；I-22/I-23（B 组）保持待决策。清单仍 28 条 |
| 2026-11-12 | 新增 I-30（审批在界面上不可见，且审批路由不分层，📥 待处理 / P1）；清单共 29 条 |
| 2026-11-13 | 新增 I-31（MCP 工具全部被判未知工具、逐次审批致真机验证不可行，📥 待处理 / P1）；清单共 30 条 |
| 2026-11-13 | 新增 I-32（审批链上没有主动方：worker 不告知、管家不提醒、用户看不见，📥 待处理 / P0）；清单共 31 条 |
| 2026-11-13 | 新增 I-33（计划只能去侧栏明细看、对话里无法审批，📥 待处理 / P1）与 I-34（提醒送达无持久化，管家离线即丢且同签名不重发，📥 待处理 / P0）；清单共 33 条 |
| 2026-11-13 | 新增 I-35（计划 scope 绝对路径与匹配相对路径错位，计划内写入被误判计划外，📥 待处理 / P1）；清单共 34 条 |
| 2026-11-13 | 补充 I-34 技术细节（三条知情通道、内存队列、记账顺序、落盘对照、扫描边界、未确认项），条目不增；清单仍 34 条 |
| 2026-11-13 | A 组第二轮：I-31/I-33/I-34/I-35 → ✅（I-33 第 (3) 项「回复即批」未做，已注明）。清单仍 34 条 |
| 2026-11-13 | B 组：I-22（/superagent doctor + config 写入通道评估）、I-23（复核无积压）→ ✅。清单仍 34 条，待决策分区已清空 |
