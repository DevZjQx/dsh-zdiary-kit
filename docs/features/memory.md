# memory（长期约定与记忆注入）

**Purpose.** 让 agent 每轮都带着「工作约定 + 用户偏好 + 长期记忆」开始，不用先去翻文件；
注入有硬预算，截断多少必须可观测 —— 否则模型看到的是残缺记忆却不知道残缺。

**Owns.**
- `lib/meta.ts`：meta 文件唯一清单（注入 3 份 / 排除 6 份），memory、zk、settings 共用
- `lib/memory.ts`：读 `<vault>/AGENTS.md` / `USER.md` / `MEMORY.md` → 词数 → 机械截断 → `<system-reminder>` 框；
  另读 `DREAMS.md` 的「上次做梦」一行（不进正文、不计预算）
- `lib/dream.ts`：`lastDreamDate` / `daysSinceDream`（只认整齐的一行，按本地日历天算）；`dreamNotebook` 用它算默认窗口
- `lib/wikilink.ts`：`[[链接]]` 的解析口径（路径 → `.md` → `archive/` → 活笔记标题），lint 与 dream 共用一份
- `lib/agents-template.ts`：`AGENTS.md` 模板两份 —— layered 用完整版（当前 186 词），flat 用精简版
  （88 词，不出现 `raw` / `inbox` / `archive` / `WORKFLOW.md`）；两份首行都是 `<!-- zdiary-template: vN -->`。
  layered 初始化自动写，flat 只有 `ensureNotebook(cfg, signal, { withAgents: true })` / `zk-kit init --with-agents` /
  设置页「写入 AGENTS.md 模板」才写；已存在一律不覆盖。
  `WORKFLOW.md` 模板（改已有笔记的清单确认 + 三分类；不注入、不计预算，AGENTS 只留一行指针）
- `app/plugin.ts`：`ctx.inject(['systemPrompt'])` → 注册两段：`zdiary:notebook`（order 5190，一行当前笔记本名字 / 结构 / 路径 + 其余已配置库名，每步跟随会话 pin；**不进记忆预算**）与 `zdiary:memory`（order 5200，`interpolate: false` —— 记忆是文件原文，
  `{{…}}` 一律原样保留：插值会让未注册变量在装配时抛错、`{{model}}` 这类被静默改写），`text` 是函数，每个 step 重新求值（按文件指纹 + 预算 + 日期缓存，变了才重读重算）；
  装配上下文带 `agent.id` 时按**会话工作区 + 该会话固定的笔记本**解析（`config/session`，和 `zk_*` 工具同口径）；
  别的会话切了默认值不会把已开的会话换库，裸装配才退回进程工作区 + 全局默认
- `zk_context` 工具：同一份 payload（含 `ratio` 用量），给「宿主没有 `systemPrompt`」和「人想核对被截断了什么」用；
  另返回 `notebooks`（名字 / 路径 / 结构 / 当前），没有提示注入时模型也能发现已配置的库
- 设置页「记忆」：注入预算；「目录与 group」：归档目录。快照里带 `memory.words/budget/truncatedWords` 状态行

**Does not own.** MEMORY.md 写什么（agent 按 AGENTS.md 直接改文件，git diff 可审）；
哪些记忆该晋升（语义判断是 agent 的活，插件只做机械截断）；`MEMORY.md` 的写入路径 ——
它由人和 agent 直接编辑，`zk_append` / `zk_link` / `zk_supersede` 都会拒绝（追加会把记忆变成流水账，也丢掉「谁改的」这条审计线；后者还会把文件搬进 archive/）。

**记忆层与事实层的一致性。** `MEMORY.md` 每条结论后附 `[[来源路径]]`（写进 AGENTS 模板）；
`zk_lint` 的 `memoryLinks` 只做机械核对：原路径 → 加 `.md` → `archive/` 下同名 → 活笔记标题 / 文件名，
旧路径在 `archive/` 下找到同名（或活文件带 `status: superseded`）报 `superseded`，都找不到报 `missing`；
显式写 `archive/` 的链接是有意引用，不算漂移；另数 MEMORY.md 里有多少列表条目没附链接（USER 不计）。
P1-3 再加三项，都只报告：`undated`（条目首行没有 `YYYY-MM-DD`，退役行不计）、`retired`（`- [superseded …]` 条目数）、
`retiredBroken`（退役行的 `→ [[新结论]]` 解析不到活笔记）。注入仍按文件原文，退役行不删、不过滤 ——
「注入 = 文件原文」这条现状留给 A 案跑一段时间后再评估（B 案）。
为什么要有：`zk_supersede` 只重写 `zk graph` 里的入链，meta 文件被 `excludedNames` 排除在图外 ——
链接不会跟着搬，`--broken-links` 也看不见。语义重复仍留给 agent，插件不碰。

