# 计划：角色契约与自主权（「赋予」层，v0.10 候选）

**状态**：M1 已实施（2026-11-02，提交 `9f365b2`；基线 v0.9.0 → 0.10 候选）；M2 / M3 / M4 待实施
**目标批次**：0.10（若与 0.9 / 质量计划同批，则并入 0.10.0，不抢跑）
**关系**：不重复 Q1 / Q3 / Q8 / Q10 / Q11；Q12 只借用 `origin` / `via` 两个字段做可信度检查，
不重复完整的三段来源链设计。本计划只做「契约层 / 状态层 / 可信层」，
落地时按 0.9 与质量计划的实际状态 rebase。

**目标**：让 agent 有稳定的角色、可追溯的记忆和明确的自主权边界；**不把「意识」写进工程目标**。
用「在场 / 连续性 / 一致性」替代「意识」，用「契约」替代「赋予」。

**不在本计划内**：意识模拟 / 自省提示词；从笔记自动生成人格；自动写 `MEMORY.md` / `PERSONA.md`；
向量 / embedding；定时器 / cron；语义冲突判断；替 `bili_*` 等动作工具执行权限；全局共享一个 persona；
把运行时状态写进 `MEMORY.md`；自动迁移旧笔记。

---

## 0. 问题清单

| ID | 问题 | 级别 | 本计划 |
|---|---|---|---|
| E1 | 没有角色层：只有 `AGENTS.md` / `USER.md` / `MEMORY.md`，人设、规则、事实混在一起 | P1 | ✅ M1 |
| E2 | 没有自主权层：插件无法表达「发布 / 花钱 / 对外发言 / 改记忆」谁批准 | P1 | ✅ M3 |
| E3 | 没有运行时状态层：饥饿值 / token 余额 / 情绪只能塞进 `MEMORY.md`，必然过期 | P1 | ✅ M3 |
| E4 | 记忆条目没有「谁说的 / 哪个 scope / 来源可信度」；`authority` 默认值偏高 | P1 | ✅ M2 |
| E5 | 记忆页只展示四份原文 + 一行用量，不展示模型实际收到的载荷；退役与截断混在一起 | P1 | ✅ M1 |
| E6 | 没有角色一致性检查：`PERSONA.md` 缺失 / 旧版 / 占位符、policy 空表、persona 与 MEMORY 名字冲突都不可见 | P2 | ✅ M1 / M2 |
| E7 | 预算没有契约层：`AGENTS.md` 已是硬规则，再加 persona / policy 会挤掉 MEMORY | P1 | ✅ M1 |
| E8 | 多 agent 共库时 persona 没有 scope：一个 `PERSONA.md` 会让 A 的人格串到 B | P2 | ✅ M4 |
| E9 | 取回仍只靠全量 MEMORY 与全文搜索；没有按人 / 事件 / BV 的 key 索引 | P2 | ⏸ M4 另案（与「记忆难点在取回」对齐） |

---

## 1. 证据

### 1.1 参考笔记本（只当假设，不作验收依据）

参考库 `bili-lite-work`（只读页，2026-11-02 快照）：
93 篇笔记 / 196 个标签；一本库同时装 B 站运营、AI、游戏、神经科学、插件开发。
相关笔记只作为**问题来源**，每条结论都另有本仓库代码或可复现实验支撑：

- `notes/concepts/串台是作用域问题`：同一笔记本里装着 B 站运营、插件开发、记忆研究，只靠 tags 分；
  「标签是软的，scope 是硬的」。
- `notes/concepts/记忆难点在取回`：瓶颈在索引层，不在容量；「没有按 BV 的索引」，
  同一条片子隔几天再想用还得重新认一遍。
- `notes/concepts/每条结论对上原话`：每条记忆要能回答「谁说的 / 第几版 / 什么情况下算数」；
  摘要是有损压缩，损失方向不可控。
- `notes/concepts/所有agent共用一个库`：共享记忆的代价是出处、整包搬运、一删全删；
  多 agent 共库时「A 的判断」不能当成「B 的偏好」。
- `notes/patterns/压缩之后要留门牌`：压缩后要告诉模型「这是压缩，不是失忆」，并留回原文的指针。
- `notes/concepts/在场比意识好测`：可测的是「有没有接住这一轮」，不是「有没有感受」；
  加工具 / 检索反而可能降低在场感。
- `notes/concepts/治愈癌症不是终局`、`notes/concepts/常驻省的是调度`：
  自主权是「谁决定、审批从哪进」，不是「能力越大越自由」。
