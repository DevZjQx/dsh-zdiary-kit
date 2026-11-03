# 计划：角色契约（「赋予」层，v0.10 候选）

**状态**：M1 已实施（2026-11-02，提交 `9f365b2`；词数 / 模板口径修复随本批提交；基线 v0.9.0 → 0.10 候选）；
M3 已实施（2026-11-03，事件流 + 读时投影，见 D7）；M2 / M4 待实施
**目标批次**：0.10（若与 0.9 / 质量计划同批，则并入 0.10.0，不抢跑）
**关系**：不重复 Q1 / Q3 / Q8 / Q10 / Q11；Q12 只借用 `origin` / `via` 两个字段做可信度检查，
不重复完整的三段来源链设计。本计划只做「契约层 / 状态层 / 可信层」，
落地时按 0.9 与质量计划的实际状态 rebase。

**目标**：让 agent 有稳定的角色与可追溯的记忆；**不把「意识」写进工程目标**。
用「在场 / 连续性 / 一致性」替代「意识」，用「契约」替代「赋予」。

**不在本计划内**：意识模拟 / 自省提示词；从笔记自动生成人格；自动写 `MEMORY.md` / `PERSONA.md`；
向量 / embedding；定时器 / cron（状态用惰性衰减）；语义冲突判断；全局共享一个 persona；
LLM 生成可执行规则；把投影公式写进系统提示；
把运行时状态写进 `MEMORY.md`；自动迁移旧笔记。

---

## 0. 问题清单

| ID | 问题 | 级别 | 本计划 |
|---|---|---|---|
| E1 | 没有角色层：只有 `AGENTS.md` / `USER.md` / `MEMORY.md`，人设、规则、事实混在一起 | P1 | ✅ M1 |
| E3 | 没有运行时状态层：饥饿值 / 情绪 / 场景只能塞进 `MEMORY.md`，必然过期（token 余额属宿主观测，另管） | P1 | ✅ M3 |
| E4 | 记忆条目没有「谁说的 / 哪个 scope / 来源可信度」；`authority` 默认值偏高 | P1 | ✅ M2 |
| E5 | 记忆页只展示四份原文 + 一行用量，不展示模型实际收到的载荷；退役与截断混在一起 | P1 | ✅ M1 |
| E6 | 没有角色一致性检查：`PERSONA.md` 缺失 / 旧版 / 占位符、persona 与 MEMORY 名字冲突都不可见 | P2 | ✅ M1 / M2 |
| E7 | 预算没有契约层：`AGENTS.md` 已是硬规则，再加 persona 会挤掉 MEMORY | P1 | ✅ M1 |
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
  自主决策是「谁决定、审批从哪进」，不是「能力越大越自由」。
- 日记 2026-11-02 09:00：source 的 `authority` 从 `expert` 改回 `informal`，因为只读了中配 AI 字幕；
  「投毒在元数据层的形态是悄悄把信任等级调高，它不产生断链、孤儿、解析错误，`zk_lint` 永远报 0」。
- 日记 2026-11-01：`饥饿值 / TOKEN 余额 / 身体参数` 属于运行时状态；
  「这类身体参数最好别埋死在代码里」。

这些笔记说明：角色一致性不是「写得更多」，而是**稳定的不变量 + 可追溯的记忆 + 明确的边界**。

### 1.2 M1 前（0.9）的实现事实

> 这一节是起草时的基线，保留用于说明「为什么要做」；M1 已落地的部分见 §3。
> 不要在实现 M2 / M3 时把这里当成当前状态。

- `src/lib/meta.ts`：`MEMORY_META_FILES = ['AGENTS.md', 'USER.md', 'MEMORY.md']`；
  `META_NAMES` 只多 `DREAMS.md` / `INDEX.md` / `WORKFLOW.md`。没有 persona / state。
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
  没有 `PERSONA` / `STATE` 检查，也没有「来源可信度与 via 不一致」的检查。
- 0.9 / 质量计划已经处理或立为另案：Q1（source 模板正文位置）、Q3（总词口径）、Q8（空小节）、
  Q10（长条目 / 近似重复）、Q11（机器级 USER）、Q12（source 三段链）。
  本计划不重复这些；Q12 只在 M2 借用 `origin` / `via` 两个字段做可信度检查，完整三段链仍按另案评审。
  本计划只补「契约层与状态层」以及它们与记忆层的接口；Q11 仍按另案处理，不在这里做。

### 1.3 为什么现在做

现在加 persona 只是往 `AGENTS.md` 里再塞规则，或者往 `MEMORY.md` 里再塞人设：
AGENTS 已经是 175 词硬规则，再加就会挤掉 MEMORY；人设和事实混在一起后，退役、截断、溯源都会失真。
先把层分开，比以后从 `AGENTS.md` 里往外拆便宜。

---

## 2. 设计决策

### D0：术语与边界

- 用**角色契约**（persona contract）而不是「人格文件」。
- 用**记忆连续性**（continuity）而不是「意识」；用**在场**（presence）而不是「有感受」。
- 插件只负责**存契约、注入、检查、展示**；不负责让模型「真的有感觉」。
- 任何「角色一致性」检查都是机械的：名字、角色、版本、占位符、来源可信度、事件时间戳；不做语义判断。

### D1：三层，不都进 MEMORY

| 层 | 内容 | 文件 / 来源 | 谁写 | 注入方式 |
|---|---|---|---|---|
| 角色契约 | 名字、身份、语气、价值观、边界、禁用表达 | `<notebook>/PERSONA.md` | 人 | 永远注入，短、版本化 |
| 记忆 | 事实、结论、关系、承诺、情节 | `MEMORY.md` / `journal/` / `notes/` | 人或 agent 提议、人裁决 | MEMORY 有预算、可截断；情节按 key / scope 取回 |
| 运行时状态 | 此刻的身体 / 场景参数 | `<notebook>/.state/events.log`（事件）+ `.state/rules`（投影） | agent 追加事件；规则人写 | 读时投影成一行场景，不进 MEMORY |

`AGENTS.md` 仍放工作规则（工具怎么用、笔记怎么写），不承担 persona；`USER.md` 放用户偏好，
可以跨库共享；`MEMORY.md` 只放稳定事实与结论，不放「我是谁」和「我现在多饿」。

### D2：persona 的 scope

- **默认**：一本笔记本一个 `PERSONA.md`。这符合「笔记本是硬 scope」的现状。
- **多 agent 共库**：M4 再支持 `PERSONA/<agent>.md`（或配置里的 `personaByAgent` 映射），
  注入时按会话的 `agent.id` 选；没有匹配就退回默认 `PERSONA.md`，并在 `zk_context` 里说明用了哪份。