**Depends on.** `config/store`（`memoryBudgetWords`，每次现读 —— 设置页保存后下一次工具调用就生效）、
`lib/meta`、`node:fs`；宿主的 `systemPrompt` 服务（可选，没有就只留 `zk_context`）。

**Public surface.** `buildMemoryPayload(cfg)`、`countWords(text)`、`formatFileShares(files, tocWords)`、`META_FILES`（别名 `MEMORY_META_FILES`）、
`AGENTS_TEMPLATE` / `AGENTS_TEMPLATE_FLAT`、`TEMPLATE_VERSION` / `TEMPLATE_MARK`、`WORKFLOW_TEMPLATE`。
笔记本侧：`writeAgentsTemplate(cfg)`（缺才写，返回是否写入）与 `ensureNotebook(cfg, signal, { withAgents })`。
`WORKFLOW.md` 不进 `META_FILES`（不注入），只在 `META_NAMES` 里（排除出检索、`zk_append` 拒写）。

**Rejected.** 只在会话开始时注入一次 —— 拒绝：改完 MEMORY.md 要等下一次会话才生效，还得自己实现「这条已经注入过」的去重。
用 `systemPrompt.context()` 而不是 `section()` —— 拒绝：`context()` 会被 `suppressRuntimeContext` 连带关掉，
多一个开关就多一种「记忆静默消失」。依赖 DSH 自动加载 vault 根目录的 `AGENTS.md` —— 拒绝：不成立，
内置加载器只认「项目根 → cwd」链与用户级两份，vault 不在 cwd 祖先链上时完全读不到（见计划 §4 M1）。

**Exceptions.** 中文按 2 字 1 词计（空白切分在中文上严重低估，预算会变成装饰）；
`AGENTS.md` 模板自己也得守这条预算：初版 310 词，`bun run docs` 里 `zk-kit doctor` 直接报
`✗ 记忆：310/300 词` —— 模板吃掉整个预算，MEMORY.md 就永远被截光，所以先压到 160 词（195 词的版本把 USER + MEMORY 压到只剩 105 词），后续补 `name` / `WORKFLOW` / `rename` 规则后为 175 词，加「截断从底部往前丢」后为 187 词，
P1-3 的日期 / 退役格式 + P2-15 的版本标记后为 189 词；P2-8 去掉 `inbox/` 后实测 186 词（单测锁 `≤190`；flat 精简版锁 `≤90`，实测 88）。
`AGENTS.md` 是硬规则，单独超预算也不截断，只回显告警；文件内容里的 `</system-reminder>` 会被转义，
截断目录里的段落标题同样转义 —— 不许提前闭合插件自己的框；任何一份文件读不到都当作不存在，笔记本没建好时返回空载荷而不是报错。

**截断要归因。** 只说「已截断 83 词」等于没说：看的人（和模型）不知道是 AGENTS 太长，最容易把排查方向
带到「注入没挂载」上。所以「确实截断了、且总载荷没超预算」时额外点名
`AGENTS.md 占 120/200 词且不参与截断，留给 USER / MEMORY 的只有 80 词`；
没截断时一个字都不加（不为诊断污染每步的载荷），AGENTS 自己超预算时也不加（「预算不足」那条已经点了名）。
最终仍超预算时，点名**谁已经没法再丢**：`预算不足：内容 126 词，超出 50 词；MEMORY.md 126 词（已无更多可丢的段落）`
—— 只说「AGENTS 不截断」会把 MEMORY 的条目形状问题藏在后面（P0-1 的归因错误就是这样漏掉的）。
这条只写在 `buildMemoryPayload` 一处 —— 注入、`zk_context`、设置页、`doctor` 读的都是同一份载荷。

**接近上限就回显用量。** 增长是连续的、反馈是离散的：等到第一次截断才说话，正好是最坏的时刻（此时只能丢条目）。
所以未截断且 `words / budget ≥ 0.8` 时，在 notice 里加一行 `记忆已用 246/300 词（82%）`（数字已含这行提示本身）。
这一行**算进** `words`（否则数字是假的），加之前先检查「加上后仍 ≤ 预算」，放不下就整条不加 ——
宁可不说，也不让提醒本身把预算吃满。与「已截断」「预算不足」互斥，三者只会出现一个。
`zk_context` 另返回 `ratio`（两位小数，> 1 表示超预算），给模型和测试一个机器可读的用量。