- 日记 2026-11-02 09:00：source 的 `authority` 从 `expert` 改回 `informal`，因为只读了中配 AI 字幕；
  「投毒在元数据层的形态是悄悄把信任等级调高，它不产生断链、孤儿、解析错误，`zk_lint` 永远报 0」。
- 日记 2026-11-01：`饥饿值 / TOKEN 余额 / 身体参数` 属于运行时状态；
  「这类身体参数最好别埋死在代码里」。

这些笔记说明：角色一致性不是「写得更多」，而是**稳定的不变量 + 可追溯的记忆 + 明确的边界**。

### 1.2 当前实现的事实

- `src/lib/meta.ts`：`MEMORY_META_FILES = ['AGENTS.md', 'USER.md', 'MEMORY.md']`；
  `META_NAMES` 只多 `DREAMS.md` / `INDEX.md` / `WORKFLOW.md`。没有 persona / policy / state。
- `src/lib/memory.ts`：`readMeta()` 只读三份；`buildMemoryPayload()` 只拼这三份；
  `formatFileShares()` 用 `originalWords > words` 判断「原 X」，把退役省略和预算截断混在一个括号里。
- `src/features/readonly/feature.ts` 的 `handleMemory()`：展示 `AGENTS / USER / MEMORY / DREAMS`
  四份原文 + 一行用量；不展示 payload 的 `notice`、目录、做梦提醒，也不区分「退役省略」与「预算截断」。
- `src/app/plugin.ts`：只有 `zdiary:notebook`（order 5190）与 `zdiary:memory`（order 5200）两段；
  没有契约段、状态段。
- `src/lib/notebook.ts` 的 `layeredGroups()`：source 默认 `authority=official`，
  concept / entity / pattern 默认 `expert`。新笔记默认就被标成高可信，`zk_dream` 的
  `authority=informal` 机械门被绕过。
- `src/config/store.ts`：只有 `memoryBudgetWords`（AGENTS + USER + MEMORY 的合计）；
  没有契约预算、场景预算、per-notebook 预算。
- `src/lib/dream.ts`：只按 `authority === 'informal'` 拒绝候选；不检查来源是否二手、MEMORY 条目是否过期。
- `src/lib/lint.ts`：已有 `memoryLinks` / `undated` / `retired` / `incomplete` / `tags`；
  没有 `PERSONA` / `POLICY` / `STATE` 检查，也没有「来源可信度与 via 不一致」的检查。
- 0.9 / 质量计划已经处理或立为另案：Q1（source 模板正文位置）、Q3（总词口径）、Q8（空小节）、
  Q10（长条目 / 近似重复）、Q11（机器级 USER）、Q12（source 三段链）。
  本计划不重复这些；Q12 只在 M2 借用 `origin` / `via` 两个字段做可信度检查，完整三段链仍按另案评审。
  本计划只补「契约层与状态层」以及它们与记忆层的接口；Q11 仍按另案处理，不在这里做。

### 1.3 为什么现在做

现在加 persona / policy 只是往 `AGENTS.md` 里再塞规则，或者往 `MEMORY.md` 里再塞人设：
AGENTS 已经是 187 词硬规则，再加就会挤掉 MEMORY；人设和事实混在一起后，退役、截断、溯源都会失真。
先把层分开，比以后从 `AGENTS.md` 里往外拆便宜。

---

## 2. 设计决策

### D0：术语与边界

- 用**角色契约**（persona contract）而不是「人格文件」；用**自主权契约**（policy contract）而不是「权限系统」。
- 用**记忆连续性**（continuity）而不是「意识」；用**在场**（presence）而不是「有感受」。
- 插件只负责**存契约、注入、检查、展示**；不负责让模型「真的有感觉」，也不负责执行外部动作的权限。
- 任何「角色一致性」检查都是机械的：名字、角色、版本、占位符、来源可信度、TTL；不做语义判断。

### D1：四层，不都进 MEMORY

| 层 | 内容 | 文件 / 来源 | 谁写 | 注入方式 |
|---|---|---|---|---|
| 角色契约 | 名字、身份、语气、价值观、边界、口头禅、禁用表达 | `<notebook>/PERSONA.md` | 人 | 永远注入，短、版本化 |
| 自主权契约 | 读 / 写 / 发布 / 花钱 / 对外发言的级别与审批入口 | `<notebook>/POLICY.md` | 人 | 永远注入；动作工具负责强制 |
| 记忆 | 事实、结论、关系、承诺、情节 | `MEMORY.md` / `journal/` / `notes/` | 人或 agent 提议、人裁决 | MEMORY 有预算、可截断；情节按 key / scope 取回 |
| 运行时状态 | 情绪、能量、饥饿值、token 余额、当前场景 | `STATE`（宿主 / 运行时 / 配置的 JSON） | 运行时 | 只注入一小段「当前场景」，不进 MEMORY |