- **不共享 persona**：`USER.md` 可以共享，`PERSONA.md` 不跨 agent 共享；A 的人格不能串到 B。
- 角色一致性靠「persona 不变量 + 记忆 scope + 取回 key」，不靠把全库笔记都塞进 prompt。

### D3：契约文件的人类所有权

- `PERSONA.md` 与 `MEMORY.md` 同级：根目录 meta，人类所有；`zk_append` / `zk_new` /
  `zk_link` / `zk_supersede` 一律拒绝写入或搬移。`<notebook>/.state/rules` 同样人类所有；
  通用笔记工具拒绝 `.state/`，只有 `zk_state append` 能写事件。
- 首行版本标记：`<!-- zdiary-persona: vN -->`；
  与 `AGENTS.md` 的 `<!-- zdiary-template: vN -->` 分开，避免 `TEMPLATE_VERSION` 一改就误报。
- 缺文件 = 未启用，不报错；`doctor` 给一条 ⚠️，`zk_lint` 给一个只读桶。
- 模板只写一次，已存在不覆盖；flat 默认不写，保持「升级不多一个文件」。
  写入入口：`zk-kit init --with-contract`、设置页「写入角色契约模板」、`ensureNotebook(..., { withContract: true })`。
- `META_NAMES` 扩到 `PERSONA.md`；根目录同名文件从此不进检索。
  迁移说明写清楚：如果用户曾在根目录用同名普通笔记，需要改名或移入子目录。

### D4：预算

先做**additive contract budget**，不改现有 `memoryBudgetWords` 的语义：

- `contractBudgetWords`：`PERSONA.md` 的上限，默认 240（可调 50–800）。
  它是硬规则，不参与 MEMORY 的截断；超了只告警，不静默丢。
- `memoryBudgetWords`：维持现状（AGENTS + USER + MEMORY），截断逻辑与 0.9 一致。
- `sceneBudgetWords`：投影后场景行的上限，默认 80；不进 MEMORY 预算；日志不存在或一条有效事件都没有 = 不注入
  （事件全在窗口外仍要注入，见 D7「窗口与裁剪」）。
- 场景行单独成段；memory 段只报「记忆载荷」（契约 + 记忆 + 框与提示），不要把它叫总 prompt。
- `totalPromptBudgetWords` 是合并总账：`memory.totalWords + scene.words`；在 `zk_context` / `doctor` /
  记忆页 / 设置页用同一个 `combinedWords` 算。**超了只告警给人**（这四个界面），不在系统提示里追一句：
  那句话每轮都要花词，而模型并不需要这个数字 —— 预算诊断是人的工作面。
- 三者都出现在 `zk_context` / 记忆页：`契约 X/240 + 记忆 Y/500 = 记忆载荷 T1；场景 Z/80；合计 T1+Z`。
- 不在本轮引入 `promptBudget` 大对象：等契约层稳定后，再单独评审是否把 AGENTS 从记忆预算移到契约预算。
- 如果 `PERSONA + AGENTS + MEMORY + 场景行` 超过 `totalPromptBudgetWords`（默认 900），
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

### D7：运行时状态（事件流 + 读时投影）

**决策**：不存状态快照，存**事件**；状态是事件日志的投影，读时现算。规则是**数据**，不是代码。

**这是叙事状态，不是遥测**：事件是 agent 自述，插件只校验格式与时间；token 余额等宿主观测不进这个日志。

| 项 | 决定 | 理由 |
|---|---|---|
| 存什么 | 一行一条事件：`<ISO 时间> <事件> [key=value …]` | 模型擅长记「发生了什么」，不擅长算「所以数值是几」 |
| 谁写 | agent 通过 `zk_state append`；插件校验格式与时间；人也可以手改 | 写入窄、可审计 |
| 谁算 | `scene.ts` 的纯函数 `project(events, rules, now, { sceneWindowDays, staleHours })` | 可单测、可重放、clamp 落在代码里 |
| 规则 | `<notebook>/.state/rules`，`变量 = 表达式` 行式 DSL（包 1） | 不引 YAML 依赖；严格解析，拼错不静默 |
| 标签 | 读时派生，永不落盘 | 避免两个真相源 |
| 衰减 | 惰性：`now - 事件时间`；tombstone 保留最后时间 | 不跑定时器，契合「不在本计划内：定时器 / cron」 |
| 位置 | `<notebook>/.state/events.log` + `.state/rules`，git 跟踪 | 跟着笔记本走，多工作区不串库；不进 zk 索引 / FTS |

**为什么按笔记本而不是 `agent.id`**：宿主的 `agent.id` 是会话 id（`src/lib/dsh.ts`）。
按会话存，每开新会话角色就失忆一次，「常驻」直接失效。一本笔记一份 persona，就一份状态；
`.state/` 在笔记本里，路径天然唯一，不会出现两个工作区的 `default` 抢同一个日志。

**事件格式**（固定行式，不是自由文本）：

```
# zdiary-state v1
2026-11-03T13:10:00+08:00 ate amount=1
2026-11-03T23:30:00+08:00 slept
2026-11-04T07:10:00+08:00 woke hours=7.5
2026-11-04T07:15:00+08:00 at place=书房
2026-11-04T07:20:00+08:00 set_goal text="写完 D7"
2026-11-06T09:00:00+08:00 user_left
2026-11-09T18:00:00+08:00 user_returned
```

- 首行 `# zdiary-state v1`：建文件时写；老文件没有也认。
- 时间戳必须带 `Z` 或 `±HH:MM`；没有时区 = 坏行。`zk_state append` 默认写 `now`，允许 `at` 回填，但必须是过去时间、不能晚于 now + 5 分钟。A 之下时间也是自述的一部分，插件只校验格式，不校验真假。
- 事件名 `[a-z][a-z0-9_]{0,31}`；参数 `key=value`，最多 8 个；key `[a-z][a-z0-9_]{0,15}`；value 是数字、带引号字符串或无空格裸词；单行 ≤ 512 字节；禁止换行 / 回车；重复 key 拒绝；未知 key 保留。事件参数允许裸词；规则里的字符串必须加引号，两套语法别混。
- `#` 开头的行和空行跳过；坏行跳过并在 `doctor` 计数，不让整段投影失败。
- `slept` 记入睡，`woke` 记醒来；时长挂在结束事件上（`woke hours=7.5`）。不要写 `user_absent 3d`：`3d` 是计划还是已发生分不清，用 `user_left` / `user_returned`。
- 追加写 + 文件锁；正常 append 不 rewrite、不排序；只有 `prune` 做压实（见「窗口与裁剪」）。

