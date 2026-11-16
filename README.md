# SuperAgent 管家（@local/dsh-superagent-butler）

本机 dsh session 的**只读管家**：帮你盯着所有 session 的进度和卡点、审查 worker 交上来的计划、派活、代批低风险操作，所有高风险动作都转回给你。

设计规格见 [`docs/dsh-superagent-butler-design.md`](docs/dsh-superagent-butler-design.md)（下称"设计"）。本文件只写**怎么用、怎么验证、哪些还没验证**。

配套文档：[问题与优化清单](docs/dsh-superagent-butler-issues.md) · [Backlog](docs/dsh-superagent-butler-backlog.md) · [二期方案](docs/dsh-superagent-butler-phase2-plan.md) · [对话内提醒改造方案](docs/dsh-superagent-butler-chat-actions-plan.md) · [三项改动开发计划](docs/dsh-superagent-butler-optimization-plan.md)

## 一期做了什么

| 能力 | 实现位置 | 设计 |
|---|---|---|
| 只读管家 session（只能 read/glob/grep，不能写、不能执行） | `src/butler/index.ts` + `cordis.patch.yml` 的 `preset-superagent-butler` | §3、§12.3 |
| 十个管家工具：查状态、看收件箱、读 session、派活、发消息、改派、收尾派发、处理卡点、切模式、查审计 | `src/butler-tools.ts` | §12.2 |
| 两个 worker 工具：上报状态、交计划 | `src/worker-tools.ts` | §12.4 |
| 硬门禁 + 计划审查 + 审批代批 | `src/service.ts`（`gate` / `answerApproval`）、`src/risk.ts`、`src/plans.ts` | §7 |
| 卡点检测（审批/提问/待审计划/重复失败/打转/中断/待决策） | `src/blockers.ts`、`src/status.ts` | §6.1 |
| 卡点提醒与进度提醒（`【SuperAgent 提醒】`/`【SuperAgent 进度】`，注入不唤醒；source 带结构化 `notice`，客户端渲染成带按钮的卡片） | `src/service.ts`（`maybeRemind` / `queueProgress`）、`src/blockers.ts`（`buildBlockerNotice`） | §6.3、§6.4 |
| 会话路由候选与 Host 校验 | `src/router.ts` | §5 |
| 持久化（projects/sessions/dispatches/plans/blockers/approvals/audit 八张表） | `src/store.ts` | §9 |
| 重启恢复（保留卡点/计划，补投未投递 dispatch） | `src/service.ts`（`recover`） | §6.3 |
| 三条认证 HTTP 路由（快照 / SSE / 动作） | `src/host/routes.ts` | §8.4 |
| `/superagent` 命令（status/inbox/mode/dispatch/butler/refresh/help） | `src/host/command.ts` | §8.5 |
| 对话内可交互提醒（抢注带 `superagent-notice` source 的消息行 + 输入框上方「待处理」条 + 按钮直接打 `/api/superagent/action`） | `src/client/index.ts`（`superagent-notice` Definition、`NoticeRow`、`NoticeDock`） | §8.6 |
| Web 面板（**只读**：概览 / 日志 / 明细，没有任何改变状态的动作） | `src/client/index.ts` | §8 |
| 原生 session 行的卡点徽标与软状态 | `src/client/index.ts`（`sidebar.session.row.*`） | §8.3 |

门禁矩阵（`src/service.ts` 的 `gate`）：

| 项目模式 | 有进行中的管家 dispatch | 风险 | 结果 |
|---|---|---|---|
| `plan_review` | 是 | 计划外 / 高危 / 未知 | 原生审批 → 你 |
| `plan_review` | 是 | 计划内 | 自动放行 |
| `plan_review` | 是 | 写操作但**还没批计划** | 直接 deny（`先交计划`） |
| `gate_confirm` | 是 | 低风险白名单 | 自动代批并写审计 |
| `gate_confirm` | 是 | 其他 | 原生审批 → 你 |
| 任意 | 否（手动 session） | 任意 | 插件不介入，审批走 dsh 原生流程 |

申请 `sandbox_permissions` 升级的调用一律按高危处理，不会被代批。