`AGENTS.md` 仍放工作规则（工具怎么用、笔记怎么写），不承担 persona；`USER.md` 放用户偏好，
可以跨库共享；`MEMORY.md` 只放稳定事实与结论，不放「我是谁」和「我现在多饿」。

### D2：persona 的 scope

- **默认**：一本笔记本一个 `PERSONA.md`。这符合「笔记本是硬 scope」的现状。
- **多 agent 共库**：M4 再支持 `PERSONA/<agent>.md`（或配置里的 `personaByAgent` 映射），
  注入时按会话的 `agent.id` 选；没有匹配就退回默认 `PERSONA.md`，并在 `zk_context` 里说明用了哪份。
- **不共享 persona**：`USER.md` 可以共享，`PERSONA.md` 不跨 agent 共享；A 的人格不能串到 B。
- 角色一致性靠「persona 不变量 + 记忆 scope + 取回 key」，不靠把全库笔记都塞进 prompt。

### D3：契约文件的人类所有权

- `PERSONA.md` / `POLICY.md` 与 `MEMORY.md` 同级：根目录 meta，人类所有；`zk_append` / `zk_new` /
  `zk_link` / `zk_supersede` 一律拒绝写入或搬移。
- 首行版本标记：`<!-- zdiary-persona: vN -->` / `<!-- zdiary-policy: vN -->`；
  与 `AGENTS.md` 的 `<!-- zdiary-template: vN -->` 分开，避免 `TEMPLATE_VERSION` 一改就误报。
- 缺文件 = 未启用，不报错；`doctor` 给一条 ⚠️，`zk_lint` 给一个只读桶。
- 模板只写一次，已存在不覆盖；flat 默认不写，保持「升级不多一个文件」。
  写入入口：`zk-kit init --with-contract`、设置页「写入角色契约模板」、`ensureNotebook(..., { withContract: true })`。
- `META_NAMES` 扩到 `PERSONA.md` / `POLICY.md`；根目录同名文件从此不进检索。
  迁移说明写清楚：如果用户曾在根目录用同名普通笔记，需要改名或移入子目录。

### D4：预算

先做**additive contract budget**，不改现有 `memoryBudgetWords` 的语义：

- `contractBudgetWords`：`PERSONA.md` + `POLICY.md` 的合计上限，默认 240（可调 50–800）。
  它们是硬规则，不参与 MEMORY 的截断；超了只告警，不静默丢。
- `memoryBudgetWords`：维持现状（AGENTS + USER + MEMORY），截断逻辑与 0.9 一致。
- `sceneBudgetWords`：运行时场景块，默认 80；不进 MEMORY 预算，按 TTL 失效。
- 三者都出现在 `zk_context` / 记忆页：`契约 X/240 + 记忆 Y/500 + 场景 Z/80 = 总 T`。
- 不在本轮引入 `promptBudget` 大对象：等契约层稳定后，再单独评审是否把 AGENTS 从记忆预算移到契约预算。
- 如果 `PERSONA + POLICY + AGENTS + MEMORY` 总量超过一个新配置 `totalPromptBudgetWords`（默认 900），
  只告警并点名，不自动截断契约。

### D5：来源可信度与记忆出处

- `authority` 默认改为 `informal`：新笔记要 `official/expert` 必须显式传；已有笔记不动。
  这样 `zk_dream` 的 `authority=informal` 门才有意义。
- source 模板增加 `origin` / `via` 两个字段：
  ```yaml
  authority: informal
  origin: BV1...
  via: 中配 / AI字幕 / 原文
  ```
  `authority` 只评原片；`via` 记录「我实际读到的是哪一层」。
- `MEMORY.md` 条目格式向后兼容地扩成：
  ```
  - 结论（YYYY-MM-DD）[[来源路径]] [user|agent|persona] [scope:...]
  ```
  三个标记都可选；缺失时 `zk_lint` 只报告，不阻断。
