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
| I-32 | 审批链上没有主动方 | 🔧 进行中 | P0 |
| I-33 | 计划只能去侧栏明细看，对话里无法审批 | ✅ 已修复 | P1 |
| I-34 | 提醒送达无持久化，管家离线即丢且同签名不重发 | ✅ 已修复 | P0 |
| I-35 | 计划 scope 绝对路径与匹配相对路径错位，计划内写入被误判计划外 | ✅ 已修复 | P1 |
| I-36 | 管家回答阻塞中的提问是假成功（answer 用了只对 continued 有效的 API） | ✅ 已修复 | P1 |
| I-37 | 审批提醒/真唤醒发给派发者而非当前活跃管家，用户看不到 | ✅ 已修复 | P0 |
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
- **状态**：🔧 进行中（(1) 主动上报 + (3) 主动开口已做；(2) LLM 代审判权 allow/deny/escalate 未做）
- **现象**：用户原话（2026-11-13）：「管家管理的 worker 需要审批，用户侧看不见任何提示需要审批，管家也不会主动提醒用户，而且也只能通过管家对话进行审批。理想的应该是 worker 通知管家需要审批，然后管家拦截一部分自动放行，这里可以调用大模型思考权限安全，需要用户审批的由管家发消息给用户。」实测佐证：A 组真机验证派发 `dsp_0bf52c3be5f441e8` 自 2026-11-12 19:50 至 2026-11-13 11:33 前后产生 4 条审批卡点——`blk_590c348ae9414999`（`new_page`）、`blk_e3ab1bf8551044b1`（`take_snapshot`）、`blk_1ce25e0ee8604a76`（`fill`）、`blk_53d4c239d8514de5`（`take_snapshot`），**每一条都存在但界面上零提示**，全靠管家在聊天里口头转述才被发现，第一条挂了 14 小时。结构性缺陷：审批 → 管家 → 用户 这条链上**没有任何一步是主动的**——worker 遇审批不会告知管家，管家不运行就不会开口，用户不问就永远不知道。另有一个连带故障：审批挂起时 turn 被冻结，**队列里的新指令不会被消费**（本次管家连发 3 条「收尾」指令全部卡在 `queuedCount`，最后只能靠「拒绝审批」把 turn 撬开才读到）。
- **修复方法**：三层，建议按 (1)→(2)→(3) 推进 —
  (1) **主动上报**：worker 遇到审批时，插件必须产生一条**用户可见的提醒卡片**（复用 `superagent-notice` + `progressNotices` 通道），带「需要你审批」语义与 `dispatchId`，**不依赖管家是否在运行**。
  (2) **管家代审（LLM 判权）**：审批进来先交管家判断——把「命令原文 + 宿主给的风险原因 + 当前派发任务上下文」交给模型，输出 `allow / deny / escalate` 三选一。`allow` 直接放行并写审计（`by=butler-auto` + 判权理由 + 规则 id）；`deny` 拒绝并说明；`escalate` 走 (3)。
  (3) **人决策且由管家主动开口**：升级的由管家**主动**发消息给用户（原因 / 需要你决策什么 / 建议决策含理由 / 备选与后果 / 按钮），带 dispatchId 级去重与冷却，避免同一审批反复骚扰。
  **硬约束**：判权结果必须落审计并带理由，`allow` 要可枚举可回放；**不允许「判断不出来就默认放行」**（那是把风险从审批转移成静默）。
- **备注**：与 I-30、I-31 同源但**问的是三件不同的事**——I-30 问「审批看不看得见、该谁批」，I-31 问「每步都批导致自动化验证跑不完」，本条问「**审批链上没有主动方**：worker 不报、管家不问、用户不知」。与 I-31 叠加时后果最严重：一条自动化任务可以无限期停摆而无人知晓（本次 14 小时实例）。优先级 **P0**：不是体验问题，是「任务卡死且无人发现」的可靠性缺口。2026-11-13 记录。


**补充（2026-11-16）：真唤醒已生效，但"投错对象"→ 见新条 I-37**

今天实测：`meta.codeVersion = v0.3.2-4-g294bd8e`（HEAD），进程 2026-11-16T07:21:22Z 启动——**新代码已生效**，今天有 9 次带 blocker 的真唤醒（2 条 approval、其余 decision）。但 baidu worker 的派发者是 `session-caac7193…`，而用户当前在 `session-6385aa8d…`，提醒/唤醒全部发给了前者 → 用户仍然「什么都看不到」。

因此本条 (1)(3) 的**机制**已通，缺的是**目标选择与用户侧兜底**，已单列为 I-37（新维度：投给了不在线的派发者 + 跳过不可观测 + 唤醒文案压制开口）。本条剩余 (2) LLM 代审仍未做。