**规则 DSL（包 1：严格）**

文件 `<notebook>/.state/rules` 可选；缺 = 内置默认。UTF-8，一行一条，`#` 注释与空行跳过。
第一条非注释行必须是 `version = <整数>`；`version` 是保留名，只用于审计，不参与求值。

**赋值与切分**

- 形式：`变量 = 表达式`；变量名 `[a-z][a-z0-9_]{0,15}`。**一行一条，不续行** —— 长表达式就写在那一行里。
- 先词法再解析：`==` / `!=` / `<=` / `>=` 是独立的比较 token；赋值是**顶层第一个单独的 `=`**。
  引号里的 `=` 不算；没有 `=` 或出现多个顶层单 `=` = 加载失败。
- 求值自上而下，只能引用前面已定义的变量；没有前向引用，也就没有环。
- 重复变量名 = 加载失败；`version` 不能当变量。

**值、类型与裸词**

- 值只有三种：数字、双引号字符串（`\"`、`\\` 转义）、`null`。
- 布尔值只出现在比较 / `isNull` 的结果里，供 `if` 使用；不能存进变量。
- 表达式位置的裸词只认已定义变量和函数名；未定义 = 加载失败，不静默当字符串。
- `hoursSince(name)` / `count(name[, days])` / `last(name, key)` 里的 `name` / `key` 是事件名 / 参数名，
  不是变量，按裸词读；分隔符是逗号。
- 字符串必须加引号：`if(energy < 20, "力竭", "正常")`。`力竭` 单独出现会报「未定义变量」。
- 类型在加载时尽量检查，求值时再兜一层：字符串进算术 / 比较 = 错误；
  `if` 两个分支必须同类型，或一边是 `null`；`coalesce` 各参数同类型（`null` 例外，返回非 null 的那个类型）。
- 任何解析 / 类型 / 求值错误 = **整份规则拒绝**，回退内置默认，带 `文件:行:列` 告警；
  不注入半套规则。`zk_context.scene.rulesVersion` 显示 `default(fallback)`，`doctor` 显示第一条错误。

**函数与运算**

| 函数 / 运算 | 签名 | 语义 |
|---|---|---|
| `clamp(x, lo, hi)` | 数值 → 数值 | `lo <= hi`，否则加载失败 |
| `min(a, b, …)` / `max(…)` | 至少 2 个数值 | 逐项比较 |
| `abs(x)` | 数值 → 数值 | 绝对值 |
| `if(cond, a, b)` | 布尔, T, T → T | 运行期只求值命中分支；类型检查覆盖两个分支 |
| `hoursSince(name)` | 事件名 → 数值 \| null | 见下表 |
| `count(name[, days])` | 事件名, 正整数 → 数值 | 只数窗口内事件；默认 `sceneWindowDays`；`days <= sceneWindowDays`；tombstone 不计 |
| `last(name, key)` | 事件名, 参数名 → 字符串 \| null | 最后一条同名事件的该参数；缺 key 返回 null，**不往前找**；可读 tombstone；数值参数按原文转字符串 |
| `num(x)` | 字符串 \| 数字 \| null → 数值 \| null | 把参数原文转数字（`num(last(woke, hours))`）；转不出 = null，不报错 |
| `coalesce(a, b, …)` | 同类型 → 同类型 | 第一个非 null |
| `isNull(x)` | 任意 → 布尔 | 是否为 null |
| `+ - * /`、一元 `-` | 数值 | 除零 = 求值错误 |
| `< <= > >= == !=` | 数值 | 只比较数值；null 用 `isNull`，字符串不进比较 |

`last` 只返回字符串；要读数值参数（如 `woke hours=7.5`）用 `num(last(...))`。`num` 是通用类型转换，
不是「按事件名取数值」的专用函数 —— 后者（`lastNum`）留到 M4，别在 M3 混用。

`hoursSince(name)` 的三种情况：

| 日志情况 | 返回 | 后果 |
|---|---|---|
| 没有该事件 | `null` | 规则可用 `coalesce` 给中性先验；渲染层显示「未记录」 |
| 有，且在窗口内 | 实际小时数 | 正常衰减 |
| 有，但在窗口外 / 只剩 tombstone | 实际小时数（可能 > 720） | 仍能算衰减 / 自愈；**不当作从未发生** |

读日志时必须同时取每个事件名的**最后一条**（last-seen 索引或反向扫描，含参数），不能只读窗口；
否则窗口外的 `hoursSince` 只剩 null。tombstone 就是 prune 之后的 last-seen 行。

内置常量（求值器注入，不是事件变量）：`sceneWindowDays`（默认 30）、`staleHours`（默认 72）。
规则只能读，不能写；不能读笔记 / 环境变量 / 文件系统。

两个版本号不要混：日志首行 `# zdiary-state v1` 是**日志格式**版本，`rules` 里的 `version` 是**规则内容**版本；
两者独立、互不校验，只有改日志行格式时才动前者。

**内置默认规则**

`present` 不进规则：由投影层用 `user_left` / `user_returned` 的最后时间 + `staleHours` 判断
（规则返回 0/1 后没法区分「不在」和「未知」）。顺序：
① 两个事件都没有 → 未知（不能因为「没记录」就说在场，否则只记 `ate` 的日志会永远显示在场）；
② 最新一条超过 `staleHours` → 未知；
③ 有 left 无 returned（或 left 晚于 returned）→ 不在；
④ 否则 → 在场。

```
version = 4
woke_h = hoursSince(woke)
awake = coalesce(woke_h, 0)
sleep_h = coalesce(num(last(woke, hours)), 7)
energy = if(isNull(woke_h), null, if(woke_h > staleHours, null, clamp(70 + 4 * (sleep_h - 7) - 5 * awake, 0, 100)))
mood = if(isNull(energy), null, if(energy < 20, "力竭", if(energy < 45, "疲惫", "正常")))
ate_h = hoursSince(ate)
satiety = if(isNull(ate_h), null, if(ate_h > staleHours, null, clamp(100 - 4 * ate_h, 30, 100)))
at_h = coalesce(hoursSince(at), 0)
location = if(isNull(hoursSince(at)), null, if(at_h > staleHours, null, last(at, place)))
goal_h = coalesce(hoursSince(set_goal), 0)
goal = if(isNull(hoursSince(set_goal)), null, if(goal_h > staleHours, null, last(set_goal, text)))
```

