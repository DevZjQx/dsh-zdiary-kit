# memory（长期约定与记忆注入）

**Purpose.** 让 agent 每轮都带着「工作约定 + 用户偏好 + 长期记忆」开始，不用先去翻文件；
注入有硬预算，截断多少必须可观测 —— 否则模型看到的是残缺记忆却不知道残缺。

**Owns.**
- `lib/memory.ts`：读 `<vault>/AGENTS.md` / `USER.md` / `MEMORY.md` → 词数 → 机械截断 → `<system-reminder>` 框
- `app/plugin.ts`：`ctx.inject(['systemPrompt'])` → 注册 `zdiary:memory` 段（order 5200），`text` 是函数，每个 step 重新读文件
- `zk_context` 工具：同一份 payload，给「宿主没有 `systemPrompt`」和「人想核对被截断了什么」用

**Does not own.** MEMORY.md 写什么（agent 按 AGENTS.md 直接改文件，git diff 可审）；
哪些记忆该晋升（语义判断是 agent 的活，插件只做机械截断）；设置页字段（M4 才加，配置键已存在）。

**Depends on.** `config/store`（`memoryBudgetWords`，每次现读）、`node:fs`；
宿主的 `systemPrompt` 服务（可选，没有就只留 `zk_context`）。

**Public surface.** `buildMemoryPayload(cfg)`、`countWords(text)`、`META_FILES`。

**Rejected.** 只在会话开始时注入一次 —— 拒绝：改完 MEMORY.md 要等下一次会话才生效，还得自己实现「这条已经注入过」的去重。
用 `systemPrompt.context()` 而不是 `section()` —— 拒绝：`context()` 会被 `suppressRuntimeContext` 连带关掉，
多一个开关就多一种「记忆静默消失」。依赖 DSH 自动加载 vault 根目录的 `AGENTS.md` —— 拒绝：不成立，
内置加载器只认「项目根 → cwd」链与用户级两份，vault 不在 cwd 祖先链上时完全读不到（见计划 §4 M1）。

**Exceptions.** 中文按 2 字 1 词计（空白切分在中文上严重低估，300 词会变成装饰）；
`AGENTS.md` 是硬规则，单独超预算也不截断，只回显告警；文件内容里的 `</system-reminder>` 会被转义，
不许提前闭合插件自己的框；任何一份文件读不到都当作不存在，笔记本没建好时返回空载荷而不是报错。