### I-36 管家回答「阻塞中的提问」是假成功：answer 走了只对 continued 提问有效的宿主 API，返回 ok 但 worker 收不到
- **状态**：✅ 已修复（含已知限制：插件无法事后认领「不持有句柄的 open 提问」，只能引导到界面回答）
- **现象**：baidu 项目的专职 git worker（新会话 `session-377c0892-7a3b-4a90-9f72-7e1acaf0aede`，派发 `dsp_eaf9bd11ff8f4ec8`）用 `ask_user_question` 问「后端 `.gitignore` 有已跟踪修改，要不要一起提交？」并给出两个选项 → 产生 question 类卡点 `blk_969cea1fd81b4bc2`（callId `call_01_2fpf9zxrx19fbitdi6cdtwga`），会话进入 `hardStatus=awaiting_answer`。管家先后对 decision 类卡点 `blk_c628567e06aa4a76` 与这个 question 类卡点各调一次 `butler_resolve action=answer`，**两次都返回「已回答/已转发」，但 worker 从未收到**：会话一直停在 `awaiting_answer`，`queuedCount` 持续 1~2，最后只能由用户手动回答才解开。
- **修复方法**：
  1. **按提问状态分流（根因修复）**：`answerQuestionByCall`（`src/service.ts:2707`）现在不区分状态地调 `ctx.userQuestions.answer()`（`2744`）。必须改成：
     - `continued`（超时后转为后续轮次的提问）→ 才允许用 `userQuestions.answer()`（它内部是 `agent.steer()` 注入一条 `user-question-reply` 消息）；
     - `open`（正阻塞 tool call 的提问）→ **不能用 answer()**，必须走 Agent-scoped `user-questions/request` waterfall 的 answerer（宿主 `ask()` 就靠这个 waterfall 等人工回答，见 `dsh-user-questions/lib/index.js:709`；注册 answerer 的先例是 UI 的 `dsh-client-ui-user-questions/lib/client.js:2277`）。插件已 `inject: ['userQuestions']`（`src/index.ts:25`），但**目前没有注册任何提问 answerer**（全仓 `waterfall` 零命中）。
  2. **失败必须可观测（最坏情形就是现在这样）**：`answer()` 返回 `boolean`（是否仍处于 continued），宿主实现里找不到 callId 时**直接 `return false` 不抛错**（`dsh-user-questions/lib/index.js:562`）。插件忽略了这个返回值，紧接着还执行 `resolveBlockersBy(..., '问题已回答')`（`2745-2748`）——于是**卡点被标成已处理**，用户看到「已回答」，worker 却什么都没收到。改为：返回 `false` 时返回 `{ ok:false, reason:'question_not_continued', hint:'该提问仍在前台等待，请在界面上回答或先取消提问' }`，写审计 `answer_question_failed`，且**不要**清卡点。
  3. **不要用普通消息兜底**：`awaiting_answer` 期间 turn 阻塞在 tool call 上，`source.prompt`（`mode:'queue'`）只会排进下一轮，**本轮不结束永远不会被消费**；可以留一条记录，但不能算作应答。
  4. **短期兜底**：在 (1) 的 waterfall 接入完成前，question 类卡点的「回答」应改为「到界面回答」或「取消提问」，避免再次假成功。
  5. 顺带说明：`answerQuestionByCall` 的 `questionWaiters` 分支只覆盖插件自己接管的两处提问登记（`src/service.ts:2648` / `2679`，原生计划模式），**宿主 `ask_user_question` 永远走不到那条分支**，注释要写清。
- **备注**：根因一句话——**用了只对 `continued` 有效的 API 去回答仍 `open` 的提问，并且忽略了它返回的 `false`**。关键证据：宿主 `answer()` 只从 `continued(agent)` 里找 callId（`dsh-user-questions/lib/index.js:544-562`），`continued()` 只取 `state === 'continued'` 的提问；open 提问的真实应答方是 `user-questions/request` waterfall（`index.js:709`），由 UI 注册（`client.js:2277`）。另外 `ANSWERABLE_KINDS` 含 `question`（`src/blockers.ts:374`）——**协议允许「回答」按钮，但通道根本不通**，属于「渲了按钮却不可能生效」。decision 类卡点走 `forwardToSession`（`src/service.ts:3717`）发普通消息，那是「下一轮读到」的既有语义，与本缺陷无关；`awaiting_answer` 时队列里的消息也解释了 `queuedCount` 为什么是 1~2。
  **归属判定**：新缺陷，不是 I-32 / I-34 的延伸——那两条是「提醒 → 管家」方向（可达性、主动方），本条是反方向「管家 → worker 的提问应答通道」。2026-11-16 记录（只读调查，未改代码）。