- `energy` 单调下降：`70 + 4 × (睡眠小时 − 7) − 5 × 醒着小时`，**地板 0**（地板 20 会让 `mood` 的
  「力竭」分支永远够不着）。恢复只靠新的 `woke`，睡眠时长来自 `woke hours=`（`num(last(woke, hours))`，缺省 7）；
  **没有 `woke` 记录 = null**，「没记录」不等于「刚睡醒」；超过 `staleHours` 也归 null。
- `satiety`（饱腹度，不是饥饿值：100 = 刚吃完，30 = 很久没吃）没记录 = null（不给中性先验），
  超过 `staleHours` 也归 null。`location` / `goal` 同样在 `staleHours` 后返回 null；
  「最后 X · N 天前」由投影结果一并给出，渲染层不回读日志。
- `set_goal` 是事件，`goal` 是展示变量；分开命名，避免 `hoursSince(goal)` 读的是变量还是事件说不清。
- 展示层只认固定变量名（`energy` / `mood` / `satiety` / `location` / `goal` / `present`）；
  其余变量算得出但不注入。事件里的字符串（`at place` / `set_goal text`）是 agent 通过
  `zk_state append` 写的——这是最短的自我注入通道，靠 80 词上限 + git diff 审计兜底，不是「人写」。

40 天没记录时（事件都在窗口外，只有 tombstone），场景行大致是：

```text
当下：用户状态未知（最后离开 · 40 天前） · 最近醒来 40 天前 ·
地点未知（最后 书房 · 40 天前） · 目标未知（最后 写完 D7 · 40 天前）
```

注意这里**没有 energy / satiety**：过期值一律 null，长尾靠「最后 X · N 天前」表达。
（旧版示例写「energy 60 · mood 正常」是错的：按公式 40 天早已远超 72 小时的新鲜度线，
而且当时的地板 20 让「力竭」不可达。）

**重放是人的能力，不是模型的默认能力**：同一份日志换一套规则，可以重新解释过去
（「那时以为还行，其实早就在硬撑」），历史一条不丢；`zk-kit state show --at <ISO>` 做过去时点的投影。
模型侧不给 `--at` / 历史入口（`zk_state` 没有这两个参数）；`zk_read` 按路径仍能读到原文，
但 `.state/` 不进检索，AGENTS 也约定不主动翻 —— 这是约定，不是硬隔离。

**默认不召回**：`zk_state show` 只回投影 + 窗口内最近 20 条（结构化事件）+ 派生摘要
（「最近醒来 40 天前」「最后 书房」），不回全量原始日志、不回窗口外事件。旧事件留在 git，
模型默认不主动翻；AGENTS 明确禁止主动查 `.state` 历史。这是「惰性遗忘」，不是数据抹除——
git 里还在，人能用 `git show` 恢复。

**注入**：

- 动态运行时上下文 `zdiary:scene`（`systemPrompt.context()`，order 220，排在宿主内置 context 之后），
  `interpolate: false`；作为可选 user-role 快照，`suppressRuntimeContext()` 时一起关掉（`zk_state show` 仍是后备）。
  比放 section 好：场景每步都变，`context()` 由宿主的 `refreshContext()` 在准入前重读，不改写系统提示，也不打断前缀缓存。
- 每步求值；日志不存在或没有有效事件 → 返回空串，**不报错**；事件全在窗口外时仍注入（长尾）。
  规则坏了（编译或求值）→ 整份回退内置默认并记 `rulesError`；只有连默认都算不出来才返回空串。
- 展示层只认固定几个变量名（`energy` / `mood` / `satiety` / `location` / `goal` / `present`）；
  其余变量算得出但不注入。`present` 由渲染层用 `user_left` / `user_returned` + `staleHours` 判断。
- 渲染目标 ≤ `sceneBudgetWords`（默认 80）；超了按变量优先级裁（energy / mood 先留，location / goal 后留），
  最后才裁「最后 X · N 天前」的注脚。
- **不进 `buildMemoryPayload.text`**：场景独立投影、独立缓存；`memory.ts` 不再产出 `scene`。
  合并总量只在 `zk_context` / `doctor` / 记忆页 / 设置页算，**超了也不在提示里追**（D4）——
  同一条口径不能两处不同，否则「总 prompt」又会变成少一截的数。
- 不存 token 余额等敏感值；渲染层只认白名单变量（`note` 之类根本读不到），
  **不做通用 redact**：能进场景的只有 energy / mood / satiety / 地点 / 目标 / 在场。

**窗口与裁剪**：

- 两个窗口，别混：`sceneWindowDays`（默认 30，读日志）和 `staleHours`（默认 72，显示新鲜度）。
- 日志 > 5000 行或 > 2 MiB 时 `doctor` 提示；`zk-kit state prune` 显式压实，不自动删。
- `prune` = 压实，不是清空：保留 `# zdiary-state v1` + 每个事件名在窗口外的最后一条（tombstone）
  + 窗口内全部事件。tombstone 保住「发生过但在窗口外」，`hoursSince` 仍返回真实小时数。
- `prune` 的截止天数必须 ≥ `sceneWindowDays`；否则窗口内 count 被删、投影当场变。CLI 拒绝或要 `--force`。
- 模型可以调 `zk_state prune`（会写 git 历史）；返回只给 `{dropped, kept, windowDays}`，不回事件名 / diff。
  删前不检查 journal；`journal/` 是模型自觉。`prune` 只 stage / commit `.state/`，不碰用户别的改动。
- `prune` **不自动 commit**：模型只落文件，`git diff` 就是删除证据；提交由人决定（CLI 显式 `--commit`）。
  一次调用只写一次历史、且可撤，比「pre/post 两个 commit」更符合审计线（pre 在干净工作区还会是空提交）。
- 非 git 的库照样可以 `prune`（压实是本地文件操作），只是 `--commit` 会失败并提示；
  没有 git 就没有「删除证据」，所以人的用法是 `prune` 后自己看 `state log`，或先 `git init`。
- 不写 rollup：更早的事件靠 tombstone 保留最后时间；故事性的「三个月没见」由 `journal/` 或投影的
  `hoursSince` 长尾表达。
- 两台机器同步同一本笔记时，append-only 日志的 git 合并必然冲突：约定按时间戳排序合并、双方都保留，
  不手工取舍；单机用户可以把 `.state/` 加进 `.gitignore`，代价是换机器后长尾断掉。

**与其它层的边界**：

- MEMORY 只放稳定结论；事件不进 MEMORY。
- 想留念的情节 → `journal/`，带日期；日志只服务投影。
- 日志不进 FTS / 标签 / 双链 / RSS。

**降级与零存储路径**：