**bash 管家审查**（`src/bash-review.ts`，配置 `bashReview.enabled`，默认开）：管家派发的任务里，规则判不了的 bash 先交给 worker 当前的模型审一次，**只有真正危险的才转你**。
- 计划审查、计划还没批准：只读命令放行，其余拒绝并要求先交计划（不打扰你）。
- 其余情况（卡点确认，或计划已批准后的计划外命令）：普通开发操作都放行，包括管道、heredoc、脚本改项目内文件、读项目外的普通文件、清理 `/tmp` 和构建产物。只有能说出具体危险的才转你：删除不是 worker 创建的源码/数据、推远程/发布/上传、下载并执行、读写凭证、提权、混淆执行等。
- `rm`、`curl`、`deploy` 这类关键词只作为提示交给模型核对，不再直接转你（`grep deploy` 不会被拦）。sandbox 升级不送审，始终转你。
- 转给你的审批写明原因：模型判定危险时是「危险原因：<具体操作、对象、后果>」；审查没跑成（超时、没有模型路由、两次输出都不合协议）时写「管家没能完成审查（原因），请你判断」。审批卡点的标题带上命令本身。
- 审计动作：`bash_review_allow` / `bash_review_deny` / `bash_review_failed`。代价：每条送审命令多一次模型请求，同一命令的结论在进程内缓存，失败不缓存。

计划待审或计划审查下还没批准计划时，worker 上报「done 非空、next 为空」不会把 dispatch 判为完成。

## 安装到 profile

```bash
# 装进现有的 web profile（写 ~/.dsh，需要该目录的写权限）
# 注意 -w：profile 目录自带 pnpm-workspace.yaml，不加会被 pnpm 当成 workspace root 拒绝
# 在仓库根目录执行：$PWD 就是本插件的绝对路径
dsh plugin --profile web add -w "link:$PWD"

# 重启 dsh web 后生效（插件在启动时组装，热装不会进已在跑的进程）
dsh web
```

安装会同时做两件事：把包加进 `~/.dsh/profiles/web/package.json` 的 `dependencies`，并把 `@local/dsh-superagent-butler` 追加进 `dsh.profile.bundles`（bundle patch 由插件自己的 `cordis.patch.yml` 提供）。

bundle patch 会插入两项：`superagent-butler`（Host 服务 + 面板）和 `preset-superagent-butler`（只读管家 preset，含 `tool-fs` 只读配置与 `tool-fs-search`）。

卸载：`dsh plugin --profile web remove -w @local/dsh-superagent-butler`（并把 bundles 里那一条删掉）。

## 用起来

1. 侧栏出现「管家」图标 → 点开面板 → 「创建管家会话」；之后所有事都在和它的对话里说，例如「让 worker 把 util 的 isInside bug 修了」——管家自己挑 session 或新开一个。
2. 管家派活后，worker 的写操作会被门禁拦住，先要求交计划；对话里会出现一张带 [批准] / [提修改意见] / [驳回] 的提醒卡片，点一下就行。
3. 卡点、进度提醒都会以**带按钮的消息**出现在管家对话里：审批给 [允许一次] [拒绝] [忽略]，卡住给 [重试] [忽略]，有在跑的派发还会多 [标记完成] [放弃任务]。点完就地变「✓ 已处理」，不跳页、不用回面板。
4. 管家 idle 时提醒可能还没落进对话（`agent.inject` 的机制限制），这时管家会话输入框上方会出现「管家待处理 N 条」，展开还是同一套卡片。
5. 面板（侧栏「管家」）现在是**只读**的：概览（计数 / 会话 / 项目 / 最近日志 / 最近已处理）、日志（审计表）、明细（卡点 / 计划 / 派发 / 项目模式），只保留跳转和刷新。
6. 可以开多个管家（新建 session 时选「SuperAgent 管家」preset；先建普通会话、发第一条消息前再切到管家 preset 也可以，插件会卸掉 worker 注入）。每个管家派出的任务，进度和卡点只提醒它自己；手动 session 的卡点和重启汇总会提醒所有管家。离线的管家下次打开时补一条汇总。

## 开发与验证