- `zk_lint` 新增只读检查：
  - `sourceTrust`：`via` 含「中配 / 二手 / AI字幕」但 `authority` 是 `expert/official`；
  - `memoryProvenance`：MEMORY 条目无日期 / 无来源 / 来源是 informal / 标记为 persona 却写在 MEMORY；
  - `memoryTtl`：`有效至 YYYY-MM-DD` 已过期（与 Q10 的 longEntries 同批）。
- `zk_dream` 增加 `trust` 栏（来源 authority / via）与 `expired` 候选；仍然只报告、不写文件。
- 不做「语义冲突判断」；只做 key-value / 日期 / 来源级别的机械核对。

### D6：自主权契约

`POLICY.md` 用「frontmatter + 一张表」的形状，既可读也可机读：

```yaml
---
version: 1
updated: 2026-11-02
---
| action | level | approval | reversible |
|---|---|---|---|
| read-note | auto | none | yes |
| write-note | auto | none | yes |
| publish | ask | human | no |
| spend | ask | human | no |
| edit-persona | forbidden | human | yes |
| edit-memory | forbidden | human | yes |
| impersonate-human | forbidden | human | no |
```

- 级别只认 `auto` / `ask` / `forbidden`；`approval` 只认 `none` / `human` / `policy`。
- `zk_context` 返回 policy 原文与解析结果；解析失败只告警，不猜。
- 插件只对 `zk_*` 自己的动作做最小检查（读 / 写笔记 / 改 meta）；
  `publish` / `spend` / 外部动作由 `bili_*` 等工具按同一份 policy 执行 —— **本插件不假装能管住别的插件**。
- 审计：`POLICY.md` 指定审计落点（默认 `DREAMS.md` 的「本周裁决」或 `journal/`）；
  谁批准、什么时候、改了哪条记忆，写进日记；插件只检查「policy 里有没有写审计落点」。
- 现有「meta 文件不接受工具写入」是自主权护栏，保持不变；agent 只能提议，人裁决。

### D7：运行时状态

- `STATE` 不是笔记本 meta 文件，不落 git；由宿主 / 运行时提供，或读一个配置的 JSON：
  - 路径：`~/.dsh/zdiary/state/<agent>.json`（默认，可用配置覆盖）；
  - 形状：`{ agent, updatedAt, ttlSeconds, scene: { location, time, present, goal }, body: { energy, mood, hunger, tokens } }`；
  - 过期或读不到 = 不注入，不报错。
- 注入只取一小段「当前场景」：时间、地点、在场的人、当前目标、能量 / 额度；
  不把 `body` 全量塞进 prompt，避免状态每轮变化把预算吃掉。
- `MEMORY.md` 不存可变身体参数；如果用户想保留历史，写进 `journal/` 并标日期，不进 MEMORY。
- `zk_context` / 记忆页显示 `STATE` 的「有没有 / 过期没有」，不显示敏感值（token 余额只显示「有」或红acted）。

### D8：一致性检查（只报告）

- `persona`：缺文件 / 旧版本 / 未填 `{{...}}` / 缺 `name` / `role` / `updated`。
- `policy`：缺文件 / 旧版本 / 表头不合法 / 未知 level / 空 action / 缺审计落点。
- `personaDrift`：`PERSONA.md` 的 `name` / `role` 与 `MEMORY.md` 的 `name` / `role`（两边都写了才比）机械冲突；
  MEMORY 条目带 `persona` 标记（说明人设事实写错了层）。
- `memoryProvenance` / `sourceTrust` / `memoryTtl`：见 D5。
- `delivery`：payload 里契约 / 记忆 / 场景各自的词数、截断量、退役省略量、notice；不是「文件里有什么」，而是「这一轮实际注入了什么」。
- 不做「角色像不像」「有没有意识」「语义矛盾」评分：这些不可机械验收，也不该由插件下判断。

### D9：可观测性

- 记忆页从「四份原文 + 一行用量」改成：
  1. **契约**：`PERSONA.md` / `POLICY.md`（渲染时把 `forbidden` 行标成警示色）；
  2. **用户**：`USER.md`；
  3. **记忆**：`MEMORY.md`，退役行加删除线 / `[retired]` 徽标，过期行加 `[expired]`；
  4. **周审**：`DREAMS.md` 标注「只有『上次做梦』一行参与提醒，不注入」；
  5. **场景**：`STATE` 的 TTL 与「已注入 / 已过期 / 未配置」；
  6. **载荷预览**：模型这一轮实际收到的文本（转义、只读、折叠），含 `contract / memory / scene / notice` 的词数。
