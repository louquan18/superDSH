# SuperAgent 管家 · 三项改动开发计划

> 状态：**待评审，未动代码**
> 日期：2026-11-12
> 范围：决策台账与策略引擎、Thread 生命周期、版本戳贯穿
> 对齐：[设计文档](dsh-superagent-butler-design.md) §6.4 / §9、[问题清单](dsh-superagent-butler-issues.md) I-19 / I-20 / I-21 / I-28 / I-29

---

## 0. 结论先行

三阶段串行，总 **6.5 人日**，每阶段独立发版、独立可回滚：

| 阶段 | 内容 | 工期 | 版本 |
|---|---|---|---|
| **P0** | 版本戳贯穿（git 版本 + 配置指纹进审计与快照） | 0.5 天 | `v0.1.1` ✅ 已完成 |
| **P1** | 决策台账 + 准确率 + shadow 策略 | 2 天 | `v0.2.0` ✅ 已完成 |
| **P2** | Thread 生命周期（销账单位从 dispatch 改为 thread） | 3.5 天 | `v0.3.0` ✅ 已完成 |

四条判断：

1. **顺序不能倒**。P1 的指标没有 P0 的版本戳就没有可比性；P2 的收益必须用 P1 的指标验收，否则改完没法证明变好了。
2. **每个阶段都能一键关回去**。P1 关 `policy.enabled`、P2 关 `thread.enabled`，关掉即回到今天的语义（P2 期间 dispatch 与 thread 双写一个版本）。
3. **不动主链路**。门禁 `gate()`、审批代理、外部来源、worker 工具面全部不改签名；改动集中在「决策写完后多记一笔」和「销账单位换一层」。
4. **已定位一个会踩的坑**：存储加表必须同时写 `compatibleVersions`，否则老记录会被**读作不存在**（见 §5.1）。

---

## 1. 现状基线

| 项 | 状态 | 证据 |
|---|---|---|
| git 仓库 + 首次提交 | ✅ 已完成 | `louquan18/superDSH`，`dad40fe`，119 文件 |
| 版本标签 | ✅ 已完成 | annotated tag `v0.1.0` |
| **运行时版本标识** | ❌ 未做 | `Meta` 无 `codeVersion`/`configHash`；`diagnostics()` 不返回版本 |
| **决策台账** | ❌ 未做 | `AuditEntry`（`types.ts:264`）无 `dispatchId` / `outcome`；只有 `sessionId` |
| **Thread** | ❌ 未做 | 调度单位是 `Dispatch`（`types.ts:166`）；`Blocker`（`types.ts:219`）只有 `sessionId` |

可直接复用的既有资产（决定了工期能压到 6.5 天）：

- `Store.appendAudit()`（`store.ts:302`）是**唯一审计写入点** → 版本戳和台账字段只需改这一处
- `storageDomain` 的 `per-record` 布局 + 可选字段 → P0/P1 零迁移
- `snapshot()` / `diagnostics()`（`service.ts:3068`）已有稳定出口 → 报表和版本都挂这里
- 261 个测试 + `verify` + `smoke:cold-start` → 每阶段有回归门槛

---

## 2. 范围边界

**做**：版本标识、决策台账与标注、规则准确率报表、shadow 与快慢路径迁移、Thread 实体与生命周期、卡点归属与归档、销账语义切换、面板两个新页签。

**不做**（明确排除，避免范围蔓延）：

1. **不做历史数据迁移**。老记录靠可选字段兜底，P2 加表靠 `compatibleVersions` 兼容（§5.1）。
2. **不做 TTL 自动销账**。销账会取消待审计划并解除 plan gate，自动销风险大于收益；只做「建议销账」。
3. **外部来源（claude/codex）不进 Thread、不进台账**。它们只读、不派发、不销账，行为零变化。
4. **不做跨机器/云端**。计算、状态、环境仍绑在本机（与原文的存算分离是两条路）。
5. **不改门禁判定逻辑**。P1 只加「记录 + 是否允许动作」的旁路判断，`risk.ts` / `plans.ts` 的判据不动。

---

## 3. P0 · 版本戳贯穿（0.5 人日，`v0.1.1`）— ✅ 已完成 2026-11-12

### 3.1 目标

任何一条审计都能回答：**这条决策是哪版代码、哪版配置下产生的**。

### 3.2 改动清单