- 没有 `.state/events.log`、或文件里一条有效事件都没有 → 不注入场景段，行为与 2.0 一致；
  有事件但全在窗口外 → 仍注入长尾（`hoursSince` 走 tombstone）。
- 有日志、没有 `.state/rules` → 用内置默认规则（不是不注入）。
- 只需要「多久没见」时，**不建日志**：从 `journal/` 最新日期或会话时间派生。

**被否方案**：

| 方案 | 否掉的理由 |
|---|---|
| 固定 JSON 快照（`scene` + `body`） | 字段永远填不满；改公式后旧数值失去意义 |
| LLM 直接写数值 + 自定义数学函数 | 数值跨轮漂移；函数没人能维护；若由模型生成则是执行模型代码 |
| 把状态写进 `MEMORY.md` | 每轮变，会触发截断 / 退役机制；污染「稳定结论」层 |
| 把公式写进系统提示 | 每轮多花 100+ 词，模型还算错；计算必须在代码里 |

### D8：一致性检查（只报告）

- `persona`：缺文件 / 旧版本 / 未填 `{{...}}` / 缺 `name` / `role` / `updated`。
- `personaDrift`：`PERSONA.md` 的 `name` / `role` 与 `MEMORY.md` 的 `name` / `role`（两边都写了才比）机械冲突；
  MEMORY 条目带 `persona` 标记（说明人设事实写错了层）。
- `memoryProvenance` / `sourceTrust` / `memoryTtl`：见 D5。
- `delivery`：契约 / 记忆取自 payload，场景取自 `project()`；三者的词数、截断量、退役省略量、notice；
  不是「文件里有什么」，而是「这一轮实际注入了什么」。
- 不做「角色像不像」「有没有意识」「语义矛盾」评分：这些不可机械验收，也不该由插件下判断。

### D9：可观测性

- 记忆页从「四份原文 + 一行用量」改成：
  1. **契约**：`PERSONA.md`（渲染时把 `forbidden` 行标成警示色）；
  2. **用户**：`USER.md`；
  3. **记忆**：`MEMORY.md`，退役行加删除线 / `[retired]` 徽标，过期行加 `[expired]`；
  4. **周审**：`DREAMS.md` 标注「只有『上次做梦』一行参与提醒，不注入」；
  5. **场景**：投影结果 + 事件条数 / 规则版本 / 窗口内是否有数据；不显示敏感值；
  6. **载荷预览**：分两段显示 memory text + scene text（转义、只读、折叠），含 `contract / memory / scene / notice` 的词数。
- `zk_context` 返回同一份结构：
  ```ts
  {
    contract: { persona, words, budget, overBudget },
    memory: { words, budget, truncatedWords, retiredWords, tocWords, notice },
    scene: { present, presence, events, rulesVersion, words },
    totalWords,   // memory text only
    combinedWords // totalWords + scene.words
  }
  ```
- `doctor` 增加：契约文件、状态日志（行数 / 坏行 / 窗口内事件数）、规则版本、总预算。
- 只读视图仍然 GET-only + 回环；`PERSONA` 可能含敏感内容，页面不返回绝对路径，
  不提供 `?p=note&path=PERSONA.md`（固定白名单，和现在记忆页一样）。

### D10：兼容与迁移

- 现有库没有 `PERSONA.md` / 事件日志：行为与 2.0 完全一致，payload 不多一个词。
- `META_NAMES` 扩一项后，根目录同名普通笔记会被当成 meta；迁移说明要求改名或移入子目录。
- `authority` 默认改为 `informal` 只影响**新笔记**；旧笔记的 `authority` 不动，`zk_lint` 只报告。
- `memoryBudgetWords` 语义不变；`contractBudgetWords` / `sceneBudgetWords` 是新配置，默认不写文件时不生效；
  `sceneBudgetWords` 的口径是「投影后的场景行」，不是存储预算。
- `zk_context.scene` 去掉 `expired`，改为 `{ present, presence, events, rulesVersion, words, emptyReason }`；
  M1 只是形状、未承诺稳定，不算破坏性变更。
- 状态文件在 `<notebook>/.state/`，跟着笔记本走、git 跟踪、不进 zk 索引 / FTS；
  首个事件才建目录，升级不新增用户可见文件。
- 模板版本：新增 `PERSONA_TEMPLATE_VERSION`，不复用 `TEMPLATE_VERSION`；
  修改 `AGENTS.md` 时才升旧的 `TEMPLATE_VERSION`。
- flat 默认不写契约文件，保持「0.1.0 升级不多一个文件」；layered 也只 opt-in，避免自动多一个文件。
- 已有 `MEMORY.md` 条目格式不改写；新标记都是可选的，旧条目照常注入、截断、退役。

---

## 3. 实施里程碑

### M1（P0，契约壳 + 可观测）——✅ 已实施（2026-11-02）

**已落地的事实**（与下列落点的差异都记在这里，实现时以这一节为准）
- `originalWords` 语义没改（仍是磁盘原词数、含退役条目）：`formatFileShares` 展示时先减 `retiredWords`，
  所以「原 X」只反映截断、退役单列一项，同时 payload 与 0.9 逐字一致（已用 HEAD worktree 逐字节比对验证）。
- 契约词数拆成 `contentWords`（正文，含文件标题，预算只看它）/ `noticeWords`（告警行）/ `words`（整段注入量）/ `overWords`；
  所有展示统一用 `overWords`，不再拿 `words - budget`（否则告警行会把自己算进超出量）。
- `memoryUsage` 的 `headroom` 只按记忆侧算（`totalWords - contractWords`）；`zk_dream` 单列契约段，
  不再把契约误叫成「提示」、也不让它吃掉记忆预算。
- 版本标记后**紧跟 frontmatter**；`persona-template.ts` 提供 `stripContractMarker()`，解析前先剥标记再复用 `lib/frontmatter`。
  模板形状变了，`PERSONA_TEMPLATE_VERSION` 从 1 升到 2；M1 初版生成的 v1 模板会被 `contractStatus` 报 old，不自动覆盖。