```bash
cd dsh-superagent-butler
npm run build          # Host + Client 编译到 lib/
npm test               # 261 个单测/集成测试（node:test，无外部依赖）
npm run check:client   # 校验 client 产物的装载协议、6 个挂载点、提醒 Definition 的匹配规则
npm run check:notice   # 用假 React 真渲染一遍提醒卡片 / 待处理条 / 只读面板，并点一次按钮验证动作链路
npm run verify         # build + check:client + check:notice + test
```

浏览器级验证（用真实 Chrome 打开面板，检查挂载、tab、控制台异常）：

```bash
# 1. 起一个隔离 profile（不碰你自己的 ~/.dsh）
mkdir -p .verify/home/profiles
cp -R ~/.dsh/profiles/web .verify/home/profiles/web
# 把 .verify/home/profiles/web/package.json 里的依赖改成
#   "@local/dsh-superagent-butler": "link:<绝对路径>/dsh-superagent-butler"
# 并把 bundles 加上 "@local/dsh-superagent-butler"，然后软链 node_modules
DSH_HOME=$PWD/.verify/home dsh --profile web --port 3081 --no-open

# 2. 另开一个带 CDP 的 Chrome，然后跑脚本
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9222 --user-data-dir=/tmp/sab-chrome about:blank &
node scripts/verify-web.mjs http://127.0.0.1:3081 "<启动日志里的 token>"
```

`scripts/verify-web.mjs` 会检查：侧栏有「管家」按钮、主面板挂载、三个 tab、审计表格有行、没有未捕获异常。

`scripts/verify-panel-readonly.mjs` 用一份假快照（有卡点、在审计划、进行中派发、项目）打开面板，检查 tab 只有「概览/日志/明细」、三个 tab 都能切、面板里**没有任何**改变状态的按钮，并且只浏览面板不会发出任何 `/api/superagent/action` 请求（同一个 Chrome CDP 会话，先起 `--remote-debugging-port=9222`）。

## 已验证 / 未验证

**已验证（自动化）**

- 手动收尾派发（标记完成 / 放弃）：门禁立即解除、待审计划被关闭、失败时通知 worker、对已结束派发重复标记被拒、两种标记都写审计 —— `test/integration/service.test.ts`。
- 提醒的结构化协议：注入消息的 `source.kind === 'superagent-notice'`、`form === 'notice'`、`notice.actions` 按卡点类型给对按钮、模型可见文本前缀仍是 `【SuperAgent 提醒】` —— `test/integration/service.test.ts`、`test/unit/notices.test.ts`（12 个用例）。
- 已处理卡点出现在 `snapshot.resolvedBlockers`，提醒卡片据此回显「已处理」 —— 同上。
- 客户端装载：6 个挂载点（面板 / 侧栏徽标 ×2 / 提醒消息行 / 待处理条）、`superagent-notice` Definition 只抢注带该 source 的 append 消息、渲染节点的 `kind`/`target`/`groupTree` 形状、只读面板 —— `scripts/check-client.mjs`。

- 门禁六种组合、计划批准前后、计划外转审批后再放行、卡点确认下代批与拒绝、dispatch 完成后解除门禁 —— `test/integration/service.test.ts`。
- 里程碑提醒去重、完成时关闭 dispatch、手动 session 不推送 —— 同上。
- 路由候选过滤与 Host 校验、状态推导、卡点阈值、风险分级、计划 scope 匹配、存储 schema —— `test/unit/*.test.ts`（202 个）。
- HTTP 路由：`GET /api/superagent/state`、SSE 首帧、`POST /api/superagent/action` 的各 action 及其错误分支。
- 重启后管家 session 复用同一条记录（`ensure_butler` 返回同一个 sessionId），审计里有 `recovery/startup`。

**未验证（诚实清单）**