| 文件 | 改动 |
|---|---|
| `src/version.ts`（新增，~50 行） | `codeVersion()` / `configHash(cfg)` / `versionInfo()`，进程内缓存 |
| `src/types.ts` | `Meta` 加 `codeVersion`/`configHash`/`startedAt`；`AuditEntry` 加两个可选字段 |
| `src/store.ts` | `appendAudit()`（`:302`）统一注入版本；`putMeta()` 写入当前版本 |
| `src/service.ts` | `diagnostics()`（`:3068`）返回 `version`；`snapshot()` 带 `version` |
| `src/client/index.ts` | 明细页顶部一行版本信息（只读，~10 行） |

### 3.3 实现要点

```ts
// src/version.ts
export function codeVersion(): string {
  // 插件是 link: 安装，目录即仓库；从 node_modules 拷贝安装时无 .git → 降级
  try {
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'],
      { cwd: pluginRoot, encoding: 'utf8', timeout: 1500, stdio: ['ignore','pipe','ignore'] }).trim()
  } catch {
    return `pkg@${pkgVersion}+unknown`
  }
}

// 配置指纹必须是稳定序列化：键排序、去掉 undefined
export function configHash(cfg: Config): string {
  return createHash('sha256').update(stableStringify(cfg)).digest('hex').slice(0, 12)
}
```

三条纪律：

- **只算一次**。模块加载时算好，之后所有审计复用，不在热路径上跑 `git`。
- **有超时**。`timeout: 1500`，防止 `.git` 异常（网络盘、损坏索引）阻塞启动。
- **失败不抛**。降级成 `pkg@0.1.0+unknown`，绝不因为拿不到版本让插件起不来（对齐 I-15 的教训）。

### 3.4 验收（已完成）

- [x] `diagnostics` 返回 `version.codeVersion` 与 `configHash` —— 集成测试断言
- [x] 新建任一条审计，其 `codeVersion`/`configHash` 与 diagnostics 一致 —— 集成测试断言
- [x] `meta` 也带版本（重启后能查上一次跑的是哪版）—— 集成测试断言
- [x] 非 git 环境降级为 `pkg@x.y.z+unknown` 且不抛错 —— 单测断言降级串形状
- [x] 真实 dsh 进程端到端：`smoke:cold-start` 新增断言，`/state` 必须带 version 且 `configHash` 是 12 位 hex（实测 `codeVersion = v0.1.0-1-g68e66f1-dirty`）
- [x] 266 测试全绿（原 261 + 4 单测 + 1 集成）+ `check:client` + `check:notice`
- [x] 面板右上角显示 `codeVersion`，悬停显示完整版本 + 配置指纹 + 启动时间

### 3.5 回滚

纯增量字段，回滚 = 删 `version.ts` 与四处引用，无数据影响。

---

## 4. P1 · 决策台账 + 准确率 + shadow（2 人日，`v0.2.0`）— ✅ 已完成 2026-11-12

### 4.1 目标

把「系统替你做过的判断」变成可计量的对象，并让**低准确率的规则自动退回给人或模型**——这是对「Fast Path 会腐烂」的直接应答。

### 4.2 四个可独立验证的步骤

| 步 | 内容 | 工期 | 验收 |
|---|---|---|---|
| P1.1 | 审计补外键：`dispatchId` / `threadId` / `outcome` / `outcomeRule` | 0.3 | 新审计能按 dispatch 归因 |
| P1.2 | 标注引擎 `src/label.ts`：5 条确定性规则 | 0.7 | 单测覆盖每条规则的 TP/FP/FN |
| P1.3 | 准确率报表：Wilson 下界 + `snapshot.policyStats` | 0.4 | 面板「规则」页看到 n / precision / LB |
| P1.4 | 策略引擎 `src/policy.ts`：act / shadow / skip | 0.6 | shadow 下审计有记录、提醒不发 |

### 4.3 标注规则表（P1.2 的核心）

| # | 决策 | 判定信号（全部确定性，不含模型） | 记为 |
|---|---|---|---|
| L1 | watchdog 停滞提醒 | 提醒后 15 分钟内 worker 自己恢复活动，且期间无用户消息 | FP |
| L2 | 卡点（重复失败/编辑打转/中断） | 无任何人工操作而 `auto_resolve` | FP |
| L3 | bash deny / 代批拒绝 | 同一命令随后被 `user_approved` | FN（过严） |
| L4 | 派发/路由 | 该 dispatch 被 `superseded` 或被 `reassign` | FP |
| L5 | 销账 | 该 thread 关闭后同类卡点再次出现 | 标注错误 |

**两种口径必须并存**（见 §10 待拍板 1）：