**三级切分（P0-1）。** 只按 `##` 小节切时，「`# 记忆` + 要点列表」这种最常见的形状一个小节都切不出来，
丢弃循环一次都不进，预算于是完全不生效（真机实测 880 / 449 / 895 词，`truncatedWords` 都是 0）。
现在按顺序降级：`##` 小节 → 顶层列表项（至少两条，缩进续行归上一条）→ 空行段落（首段作为 head）；
三级都跳过 ```` ``` ```` 围栏里的行 —— 代码块里的 `- ` 或空行不该被当成可丢弃的条目。
丢弃仍从尾部开始、`head` 永远保留，所以**条目列表是从末尾往前丢**：新条目加在底部会先被丢，
README 与模板不要暗示「新条目往下加」而不提这一点。

**截断留目录，不静默消失。** 丢掉的段会合成一份紧凑目录（`MEMORY.md：§标题、§标题`），
标题取首行（去掉 `##` 或列表符号）、压到 40 字，最多 5 个；目录自己也算预算（载荷里的 `tocWords`，
`min(40, 20%)`：默认 500 词预算时封顶 40 词），
放不下时按标题数递减，一段都列不出就退化成一句 `zk_read 读 MEMORY.md` 的指引。需要哪段由 agent
按当前任务决定 —— 装配层拿不到 query，插件也不猜相关性，只保证「被丢掉的东西仍然可发现」。
逐文件 `files[].originalWords` + `formatFileShares()` 让 `doctor` / 设置页能说清预算被谁吃掉。

**周节奏靠注入提醒，不装定时器。** 插件不跑 cron（计划 §11），但模型自己算「过了几天」不可靠，
所以把日期算术机械化：`DREAMS.md` 里写一行 `上次做梦：YYYY-MM-DD`，`buildMemoryPayload` 每步读它，
到期（≥ 7 天）才在载荷末尾加一句「该 zk_lint → zk_dream → 写 DREAMS.md 并更新这一行」。
四种静默/降级：没有 `DREAMS.md` 就说「从未整理过」（**冷启动**：否则这套节奏对从没跑过 `zk_dream` 的库
永远不生效）；有文件没日期行只说「无法判断」（不猜日期）；日期不合法同样只说明；
**整段提醒只在根目录有 `AGENTS.md` 时出现** —— 没采用这套工作约定的库不该每步被催。
这一行**不计入预算**、不参与截断，也不写进 `files` —— 它不是被注入的记忆，是给模型的一个机械提醒。

**条目生命周期（P1-3）。** 只增不减的记忆一定撞上限，撞上之后由三级切分按位置丢弃 —— 那不可审计。
所以 `AGENTS.md` 约定每条写 `结论（YYYY-MM-DD）[[来源路径]]`，退役写 `- [superseded YYYY-MM-DD] 旧结论 → [[新结论]]`，
行留在原处：`zk_lint` 数 `undated` / `retired` / `retiredBroken`，但**不删、不改、不过滤**。
整篇重写会丢掉「这里曾经有过什么、为什么废掉」；退役行是笔记 `supersede + reason + archive` 在记忆层的对应物。
注入仍按文件原文（B 案「过滤退役行」等退役行真的出现、预算压力可测之后再评估）。

**flat 也能有约定（P1-6）。** `flat` 是默认结构，但自动写 `AGENTS.md` 会破坏 M0 的「升级不多一个文件」，
于是默认安装既没有约定、也没有周提醒（提醒只在根目录有 AGENTS 时出现）。改成 opt-in：
`zk-kit init --with-agents`、设置页「写入 AGENTS.md 模板」、`ensureNotebook(..., { withAgents: true })`；
`doctor` 在「有 MEMORY.md 但没有 AGENTS.md」时给一条 ⚠️（不是错误、不翻退出码）。
精简版只保留 flat 下成立的四条规则，路径里不出现 `raw/` / `inbox/` / `archive/` / `WORKFLOW.md`。

**模板版本（P2-15）。** 模板是行为契约，每轮注入；老库的 `AGENTS.md` 停在旧版本时，agent 会一直按旧规则写。
但模板允许用户改，不能自动覆盖 —— 两份模板首行写死 `<!-- zdiary-template: vN -->`，`zk_lint` 读它：
无标记按 v0 算，与 `TEMPLATE_VERSION` 不等就提示「旧版模板」，只报告、不改文件。
提示里**直接带上当前结构对应的新版模板全文**（`template.currentText`），不再让 agent 去找 `docs/features/memory.md`：
插件装进 DSH 后文档躺在 profile 的 `node_modules` 里，工作区外的读取可能被策略拦掉，给路径等于让它多搜几次。
反过来，标记**高于** `TEMPLATE_VERSION` 时（用户升过更新的插件又降级 / 手写了更大的号）照样报，但不给 `currentText`：
那是插件该升级，递旧模板等于让 agent 把规则改回去。
标记固定 4 词、不带日期（带日期实测 6 词，白花 2 词）；改模板时 `TEMPLATE_VERSION + 1`。