### I-37 审批提醒/真唤醒发给了「派发者管家」而不是「当前活跃管家」→ 用户在另一个管家会话里完全看不到
- **状态**：✅ 已修复（含残留项：允许失败回退与「唤醒后必须开口」的硬检测见实现记录）
- **现象**：用户原话（2026-11-16）：「我希望这种审批不光能通过白名单来解决，首先要解决的是**看得见的**问题。在 work 侧有需要审批的请求，但是我在 superagent 侧没有收到任何的反馈。」实测：baidu 项目今天产生 14 条 approval 类卡点（`mvn test`/`build.sh` 读 `~/.m2`、`mcp__chrome-devtools-mcp__new_page`/`evaluate_script`/`navigate_page`/`close_page` 等），受影响 worker 会话 `session-2fd87169-5f55-4276-a33b-31bd125b452f`、`session-13b291a3-5f3b-44dd-bd00-109028ffbc09`。**这 14 条全部有 `remind` 审计（提醒确实产生了）**，但用户侧看不到任何反馈。
- **根因（一句话）**：提醒与真唤醒都只发给**派发这条任务的管家**（`dispatch.fromButlerSessionId`），而用户此刻在**另一个**管家会话里；这条链上没有任何一步会把消息改投/顶到「当前活跃管家」或「UI 眼前」，于是提醒进了冷管家的持久化队列、唤醒投给了一个没人看的会话。
- **修复方法**：
  1. **目标选择改成「在线的优先」（核心）**：`injectButlerNotice()`（`src/service.ts:895` 附近）与 `shouldWakeForBlocker()`（`src/service.ts` 的 blockerWake 判定）在决定接收者时按序回退：
     `dispatch.fromButlerSessionId`（且 `agentOf(id)` 存在）→ 当前活跃管家（`meta.butlerSessionId` 且 agent 存在）→ 其它任一在线管家（`butlerSessionIds()` 里 `agentOf` 非空的）→ 全都不在线才进队列。
     现在的做法是「派发者优先，不在线就入队」，这是本条的直接成因。
  2. **唤醒前先验证目标在线**：`wakeSession()` 之前加 `if (!this.agentOf(target)) 不投`——现在会把 `prompt` 发给一个没有 agent 的会话，等于**凭空拉起一个用户看不见的管家会话**，别处再怎么修都白费。
  3. **唤醒后必须开口**：当前唤醒 prompt 里写着「不要为了回应这条而重复播报」，等于**明示管家别说话**。改成硬要求：处理完必须用一句话告诉用户「刚才哪个 worker 的什么审批、你做了什么/在等什么」；并把目标管家 id 写进 `wake` 审计。
  4. **跳过要可观测**：`shouldWakeForBlocker()` 返回 `running` / `quota` / `throttled` / `butler-self` 时**现在完全静默**（今天没有任何 `wake_skipped` 审计），排查时无从判断「是没生成、还是被闸掉」。加审计 `wake_skipped`（带 reason），至少按天汇总。
  5. **UI 兜底（不依赖管家）**：审批类 blocker 应做到「在任何会话都能看见」——侧栏徽标计数（现在徽标只反映当前渲染态）、面板「明细」把审批置顶；可选在 **worker 会话**也渲染一条只读提示（避免用户以为是 worker 卡死）。
  6. **白名单只减量、不替代可见性**：`mvn test`/`build.sh` 读 `~/.m2` 这类可预判的，进 `approvalPolicy` 自动放行；但 MCP、未知工具、跨仓库写入仍必须靠「看得见 + 能拍板」。
- **备注**：**先纠正任务里的一个前提**——当前 dsh web 跑的**不是旧代码**：`meta.codeVersion = v0.3.2-4-g294bd8e`、`meta.startedAt = 2026-11-16T07:21:22Z`（本地 15:21），即 HEAD `294bd8e`（含 I-36/真唤醒/改投），进程是**重启过的新版本**。所以本轮现象不能归因于「旧代码未生效」。
  今天实测的三条通道：
  - **A 注入**：14/14 都有 `remind` 审计 → 生成正常；但目标是派发者，不在线时进 `meta.pendingNotices`（现积压 **52 条 / 10 个目标管家**，其中 2 条是审批，目标 `session-caac7193…`）。
  - **B 唤醒**：今天 9 次「带 blocker 的真唤醒」全部 `by=butler-auto`、文案「已送达」，其中只有 **2 条是 approval**（`blk_1fd5074b1b2b4231` 06:04 bash、`blk_21648f38537743cc` 07:03 `new_page`）；其余 12 条审批只有 `remind`。未唤醒的原因不可观测（见修复方法 4），但从时间看多数落在「管家正在 running」的窗口内。
  - **C 快照**：审批 blocker **确实在** `blockerNotices` 里（无 kind 过滤），但 `NoticeDock` 只在**管家会话且 `sessionId === butler.sessionId`** 时渲染（`src/client/index.ts:1536`），用户在 worker 会话或另一个管家会话时看不到；面板「明细」要手动打开。
  - **D 用户可见卡片**：只有「管家会话 + 有 turn 跑过 + 注入被 pre-step 取走」三者同时成立才会出现卡片；本轮多数不满足。
  **归属**：新增本条而不是并入 I-32——I-32 是「链上缺主动方」（已做 (1)(3)），本条是**已做的那部分投错了对象**（目标选择缺陷）+ 跳过不可观测 + 唤醒文案压制开口，属于新维度。与 I-34 的「改投」相邻但不同：I-34 改投的是**离线队列**（落地时要求同 projectKey），本条要的是**实时投递**就直接选在线管家。今天两条派发 `dsp_f365569e6b514876` / `dsp_fbadf96a91aa4a08` 的 `fromButlerSessionId` 分别是 `session-caac7193…` 和 `session-caac7193…`，而 `meta.butlerSessionId = session-6385aa8d…` —— 不是同一个会话，这就是「什么都收不到」的机制。
  **必须重启 dsh web 才能验证修复**：本轮修复涉及 Host 侧投递目标与唤醒目标，属启动时组装，热改无效。重启前能验证的只有「代码与配置现状」（`/superagent doctor` 看版本）；重启后才能验证「审批出现在当前管家会话 / 唤醒确实发给在线管家 / `wake_skipped` 审计出现」。2026-11-16 记录（只读调查，未改代码）。