- **自愈口径**：L1/L2 用「没人管就好了」判 FP。样本多，但会把「worker 自己绕过去的真卡点」误判成误报。
- **严格口径**：只把「事后人工确认是误报」判 FP。样本少，但准。

报表**两列都出**，用哪一列做升降级由配置决定，默认自愈口径。

### 4.4 策略引擎状态机（P1.4）

```
新建规则 ──▶ shadow ──(n≥minSamples & LB≥promoteAbove)──▶ act
                ▲                                          │
                └──────(n≥minSamples & LB<demoteBelow)─────┘
```

```ts
// src/policy.ts
type Mode = 'act' | 'shadow' | 'skip'
decide(ruleId: string, stats: RuleStat, cfg: PolicyConfig): Mode
```

配置（`DEFAULT_CONFIG` 新增，默认全开但**默认全 shadow**）：

```yaml
policy:
  enabled: true
  shadowRules: ['watchdog_stall', 'blocker_repeat_failure']  # P1 首发只 shadow 这两条
  minSamples: 20        # 样本不足不下结论（Wilson 下界在小样本上没有意义）
  demoteBelow: 0.70
  promoteAbove: 0.90
  windowDays: 7
```

**首发策略很重要**：第一天就把 watchdog 放进 shadow（只记账不提醒），等于用真实流量做 A/B——这正是 I-19/I-20/I-21 需要的证据，而且**不改变你看到的任何东西**。

### 4.5 实施记录（2026-11-12）

实际落地与计划的差异，两处都是主动调整：

1. **准确率表放进「明细」页，没有新开 tab**。原因：`scripts/verify-panel-readonly.mjs:259`
   把 tab 集合硬断言为「概览 / 日志 / 明细」，新增 tab 会让既有真机验收变红。
   放在明细页同样可达，且不动验收基线。
2. **L5（销账错误）推迟到 P2**。它的判据需要「一件活」的边界，而 Thread 在 P2 才有；
   P1 先把 L1–L4 做扎实。

另外落地时修掉一个自己造的 bug：`ruleStats()` 有 30s 缓存，而缓存是在写入本条决策**之前**
算出来的，导致新决策不进统计、面板要等半分钟。改为「写规则决策后立即失效缓存」。

### 4.5 验收

- [x] 离线重放：拿现有审计跑 `computeStats()`，输出一张表（历史无 `outcome` 的记 `unknown`，只验证管线不验证结论）
- [x] shadow 命中时：审计有 `shadow:true` 记录、管家**一条提醒都没发**（集成用例覆盖）
- [x] 升降级链路：`decidePolicy` 的晋升/降级/样本不足三个分支各有单测
- [x] 面板在 n<minSamples 时显示「不下结论」而不是给个百分比
- [x] 284 测试全绿（原 261 + 23 新增）+ `verify` + 真机冷启动冒烟

### 4.6 回滚

`policy.enabled: false` → 所有规则回到 `act`（即今天的行为），台账继续记录但不影响任何决策。

---

## 5. P2 · Thread 生命周期（3.5 人日，`v0.3.0`）— ✅ 已完成 2026-11-12

### 5.1 第 0 步：存储升级（最容易踩坑，必须先做）

**事实**（已核实 `dsh-storage-json/lib/index.js:106` 与 `:302`）：

- 整个域有 `version`，**per-record 文件还各自带版本戳**；
- 读取时，版本戳不在接受集合内的记录**被丢弃并读作不存在**——不是迁移，是静默消失；
- 接受集合 = `[descriptor.version, ...descriptor.compatibleVersions ?? []]`（`:372`）；
- 声明的表在磁盘上不存在时读作空表（`:113-118`），所以**加表是安全的**。

因此加 `threads` 表必须写成：

```ts
export const STORAGE_SPEC: any = {
  name: 'superagent',
  version: 2,                 // 1 → 2
  compatibleVersions: [1],    // ★ 不写这行，现有 83 会话 / 141 卡点 / 862 审计全部读不出来
  layout: 'per-record',
  tables: { /* 原 8 张表不动 */ threads: { valueSchema: schema<Thread>(...) } },
}
```

**硬验收**：升级后冷启动，`diagnostics().counts` 必须仍是现状量级（sessions≈83、blockers≈141、audit≈862）；少一个就说明版本戳写错了，立即回退。

### 5.1.1 实施记录：升级验证做了两遍

`npm run smoke:upgrade`（新增）把**真实存储目录的副本**放进隔离 home，用新代码冷启动后逐表核对：