- 合并预算（M3 起）按「记忆载荷 + 场景行」量，只在 `zk_context` / `doctor` / 记忆页 / 设置页说，不写进 payload（D4）。
- 契约缺失 = 未启用：`zk_lint` 不占行，`doctor` 只留一行 `·`；旧版 / 占位符才体检提醒。
- **多 agent 边界**：M1 仍是「一本笔记本一份」；多 agent 共库会共用同一份 `PERSONA.md`。M4 之前不要在多 agent 共库里启用。
- `doctor` 的「契约：未启用」行用 `·` 前缀，退出码判定同时接受 `·`（未启用 / 未配置不算装坏）。
- 影响 payload 的预算（记忆 / 契约）都进了缓存键；`sceneBudgetWords` / `totalPromptBudgetWords` 不进 —— 它们不改变记忆载荷。
- 场景段本批只落形状（`scene.present` 恒 false、`words` 恒 0），等 M3。
- `zk_context` 的契约摘要行只在有契约时输出；`zk-kit contract` 是只读子命令，可看用量 / 预算 / 体检。
- 设置页需要 `POST /contract`（第八条路由）：smoke 的路由数断言从 11 改为 12。
- 记忆页多了「工作约定（AGENTS.md）」一段，否则预算里的 175 词无法逐项对上。

**落点**
- `src/lib/meta.ts`：新增 `CONTRACT_META_FILES`（`PERSONA.md`），扩 `META_NAMES`。
- `src/lib/persona-template.ts`（新）：`PERSONA_TEMPLATE` + 版本标记。
- `src/lib/notebook.ts`：`ensureNotebook(..., { withContract })`；缺文件才写；`ensureTemplates` 不碰契约。
- `src/lib/memory.ts`：`readMeta` 读契约；`computePayload` 增加 `contract` / `scene`（scene 先留空）；
  `formatFileShares` 增加 `retiredWords` / `truncatedWords` 的分解；`MemoryPayload` 增加 `totalWords` / `overheadWords`。
- `src/lib/lint.ts`：新增 `contract` 桶（missing / old / placeholder）。
- `src/features/readonly/feature.ts`：记忆页分契约 / 用户 / 记忆 / 周审 / 场景；渲染退役 / 过期徽标；载荷预览。
- `src/features/zk-tools/feature.ts`：`zk_context` 返回契约 / 记忆 / 场景 / 总量；`zk_new` 拒绝创建 meta 的路径已存在，补 `PERSONA`。
- `src/config/store.ts`：`contractBudgetWords` 默认 240；`sceneBudgetWords` 默认 80；
  `totalPromptBudgetWords` 默认 900（只告警）。
- 设置页：契约预算、写入模板按钮、记忆页状态行。
- `src/cli.ts`：`zk-kit init --with-contract`；`doctor` 契约行；`zk-kit contract`（只读状态）。

**验收**
- 没有契约文件的库：payload 与 0.9 逐字一致（除新增空字段）。
- 有契约文件：契约段在记忆段之前，超预算只告警、不截断。
- 记忆页能解释 `312/500` 的每一项：AGENTS / USER / MEMORY / 目录 / 退役省略 / notice。
- 退役行在记忆页有删除线 / 徽标，不再看起来像活条目。
- `PERSONA.md` 不能被 `zk_append` / `zk_new` 写；根目录同名普通笔记迁移说明存在。
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

### M3（P1，运行时状态：事件流 + 读时投影）

**落点（M3 已实施）**

- `src/lib/state-log.ts`（新）：追加事件（文件锁 + 单行 `O_APPEND`）、按窗口读取 +
  每个事件名的 last-seen（含最后一条参数，供 `hoursSince` / `last` 用）、坏行跳过、
  tombstone / 行数统计、显式 prune 压实。只碰 `<notebook>/.state/`，不进 zk 索引。
- `src/lib/state-rules.ts`（新）：`.state/rules` 的严格 DSL（包 1）：词法 / AST、类型检查、
  白名单求值、内置默认、`version` 校验、失败回退 + 告警。纯函数，不读笔记 / 环境变量 / 文件系统。
- `src/lib/scene.ts`（新）：`project(events, rules, now, { sceneWindowDays, staleHours })` 纯函数；
  独立缓存（log mtime/size + rules mtime + minute）；渲染一行并按 `sceneBudgetWords` 裁；
  `present` 由渲染层判断；渲染层只认白名单变量（不做通用 redact）；导出 `combinedWords` / `combinedBudgetNote`。
- `src/lib/memory.ts`：**不再产出 `scene`**；`totalWords` 仍是 memory text；`overheadWords`
  不再减场景；`zk_context` / 记忆页 / doctor / 设置页用 `combinedWords` 组合两段。
- `src/app/plugin.ts`：挂 `zdiary:scene`（`systemPrompt.context()`，order 220，运行时上下文最后），`interpolate: false`，
  不设 `required`（可选运行时状态）；宿主没有 `context()` 时只跳过场景，笔记本与记忆照常；
  text 函数里先 `memoryUsage` 再 `projectScene`；异常一律返回空串。
- `src/lib/agents-template.ts`：AGENTS 模板加一节「状态：用 `zk_state` 记事件，不翻历史」；
  改 AGENTS 就升 `TEMPLATE_VERSION`（本次 v5 → v6，哨兵要求出现 `zk_state`）。
- `src/features/zk-tools/feature.ts`：新增 `zk_state`（`append` 追加 / `show` 读投影 /
  `prune` 压实）；`append` 校验格式，`show` 只回投影 + 窗口内最近 20 条，`prune` 只回
  `{ dropped, kept, windowDays }`；`zk_context` 组合新的 `scene`。
- `src/features/readonly/feature.ts`：记忆页「场景」段显示投影、事件条数、规则版本、最近几条事件；
  载荷预览分两段显示 memory text + scene text；用量行用 `combinedWords`。
- `src/lib/zk.ts`：`excludedNames()` 加 `.state`；`zk_append` / `zk_new` / `zk_link` / `zk_supersede`
  的路径守卫拒绝 `.state/`（D3 的要求要落在现有写工具上，不只是新增 `zk_state`）。
- `src/config/store.ts`：沿用 `sceneBudgetWords`（80）；新增 `sceneWindowDays`（30）与
  `staleHours`（72）；**删掉 `stateDir`**（状态固定在笔记本 `.state/`）；顺手改掉 `store.ts:62`、
  `memory.ts:71/559`、`docs/features/zk-tools.md:122` 里「M3 起由 STATE 填」的旧注释。
- `src/cli.ts`：`zk-kit state show --at <ISO>`（人重放）/ `log`（人看原始日志）/ `prune`
  （压实；显式传天数且 ≥ `sceneWindowDays`；`--commit` 只提交 `.state/`，非 git 库会提示失败但不影响压实）。
- 设置页：窗口天数、`staleHours`、规则版本；只读，改规则仍靠人编辑 `.state/rules`。

**实施顺序**

1. `state-log` + `state-rules`（纯函数 + 单测，不接宿主）
2. `scene` 渲染 + 预算裁剪
3. `plugin.ts` 挂 section（先只读，确认注入效果与词数）
4. `zk_state` 写入口 + `zk_context` / 记忆页 / `doctor`
5. 设置页与 CLI