> 待新增：发现即记，不要攒着。按上面的四字段模板追加到本节末尾，编号取当前最大 +1，并同步快速索引。


**补充（2026-11-13 真机复核：管家为什么始终收不到「待审批」）**

**(1) 三条通道的实测行为（带行号）**

- **通道 A 注入提醒（会生成，但不唤醒）**：审批 blocker 与其它卡点走同一条 `maybeRemind`（`src/service.ts:1846`，调用点 `1787` / `1815`），**没有按 kind 过滤**，所以审批会正常生成 notice 并投递（`injectButlerNotice` `895` → `injectMessage` `955` → `agent.inject`）。
  但 dsh 对 `agent.inject` 的契约是明文写死的：**“Queue model-facing context for the next pre-step without waking the driver … idle drivers leave it pending until follow-up or steering wakes them”**（`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:237-244`）。也就是说：**管家空闲时，注入只是躺在待处理上下文里，不产生任何 turn**，要等用户下一条消息的 pre-step 才会被取走。这是「管家没感知」的直接原因。
- **通道 B 唤醒（完全不覆盖审批）**：唯一真正会起 turn 的投递是 `maybeWakeButler`（`src/service.ts:1658`）→ `sendToSession`（`3231`）→ `source.prompt`（`3233`）。但它**全仓只有一个调用点**：`evaluateProgress` 末尾（`1572`）；入参 `events` 来自 `detectProgress`，事件类型只有 `milestone | stage_end | blocker_resolved | watchdog`（`src/progress.ts:21`），`decideWake` 再按 `config.progress.wake.kinds`（默认 `['stage_end','watchdog']`）过滤（`src/progress.ts:446`）。**blocker / approval 从不在事件类型里，因此审批打开永远不会触发唤醒** —— I-32 原文记的根因仍然成立。
- **通道 C 快照（用户可见，但不喂模型）**：`blockerNotices` 由 `blockers.map(buildBlockerNotice)` 生成（`src/service.ts:3712`），**没有 kind 过滤**，审批确实会进快照；但它是给 UI 的轮询数据，模型侧不会主动读，除非管家跑一次 `butler_inbox`——而管家要跑必须先有 turn（回到通道 A/B 的死结）。客户端侧还有两个约束：`NoticeDock` 只在**管家会话**渲染（`src/client/index.ts:1530`，`1536` 判 `sessionId === butlerId`，否则 `return null`），且要求 notice 带非 `open_session` 的动作。

**(2) 真机数据佐证（本插件存储，只读）**

- 用户提到的三条审批都存在，且最终都由 `butler-chat` 放行——正是「用户开口之后才批」：`apv_2492d38ef2264f5e`（edit，11-13T04:00）、`apv_3a8472bd87f64e26`（edit，04:02）、`apv_8297409211814971`（bash，06:12）。
- 对应审批 blocker **确实跑过提醒**（`reminderCount` 有增长）：`blk_baf960ea542245dd`（关联 apv_8297409211814971）`reminderCount=1`、`notifiedAt=06:12`；另有 `blk_faba95d25c08489d` `reminderCount=3`（06:32→07:32，每 30 分钟重试一次，依然没人被叫醒）。
- 结论：**提醒管线是通的（生成、记账、计数、注入都发生了），坏的是「注入 ≠ 唤醒」这一步**。这也解释了为什么 I-34 修完「重启不丢」症状依旧：I-34 只保证内容不丢，没解决「没人读」。

**(3) 实际发生 vs 代码声称（不一致点）**

- README 与代码注释写「提醒用 inject，不唤醒管家」——这句本身正确，但**没写后果**：对空闲管家，inject 等价于「不投递」，要等用户下次开口才被 pre-step 取走。于是「插件产生了提醒」与「管家看到了提醒」是两件事，而审计里 `reminderCount++` 会让人误以为已送达。
- I-34 之后新增的 `delivered/queued` 区分只覆盖「投递彻底失败」（`notify_deferred`），**不覆盖「投递成功但没人消费」**这一状态。

**(4) 结论与归属**

- **与 I-32 同源，不新开条目**（不新增 I-36）：这是「审批 → 管家 → 用户」链上缺主动方在**实现层**的落点——唤醒通道只接进度事件。
- 修复方向仍按本条 (1)(2)(3)；**最小可用改动**是把 blocker/approval 纳入唤醒通道（新增一种 wake 事件 kind，复用 `sendToSession` + `prompt` 这类会起 turn 的投递），但必须带配额/节流与「不重复播报」约束，否则会退化成 I-21 那类假唤醒。
- 本次只补证据，**状态保持 📥 待处理**（未修）。


**部分实现（2026-11-16，用户拍板「投递可达 + 真唤醒」这半边）**