- `zk_context` 返回同一份结构：
  ```ts
  {
    contract: { persona, policy, words, budget, overBudget },
    memory: { words, budget, truncatedWords, retiredWords, tocWords, notice },
    scene: { present, expired, words },
    totalWords
  }
  ```
- `doctor` 增加：契约文件、policy 表、state TTL、总预算。
- 只读视图仍然 GET-only + 回环；`PERSONA` / `POLICY` 可能含敏感内容，页面不返回绝对路径，
  不提供 `?p=note&path=PERSONA.md`（固定白名单，和现在记忆页一样）。

### D10：兼容与迁移

- 现有库没有 `PERSONA.md` / `POLICY.md` / `STATE`：行为与 0.9 完全一致，payload 不多一个词。
- `META_NAMES` 扩两项后，根目录同名普通笔记会被当成 meta；迁移说明要求改名或移入子目录。
- `authority` 默认改为 `informal` 只影响**新笔记**；旧笔记的 `authority` 不动，`zk_lint` 只报告。
- `memoryBudgetWords` 语义不变；`contractBudgetWords` / `sceneBudgetWords` 是新配置，默认不写文件时不生效。
- 模板版本：新增 `PERSONA_TEMPLATE_VERSION` / `POLICY_TEMPLATE_VERSION`，不复用 `TEMPLATE_VERSION`；
  修改 `AGENTS.md` 时才升旧的 `TEMPLATE_VERSION`。
- flat 默认不写契约文件，保持「0.1.0 升级不多一个文件」；layered 也只 opt-in，避免自动多两个文件。
- 已有 `MEMORY.md` 条目格式不改写；新标记都是可选的，旧条目照常注入、截断、退役。

---

## 3. 实施里程碑

### M1（P0，契约壳 + 可观测）——✅ 已实施（2026-11-02）

**已落地的事实**（与下列落点的差异都记在这里，实现时以这一节为准）
- `originalWords` 语义没改（仍是磁盘原词数、含退役条目）：`formatFileShares` 展示时先减 `retiredWords`，
  所以「原 X」只反映截断、退役单列一项，同时 payload 与 0.9 逐字一致（已用 HEAD worktree 逐字节比对验证）。
- `doctor` 的「契约：未启用」行用 `·` 前缀，退出码判定同时接受 `·`（未启用 / 未配置不算装坏）。
- 三个新预算都进了 payload 缓存键 —— 漏一个就会在改配置后拿到旧预算的载荷（实现时踩过）。
- 场景段本批只落形状（`scene.present` 恒 false、`words` 恒 0），等 M3。
- `zk_context` 的契约摘要行只在有契约时输出；`zk-kit contract` 是只读子命令，可看用量 / 预算 / 体检。
- 设置页需要 `POST /contract`（第八条路由）：smoke 的路由数断言从 11 改为 12。
- 记忆页多了「工作约定（AGENTS.md）」一段，否则预算里的 187 词无法逐项对上。

**落点**
- `src/lib/meta.ts`：新增 `CONTRACT_META_FILES`（`PERSONA.md` / `POLICY.md`），扩 `META_NAMES`。
- `src/lib/persona-template.ts`（新）：`PERSONA_TEMPLATE` / `POLICY_TEMPLATE` + 版本标记。
- `src/lib/notebook.ts`：`ensureNotebook(..., { withContract })`；缺文件才写；`ensureTemplates` 不碰契约。
- `src/lib/memory.ts`：`readMeta` 读契约；`computePayload` 增加 `contract` / `scene`（scene 先留空）；
  `formatFileShares` 增加 `retiredWords` / `truncatedWords` 的分解；`MemoryPayload` 增加 `totalWords` / `overheadWords`。
- `src/lib/lint.ts`：新增 `contract` 桶（missing / old / placeholder）。
- `src/features/readonly/feature.ts`：记忆页分契约 / 用户 / 记忆 / 周审 / 场景；渲染退役 / 过期徽标；载荷预览。
- `src/features/zk-tools/feature.ts`：`zk_context` 返回契约 / 记忆 / 场景 / 总量；`zk_new` 拒绝创建 meta 的路径已存在，补 `PERSONA` / `POLICY`。
- `src/config/store.ts`：`contractBudgetWords` 默认 240；`sceneBudgetWords` 默认 80；
  `totalPromptBudgetWords` 默认 900（只告警）。
- 设置页：契约预算、写入模板按钮、记忆页状态行。
- `src/cli.ts`：`zk-kit init --with-contract`；`doctor` 契约行；`zk-kit contract`（只读状态）。