**验收**

- 空日志（无文件 / 零条有效事件）：不注入场景段，`text` 与 2.0 逐字一致；只有窗口外事件时仍注入长尾；
  无 `.state/rules` 时用内置默认（不是不注入）。
- 追加 `woke hours=7.5`、`ate amount=1`、`user_left` / `user_returned` 后，投影出能量 / 情绪 / 在场；
  等待数小时重新装配，数值按惰性衰减 / 自愈变化（期间没有进程在跑）。
- `energy` 曲线（睡 7h）：0h=70、10h=20、16h=0（地板 0，`mood`=「力竭」）、24h=0；超过 72h = null（不拿旧值当现在）；
  睡 9h 起点 78；`mood` 在 20 是「疲惫」。
- `hoursSince`：无记录 = null；40 天前 = 960 左右；`prune` 后只剩 tombstone 仍返回真实小时数，
  不返回 null、不当作 0。
- DSL 解析：`energy = if(ate == 0, 70, 1)` 能正确切赋值与 `==`；`energi` 拼错 / 裸 `力竭` /
  字符串进算术 = 整份拒绝 + 回退默认 + `rulesVersion=default(fallback)`。
- `count(name, days)`：`days > sceneWindowDays` 拒绝；tombstone 不计；`prune` 只保留窗口内 count。
- `prune`：只 stage / commit `.state/events.log`（不碰 `.state/rules`）；人写的注释跟着后面那条事件走
  （事件被压实掉就顺延到下一条保留的事件或文件末尾）；
  返回 `{dropped, kept, windowDays}`，不回事件名 / diff；截止天数 < `sceneWindowDays` 时拒绝；
  非 git 库的 `--commit` 只提示失败，不影响压实。
- 场景行 ≤ `sceneBudgetWords`；不进 `buildMemoryPayload.text`；`combinedWords` 在 `zk_context` /
  doctor / 记忆页 / 设置页 / CLI 报同一个合计，超了只对人告警。
- `MEMORY.md` / `journal/` 里没有 `饥饿值` / `token 余额` 时仍能正常工作。

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
| 契约读取 | 无文件 = 空；有文件 = 按 `PERSONA → AGENTS → USER → MEMORY` 顺序；读不到 = 不存在 |
| 契约预算 | 240 词内完整；超了只告警、不截断；`totalPromptBudgetWords` 超了点名 |
| 契约词数 | `contentWords` / `noticeWords` / `words` / `overWords` 分开；注入提示与 doctor / contract / 设置页 / 记忆页 / `zk_context` 报同一个超出量；`memoryUsage.headroom` 不扣契约 |
| 模板解析 | 版本标记后紧跟 frontmatter；`stripContractMarker()` 后 `parseFrontmatter()` 能读到 name / role / updated |
| 退役 / 截断 | `retiredWords` 与 `truncatedWords` 分开；`formatFileShares` 不再把退役写成「原 X」 |
| 记忆页 | 退役行有徽标；`<script>` 被转义；`PERSONA` 不能按 `path` 打开；载荷预览与 payload 同源 |
| 写入守卫 | `zk_append` / `zk_new` / `zk_link` / `zk_supersede` 拒绝 `PERSONA`；根目录同名普通笔记迁移提示 |
| authority | 新 source 默认 informal；显式 expert 保留；旧笔记不变；`sourceTrust` 命中「中配 + expert」 |
| provenance | MEMORY 条目 `[agent]` / `[scope]` 解析；`persona` 标记报错；旧格式不报错 |
| TTL | `有效至` 过期报 `memoryTtl`；无日期不报；日期非法按无日期 |
| 事件日志 | 追加 / 窗口读取 / last-seen 索引 / prune 压实；未知事件忽略；坏行跳过不炸；并发追加不丢行；`.state/` 不进 zk find / 标签 / 双链 / RSS |
| 状态路径 | 两个 workspace 的同名 `default` 各有自己的 `.state/`；非 git 库 `prune` 照常、`--commit` 提示失败；`--commit` 只提交 `.state/` |
| 投影 | 内置默认；同一日志换规则重放结果变化但历史不丢；clamp 上下限；非白名单表达式拒绝加载；`==` 不被当赋值；未定义变量 / 裸中文 / count 越界整份拒绝；tombstone 仍返回真实 `hoursSince` |
| 场景注入 | 空日志不注入；场景不进 memory text；词数 ≤ 预算；读失败返回空串；只注入白名单变量（`note` 之类读不到） |
| 回归 | 无契约文件的 payload 与 0.9 一致；flat 0.1.0 产物逐字节不变；只读视图 GET-only + 回环 |

**手工验收**

1. 复制参考库一份，写入 `PERSONA.md`：记忆页出现契约段，用量行三项对得上。
2. 把 `PERSONA.md` 改到超预算：只出现告警，MEMORY 仍按原预算截断；注入提示、`doctor`、`zk-kit contract`、记忆页报同一个超出量。
3. 追加 `woke hours=7.5`、`ate amount=1`、`user_left` / `user_returned`：第一轮出现场景行；
   把 `.state/rules` 的 `version` 升一版并改系数，同一份日志重算结果变化；
   删掉 `.state/events.log` 后场景段回到「未配置」。
4. 把一个 source 的 `via` 写成「中配」，`authority` 写 `expert`：`zk_lint` 报 `sourceTrust`。
5. 在 `MEMORY.md` 写一条 `[persona]`：`zk_lint` 报「人设事实写错层」。
6. 参考库的退役行：记忆页显示删除线，载荷预览里不出现，notice 说明省略几条。

---

## 5. 兼容与迁移

1. **无契约文件的旧库**：`PERSONA` 不存在 = 未启用；payload 与 0.9 一致；`ZkContext` 多空字段。
2. **新增 meta 名字**：`PERSONA.md` 进入 `META_NAMES`，根目录同名普通笔记会从检索里消失；迁移说明要求改名或移入子目录。
3. **authority 默认**：只影响新笔记；旧笔记不变；`zk_lint` 不把旧 `expert` 当错误，只按 `sourceTrust` 报告。
4. **预算**：`memoryBudgetWords` 不变；`contractBudgetWords` / `sceneBudgetWords` 默认在无文件时为零；总预算超限只告警。
5. **模板版本**：`PERSONA_TEMPLATE_VERSION` 独立；不改 `AGENTS` 就不动 `TEMPLATE_VERSION`。
6. **flat 不变式**：flat 默认不写契约文件；0.1.0 初始化产物逐字节不变；opt-in 入口与 `--with-agents` 同级。
7. **只读视图**：安全门不变（GET/HEAD、回环、无脚本、无绝对路径、固定白名单）；新增页面只读，不提供编辑。