- **只对需要人拍板的三类真唤醒**：`blockerWake.kinds` 默认 `['approval','decision','error']`。命中时走 `wakeSession()`（`source.prompt`，会起 turn），其余类型仍走 `injectButlerNotice`（不唤醒）。
- **四道闸**（`shouldWakeForBlocker()`）：
  1. 同签名只唤醒一次：签名 `blockerwake:<kind>:<id>` 落盘进 `dispatch.progress.woke`（有派发）或 `blocker.woke`（无派发），与原有 wake 去重同一套语义；
  2. 每派发配额 `maxPerDispatch`（默认 3，数已落盘的 `blockerwake:` 签名）；
  3. 同一 dispatch 两次唤醒间隔 ≥ `minGapMs`（默认 5 分钟）；
  4. 管家 `running` 时不打断。
- **防自激（三层，缺一不可）**：
  1. **会话闸**：卡点所在会话若是管家自己的会话（`isButlerSessionId`），**绝不唤醒**——管家自己的审批永远不会反过来叫醒自己；
  2. **先落盘再发送**：签名在 `wakeSession()` 之前写入，发送失败也不会下一轮立刻重发（失败则退回 inject，内容不丢）；审计记 `action:'wake'` 并标明「已送达/投递失败」；
  3. **着色闸**：管家 running 时不唤醒，而管家被唤醒后的那一轮正是 running，天然不会在自身回合内再次触发。
- **未做**：第 (2) 项 LLM 代审（把命令原文交模型判 allow/deny/escalate）——按用户要求本轮不做。
- **验证**：集成 5 条（approval 真唤醒且不重复 inject / 仅三类唤醒、stall 仍走注入 / 同签名第二次不再唤醒 / 每派发最多 3 次 / running 时不打断）。既有「结构化 source」用例改为显式关掉真唤醒以继续覆盖注入通道。
  **反向验证**：去掉类型闸（任何卡点都唤醒）→ 「只对三类唤醒」用例变红，单行改回。


**实现记录（2026-11-16，用户选方案 1）**

先说一处**上一轮记录的纠正**：原文写「插件目前没有注册任何提问 answerer」是**错的**——`installWorker` 里其实注册了 `agent.ctx.on('user-questions/request', … answerQuestion …, { prepend: true })`（`src/service.ts:565-570`），并且 `answerQuestion` 会为 root worker 持有 waiter（`src/service.ts:2648` / `2679`）。当时的 grep 只搜了 `waterfall` / `answerer`，漏了事件名，特此更正。

**已修（本轮）**

1. **应答组包修正**：新增 `answerForQuestions()`（`src/service.ts`，已导出），把管家的一句话装成宿主认识的结构化批次：
   - `id` 用**问题自己的 id**（以前写死 `id:'answer'`，模型拿到的答复对不上任何问题）；
   - 文本恰好等于某个选项标签 → 放进 `selected`；否则放进 `custom`；
   - 多问题时只答第一个，其余 `selected: []`（宿主语义 = 跳过）。
   `resolveBlocker` 的 question 分支改为传**原始文本**（`src/service.ts:3674`），由 `answerQuestionByCall` 统一按问题 id 组包（waiter 路径用 `runtime.questions` 里的问题，宿主路径用 `blocker.evidence.questions`）。
2. **消除假成功（最坏情形）**：`ctx.userQuestions.answer()` 的返回值是 `boolean`，对非 `continued` 的提问**返回 `false` 而不抛错**。现在显式判断：`false` → 返回 `{ ok:false, reason:'question_not_pending', message:'…请在界面上直接回答，或先取消这个提问' }`，写审计 `answer_question_failed`，并且**不再执行 `resolveBlockersBy(...,'问题已回答')`**——卡点保持未处理，不会再出现「显示已回答、worker 没收到」。
3. **实测证据（本次实例）**：`audit` 里该 callId 的记录是 `action=answer_question, by=butler-chat, sessionId=session-377c0892…`——**带 sessionId** 说明当时走的是「宿主 API 分支」，也就是 **waiter 不在**（占据 waiter 的分支打审计不带 sessionId）。因此本次不是「组包错」，而是「插件当时没有持有这个提问」，`answer()` 又静默返回 false。

**仍未解（下一步）**

- **插件未持有时如何接管**：`answer()` 只覆盖 `continued`；仍 `open` 的提问只能由注册时的 answerer 在 `ask()` 期间 resolve。插件**错过后无法加入**（宿主没有「事后认领 open 提问」的 API）。最可能的成因是**进程重启丢失内存里的 waiter**（与 I-34 同类的「内存态」问题）。可选下一步：
  (a) 把「待答提问」落盘（callId + sessionId + 问题），重启后若对应 blocker 仍在，把卡点直接标成「到界面回答」而不是装作可代答；
  (b) 请宿主提供「事后认领/答复 open 提问」的 API（需上游支持，插件侧无法自解）。
- 在 (a)/(b) 落地前，行为是：**能答的（waiter 在）真的会送达；不能答的立刻明确报错并给出路**，不再假成功。

**验证**：单测 4 条（`test/unit/answer.test.ts`：命中选项 / 自由文本 / 多问题 / 无问题兜底）+ 集成 2 条（waiter 路径按问题 id 真送达；宿主返回 false 时不假成功、不清卡点、留审计）。
**反向验证**：① 把 `id` 改回写死的 `'answer'` → 4 条用例变红；② 把 `if (accepted === false)` 去掉（忽略返回值）→ 「不许假成功」用例变红。两处均单行改回。