- **没有在真实浏览器里跑过新的提醒卡片**：`agent.inject` 的结构化消息需要重启 `dsh web` 才会由新的 Host 产出，而重启会关掉当前会话，所以只做到「构建 + 单测 + 集成 + 客户端装载自检」。`scripts/verify-panel-readonly.mjs` 需要带 `--remote-debugging-port=9222` 的 Chrome，这次也没跑。
- **没有跑过真实模型的端到端流程**：隔离 profile 里没有 API 凭证，管家/worker 的 LLM 回合会以 `error` 结束（插件本身不崩）。所以"管家自己挑 session 派活"、"worker 交计划、批准后继续"这两条链路的**模型行为**没有实测，只有 Host 侧的确定性测试。
- `tools/pre-execute` 是否覆盖 PTC `run_code` 子调用（设计 §12.7-1）没做 spike；当前把 `run_code` 归为高危工具直接拦。
- `sessionController.prompt` 的 `requestId` 幂等跨重启（§12.7-3）、`userQuestions.answer` 对 continued question 的行为（§12.7-6）没实测。
- 多标签页同时打开时的 SSE 广播一致性（§12.7-9）没测。
- 视觉细节（窄屏、深色、卡片在回答流里的间距）只做了代码层面的约束，没有真机截图。

## 自检

`POST /api/superagent/action {"action":"diagnostics"}` 会返回运行期实况：管家 sessionId、当前每个 root agent 的 preset/状态、**本插件是否真的给它装了门禁和 worker 工具**（`installed: true` 表示五个注册点全部成功、没有静默降级）、以及八张表的记录数。排查"为什么没拦"时先看这里。

诊断、`snapshot()` 和**每一条审计**都带 `version`：`codeVersion`（`git describe --tags --always --dirty`；脱离 git 安装时降级为 `pkg@x.y.z+unknown`）与 `configHash`（有效配置的 sha256 前 12 位）。目的很具体：事后能回答「这条决策是哪版代码、哪版配置下做的」。面板右上角显示当前 `codeVersion`，悬停看完整信息。

## 多来源（二期 P1：Claude Code 只读）

`SourceKind = dsh | claude | codex | remote`，`source` 字段贯穿 session/dispatch/blocker/audit 与面板；缺字段一律按 `dsh` 解释，**不迁移**旧数据。

Claude Code 来源是**只读旁路**，默认关闭：

```yaml
- id: superagent-butler
  name: "@local/dsh-superagent-butler"
  config:
    sources:
      claude:
        enabled: true          # 默认 false，显式开启才扫描
        home: ~/.claude        # 可指向 fixture
        scanDays: 14           # 只扫最近有更新的会话
        maxSessions: 500
        tailBytes: 65536       # 只读文件尾部，不读全文
        includeSubagents: true
        watch: true            # fs.watch 触发缓存失效；另有 15s 定时扫描兜底
```

能力边界：`list/readEvents/readDigest/subscribe/hardStatus = true`，`send/create/resume/queue/cancel/approvals/questions/plans/softStatusTool/reassign = false`。只读来源**不进派发候选**、显式指定会返回 `target_read_only`；`prompt()`/`create()` 直接抛错，不会静默失败。

它只读三类文件：`~/.claude/projects/**`、`~/.claude/sessions/*.json`（活进程表）、`~/.claude/history.jsonl`（取 goal）；**不读** `sessions/<pid>.key`，**不写** `~/.claude`。

真实机器自检：`npm run probe:claude`（本机 189 个 session：首扫 ~90ms，缓存后 ~33ms）。

## 面板多来源可见性（二期 P3）

- **来源徽标**：`dsh`（品牌色）/ `Claude`（橙）/ `Codex`（绿），彩色圆点 + 名字，颜色由主题 token 决定、三者互不相同；会话表、卡点卡片、计划卡片、派发卡片、提醒卡片（`superagent-notice`）上都带。
- **来源筛选**：概览页会话区顶部有 `全部 / dsh / Claude / Codex` 药丸筛选，带计数，点一下只看该来源。
- **只读降级**：外部来源的会话不能在这里打开（`打开` 按钮渲成 disabled + 「该来源不支持：只能看状态与摘要」）；卡点/计划/派发的「在对话里处理」按 `capabilities` 置灰——`approvals`/`questions`/`plans`/`send` 为 false 就不渲染可点按钮（R6：渲了就必须能用）。
- **已知限制**：出现 Codex 会话时，会话区底部固定显示「Codex 不区分主会话与子会话，这里列出的都按 root 处理」。