**验收**
- 没有契约文件的库：payload 与 0.9 逐字一致（除新增空字段）。
- 有契约文件：契约段在记忆段之前，超预算只告警、不截断。
- 记忆页能解释 `312/500` 的每一项：AGENTS / USER / MEMORY / 目录 / 退役省略 / notice。
- 退役行在记忆页有删除线 / 徽标，不再看起来像活条目。
- `PERSONA.md` / `POLICY.md` 不能被 `zk_append` / `zk_new` 写；根目录同名普通笔记迁移说明存在。
- `bun run check` / `bun run smoke` 全绿；flat 初始化产物逐字节不变。

### M2（P1，可信度与出处）

**落点**
- `src/lib/notebook.ts`：`layeredGroups` 默认 `authority=informal`；source 模板加 `origin` / `via`；`zk_new` 可选 `origin` / `via`。
- `src/lib/memory-format.ts`：解析条目里的 `[user|agent|persona]` / `[scope:...]` / `有效至 YYYY-MM-DD`；
  与现有 `entryDate` / `isRetiredEntry` 共用一份切分口径。
- `src/lib/lint.ts`：`sourceTrust` / `memoryProvenance` / `memoryTtl` 三个只读桶；`longEntries` 可按 Q10 同批。
- `src/lib/dream.ts`：候选增加 `trust`（authority / via）；`retireCandidates` 增加 `expired`；仍不写文件。
- `docs/features/memory.md`：条目格式、authority 默认、origin / via、scope 的说明。
- `docs/features/zk-tools.md`：`zk_new` 的 `origin` / `via` 参数。

**验收**
- 新 source 笔记默认 `authority=informal`；显式传 `expert` 才升。
- `via` 含「中配 / 二手 / AI字幕」且 `authority=expert` 时，`zk_lint` 报 `sourceTrust`。
- MEMORY 条目标记 `persona` 时，`zk_lint` 报「人设事实写错层」；旧格式条目不报错。
- `zk_dream` 能列出「来源 informal 的 MEMORY 条目」与「已过期条目」，且不写任何文件。
- 现有 0.9 的日期截断 / 退役省略 / 目录行为不变。

### M3（P1，自主权与状态）

**落点**
- `src/lib/policy.ts`（新）：解析 `POLICY.md` 的 frontmatter + 表；只读，解析失败返回 `null`。
- `src/lib/state.ts`（新）：读 `STATE` JSON；TTL、过期、敏感字段 redact；不写文件。
- `src/lib/memory.ts`：payload 增加 `scene` 段（`{ present, expired, words, text }`）。
- `src/features/zk-tools/feature.ts`：`zk_context` 返回 policy / state；`zk_*` 的 notebook 操作做最小 policy 检查（读 / 写 / 改 meta）。
- `src/lib/lint.ts`：`policy` 桶（缺文件 / 表头不合法 / 未知 level / 缺审计落点）；`state` 桶（过期 / 读不到）。
- `src/app/plugin.ts`：场景段单独注入，order 在 memory 之后、notebook 之前/之后按现有约定选；
  `interpolate: false`，与记忆一致。
- 设置页：状态路径、TTL、policy 只读预览；不提供编辑（人直接改文件）。

**验收**
- `POLICY.md` 解析出 `auto / ask / forbidden`；`publish` 为 `ask` 时，插件自己的 `zk_*` 不会越权（它本来也不发布）。
- `STATE` 过期时不注入；`zk_context` 说明「已过期」；`MEMORY.md` 里没有 `饥饿值` / `token 余额` 仍能正常工作。
- 场景段不计入 MEMORY 预算；总预算超限只告警。
- 文档明确：`bili_*` 等动作工具必须自己读 policy 并执行；插件只提供契约。

### M4（P2，多 agent / 取回，另案细化）

- `PERSONA/<agent>.md` 或 `personaByAgent` 映射；按 `agent.id` 选 persona；没有匹配退回默认并告警。
- per-notebook 的 `contractBudgetWords` / `memoryBudgetWords`（与 0.9 §6.3 一起）。
- 只读视图的 notebook 切换 / 跨库搜索；记忆页显示「当前 pin 的库 / agent / persona」。
- key 索引：`origin` / `keys`（人 / 事件 / BV / URL）+ `zk_find --key` / `zk_recall`；
  注入一份紧凑 memory map，正文按需 `zk_read`。
- 这些是独立评审项，不在 M1–M3 的验收里。

---

## 4. 测试计划

**自动测试（`bun run test`）**