**方案 A 实现（2026-11-16，用户拍板）**

目标是让「够不着的提问」**可见、可查、不假成功**，而不是硬装作能代答：

1. **收到提问即落盘**：`answerQuestion` 命中时调 `rememberPendingQuestion()`（`src/service.ts`），把 `callId / sessionId / 提问正文 / options` 写进 `meta.pendingQuestions`（不新增表）；答完或取消时 `forgetPendingQuestion()` 摘掉。
2. **够不着就明确标记**：`markQuestionNeedsUiAnswer()` 给三处打标——落盘记录 `needsUiAnswer: true`、对应卡点 `evidence.needsUiAnswer` + `neededAction = '该提问只能到界面上回答（管家代答通道够不着）'`，并触发一次 `queueEmit`。
3. **重启后自动标记**：`init()` 里遍历 `listPendingQuestions()`，凡仍在的待答提问一律标「需到界面回答」——新进程**一定**不持有旧句柄，这个判断是确定的，不需要猜。
4. **console 侧可见**：快照新增 `pendingQuestions`（带 `questions[].question` 与 `options[].label`、`needsUiAnswer`），面板「明细」页新增「待界面回答的提问」表（会话 / 提问 / 选项 / 管家代答是否够得着）。用户能直接照着选项选。
5. **失败语义**：`butler_resolve answer` 对这类提问返回 `{ok:false, reason:'question_not_held'}`，文案指向界面回答；审计写 `answer_question_failed`；**不清卡点**。
6. **不做**：没有为本条实现任何「事后认领 open 提问」的能力（见已知限制）。

**已知限制（不在插件能力内）**

- 宿主 `userQuestions.answer()` 只覆盖 `continued`（超时转后续轮次）的提问；仍 `open` 的提问只能由**提问当时**注册的 answerer 在 `ask()` 期间 resolve。
- **插件无法事后认领「不持有句柄的 open 提问」**：没有可用的宿主 API（`ask()` 的 promise 不在我们手里就没法 join）。因此重启前发起、重启后才被处理的提问，**只能引导用户到界面回答**。
- 要根治需要上游提供「事后认领/答复 open 提问」的 API（方案 B），属宿主能力，不在本插件范围内；本轮按用户要求**未做任何相关实现**。

**验证**：单测 4 条（`test/unit/answer.test.ts`）+ 集成 3 条（waiter 路径真送达 / 宿主 false 不假成功且标 UI-only / 落盘+重启后快照标「需到界面回答」并带选项）。
**反向验证**：① 去掉 `markQuestionNeedsUiAnswer()` 调用 → 2 条用例变红；② 去掉 `rememberPendingQuestion()` 落盘 → 「落盘 + 重启标记」用例变红。均单行改回。


**实现记录（2026-11-16，用户批准「两条都做 + 强制开口」）**

1. **目标选择改「在线的优先」**：新增 `resolveButlerTarget(preferred)`（`src/service.ts`），顺序为
   `派发者（且 agentOf 存在）` → `当前活跃管家 meta.butlerSessionId（且在线）` → `任一在线管家` → 都不在线。
   - `injectButlerNotice()` 用它选目标；**手动 session 的广播语义保持不变**（乘性发送给所有管家，离线的照旧排队），只改「有派发者但派发者已离线」这一种。
   - 改投**必须留痕**：写审计 `action:'notify_redirect'`，note 里带「原定 X 不在线（reason）→ 改投 Y」。
   - 一个管家都不在线时：落回原定目标的队列，并写 `notify_queued` 审计（不再静默）。
2. **唤醒目标也走同一套解析并必须在线**：`shouldWakeForBlocker()` 用 `resolveButlerTarget` 取目标，
   `no-online-butler` 时直接不唤醒（避免像以前那样把 `prompt` 发给没有 agent 的冷会话、凭空拉起一个用户看不见的管家）。
   唤醒审计现在写明**目标管家**：`… 真唤醒 → session-xxxx（已送达）…`。
3. **唤醒后强制开口**：唤醒 prompt 加了硬要求——处理完必须发至少一条用户可见消息，一句话说清「哪个会话的什么事、做了什么/在等什么」；确实无事可报也必须发最短状态；并明确写了「只查 inbox/只放行不说话会被记为 wake_silent」。
4. **可检测**：新增 `wakeWatch`（进程内）——唤醒成功时按目标管家登记；该会话内出现**有文本的 `assistant/message`** 视为已开口；`turn/end` 时若从未开口，写审计 `action:'wake_silent'`（`by=butler-auto`，note 带 kind/blockerId）。这就是「唤醒后没可见消息 = 记为缺陷」的可查落点。

**反向验证**：① 同时禁用「活跃管家」与「任一在线」两条回退 → 「改投」与「唤醒目标」两条用例变红；② 把 `wake_silent` 审计写成恒不触发 → 「唤醒后不说话要被抓到」用例变红。均改回。

**残留 / 已知**：`wake_silent` 只在**进程内**检测（`wakeWatch` 不落盘）：如果 dsh 在 turn 结束前重启，这一次静默不会被记账。若要跨重启，需要把它落盘（与 I-34 同类做法），留给后续。