验证脚本：`SAB_BASE=<url> SAB_TOKEN=<token> node scripts/verify-sources-ui.mjs`（用假快照同时渲染三种来源，断言徽标/筛选/置灰/限制文案）与 `SAB_BASE=<url> SAB_TOKEN=<token> node scripts/verify-panel-readonly.mjs`（断言面板无任何会改状态的按钮、浏览不发 action 请求）。

## 进度通知（B-1）

进度事件（里程碑 / 阶段结束 / 卡点消失 / 停滞）现在**落盘并进快照**，面板概览页的「进度」时间线靠现有 2 秒轮询实时刷新——不需要你先发消息。

- 快照字段：`progressNotices: ButlerNotice[]`（与 `blockerNotices` 严格分开，不进待办、不阻塞、无按钮）。
- 生命周期：`status: open → expired`，`progress.ttlMs` 默认 24 小时，`progress.queueLimit` 默认 50 条。
- 幂等：进度注入保留给模型看，但带 `modelOnly: true`，客户端不再渲成对话卡片（避免看两遍）。
- 唤醒管家（默认开，可整段关闭）：

```yaml
progress:
  wake:
    enabled: true        # false = 完全静默
    kinds: ['stage_end', 'watchdog']   # 纯里程碑不唤醒
    maxPerDispatch: 2    # 同一条派发最多唤醒几次
    minGapMs: 120000     # 两次唤醒最小间隔；管家 running 时不唤醒
```

真机验收脚本：`SAB_BASE=<url> SAB_TOKEN=<token> node scripts/verify-progress-live.mjs`（断言无消息时 2 秒内出现、刷新后仍在、未污染 `blockerNotices`）。

## 来源健康与启动隔离（P0 修复）

来宾来源（claude/codex）坏掉**不会**再拖垮插件：

- 注册（构造 + `start()`）整体 try/catch，失败只标记该来源不可用；
- `list()` 的失败按来源隔离（`SourceRegistry.list({onError})`），其它来源照常；
- 会话落库前校验 `sessionId` 必须是 storage 的合法 per-record key（`^[A-Za-z0-9_-]+$`），非法就跳过持久化而不是抛；
- 万一是服务本身创建失败，`apply()` 会加载**降级服务**并照常 `provide('superagent')`——管家仍然能说话、工具会返回原始错误，而不是"整个管家失联"。

快照 `snapshot.sources` 会给出每个来源的 `{kind, enabled, available, error?, at}`，面板/工具都能看到原因。

冷启动回归（已进 `npm run verify`）：

```bash
npm run smoke:cold-start   # 真实 dsh web + claude/codex 双开（fixture 含子会话）
```

## 按「活」聚合与销账（P2）

调度单位本来是「一条派发消息」，但**活和消息不是一回事**：同一件活可能派发多次、换过会话，卡点、计划、进度都该挂在活上。现在引入 `Thread`（一件持续进行的活）：

- **建活**：派发时自动建一条活并挂上 `threadId`；如果这次派发取代了上一条没结束的派发（同一 session 追加指令），**沿用同一条活**——它是同一件事的延续，不是新任务。
- **状态机**：`active`（有未结束派发）→ `waiting_human`（派发都结束了，等你确认）→ `done` / `abandoned`。
- **不做自动销账**：worker 自报「完成」只把活推进到 `waiting_human`，绝不自动 `done`。因为销账会取消待审计划并解除 plan gate，一错就是放开 worker 的写权限。人（面板/对话）或管家显式确认才关。
- **销账即归档**：活关闭时，它名下还开着的卡点统一转 `auto_resolved`。今天收件箱里那 8 条 open 里 7 条是 11-09 的僵尸，这条规则就是治它们的。
- **管家工具**：`butler_thread`（`action=list` 看还开着的活、`action=close` 销账；只能按用户明确指令关）。
- **面板**：「明细」页有「进行中的活」表（活的标题、状态、派发数、未结束数、卡点数、最近活动）。
- **双写期**：`dispatch.status` 的语义**完全不变**，门禁和 watchdog 继续看 dispatch，thread 只做聚合。关掉 `thread.enabled` 就回到 P1 之前的行为。

```yaml
thread:
  enabled: true
  idleAbandonMs: 604800000   # 7 天无活动、无未结束派发、无待审计划 → 自动标 abandoned（绝不自动 done）
```