| 类别 | 用例 |
|---|---|
| 契约读取 | 无文件 = 空；有文件 = 按 `PERSONA → POLICY → AGENTS → USER → MEMORY` 顺序；读不到 = 不存在 |
| 契约预算 | 240 词内完整；超了只告警、不截断；`totalPromptBudgetWords` 超了点名 |
| 退役 / 截断 | `retiredWords` 与 `truncatedWords` 分开；`formatFileShares` 不再把退役写成「原 X」 |
| 记忆页 | 退役行有徽标；`<script>` 被转义；`PERSONA`/`POLICY` 不能按 `path` 打开；载荷预览与 payload 同源 |
| 写入守卫 | `zk_append` / `zk_new` / `zk_link` / `zk_supersede` 拒绝 `PERSONA` / `POLICY`；根目录同名普通笔记迁移提示 |
| authority | 新 source 默认 informal；显式 expert 保留；旧笔记不变；`sourceTrust` 命中「中配 + expert」 |
| provenance | MEMORY 条目 `[agent]` / `[scope]` 解析；`persona` 标记报错；旧格式不报错 |
| TTL | `有效至` 过期报 `memoryTtl`；无日期不报；日期非法按无日期 |
| policy | 三个 level 解析；未知 level / 空 action / 缺审计落点报错；解析失败不猜 |
| state | TTL 内注入；过期不注入；敏感值 redact；读不到不报错 |
| 回归 | 无契约文件的 payload 与 0.9 一致；flat 0.1.0 产物逐字节不变；只读视图 GET-only + 回环 |

**手工验收**

1. 复制参考库一份，写入 `PERSONA.md` / `POLICY.md`：记忆页出现契约段，用量行三项对得上。
2. 把 `PERSONA.md` 改到超预算：只出现告警，MEMORY 仍按原预算截断。
3. 在 `POLICY.md` 加一条 `publish: ask`：`zk_context` 能看到；`bili_*` 仍按自己的实现执行（本插件不越权）。
4. 写一个 `STATE` JSON，TTL 60 秒：第一轮有场景，过期后不再注入，`zk_context` 说明已过期。
5. 把一个 source 的 `via` 写成「中配」，`authority` 写 `expert`：`zk_lint` 报 `sourceTrust`。
6. 在 `MEMORY.md` 写一条 `[persona]`：`zk_lint` 报「人设事实写错层」。
7. 参考库的退役行：记忆页显示删除线，载荷预览里不出现，notice 说明省略几条。

---

## 5. 兼容与迁移

1. **无契约文件的旧库**：`PERSONA` / `POLICY` 不存在 = 未启用；payload 与 0.9 一致；`ZkContext` 多空字段。
2. **新增 meta 名字**：`PERSONA.md` / `POLICY.md` 进入 `META_NAMES`，根目录同名普通笔记会从检索里消失；迁移说明要求改名或移入子目录。
3. **authority 默认**：只影响新笔记；旧笔记不变；`zk_lint` 不把旧 `expert` 当错误，只按 `sourceTrust` 报告。
4. **预算**：`memoryBudgetWords` 不变；`contractBudgetWords` / `sceneBudgetWords` 默认在无文件时为零；总预算超限只告警。
5. **模板版本**：`PERSONA_TEMPLATE_VERSION` / `POLICY_TEMPLATE_VERSION` 独立；不改 `AGENTS` 就不动 `TEMPLATE_VERSION`。
6. **flat 不变式**：flat 默认不写契约文件；0.1.0 初始化产物逐字节不变；opt-in 入口与 `--with-agents` 同级。
7. **只读视图**：安全门不变（GET/HEAD、回环、无脚本、无绝对路径、固定白名单）；新增页面只读，不提供编辑。
8. **动作工具**：`bili_*` 等不在本仓库；`POLICY.md` 是共享契约，动作工具自己读、自己执行；插件发布说明要写清边界。

---

## 6. 不做 / 备选 / 另案

### 6.1 不做

- 意识模拟、自省、内心独白生成：不可验收，且容易让模型把「检索到的记录」说成「亲身经历」。
- 从笔记自动生成 persona：会把 agent 推断写成角色设定，正是「把自己的猜测当成用户要求」。
- 自动写 `PERSONA.md` / `POLICY.md` / `MEMORY.md`：保留「人和 agent 直接编辑、git diff 可审」的审计线。
- 语义冲突判断：只做 key-value / 日期 / 来源级别的机械核对。
- 插件替动作工具执行权限：插件只存契约、注入、lint；执行在动作工具。
- 全局共享 persona：多 agent 共库时 persona 必须按 agent / 笔记本隔离。
- 把饥饿值 / token 余额 / 情绪写进 MEMORY：运行时状态走 `STATE`。
- 自动迁移旧笔记 / 自动搬文件：保持「报告 + 显式 `--fix` / 手工迁移」。