**实现补充（2026-11-16 第二轮，按用户补充要求）**

1. **改投与 flush 的「同 projectKey」约束合并**：`resolveButlerTarget(preferred, noticeSessionId)` 现在先看
   「派发者是否在线」→ 不在线时在**在线候选**里**优先找同 projectKey** 的管家 → 找不到才跨工作区退回活跃/任一在线，
   并把 `crossProject` 标记出来。这样既保留了 I-34 的「同工作区才改投」原则，又不会因为找不到同项目管家而彻底投不出去。
   `reason` 会区分 `active-butler(same-project)` / `online-butler(same-project)` / `(cross-project)` 四种。
2. **审计三要素结构化**：`AuditEntry` 新增 `fromButlerId` / `toButlerId` / `redirectReason` / `crossProject` 四个可选字段，
   `notify_redirect` 一次写全「原目标 / 最终目标 / 原因 / 是否跨工作区」，不必从 note 文本里抠；note 仍保留人读版本。
3. **唤醒同样走 projectKey 优先**：`shouldWakeForBlocker()` 把 `blocker.sessionId` 传给解析函数，唤醒目标与投递目标一致。

**关于「强制开口」的信号可得性（如实说明）**：插件**能**拿到「该轮有没有可见输出」的信号——
订阅的是宿主 `session/event` 里的 `assistant/message`，用 `extractText(data.message.content)` 取文本判断非空。
因此做法是：唤醒时登记 `wakeWatch`（目标管家 + 时间 + 来源），`assistant/message` 有文本即视为已开口，
`turn/end` 结算时未开口写审计 `wake_silent`。**限制**：`wakeWatch` 是进程内状态，turn 结束前重启会漏记；
另外只对**卡点唤醒**（approval/decision/error）要求开口，`stage_end` 这类**进度唤醒不要求**——
进度唤醒的 prompt 明确说「只在确实需要推动时才行动」，静默是合法行为，若也强制开口会变成新的噪音。

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


**复现实例（2026-11-13，投递层仍未闭环）**