### 存储升级到 v2（升级前务必看这条）

`threads` 是第 9 张表，`STORAGE_SPEC.version` 从 1 升到 2。**`compatibleVersions: [1]` 是必须的**：per-record 布局下每条记录自带版本戳，不在接受集合内的记录会被**读作不存在**（不是迁移，是静默消失），漏写这一行用户会以为数据全丢了。

防回归：`npm run smoke:upgrade` 把**真实存储目录的副本**放进隔离 home，用当前代码冷启动后逐表核对 counts。反向验证过——把 `compatibleVersions` 删掉，这个冒烟会红（`sessions 84 → 0`）。

### MCP 工具分级与计划卡片（A 组第二轮）

- **MCP 工具按方法分级**（不再整批判「未知」）：只读方法（`take_snapshot` / `list_pages` / `take_screenshot` / `list_console_messages` / `list_network_requests` …）自动放行；会改状态的方法（`click` / `fill` / `navigate_page` / `evaluate_script` …）需审批；**表里没有的方法仍回落到「要人确认」**。`evaluate_script` 能执行任意 JS，**不算只读**。
- **同类批一次**：同会话、同 `server.method` 批准过一次后不再逐次问（依据已落盘的审批记录，重启仍有效），放行时写审计 `mcp_batch_allow`。

```yaml
mcp:
  batchApprove: true    # false = 每次都要批
```

- **计划进对话**：待审计划的卡片上直接有「批准 / 提修改意见 / 驳回 / 查看完整方案」，正文带「几条计划、几条路径」和方案摘要；点「查看完整方案」才按需拉全文（不塞进每 2 秒的快照轮询）。`gate_confirm` 下不阻塞，但通知会明确写「本次不阻塞」并给出 planId。

### 建议销账与 TTL 兜底（A 组修复）

活看起来干完但没人收尾时，系统**只建议、不擅自销账**：

- **建议销账**：条件为「会话 idle + worker 的 `next` 为空 + 有完成信号」。会出现一条「疑似完成」卡片，按钮是 **确认完成，销账** / **还在干，继续观察**。点前者等价于人工 `dispatch_mark`（连带关 thread、归档卡点）；点后者 6 小时内不再提。
- **完成信号**：worker 经 `butler_report_status` 报完（done 非空、next 空、无 blocker）或检测到阶段结束时，把 `suspectDoneAt` 记到 dispatch 上——这是**事实记录**，不是推断。
- **TTL 兜底**：默认**关闭**。开启后，仅当「超时 + 无活动 + 无待审计划 + 无其它未处理卡点」才会自动转 completed（`by=butler-auto`，写审计 `settle_ttl`）。销账会解除 plan gate，所以这条路默认不启用。

```yaml
settleSuggest:
  enabled: true
  cooldownMs: 21600000   # 忽略后 6 小时内不再提
settleTtl:
  enabled: false         # 默认关闭：自动销账风险高
  minutes: 1440
```

> 另外两条同源修复：`awaiting_approval` / `awaiting_answer` 期间不再报「没进展」（等的是人，不是 worker）；已报过阶段结束的派发把巡检间隔退避为 2 倍，并把文案从「做到哪了」换成「要不要销账」。

### 真唤醒与提醒改投（I-32 部分 / I-34 补）

**只对「确实需要人」的卡点真唤醒管家**（起 turn），其余类型仍然只 inject（不唤醒）：

| 卡点类型 | 投递方式 |
|---|---|
| `approval` / `decision` / `error` | `source.prompt` → 真起一轮，管家会主动开口 |
| 其余（`stall` / `repeated_failure` / `question` / 计划待审 …） | `inject`（不唤醒，进上下文等下一次 turn） |

四道闸 + 三层防自激：

- 同签名只唤醒一次（签名落盘到 `dispatch.progress.woke` 或 `blocker.woke`）
- 每派发最多 3 次；同一派发两次唤醒至少间隔 5 分钟；管家 `running` 时不打断
- 防自激：① 卡点在管家自己的会话里 → **绝不唤醒**；② 签名先落盘再发送（失败退回 inject，不会反复重试）；③ running 闸天然避免「被唤醒的那一轮里再唤醒自己」