```
projects 20→20  sessions 84→84  dispatches 14→14  blockers 141→141
approvals 631→631  audit 864→865  threads 0→0
```

又做了一次**反向验证**：把 `compatibleVersions` 从 `lib/store.js` 删掉再跑，结果是
`projects 20→0 / sessions 84→0 / blockers 141→0 / audit 864→1` —— 全表归零，
冒烟准确报红。这说明这条断言不是装饰。

### 5.2 数据模型

```ts
interface Thread {
  id: string                        // thd_<shortid>
  title: string
  state: 'active' | 'waiting_human' | 'done' | 'abandoned'
  participantSessionIds: string[]
  dispatchIds: string[]
  externalKeys?: Array<{ kind: 'github_pr' | 'im' | 'email' | 'file'; key: string }>
  createdAt: number
  lastEventAt: number
  closedAt?: number
  closedBy?: 'user' | 'butler' | 'auto_ttl'
}
```

挂载：`Dispatch.threadId?`、`Blocker.threadId?`、`Plan.threadId?`、`AuditEntry.threadId?`、`ProgressNoticeRecord.threadId?`——**全部可选**，老记录读时按 `dispatchId → dispatch.threadId → undefined` 兜底。

### 5.3 生命周期与销账语义

```
dispatch 创建 → 找 thread：目标 session 有 active thread 且任务是延续 → 复用；否则新建
                       │
        worker 干活（进度/卡点都挂 thread）
                       │
        最后一条 dispatch 结束 且 无 open blocker 且 worker 报 next 空
                       ▼
              thread=waiting_human ──(人工/管家确认)──▶ done
                                   └──(放弃)──────────▶ abandoned
```

**销账对象从 dispatch 改成 thread**，这一条同时解决三件事：

- I-28（派发不销账）：销账单位与「一件活」对齐，活完就关
- I-21（假唤醒）：thread 关闭后 watchdog 不再巡检
- 僵尸卡点：`thread` 关闭时，其名下 open blocker 统一转 `resolved(auto)`——今天 8 条 open 里 7 条是这种情况

**不做**自动销账：`waiting_human → done` 只能由人（面板/对话）或管家显式确认。`auto_ttl` 仅用于 `abandoned`（长期无活动，且无待审计划）。

### 5.4 步骤拆解

| 步 | 内容 | 工期 | 关键验收 |
|---|---|---|---|
| P2.0 | 存储升到 v2 + `threads` 表 + 兼容 | 0.3 | 老数据量级不变 |
| P2.1 | Thread 实体与生命周期（create/reuse/close） | 1.0 | 单测状态机全路径 |
| P2.2 | 各处挂 `threadId` + 卡点归档 | 0.7 | thread 关闭 → 名下 blocker 全 resolved |
| P2.3 | 工具/快照/提示词（`butler_inbox` 按 thread 分组、`butler_dispatch_mark` 兼容旧参数、新增 `close_thread`） | 0.8 | 旧调用不报错；新工具可用 |
| P2.4 | 面板 Thread 视图 | 0.4 | 只读、可下钻 |
| P2.5 | 回归 + 针对 I-03/I-21/I-28 的用例 | 0.3 | 三条 issue 有对应测试 |

### 5.5 双写期（重要）

P2 首发时 **dispatch 的 `status` 语义保持不变**，thread 只做聚合。理由：`butler_dispatch_mark`、`gate()` 的「有进行中派发」判定、watchdog 巡检都依赖 `dispatch.status`，一次性替换风险过高。

`thread.enabled: true|false` 控制聚合视图；下一个版本（v0.4）再让 gate 改看 thread 状态。

### 5.5.1 实施记录（2026-11-12）

落地时确认/调整的几件事：

1. **销账只能由人触发**。`markDispatch(completed)`（人工）会连带 `closeThread(done)`；
   worker 自报完成只把活推到 `waiting_human`。这条区分很关键：前者是人的确认，后者只是
   「疑似完成」。实现时一度把销账写进了 `completeDispatch`（自动路径），发现后立刻移走。
2. **自动 `abandoned` 实现了但只动 abandoned**：闲置超过 `thread.idleAbandonMs`（默认 7 天）、
   无未结束派发、无待审计划 → 标 abandoned。有单测断言它「绝不标 done」。
3. **`dispatch.status` 语义零改动**：门禁、watchdog、计划门禁全部继续看 dispatch，
   thread 只做聚合，`thread.enabled=false` 即回到 P1 行为。
4. 新增管家工具 `butler_thread`（list / close），工具总数 10 → 11。