---

## 6. 不做 / 备选 / 另案

### 6.1 不做

- 意识模拟、自省、内心独白生成：不可验收，且容易让模型把「检索到的记录」说成「亲身经历」。
- 从笔记自动生成 persona：会把 agent 推断写成角色设定，正是「把自己的猜测当成用户要求」。
- 自动写 `PERSONA.md` / `MEMORY.md`：保留「人和 agent 直接编辑、git diff 可审」的审计线。
- 语义冲突判断：只做 key-value / 日期 / 来源级别的机械核对。
- 全局共享 persona：多 agent 共库时 persona 必须按 agent / 笔记本隔离。
- 把饥饿值 / 情绪写进 MEMORY：运行时状态走事件日志，读时投影；token 余额由宿主另管，不混进叙事日志。
- 让模型自己写数值、自己写规则、或把公式写进系统提示：数值由宿主算，规则是数据。
- 自动改 `.rules`：M3 只提供「追加事件」，改规则仍由人写文件。
- 自动迁移旧笔记 / 自动搬文件：保持「报告 + 显式 `--fix` / 手工迁移」。

### 6.2 备选

- **把 AGENTS 移进契约预算**：更干净，但会改变 0.9 的 `memoryBudgetWords` 语义；等契约层稳定后单独评审。
- **persona 写在 `PERSONA/<agent>.md` 而不是根目录**：更利于多 agent，但多一个目录与排除规则；M4 再定。
- **把 persona 做成 settings 表单**：会引入第二份真相；当前只读文件，设置页只做预览与模板写入。
- **记忆页逐条 badge**：需要自定义列表渲染；M1 先做退役 / 过期徽标，逐条 badge 后续。

### 6.3 另案

- 机器级 `USER.md`（Q11）：本计划只做 per-notebook 的 `USER.md`；全局用户层单独评审。
- 多笔记本 per-library 预算 / 目录（0.9 §6.3）：本计划只加 `contractBudgetWords` / `sceneBudgetWords`，不动 per-notebook 覆盖。
- key 索引 / memory map（M4）：与 Q12 的 `origin` / `via` 同批设计，不要在 M1 抢跑。

---

## 7. 待定问题

1. `PERSONA.md` 的默认文件是「一本库一份」还是「一个 agent 一份」？M1 先按一本库一份，M4 再扩。
2. `contractBudgetWords` 默认 240 是否合适？参考库 AGENTS 187 + MEMORY 117 已经在 500 内；加 240 后总 prompt 会变长，需要在真机上量。
3. 事件词汇怎么定：M3 先内置最小集（`ate` / `slept` / `woke` / `at` / `set_goal` / `user_left` / `user_returned`），
   其余自由文本；是否需要一份可发现的词汇表？
4. `agent.id` 到 persona 的映射放在配置、文件命名还是 frontmatter？跨会话时谁负责 pin？
5. `sourceTrust` 只能抓显式的 `via` 关键词；没有 `via` 的二手来源无法机械识别，是否接受这个边界？
6. `MEMORY.md` 的 `[user|agent|persona]` 标记会占词；是否只在 `zk_context` 显示、不写入文件？如果写入，预算怎么算？
7. 角色一致性与「在场」冲突时怎么取舍：是宁可不召回（保持当前场景），还是宁可召回（保持长期一致）？这应由运行时策略决定，插件只提供开关。
8. `personaDrift` 的对照物：D1 规定 `MEMORY.md` 不放人设，那 `PERSONA.md` 的 name / role 该和 `USER.md` 比，
   还是只保留「MEMORY 里出现 `[persona]` 标记」这一条？M2 实施前定，避免两边都写才比却永远比不到。
9. 规则文件是否允许 agent 提议、人一键确认？M3 不提供写入口，只留人工编辑；
   `zk_state` 是否返回「规则版本」以便人对照？
10. 窗口 30 天 / 5000 行的阈值需要真机数据；多 agent 共库时日志是否按 agent 再分一层，
    与 M4 的 persona scope 一起定。
11. ~~`energy` 曲线~~ 已定（2026-11-03）：单调下降，睡眠时长定起点（`num(last(woke, hours))`）。
12. ~~`prune` 的 commit 由谁触发~~ 已定（2026-11-03）：模型只落文件，commit 由人或 CLI `--commit`。
13. ~~版本口径~~ 已定（2026-11-03）：统一成 2.1（本文件里的 0.10 是计划编号，不再当发布版本）。

---

## 8. 验收清单

- [x] 无契约文件的旧库：payload 与 0.9 逐字一致；`bun run check` / `bun run smoke` 全绿。
- [x] `PERSONA.md` 是 meta：工具不能写、不能搬；根目录同名普通笔记迁移说明存在。
- [x] 记忆页分契约 / 用户 / 工作约定 / 记忆 / 周审 / 场景，能解释每一项词数；退役行有徽标；载荷预览与 `zk_context` 同源。
- [x] 契约超预算只告警、不截断；总预算超限点名；MEMORY 截断行为不变。
- [x] 契约词数口径一致：`contentWords` / `noticeWords` / `words` / `overWords` 分开；doctor / contract / 设置页 / 记忆页 / `zk_context` 报同一个超出量。
- [x] 契约模板的 frontmatter 能被现有 `parseFrontmatter` 读取（版本标记后紧跟）；`memoryUsage` 不把契约算进记忆余量。
- [ ] 新 source 默认 `authority=informal`；`origin` / `via` 可写；`sourceTrust` 能报「中配 + expert」。
- [ ] MEMORY 条目的 `[user|agent|persona]` / `[scope]` / `有效至` 能被解析；旧格式不报错。
- [x] 事件日志追加 / 窗口投影 / 重放：同一份日志换规则重算，历史不丢；坏行与未知事件不使投影失败。
- [x] 空日志不注入、不报错；场景行 ≤ 预算且不进 `buildMemoryPayload.text`；MEMORY 里不出现运行时身体参数。
- [ ] 多 agent 场景下 persona 不串台（M4）；没有匹配 persona 时退回默认并告警。
- [x] 只读视图仍是 GET-only + 回环 + 无脚本 + 固定白名单；不新增写接口。
- [x] 文档更新（M1 部分）：`docs/features/memory.md`、`readonly.md`、`settings.md`、`provisioning.md`、
      `zk-tools.md`、`README.md` 已写契约层与预算；authority 默认、state 不在 MEMORY 等 M2 / M3 落地时补。