```yaml
blockerWake:
  enabled: true
  kinds: ['approval', 'decision', 'error']
  maxPerDispatch: 3
  minGapMs: 300000
```

**离线队列的改投**（I-34 补）：目标管家已不存在时，**只有同一 projectKey（同工作区）**才把积压提醒改投给当前管家；不同工作区或无法判断的**留在队列不丢**，并在快照 `pendingNotices` 与面板「明细 · 未送达提醒」里显示（目标是否在线、条数、来源工作区、最近一条摘要）。

## 自动决策准确率与 shadow（P1）

系统替你做过的判断（发提醒、拒命令、派任务）现在**都进台账，并且事后会被判定对错**——用来回答一个问题：这条规则现在还准吗。

- **台账**：每条决策写审计，带 `ruleId`（哪条规则）、`dispatchId` / `blockerId`（归属）、`shadow`（是否只记录）、`outcome`（事后判定）。
- **标注只用确定性信号，不调模型**（用可能出错的智能评估自己，只会更自信）：

| 规则 | 判成误报的依据 |
|---|---|
| `watchdog_stall` | 提醒后 15 分钟内 worker 自己产出真实进度，且期间没有人工介入 |
| `blocker_repeat_failure` / `blocker_edit_thrash` | 卡点在 15 分钟内条件自行消失（没人管就好了） |
| `bash_deny` | 被拒的命令 10 分钟内被人工批准（判太严，记漏报） |
| `dispatch_route` | 该派发随后被 superseded |

- **口径两种并存**：`self_heal`（默认，没人管自己好了就算误报，样本来得快）与 `strict`（只认人工动作，样本少但准）。判不了的一律留 `unknown`，不推断凑数。
- **统计用 Wilson 下界**，不用裸命中率：`watchdog` 到现在只醒过 14 次，3 次误报就是 79% 命中率，但这在三五个样本上没有意义。样本少于 `minSamples` 时面板显示「不下结论」。
- **双向迁移**：下界跌破 `demoteBelow` 自动降级为 shadow（规则退休），升破 `promoteAbove` 自动晋升回生效。规则会腐烂，所以必须有退休机制。
- **首发只 shadow 两条**（`watchdog_stall` + `blocker_repeat_failure`）：只记账、不发提醒、不打扰你，正好覆盖 I-19 / I-20 / I-21 三个假唤醒问题，用真实流量攒证据。
- 面板「明细」页有「自动决策准确率」表：样本 / 命中率 / 下界 / 对·误报·漏 / 误报依据，模式列标「生效」或「只记录」。

```yaml
policy:
  enabled: true
  shadowRules: ['watchdog_stall', 'blocker_repeat_failure']  # 只记录不动作
  minSamples: 20        # 样本不足不下结论
  demoteBelow: 0.70     # 下界跌破 → 降级为 shadow
  promoteAbove: 0.90    # 下界升破 → 从 shadow 晋升
  windowDays: 7
  standard: self_heal   # 或 strict
  labelIntervalMs: 300000
```

> shadow 期间**不推进 `reminderCount` 配额**，但会推进节流时间——否则每轮扫描都会刷一条审计。审计里能看到 `shadow: true` 和「本会提醒……」的原因。

## 审批提醒投给谁（I-37）

提醒和真唤醒不再只发给「派发这条任务的管家」，而是**在线优先**：

```
派发者管家（且在线） → 当前活跃管家 → 任一在线管家 → 都不在线才入队
```

- **改投留痕**：写审计 `notify_redirect`，内容为「原定 X 不在线（原因）→ 改投 Y」，不再静默。
- **唤醒必须在线**：目标没有 agent 时直接不唤醒（以前会把 `prompt` 发给冷会话，凭空拉起一个你看不见的管家）。
- **唤醒后必须开口**：唤醒 prompt 是硬要求——处理完至少发一条用户可见消息；确实无事也要发最短状态。若该轮没有任何助手文本，`turn/end` 时写审计 `wake_silent`（= 记为缺陷）。

> 残留：`wake_silent` 的监测是进程内的，若在 turn 结束前重启则这一次不记账。

## 提问应答通道（I-36）

