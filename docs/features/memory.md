# memory（长期约定与记忆注入）

**Purpose.** 让 agent 每轮都带着「工作约定 + 用户偏好 + 长期记忆」开始，不用先去翻文件；
注入有硬预算，截断多少必须可观测 —— 否则模型看到的是残缺记忆却不知道残缺。

**Owns.**
- `lib/meta.ts`：meta 文件唯一清单（注入 3 份 / 排除 6 份），memory、zk、settings 共用
- `lib/memory.ts`：读 `<vault>/AGENTS.md` / `USER.md` / `MEMORY.md` → 词数 → 机械截断 → `<system-reminder>` 框；
  另读 `DREAMS.md` 的「上次做梦」一行（不进正文、不计预算）
- `lib/dream.ts`：`lastDreamDate` / `daysSinceDream`（只认整齐的一行，按本地日历天算）
- `lib/agents-template.ts`：`AGENTS.md` 模板（layered 初始化时写入；约 160 词，占默认 300 词的 53%，因为它在预算里且永不截断）
  与 `WORKFLOW.md` 模板（改已有笔记的清单确认 + 三分类；不注入、不计预算，AGENTS 只留一行指针）
- `app/plugin.ts`：`ctx.inject(['systemPrompt'])` → 注册 `zdiary:memory` 段（order 5200），`text` 是函数，每个 step 重新读文件；
  装配上下文带 `agent.id` 时按**会话工作区**解析笔记本（和 `zk_*` 工具同口径），裸装配才退回进程工作区
- `zk_context` 工具：同一份 payload，给「宿主没有 `systemPrompt`」和「人想核对被截断了什么」用
- 设置页「记忆」：注入预算；「目录与 group」：归档目录。快照里带 `memory.words/budget/truncatedWords` 状态行

**Does not own.** MEMORY.md 写什么（agent 按 AGENTS.md 直接改文件，git diff 可审）；
哪些记忆该晋升（语义判断是 agent 的活，插件只做机械截断）；`MEMORY.md` 的写入路径 ——
它由人和 agent 直接编辑，`zk_append` 会拒绝（追加会把记忆变成流水账，也丢掉「谁改的」这条审计线）。

**记忆层与事实层的一致性。** `MEMORY.md` 每条结论后附 `[[来源路径]]`（写进 AGENTS 模板）；
`zk_lint` 的 `memoryLinks` 只做机械核对：原路径 → 加 `.md` → `archive/` 下同名 → 活笔记标题 / 文件名，
旧路径在 `archive/` 下找到同名（或活文件带 `status: superseded`）报 `superseded`，都找不到报 `missing`；
显式写 `archive/` 的链接是有意引用，不算漂移；另数 MEMORY.md 里有多少列表条目没附链接（USER 不计）。
为什么要有：`zk_supersede` 只重写 `zk graph` 里的入链，meta 文件被 `excludedNames` 排除在图外 ——
链接不会跟着搬，`--broken-links` 也看不见。语义重复仍留给 agent，插件不碰。

**Depends on.** `config/store`（`memoryBudgetWords`，每次现读 —— 设置页保存后下一次工具调用就生效）、
`lib/meta`、`node:fs`；宿主的 `systemPrompt` 服务（可选，没有就只留 `zk_context`）。

**Public surface.** `buildMemoryPayload(cfg)`、`countWords(text)`、`META_FILES`（别名 `MEMORY_META_FILES`）、`AGENTS_TEMPLATE`、`WORKFLOW_TEMPLATE`。
`WORKFLOW.md` 不进 `META_FILES`（不注入），只在 `META_NAMES` 里（排除出检索、`zk_append` 拒写）。

**Rejected.** 只在会话开始时注入一次 —— 拒绝：改完 MEMORY.md 要等下一次会话才生效，还得自己实现「这条已经注入过」的去重。
用 `systemPrompt.context()` 而不是 `section()` —— 拒绝：`context()` 会被 `suppressRuntimeContext` 连带关掉，
多一个开关就多一种「记忆静默消失」。依赖 DSH 自动加载 vault 根目录的 `AGENTS.md` —— 拒绝：不成立，
内置加载器只认「项目根 → cwd」链与用户级两份，vault 不在 cwd 祖先链上时完全读不到（见计划 §4 M1）。

**Exceptions.** 中文按 2 字 1 词计（空白切分在中文上严重低估，300 词会变成装饰）；
`AGENTS.md` 模板自己也得守这条预算：初版 310 词，`bun run docs` 里 `zk-kit doctor` 直接报
`✗ 记忆：310/300 词` —— 模板吃掉整个预算，MEMORY.md 就永远被截光，所以压到 160 词（195 词的版本把 USER + MEMORY 压到只剩 105 词）；
`AGENTS.md` 是硬规则，单独超预算也不截断，只回显告警；文件内容里的 `</system-reminder>` 会被转义，
不许提前闭合插件自己的框；任何一份文件读不到都当作不存在，笔记本没建好时返回空载荷而不是报错。

**截断要归因。** 只说「已截断 83 词」等于没说：看的人（和模型）不知道是 AGENTS 太长，最容易把排查方向
带到「注入没挂载」上。所以「确实截断了、且总载荷没超预算」时额外点名
`AGENTS.md 占 120/200 词且不参与截断，留给 USER / MEMORY 的只有 80 词`；
没截断时一个字都不加（不为诊断污染每步的载荷），AGENTS 自己超预算时也不加（「预算不足」那条已经点了名）。
这条只写在 `buildMemoryPayload` 一处 —— 注入、`zk_context`、设置页、`doctor` 读的都是同一份载荷。

**周节奏靠注入提醒，不装定时器。** 插件不跑 cron（计划 §11），但模型自己算「过了几天」不可靠，
所以把日期算术机械化：`DREAMS.md` 里写一行 `上次做梦：YYYY-MM-DD`，`buildMemoryPayload` 每步读它，
到期（≥ 7 天）才在载荷末尾加一句「该 zk_lint → zk_dream → 写 DREAMS.md 并更新这一行」。
四种静默/降级：没有 `DREAMS.md` 就说「从未整理过」（**冷启动**：否则这套节奏对从没跑过 `zk_dream` 的库
永远不生效）；有文件没日期行只说「无法判断」（不猜日期）；日期不合法同样只说明；
**整段提醒只在根目录有 `AGENTS.md` 时出现** —— 没采用这套工作约定的库不该每步被催。
这一行**不计入预算**、不参与截断，也不写进 `files` —— 它不是被注入的记忆，是给模型的一个机械提醒。