### 6.2 备选

- **把 AGENTS 移进契约预算**：更干净，但会改变 0.9 的 `memoryBudgetWords` 语义；等契约层稳定后单独评审。
- **persona 写在 `PERSONA/<agent>.md` 而不是根目录**：更利于多 agent，但多一个目录与排除规则；M4 再定。
- **policy 用 JSON 而不是 Markdown 表**：更好解析，但人读成本高；先用 frontmatter + 表，解析失败只告警。
- **把 persona 做成 settings 表单**：会引入第二份真相；当前只读文件，设置页只做预览与模板写入。
- **记忆页逐条 badge**：需要自定义列表渲染；M1 先做退役 / 过期徽标，逐条 badge 后续。

### 6.3 另案

- 机器级 `USER.md`（Q11）：本计划只做 per-notebook 的 `USER.md`；全局用户层单独评审。
- 多笔记本 per-library 预算 / 目录（0.9 §6.3）：本计划只加 `contractBudgetWords` / `sceneBudgetWords`，不动 per-notebook 覆盖。
- key 索引 / memory map（M4）：与 Q12 的 `origin` / `via` 同批设计，不要在 M1 抢跑。
- `bili_*` 的 policy 执行：需要跨仓库契约；本计划只定义文件形状和 `zk_*` 的最小检查。

---

## 7. 待定问题

1. `PERSONA.md` 的默认文件是「一本库一份」还是「一个 agent 一份」？M1 先按一本库一份，M4 再扩。
2. `contractBudgetWords` 默认 240 是否合适？参考库 AGENTS 187 + MEMORY 117 已经在 500 内；加 240 后总 prompt 会变长，需要在真机上量。
3. `POLICY.md` 的表格式是否足够稳定？是否需要 frontmatter 里放一份 `actions` 列表作为机读真相？
4. `STATE` 由谁提供：宿主、运行时插件、还是一个手写 JSON？如果宿主没有 state 服务，是否只读配置文件？
5. `agent.id` 到 persona 的映射放在配置、文件命名还是 frontmatter？跨会话时谁负责 pin？
6. `sourceTrust` 只能抓显式的 `via` 关键词；没有 `via` 的二手来源无法机械识别，是否接受这个边界？
7. `MEMORY.md` 的 `[user|agent|persona]` 标记会占词；是否只在 `zk_context` 显示、不写入文件？如果写入，预算怎么算？
8. 角色一致性与「在场」冲突时怎么取舍：是宁可不召回（保持当前场景），还是宁可召回（保持长期一致）？这应由运行时策略决定，插件只提供开关。

---

## 8. 验收清单

- [x] 无契约文件的旧库：payload 与 0.9 逐字一致；`bun run check` / `bun run smoke` 全绿。
- [x] `PERSONA.md` / `POLICY.md` 是 meta：工具不能写、不能搬；根目录同名普通笔记迁移说明存在。
- [x] 记忆页分契约 / 用户 / 工作约定 / 记忆 / 周审 / 场景，能解释每一项词数；退役行有徽标；载荷预览与 `zk_context` 同源。
- [x] 契约超预算只告警、不截断；总预算超限点名；MEMORY 截断行为不变。
- [ ] 新 source 默认 `authority=informal`；`origin` / `via` 可写；`sourceTrust` 能报「中配 + expert」。
- [ ] MEMORY 条目的 `[user|agent|persona]` / `[scope]` / `有效至` 能被解析；旧格式不报错。
- [ ] `POLICY.md` 的 `auto / ask / forbidden` 能解析；解析失败只告警；插件不替动作工具执行。
- [ ] `STATE` 过期不注入；敏感值 redact；MEMORY 里不出现运行时身体参数。
- [ ] 多 agent 场景下 persona 不串台（M4）；没有匹配 persona 时退回默认并告警。
- [x] 只读视图仍是 GET-only + 回环 + 无脚本 + 固定白名单；不新增写接口。
- [x] 文档更新（M1 部分）：`docs/features/memory.md`、`readonly.md`、`settings.md`、`provisioning.md`、
      `zk-tools.md`、`README.md` 已写契约层与预算；authority 默认、policy 解析边界、state 不在 MEMORY 等 M2 / M3 落地时补。