管家代答 `ask_user_question`（worker 阻塞提问）时，行为是这样的：

- **插件持有该提问时**（正常路径：worker 提问 → 插件的 `user-questions/request` answerer 持有 waiter → 卡点进收件箱）：管家的回答会**真正 resolve 回那个 tool call**，并且按**问题自己的 id** 组包（文本命中选项时放 `selected`，否则放 `custom`），不再是写死的 `id:"answer"`。
- **插件没持有时**（例如进程重启丢了内存里的 waiter）：宿主的 `userQuestions.answer()` 只对 `continued`（超时转后续轮次）的提问有效，对仍 `open` 的会**返回 `false` 且不抛错**。现在这种返回会被显式判失败：
  - `butler_resolve` 返回 `{ok:false, reason:"question_not_pending"}`，提示「在界面上直接回答，或先取消提问」；
  - **不再**把卡点标成「已处理」（这是之前的假成功）；
  - 审计写 `answer_question_failed`。

> **够不着的提问会被明确标注**：插件收到提问时会把 `callId / 正文 / 选项` 落盘（`meta.pendingQuestions`）；进程重启后内存句柄丢失，凡仍在的待答提问会自动标成「需到界面回答」——卡点 `neededAction` 改写、快照 `pendingQuestions` 与面板「明细 · 待界面回答的提问」都会列出来（带选项，可直接照着选）。
>
> **已知限制**：宿主没有「事后认领 open 提问」的 API（`ask()` 的 promise 不在我们手里就无法 join），所以这类提问**只能到界面回答**，插件侧无法代答。详见问题清单 I-36。

## `/superagent doctor`（只读自检，I-22）

为了「看一眼配置到底生效没有」而去改 `~/.dsh`，历史上把 turn 挂起过几次。所以加了一条纯只读命令：

```
/superagent doctor
```

输出：插件版本（`codeVersion` + `configHash` + 启动时间）、管家会话与「门禁/worker 工具已装载的会话数」、管家工作区（含是否存在）、各来源是否启用与不可用原因，以及**关键配置项的实际生效值**（扫描间隔、计划门禁、policy/shadowRules、thread、mcp.batchApprove、settleSuggest/settleTtl、watchdog、progress.wake、bashReview、外部来源开关）。

- **只读**：不写 `~/.dsh`、不写审计、不改任何状态（单测断言「零写入」）。
- 启动失败时也能用：会说明降级原因并提示检查 `cordis.patch.yml`。

> 改插件配置目前**没有**受支持的写入通道（详见问题清单 I-22 的评估：`dsh --dump-config` 只读、`dsh plugin` 只转发 pnpm、plugin-manager 只读 patch 文件、settings API 管的是应用设置而非插件加载配置）。改配置仍需手改 profile 的 `cordis.patch.yml` 并重启 dsh。

## 配置项

默认值见 `src/types.ts` 的 `DEFAULT_CONFIG`，可在 bundle patch 的 `config` 下覆盖（如 `butler.title`、`butler.cwd`、`planReview.allowReadOnlyBash`、`progress.notifyMilestones`、`scanIntervalMs`）。提醒相关的 `reminderCooldownMs`/`maxRemindersPerBlocker` 只作用于本插件，**不受**工作区 `AGENTS.md` 的安静时段与每日上限约束（设计 §6.2）。

## 目录

```
src/index.ts          Host 入口：建服务、暴露 superagent、注册路由与命令
src/service.ts        业务核心：门禁、审批、计划、卡点、派发、进度、恢复
src/host/routes.ts    三条认证 HTTP 路由
src/host/command.ts   /superagent 命令
src/butler/index.ts   管家 preset 子插件（只读工具面 + 提示词）
src/butler-tools.ts   管家工具
src/worker-tools.ts   worker 上报/交计划工具
src/client/index.ts   Web 面板（单文件 client module）
src/router.ts         路由候选与校验
src/risk.ts           风险分级
src/blockers.ts       卡点检测
src/status.ts         事件折叠与状态推导
src/plans.ts          计划 scope 匹配
src/store.ts          storageDomain 封装
test/unit             纯函数单测
test/integration      fake ctx 的 Host 集成测试
scripts/              客户端装载自检、浏览器验证
```