### 5.6 回滚

`thread.enabled: false` → 面板隐藏 thread 视图、销账回到按 dispatch、卡点不归档。数据留着（表可空）。

---

## 6. 里程碑与发版

| 里程碑 | tag | 交付 | 验收方式 | 回滚 |
|---|---|---|---|---|
| M0 | `v0.1.1` | 版本戳 | diagnostics + 审计双处一致 | 删代码 |
| M1 | `v0.2.0` | 台账 + 报表 + shadow | 24h shadow 数据 + 面板报表 | `policy.enabled=false` |
| M2 | `v0.3.0` | Thread 聚合 + 销账切换 | 老数据量级不变 + 三条 issue 用例 | `thread.enabled=false` |

每阶段结束必跑：`npm run build && npm run verify && npm run smoke:cold-start`，并**真机**打开面板看一眼（I-17 的教训：代码绿 ≠ 真机对）。

---

## 7. 测试计划

| 层 | 新增 | 覆盖 |
|---|---|---|
| 单测 | ~38 | `version`(4)、`label`(12：5 条规则 × 正反例 + 口径差异)、`policy`(8：升降级边界 n=19/20、阈值边界)、`thread`(14：状态机全路径 + 复用/新建判定) |
| 集成 | ~8 | 审计版本戳注入、shadow 不发提醒、升/降级生效、thread 关闭解除 gate、thread 关闭归档卡点、旧参数兼容、存储 v1→v2 读兼容 |
| 冒烟 | 1 | `smoke:cold-start` 增加「升级后 counts 与升级前一致」断言 |

**回归门槛**：261 全绿 + 新增全绿 + `verify` + `smoke:cold-start`；任一阶段不达标不发版。

---

## 8. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 存储升级写错，老数据读不出来 | 中 | **致命**（看起来全丢） | §5.1 的 `compatibleVersions` + 冷启动 counts 断言 + 升级前先 `cp -R ~/.dsh/storages/superagent` 备份 |
| 标注规则口径错，误判规则好坏 | 高 | 中 | 双口径并存、两列都出、n<20 不下结论 |
| shadow 期间没人看报表 → 白跑 | 中 | 中 | 面板「规则」页 + 管家每周主动报一次（用现成 progress 通道） |
| Thread 分裂/误并 | 高 | 中 | Host 默认规则 + 管家可覆盖；面板可手动合并（P2.4 预留） |
| 双写期语义混乱（dispatch 与 thread 两套状态） | 中 | 中 | 明确 thread 只读聚合；gate/watchdog 继续看 dispatch |
| 管家不理解 threadId | 中 | 低 | 工具参数全部可选、默认自动；提示词只加三行 |

---

## 9. 排期

| 人日 | 内容 | 检查点 |
|---|---|---|
| D1 | P0 全部 | diagnostics 出 `v0.1.1`，打 tag |
| D2 | P1.1 + P1.2 | 标注单测绿 |
| D3 | P1.3 + P1.4 | shadow 开跑，打 `v0.2.0` |
| D4–D5 | 观察 shadow 数据（不占人力） | 有 n≥20 的规则出 LB |
| D6 | P2.0 + P2.1 | 老数据量级不变 + 状态机绿 |
| D7 | P2.2 + P2.3 | 卡点归档 + 工具兼容 |
| D8 | P2.4 + P2.5 | 真机验收，打 `v0.3.0` |

---

## 10. 待拍板

1. **标注口径**：默认用「自愈口径」（没人管就好了算误报），还是「严格口径」（人工确认才算）？我建议默认自愈、严格并列出，因为它样本足够快。
2. **存储升级方式**：`version: 2 + compatibleVersions: [1]`（我建议），还是把 threads 塞进 `meta` 表的一个键（不升版本，但线程一多就读放大）？
3. **shadow 首发范围**：只 shadow `watchdog_stall` + `blocker_repeat_failure`（我建议，正好覆盖 I-19/20/21），还是全部自动决策一起 shadow？
4. **销账确认人**：`waiting_human → done` 只允许人确认（我建议），还是也允许管家按「worker 报了 next 空 + 无 blocker」自行确认？
5. **P2 双写期长度**：保持一个版本（v0.3）就切 gate 看 thread（我建议），还是再等一个版本？

---

## 11. 完成定义（DoD）

任一阶段的「做完」= 代码合并 + 测试达标 + 真机验收 + 文档同步（本文件 + 问题清单条目状态）+ tag 已推 + 有明确的一键回滚开关。