- **实例**：计划 `plan_22a5239a3b424bd8`（「重启司南 BA(:8198 新jar催办60s) + roac-fe(:8120) 供真机验证」，目标会话 `session-13b291a3`）提交后停在 `pending_review`，卡点 `blk_a9e563baf754409e`。
- **落盘已生效（I-34 修复验证通过）**：提醒卡确实生成并写进了 `~/.dsh/storages/superagent/meta/pendingNotices.json` 的**第 29 条**（目标 butler = `session-caac7193-0ac4-4c88-a125-02b7e9c050c4`，正文以「提交了计划：重启司南 BA(:8198…」开头）。
- **关键区分**：**落盘 ≠ 送达**。这条从入队到现在**一直没被消费**（复核时仍在第 29 条），所以断点是「**没人 flush**」，而**不是**「flush 了但只进 inject 等待队列」。用户在 GUI 上看不到卡片/按钮，只能靠管家口头转述才放行——与 I-32 叠加后的最终表现。

**断点定位（文件:行号，只读调查）**

1. **队列按目标管家 id 分区，且不会改投**：`flushButlerNotices()`（`src/service.ts:971`）只取 `'*'` 与 `get(String(agent.id))` 两个键，取完就 `delete` 这两个键（`978-979`）。第 29 条的 key 是 `session-caac7193…`，只要**这个管家 agent 没被重新创建**，条目就永远等不到 flush——即便别的管家正在跑。
2. **flush 只有两个触发点，没有兜底**：`handleAgentCreated`（`src/service.ts:342`）与「preset 切换到管家」（`512`）。`restorePendingNotices()`（`944`，在 `init()` 里 `242` 调用）只把条目读回内存，**不尝试投递**；也没有定时/扫描兜底。于是「agent 早就存在、不会再触发 `agent/created`」这个场景完全没人管。
3. **第二道门（即使 flush 了）**：投递走 `injectMessage`（`955`）→ `agent.inject`，按 dsh 契约**不唤醒**（`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:237-244`，详见 I-32 补充）。本例连第一道门都没过，但修完 (1)(2) 之后仍会撞上这道门。
4. **现状佐证（死信箱）**：落盘队列现有 **31 条、跨 8 个管家 id**（`6385aa8d` / `0ea5dfde` / `213d854a` / `5fce294a` / `705d07d1` / `e479722d` / `fc0f4e6f` / `caac7193`），其中多条指向已不再活跃的管家——队列**只增不减**，说明「投递 → 可见」这一步在真实使用中持续失效。

**修复方法补充（补完「投递 → 可见」）**

1. **解除目标死锁（最关键）**：flush 时若条目原定管家 id 对应的 agent 不存在，**改投给当前活跃管家**（先按 `butlerSessionIds()`，再退到 `ensureButler()`），并在汇总里注明「原定发往 X，已改投到本会话」；条目保留 `originButlerId` 便于追溯。否则旧 key 永远无人认领。
2. **启动即补投 + 定时兜底**：`restorePendingNotices()` 之后，对当前**已存在**的管家 agent 立即 flush 一次；再在 `scan()`（`src/service.ts:3793` 起，15s 周期）里加一条「队列非空且有活跃管家 → flush」，覆盖「agent 早于 restore 存在、不会再有 `agent/created`」的场景。
3. **把「送达」定义清楚，别混两个通道**：`inject` 只负责把上下文放进模型（不唤醒）；**用户可见性由通道 C（快照 `blockerNotices`）保证**。所以 flush 的验收标准是「条目从队列消失 + 目标会话 inject 成功」，而「用户真的看见」要靠 I-32 的 (1)(3)（真正唤醒 / 管家主动开口）。两者必须分别验收，否则还会出现「审计说发了、用户没看见」。
4. **可观测 + 清理**：`flushButlerNotices()` / `restorePendingNotices()` 各写一条审计（`notify_flush` / `notify_restored`，记条数、目标 id、是否改投）；`diagnostics` 暴露**按目标分组**的队列深度（现在只有总数），并对长期无人认领的条目给出 `stale` 标记，避免死信箱无声堆积。


**用户拍板与实现（2026-11-16）**

用户采纳「flush 允许改投」但加三道约束，并同意「投递后真唤醒管家」。落地如下：

1. **改投只在目标管家确实不存在时发生**：`flushButlerNotices()`（`src/service.ts`）先按原键取走 `'*'` 与自己的 key；再遍历其它 key，仅当 `agentOf(key)` 为空（目标 agent 已不存在）才考虑改投。目标还活着时**行为完全不变**（按原键等它自己来取）。
2. **必须同 projectKey 才允许改投**：条目来源工作区由 `noticeProjectKey()`（从 `notice.sessionId` → managed session `.projectKey`，不新造字段）取，与当前管家 `butlerProjectKey()` 比较；不相等则**不改投**。
3. **绝不静默丢弃**：不满足改投条件的条目留在队列（不 delete），并在快照新增 `pendingNotices` 暴露「按目标管家分组的积压」（含 `count` / `targetAlive` / `projectKey` / `sample`）；面板「明细」页新增「未送达提醒」表。改投成功的条目会在汇总文案里注明「原定发往 X，已改投到本会话」。
4. 配套：新增 `pendingNoticesView()` 供快照使用；改投不改变原条目的 `text`/`source`，客户端仍按结构化 notice 渲染按钮。

**验证**：集成 3 条（同项目改投成功 / 不同项目留在队列且快照标未送达 / 目标还活着按原键投递）。
**反向验证**：① 把「同项目」判断改成恒真 → 「不同 projectKey」用例变红；② 把 `keep.push(payload)` 删掉（改为丢弃）→ 同一用例变红（队列被清空）。两处均单行改回。

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
| 2026-11-13 | I-32 补充真机复核：审批提醒走 `agent.inject`（契约明文「不唤醒」）+ 唤醒通道只接进度事件 → 管家对审批零感知。附三条实例与 reminderCount 证据。不新开条目，仍 34 条 |
| 2026-11-13 | 补充 I-34 复现实例：plan_22a5239a3b424bd8 / blk_a9e563baf754409e 的提醒在 pendingNotices 第 29 条**落盘但从未被消费** → 断点是「没人 flush」（按目标管家 id 分区 + 无兜底 flush），并写入修复方法补充。条目数不变 |
| 2026-11-16 | I-34 补：改投三约束（同项目才改投/目标还活着按原键/不丢且快照可见）；I-32 部分完成（(1)(3) 真唤醒已做，(2) LLM 代审未做）。条目数不变 |
| 2026-11-16 | 新增 I-36：管家回答 `ask_user_question` 的阻塞提问是假成功（`userQuestions.answer()` 只对 continued 有效 + 忽略返回 false + 仍清卡点）。附实例 blk_969cea1fd81b4bc2 / dsp_eaf9bd11ff8f4ec8。清单 34 → 35 条 |
| 2026-11-16 | I-36 实现：应答按问题 id 组包（answerForQuestions）+ 宿主 answer() 返回 false 时不再假成功（保留卡点、写 answer_question_failed）。纠正上轮「无 answerer」的误记。条目数不变 |
| 2026-11-16 | I-36 方案 A：待答提问落盘（meta.pendingQuestions）+ 重启后标记「需到界面回答」+ 快照/明细页带正文与选项；已知限制（无法事后认领 open 提问，需上游 API）已写入备注。条目数不变 |
| 2026-11-16 | 新增 I-37：审批提醒/真唤醒发给「派发者管家」而非「当前活跃管家」（今天 14 条审批全部 remind、仅 2 条 wake，且目标是与用户不同的管家会话）；附「新代码已生效」更正与三条通道实测。清单 35 → 36 条 |
| 2026-11-16 | I-37 实现：提醒/唤醒目标改为「在线优先」（派发者→活跃管家→任一在线）+ 改投审计 notify_redirect；唤醒 prompt 强制开口；新增 wake_silent 检测（进程内）。条目数不变 |
| 2026-11-16 | I-37 补充：改投与 I-34 的「同 projectKey」约束合并（同项目优先、跨项目标记 crossProject）；审计三要素结构化（fromButlerId/toButlerId/redirectReason/crossProject）；说明 wake_silent 的信号来源与限制。条目数不变 |
