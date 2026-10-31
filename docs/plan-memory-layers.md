# 计划：记忆分层 v0.2（从「日记本」到「agent 自己维护的记忆」）

**状态**：已完成（2026-10-29 评审定稿，同日落地 M0–M4；版本 0.2.0）。评审结论见 §10。基线 0.1.0（7 个 `zk_*` 工具 + 设置页 + 内置 zk）。

> **历史快照（2026-10-31 注）**：本文是 v0.2–v0.5 的实施记录；正文中的测试数（52 / 79 / 86 / 88）、工具数（7 / 10 / 12）、
> 文档命令数（9）与 meta 份数（5）都是各版本当天的数字。当前口径以 README / 代码为准：
> `bun run test` 107 pass / 0 fail，14 个工具，`bun run docs` 17 条，meta 注入 3 份 / 排除 6 份，AGENTS 模板 175 词。
**目标**：让 zdiary 支撑 A-MEM 式「编译而非检索」的知识库——原始材料 → 原子笔记 → 精炼记忆（MEMORY.md），
agent 负责日常 upkeep，人每周审 30 分钟。不用向量库。
**不在本计划内**：重新设计 zk；自动跑 cron 做梦；多用户 / 同步；任何形式的向量或 embedding。

**实施进度**

| 里程碑 | 状态 | 落点 |
|---|---|---|
| M0 结构自举 + 统一排除 | ✅ 2026-10-29 | `structure` / `archiveDir`、layered 目录与三套模板、`excludedNames()` |
| M1 上下文注入 | ✅ 2026-10-29（端到端待验） | `lib/memory.ts`、`zdiary:memory` 段（order 5200）、`zk_context` |
| M2 记忆读写 | ✅ 2026-10-29 | `zk_query` / `zk_supersede`、`NoteRecord.metadata`、撞名报错、`lib/frontmatter.ts` |
| M3 巡检与做梦 | ✅ 2026-10-29 | `lib/lint.ts` / `lib/dream.ts`、`zk_lint` / `zk_dream`、`zk-kit lint|dream|query` |
| M4 设置页与文档 | ✅ 2026-10-29 | 设置页结构/预算/归档 + 补建按钮、`AGENTS_TEMPLATE`、`zk_append` 拒写 meta、`zk_stats` 归档计数、`scripts/docs.ts` |

当前测试：`bun run test` 52 pass / 0 fail（zk 0.15.7）；`bun run smoke` 通过（12 个工具 + 7 项自检）；
`bun run docs` 把 README 里 9 条 `zk-kit` 命令在临时 vault 上真跑通。

---

## 1. 已确认的 zk 事实（实测 zk 0.15.7，2026-10-29）

这 12 条是整个计划的地基，全部在本机用临时 vault 复现过。**实施时任何一条被推翻，都要回来改本文件。**

| # | 事实 | 影响 | 对策 |
|---|---|---|---|
| Z1 | 配置只认 `<vault>/.zk/config.toml`，模板只认 `.zk/templates/` | 根目录 `config.toml` / `_templates/` 全部无效 | 自举时写进 `.zk/`；文档里不出现 `_templates/` |
| Z2 | `--group` 只选配置，**不改创建目录**：`zk new --group daily` 把笔记建在 vault 根 | 日记层会整个空掉 | 创建时永远显式传目录（`zk new <dir>`），group 用 `paths` 自动匹配 |
| Z3 | filter 是**位置参数**：`zk list stale`；`--filter` 不存在 | 文档里的 `--filter` 全废 | filter 只在人类终端用；工具侧直接拼 flag |
| Z4 | `-x` 按**路径前缀**匹配、含子孙（`-x notes` 与 `-x notes/concepts` 都生效），但 glob 无效（`-x 'archive/**'` 会漏）；且 `-x` 是**相对 cwd** 解析的，不是相对 `--notebook-dir` | 排除会静默失效，孤儿/陈旧检查全库化；插件在任意 cwd 下跑，相对名会时灵时不灵 | 一律传**绝对路径**（`path.join(cfg.notebook, name)`），不传 glob；2026-10-29 实测：cwd 不同，`-x AGENTS.md` 在另一个目录下命中不到 |
| Z5 | `--match` 不索引 frontmatter（`keywords: [...]` 命中 0） | A-MEM 的 keywords 字段对检索无用 | frontmatter 只做 `metadata` 供 agent 判断；要检索的词必须出现在正文 |
| Z6 | `--format json` 把 frontmatter 原样放进 `metadata` | status/type/authority 可被工具层过滤 | `NoteRecord` 增加 `metadata`，过滤在 JS 里做 |
| Z7 | 根目录的 `AGENTS.md` / `MEMORY.md` 会被当普通笔记索引，`-m` 能命中 | agent 搜「SQLite」会搜到 MEMORY.md 本身 | 工具侧固定排除 meta 文件（`-x`），见 §7 |
| Z8 | `zk new` 遇到已存在文件：exit 0、**内容不写**、只回显路径 | 文件名撞名会静默丢失内容；flat 的随机文件名不会撞，但标题重复会绕过它 | 标题查重（flat）+ 建前目录快照，撞名直接报错 |
| Z9 | 模板里没有 `{{content}}` 时，stdin 的正文被丢弃 | 草案里的模板都没写 `{{content}}`，照抄会集体丢正文 | 所有模板必须含 `{{content}}`（M0 的断言） |
| Z10 | `zk init` 生成的 `[note] filename` 默认是 `{{id}}`（随机 4 字符，实测 `0tup.md`），不是 slug；`{{slug title}}` 对中文出拼音（实测「中文 标题 测试」→ `zhong-wen-biao-ti-ce-shi`）；`[group.X.note] filename` 按目录匹配也会生效，不必传 `-g` | 不显式配文件名，笔记就是随机名，文件名撞名（Z8）不会发生 | layered 的每个 group 都写 `filename = "{{slug title}}"`；flat 保持 `{{id}}`（与 0.1.0 逐字节一致），标题重复由 `createNote` 按标题查重兜住 |
| Z11 | 双链是**路径式**：`zk_link` 写的是 `[[notes/concepts/slug]]`（相对笔记本、去扩展名），不是 `[[标题]]`；外部 rename 后索引会被 CLI 自动追平（实测 0.15.7 小 vault，无需手动 `zk index`） | 笔记一 move，路径式入链可能断（不要依赖 zk 按 stem 解析），`--broken-links` 会报出来 | supersede 重写能精确匹配的入链，其它写法列 `missingLinks`；不要指望 reindex 能修断链 |
| Z12 | `--match` 用的 FTS5 unicode61 不切中文，中文整句命中 0；工具层靠「0 命中退回 `-M re`」兜底 | 中文正文召回**不完整且静默**——有部分命中时不会退回正则 | 中文笔记必须打 tags；正文匹配只算 best-effort，不能当唯一检索路径 |

补充两条实测细节：
- `[group.X.extra] type = "entity"` + 模板 `type: {{extra.type}}` 可用 → concept / entity / pattern 三类共用一套 `entry` 模板。
- 别名是 `$SHELL -c "zk ..."` 执行，依赖 PATH；agent 走 `zk_*` 工具直连二进制（按 config → env → PATH → managed 解析），不经过别名，所以**别名对 agent 无意义**，只服务人手敲。

M2 期间新确认的三条（2026-10-29）：
- `zk new --extra key=value` 可用，且 CLI 的 extra 优先于 `[group.X.extra]`（实测 `authority` 被覆盖成 `informal`）。
- `zk graph --format json` 的 `links[]` 带 `sourcePath` / `targetPath`（笔记本相对）与 `snippetStart/End`，可直接定位入链；但 **`targetId` 会随重索引变化**（同一篇从 1 变成 4），所以不能在两次调用之间缓存 id，按路径比对。
- `zk graph --link-to X` 并**不**只返回「链接到 X 的笔记」：X 自己的出链也在结果里，`notes` 与 `links` 都不过滤。要么自己按 `targetPath` 过滤，要么别用这个 flag。

---

## 2. 目标形态

```
<vault>/
├── .zk/{config.toml, notebook.db, templates/}   # zk 私有，插件只追加 group
├── AGENTS.md      # 运行手册（人写、agent 读）
├── MEMORY.md      # 精炼长期记忆（agent 写、人审，预算内）
├── USER.md        # 稳定偏好（人写）
├── DREAMS.md      # 巡检/做梦报告（agent 追加，人裁决）
├── INDEX.md       # 总索引（>150 条才建，纯文本不生成双链）
├── raw/           # 原始材料，只读，永不改名/删除
├── inbox/         # 隔离区：还没想好归属的碎片
├── daily/<date>.md        # 日记层（cfg.dailyDir）
├── notes/{sources,concepts,entities,patterns}/
└── archive/       # superseded 的笔记搬到这里（不删）
```

**数据流**（agent 的三个动作 + 人的一个动作）：

```
raw/ ──ingest──► notes/sources ──link──► notes/{concepts,entities,patterns} ──dream──► MEMORY.md
daily/ ────────────────────────────────┘                        │
                                                                 ▼
archive/ ◄── supersede ◄── lint ◄────────────────────────── DREAMS.md（人审）
```

---

## 3. 关键决策（含被拒方案）

**D1. 结构模式并存，默认不变形。**
新增配置 `structure: "flat" | "layered"`（默认 `flat`，与 0.1.0 行为完全一致）。`layered` 才建 `raw/inbox/notes/*/archive`
与 3 套模板（daily / source / entry，覆盖 5 个 group）。理由：已有用户的 vault 不能被升级悄悄改结构；新建用户想要分层就一次选好。
被拒：直接把默认改成 layered —— 会在老 vault 里造出一堆空目录和没人用的模板；等 layered 被真实 vault 跑过一个周期再翻默认，A→B 只是改默认值，B→A 要动用户数据，成本不对称。

**v0.3 翻转条件**（三条全满足才翻，缺一条不翻）：
1. 一个 minor 周期内，layered vault 连续跑满 4 周；
2. `zk_lint` 无新增结构类告警（断链 / 孤儿不因 layered 上升）；
3. archive / supersede 相关 0 bug。

设置页的结构模式**以配置为准**：`ensureNotebook` 按配置建目录，磁盘状态只用来显示「与配置不一致」。反过来（以目录为准）会把用户删掉 `raw/` 变成一次自举博弈 —— 设置页显示 flat、配置仍是 layered、下次 `ensureNotebook` 又把目录建回来。翻默认的安全性改由 §8 的迁移保证：0.2.0 读到老配置时把 `structure` **显式写成 `flat`**，所以「缺省 = flat」只对首次创建生效。

**D2. 排除逻辑放工具层，不写进 config.toml。**
`[note]` 和 `[filter]` 这些表在 `zk init` 生成的默认配置里已经存在，再追加一次是重复 TOML table，
不同解析器行为不一致。插件所有查询统一由 `lib/zk.ts` 拼 `-x`（传路径/文件名，见 Z4），
人类终端用 `zk-kit` 子命令，不用记 flag。
被拒：往 config.toml 里塞 `exclude` —— 为了省几个字符，换来一个「用户手改后整份配置解析失败」的隐患。

**D3. frontmatter 用 zk 原生 `date` 键，不用 `created`。**
默认 `creation-date-key` 就是 `date`，改键名要配 `[format.markdown.frontmatter]` 并重建索引。
被拒：沿用草案的 `created` —— 多一处配置依赖，收益为零。

**D4. supersede = frontmatter 标记 + 搬进 archive/。**
`status: superseded` 是给人和 agent 看的记录，但 zk 不能按它排除查询（`--tag` 不能取反）。
所以同时把文件 `fs.rename` 到 `archive/`，查询统一 `-x archive`。git 里历史完整，
不构成"物理删除"。
实现约束（Z11 决定，不是可选项）：改 status → `zk graph --format json` 取反链 → 重写入链 → move，
每步幂等可重放（例外：frontmatter 已写、`rename` 失败时，重试会走 `alreadySuperseded`，需要人工把文件搬进 archive/），`dry_run` 一次输出全部受影响路径。文件系统与 SQLite 无法真原子，所以要求是「单次工具调用 + 可重放」。
索引不用显式重建（Z11 实测会自动追平）；大 vault 上仍可补一次 `zk index` 当保险，但它不是正确性前提。
archive 内**保留原相对路径**（`archive/notes/concepts/x.md`），否则不同子目录的同名 slug 会在 archive 撞名。
查询默认不含 archive，但保留 `include_archived` 逃生口（单独传它时不再默认卡 `active`），否则 `superseded-by` 校验与复查旧结论都会失败。
被拒：只改 frontmatter —— 废弃笔记会永远混在检索结果里，agent 会反复引用死结论。

**D5. 插件只做机械活，语义判断留给 agent。**
`zk_lint` 只返回清单（孤儿/断链/陈旧/重名/无标签），不改任何笔记；`zk_dream` 只返回候选与评分材料
（本周新增、被引用次数、daily 未完成项），**不写 MEMORY.md**。写 MEMORY.md、写 DREAMS.md 由 agent 按 AGENTS.md 执行。
理由：插件做语义判断 = 把不可审计的逻辑塞进代码；agent 做 = 每次都有 DREAMS.md 和 git diff 可查。

**D6. 注入预算 500 词（可配）；初版 300 不够用，已上调（2026-10-30）。**
预算按**总载荷**算（AGENTS + USER + MEMORY），不是只卡 MEMORY.md —— 只卡一份的话，AGENTS.md 写长一点预算就形同虚设。
超预算时注入侧截断并提示"需要先压缩"，而不是让模型自己数。

初版定 300，理由是 500 词 ≈ 700–800 token、每会话注入偏重，宁小勿大。实跑下来 300 不够用：
`AGENTS.md` 模板本身就约 160 词且**永不截断**，留给 USER + MEMORY 的只剩 140 词 ——
一份偏好清单加几条带 `[[来源]]` 的结论就见底，截断从「异常」变成常态（模板初版 310 词时 `doctor` 直接报
`✗ 记忆：310/300 词`）。截断一旦是常态，目录提示每轮都在，记忆层反而收不到「该压缩了」的信号。
所以把默认值提到 500：500 词 ≈ 700–800 token 对「每轮都带长期记忆」是合理代价，预算仍是硬约束、仍可配；
宁小勿大依然成立，只是 300 已经小于「够用」。

实现口径：
- 预算 = 设置项 `memoryBudgetWords`，默认 500，不写死；老配置里显式存过 300 的继续按 300 走（配置是权威值，不覆盖用户已有设置）；
- 超限丢弃顺序**纯机械，不做相关性判断**（那正是 D5 禁止插件做的事）：截 MEMORY 尾部（按 `##` 整段丢）→ 仍超限再截 USER 末尾整段 → **永不截 AGENTS 的硬规则**。都超限就保留 AGENTS + 两份文件的首段并告警；
- 中文按「1 词 / 2 字」计。现有 `words` 是空白切分（`noteFromDisk`），中文严重低估，300 这个词数在中文 vault 上会变成装饰；
- 截断必须回显「已截断 N 词」——这条提示本身就是「该调晋升门槛」的信号，没有它预算不可观测。

**D7. 一切"批量改"都先出清单。**
`zk_supersede` 默认 `dry_run: true`，返回受影响路径；要真改必须显式 `dry_run: false`。
`zk_dream` / `zk_lint` 只读，没有 dry_run 参数——不给只读工具留"看起来能写"的开关。
被拒：直接改 —— 一句 "update the wiki" 就能让全库漂移，这是实践者最常见的翻车方式。

---

## 4. 分期

### M0 基座：结构自举 + 统一排除

范围
- `Config` 增加 `structure`、`memoryBudgetWords`（默认 500，管 AGENTS+USER+MEMORY 的**注入总载荷**；CJK 按 1 词/2 字计）、`archiveDir`（默认 `archive`）。
- `ensureNotebook` 支持 layered：建目录、写 3 套模板（`daily` / `source` / 共用的 `entry`，concept / entity / pattern 都走 entry）、
  追加 `[group."<name>"]` 段（只追加 group，不碰其它表）。
- 模板一律含 `{{content}}`；`type` 由 `[group.X.extra]` 注入。
- 工具侧统一排除见 §7（单个常量，别在 M0 再抄一份）。

产出 / 验收
- 集成测试：临时目录跑两次 `ensureNotebook(layered)` → 目录与模板齐全、第二次零改动。
- 断言：每个模板都含 `{{content}}`；用模板建的笔记 frontmatter 有 `type/title/date` 且正文在。
- 断言：`zk list` 结果里没有 `.zk/templates/*`、没有 meta 文件。
- flat 模式下行为与 0.1.0 逐字节一致（回归）。跑 `bun run test`：它自己解析 zk，且 skip > 0 直接失败（见 `scripts/test.ts`）。

风险：`[group.X.extra]` 若在旧 zk 版本不支持，退化为每个 type 各一份模板（5 个 group 各一，内容相同，只差 `type` 字面量）。

**实现状态（2026-10-29）**：已落地 —— `structure` / `archiveDir` 进配置（老配置首次读取时把默认值写回文件）；
layered 建 7 个目录 + 3 套模板 + 5 个 group；`excludedNames()` 一个常量被检索与统计共用（绝对路径）。
`bun run test` 24 pass（flat 无回归、layered 模板带 `type/title/date` 且正文在、meta 与 raw 不进检索/统计）。

### M1 上下文注入（spike 已完成：能注入）

**Spike 结论（2026-10-29，读 dsh `v0.2.2-alpha.2` 源码）：能注入。**

| 通道 | 出处 | 语义 | 用途 |
|---|---|---|---|
| `ctx.systemPrompt.section({ name, order, text })` | `packages/core/system-prompt` | `text` 可以是函数，每次 `assemble()`（每个 step 一次）重新求值；进系统提示，**不写会话历史** | **M1 首选**：三份 meta 每步重读，天然没有重复注入问题 |
| `agent/pre-step` 瀑布 + 自建 `source.kind` 的 user 消息 | `packages/context/agent-instructions`、`time-context` | 消息进历史，可回放/压缩；`MessageSourceMap` 是 merge-extensible，第三方可自报 kind | 需要「记忆出现在第几轮」可审计时 |
| `ctx.inject(['systemPrompt'], cb)` | `vendor/cordis` | service 就绪后回调；宿主没挂 system-prompt 时回调不跑，插件其余部分不受影响 | 挂载方式（别靠加载顺序） |

补充事实：
- 外部贡献可以用任意有限 `order`（内置段位 −1000…10200，见 `SECTION_ORDERS`），不必占仓库保留位。
- `systemPrompt/change` 事件存在，注册/销毁会触发重装配；配置变更时重注册即可，不必自己缓存。
- 记忆走 `section()` 而不是 `context()`：`context()` 的条目会被 `suppressRuntimeContext` 关掉（除非 `required: true`），
  多一个开关就多一种「记忆静默消失」的可能；`section()` 没有这个开关。

**AGENTS.md 不会被自动加载（对 vault 而言）。** DSH 内置 `dsh-agent-instructions`（`dsh-base` 默认挂载，每条链 65536 字节）只加载两条链：
用户级 `$DSH_HOME/AGENTS.md` → `~/.agents/AGENTS.md`；项目级从「项目根（默认以 `.git` 为标记）」到「会话 cwd」逐层的 `AGENTS.md` / `CLAUDE.md`
（外加 `.local` 覆盖）。vault 根目录不在会话 cwd 的祖先链上时完全不加载；vault 不是 git 仓库时「项目根」还会落到 vault 之外。
→ 三份 meta 由插件自己读、自己注入；宿主自动加载只当额外福利。`zk_context` 仍然做，服务「注入不可用的宿主 + 人手动看」。

**尚未端到端验证**：以上是源码层证据。真实 DSH 会话里「首轮就能引用 MEMORY.md」还要装好插件跑一次，才算 M1 验收通过。

范围（按结论收敛）
- 注入：`ctx.inject(['systemPrompt'], …)` → `section({ name: 'zdiary:memory', order: 5200, text: () => payload() })`；
  payload 读 `AGENTS.md` + `MEMORY.md` + `USER.md`，按 `memoryBudgetWords` 截断；文件缺失或为空 → 返回空串（不是 `undefined`）。
- 宿主没有 `systemPrompt` → 只有 `zk_context`。两者共用同一个 payload 渲染函数，不写两份。
- `/zk brief` 斜杠命令降级为可选，不进验收（与本次 spike 无关，不承诺宿主支持）。
- meta 文件位置：仍在 vault 根；文档不许写「DSH 会自动加载 AGENTS.md」。

产出 / 验收
- 新建会话问"我们上次为什么选 SQLite？"，模型第一轮就能引用 MEMORY.md 里的条目。
- 断言：payload 在 `MEMORY.md` 缺失时返回空串、不抛错；超预算时按 D6 的机械顺序截断并带「已截断 N 词」。
- 断言：`systemPrompt` service 不存在时插件照常 apply，`zk_*` 工具全部可用。

风险：注入通道本身已确认存在；剩余风险是「模型看到了但没用」——属于提示词问题，不是可行性问题。

**实现状态（2026-10-29）**：已落地 —— `lib/memory.ts`（词数 / 机械截断 / `<system-reminder>` 框 / 转义）、
`app/plugin.ts` 的 `ctx.inject(['systemPrompt'])` 注册（order 5200，`text` 为函数）、`zk_context` 工具（不 `ensureNotebook`）。
测试覆盖：中文词数、三份缺文件、顺序、超预算截断回显、AGENTS 不截断、注册与无 service 降级。**端到端（真实 DSH 会话首轮引用）未验证。**

### M2 记忆读写（工具层）

范围
- `NoteRecord` 增加 `metadata`（来自 Z6）、`status`、`type`、`authority`。
- `zk_new` 增加 `type` / `authority` / `dir` / `group`（实现上 type/authority 走 `--extra key=value`，模板读 `{{extra.*}}`）；撞名检测（Z8）。
- 新工具 `zk_query`：结构化检索（query / tags / dirs / since / until / type / status / orphan / brokenLinks / sort / limit / include_archived），
  status/type 在 JS 层过滤（Z6）。
- 新工具 `zk_supersede`：改 `status` + 写 `superseded-by` + 重写入链 + 搬进 archive（保留原相对路径）；默认 dry_run，索引按 Z11 不用手动重建。
  `superseded-by` 指向的是**搬走后的新路径**，写之前先确认目标 note 处于 active。
- 新工具 `zk_context`：读三个根文件（M1 的回退，也给人用）。
- `zk_link` 增加"目标必须存在"检查（现在已通过 findNote 间接保证，改成显式报错更清楚）。

产出 / 验收
- 测试（layered）：同一标题建两次 → 第二次明确报错，第一篇内容不变。
- 测试：supersede 后，`zk_query({status:'active'})` 查不到它，`archive/` 里能找到，git status 显示 rename。
- 测试：supersede 前后 `zk_lint.brokenLinks` 计数不增加（入链在同一调用里被重写）。
- 测试：排除清单生效（meta 文件与 `raw/inbox/archive` 不出现在 `zk_query` 结果里）。

**实现状态（2026-10-29）**：已落地。落点与实现口径：
- `NoteRecord` 增加 `metadata/status/type/authority`（`toRecord` 直取 Z6 的 `metadata`；`noteFromDisk` 用 `lib/frontmatter.ts` 解析，老笔记也能读出 status）。
- `zk_new` 增加 `type` / `authority` / `group`（`--extra`）；撞名用「建前标题查重（flat）+ 目录快照 + 建后比对 basename」判定，命中即 `ZkError`；`zk_new` 不再返回警告而是当场失败。
- `zk_query`：`status` / `type` 在 JS 层过滤；带这两个过滤时先 `--limit 200` 多取再截断（否则「前 10 条里没有 active」会假空）。
  **`status` 缺省按 `active` 算**（`include_archived: true` 且未显式给 status 是例外）—— 0.1.0 的老笔记没有 frontmatter，不兜的话 flat vault 查 `status: active` 一条都返回不了。
- `zk_supersede`：`dry_run` 默认 true；顺序 = 重写能精确匹配的入链 → 改 frontmatter（`status: superseded` + `superseded-by`）→ `rename` 进 `archive/` 原相对路径；
  入链来自一次 `zk graph`（按 `targetPath` 比对，不用 `targetId`）；写法不是 `[[旧路径]]` 的入链不猜，进 `missingLinks` 交给人；已 superseded 直接返回、正常路径重放幂等（rename 失败见 D4）。
- `zk_link` 目标不存在时附「最像的 3 篇」提示。
- 测试新增 9 条（frontmatter 4 + M2 5），25 → 34 pass；smoke 增加到 10 个工具。

### M3 巡检与做梦（只报告）

范围
- 新工具 `zk_lint`：一次返回 `{orphans, brokenLinks, stale, tagless, duplicateTitles, missingBacklink}`，每项最多 50 条 + 总数。
- 新工具 `zk_dream`：输入窗口（默认 7 天），返回
  `{ newNotes, dailyLooseEnds, topCited, rejected: [{path, reason}] }`；被引用次数用 `zk graph --format json` 一次算完（实测顶层就有 `links` 边数组，含 `sourceId/targetId`，不用解析正文）。
- `zk-kit` CLI 增加 `lint` / `dream` / `query`，人类终端不用拼 zk flag。
  `zk-kit query -- <zk list 任意参数>` 支持透传，但**禁/覆盖**会破坏不变量的参数：`--notebook-dir`、`--format`、`--exclude / -x`（由 zk-kit 注入），否则「统一排除」被一条透传绕过。

产出 / 验收
- 在一个 200 条笔记的合成 vault 上，`zk_lint` 在 3 秒内返回（不能对每条笔记跑一次 zk）。
- `zk_dream` 的输出能被 agent 直接改写成 DREAMS.md 的三栏格式（晋升/拒绝/flag）。
- 断言：两个工具都不写任何笔记（dry-run 语义由工具保证，不是靠提示词）。

**实现状态（2026-10-29）**：已落地 —— `lib/lint.ts`（6 个桶 + 重名分组 / 标题归一化）、
`lib/dream.ts`（窗口 / 机械拒绝 / Loose ends 解析 / 入链计数）、两个工具与三个 CLI 子命令。
计划里没写死、这里定下来的口径：

- **调用次数**：lint = 1 次 `zk list --format json` + 4 次原生过滤器（`--orphan` / `--broken-links` /
  `--missing-backlink` / `--tagless`），**顺序执行**（并发进程会同时补索引、撞 SQLite 写锁）；
  路径格式用 `{{absPath}}` 而不是 `{{path}}`（后者相对 cwd，Z4 同款坑）。
- **陈旧的阈值**：`stale_days` 默认 90。zk 的 `stale` **不是**内置过滤器（只在你自己的 `[filter]` 里定义过才存在），
  所以由插件按 `modified` 在 JS 里算，不赌用户配置。
- **扫描上限要说话**：一次最多扫 10000 篇，到顶时结果带 `truncated: true` 并在文本里告警 —— 静默截断比慢更糟。
- **日记不算噪音**：`orphans` 与 `tagless` 排除 `cfg.dailyDir`（日记按天写，天然没入链没标签）；
  `brokenLinks` / `missingBacklink` 仍包含日记 —— 那里出错是真问题。
- **dream 的拒绝规则只有两条**（`authority=informal`、无标签），日记不进候选/拒绝，未完成项单独一栏；
  再加规则就是语义判断，违反 D5。
- **`zk-kit query` 透传**：丢掉 `--notebook-dir` / `-W` / `--format` / `-x|--exclude` / `-q` / `-P` / `--json` / `--help`
  连同它们的值，再注入自己的排除与 `--format json`；只保留查询条件（`-m` / `-t` / `--limit` / `-s` / 日期 / 位置参数）。
  0 命中且给了 `-m` 时退回 `-M re`（中文召回，Z12）；用户自己写了 `-M` 就尊重用户。
- 测试新增 8 条（lint / 只读快照 / dream / 解析 / 透传 3 / 性能），34 → 42 pass；smoke 增加到 12 个工具。

### M4 设置页与文档

范围
- 设置页新增：结构模式（flat/layered）、注入预算（词，管三份 meta 的总载荷）、归档目录；layered 未初始化时给"一键初始化分层结构"按钮。
- 危险操作二次确认：切 flat→layered 只建目录不搬文件，弹窗里明确说这句。
- `docs/features/memory.md`（Purpose/Owns/Rejected 体例）、README 增加"记忆分层"一节、AGENTS.md 模板随插件分发。
  AGENTS.md 模板必须写清三件事：检索词归宿规则（值得检索 → tags 或正文；不值得 → 不存在）、
  中文笔记必须打 tags（Z12：中文正文召回不完整）、以及"插件不保证自动加载本文件"（M1 结论回填）。

产出 / 验收
- 设置页保存 → 下一次工具调用立刻生效（沿用现在"每次现读配置"的做法）。
- 设置页的结构模式读配置；与磁盘不一致时（例如 `structure: layered` 但没有 `raw/`）显示告警 + 底部「初始化 / 补建」按钮，**不自动改配置、不自动删目录**。
- 文档里每个命令都能在临时 vault 上跑通（docs 里的代码块进 smoke 脚本）。

**实现状态（2026-10-29）**：已落地。计划没写死、这里定下来的口径：

- **设置页字段**：结构模式用 `select`（`FIELDS` 增 `kind/options`，枚举值不接受手打），注入预算与归档目录是普通输入；
  保存后下一次工具调用立刻生效（配置每读一次都走 `config()`，本来就没有缓存）。
- **flat → layered 的确认**：保存前 `window.confirm` 列清楚要建哪些目录/模板，并明确「**不会**移动、改写或删除任何已有笔记」；
  真正建目录仍要再点一次「初始化 / 补建」（= 同一个 `POST /init`），避免「保存即动磁盘」。
- **结构一致性**：`structureStatus(cfg)` 只读（配置为准，磁盘只用来算 `missing`），快照里返回
  `structure: { mode, dirs, missing, ready, agents }`；缺目录或缺 `AGENTS.md` 时状态行下面出现告警 + 补建按钮，
  **不自动建、不自动删、不改配置**。自检新增「结构」与「长期记忆」两项（7 项）。
- **AGENTS.md 模板**：放 `lib/agents-template.ts`，只在 layered 且文件缺失时写入（flat 一个文件都不多，守住 M0 回归）。
  初版 310 词，`zk-kit doctor` 当场报 `✗ 记忆：310/300 词` —— 模板自身在预算里且永不截断，等于把 MEMORY 挤成零，
  压缩到 147 词（当时默认 300 词，留 150 词给 USER + MEMORY）后才通过。这条只有真跑才能发现；
  也正是这次实跑暴露了 300 不够用，最终在 D6 修订里把默认值上调到 500。
- **`zk_append` 拒写 meta**：根目录五个 meta 文件一律拒绝（子目录同名文件照常）；理由写进 hint。
- **`zk_stats` 归档计数**：`archived` 扫 archive/ 磁盘（归档区被索引查询排除），`superseded` = 归档区 frontmatter +
  非归档区里手工标了 status 的笔记；不额外起进程的方式是复用 `allNotes` 与一次目录遍历。
- **文档可跑**：新增 `scripts/docs.ts`，扫 README 与 `docs/features/*.md`，**整块都是 `zk-kit` 命令**的代码块逐条真跑
  （临时 vault、layered 初始化）；路径占位（`<路径>`）与下载类命令（`install`）放进表格，不进可跑清单。
  `bun run smoke` 末尾带它（`bun run docs` 可单跑）。
- **meta 清单去重**：新增 `lib/meta.ts`（注入 3 份 / 排除 5 份），`lib/zk` 与 `lib/memory` 共用 —— 不再各写一份字符串数组。
- **截断归因（D6 的补完）**：模板 310 词那件事暴露了 D6 的缺口 —— 只回显「截断 N 词」不说是谁吃掉的，
  排查方向会跑到「注入没挂载」。现在「确实截断 + 总载荷没超 + AGENTS 占一半以上」时点名
  `AGENTS.md 占 N/M 词且不参与截断，留给 USER / MEMORY 的只有 K 词`；没截断不加、AGENTS 自己超预算也不加（不重复）。
  只写在 `buildMemoryPayload` 一处，注入 / `zk_context` / 设置页 / `doctor` 同时受益。

---

## 5. 工具清单（v0.2 结束时）

| 工具 | 状态 | 说明 |
|---|---|---|
| `zk_search` | 改 ✅ | 加 `type/status` 过滤；结果带 metadata；固定排除 meta 文件 |
| `zk_read` | 改 ✅ | 支持读 meta 文件（按路径直读，绕过索引） |
| `zk_new` | 改 ✅ | 加 `type/authority/group`；撞名报错；模板必含 content |
| `zk_append` | 改 ✅ | 拒写 meta 文件（AGENTS/MEMORY/USER/DREAMS/INDEX/WORKFLOW）；子目录同名文件照常 |
| `zk_daily` | 不变 | 继续用 `ensureDailyNote` 的目录快照判断新建 |
| `zk_link` | 微调 ✅ | 目标不存在时给出候选建议 |
| `zk_stats` | 改 ✅ | 增加 `archived` / `superseded` 计数（归档区靠磁盘扫，索引里查不到） |
| `zk_query` | 新 ✅ | 结构化检索，agent 的主查询入口 |
| `zk_context` | ✅ 已完成 | 读 AGENTS/MEMORY/USER，按预算截断（与注入共用 payload） |
| `zk_lint` | 新 ✅ | 只报告，不改写 |
| `zk_dream` | 新 ✅ | 只报告，不改写 |
| `zk_supersede` | 新 ✅ | 默认 dry_run，改状态 + 重写入链 + 归档 |

> M0/M1/M2 已落地的部分：`zk_search` / `zk_stats` 带统一排除（`excludedNames`，绝对路径）；
> `zk_context` 已上线；`zk_read` 已能直接读 meta 文件（不进索引，走磁盘）；
> `zk_query` / `zk_supersede` 已上线；`zk_new` 已带 type/authority 与撞名检测；`zk_lint` / `zk_dream` 已上线（M3）。

---

## 6. 模板与配置契约

`entry.md`（concept / entity / pattern 共用；`type` 由 group extra 给，source 另有自己的模板以保留 Key claims / Quotes）：

```markdown
---
type: {{extra.type}}
title: {{title}}
date: {{format-date now "%Y-%m-%d"}}
status: active
authority: {{extra.authority}}
tags: []
---

# {{title}}

## Summary

## Content

{{content}}

## Links
```

`zk_link` 认 `## Links` 与 `## 链接` 两种小节标题，新写入一律用 `## Links`；链接追加在文末，已有小节时不再重复起标题（不保证插进该小节内部）。

`authority` 的层级：group 只给默认值，具体来源的评级由 `zk_new` 传 `--extra authority=informal` 覆盖（CLI 的 extra 优先于 `[group.X.extra]`，实测可用）。

`format-date` 吃的是 strftime 格式（`%Y-%m-%d`），不是 Go 的 `2006-01-02`——写错会原样输出 `2006-01-02`，日期过滤全废（实测）。

`daily.md`：在 0.1.0 版本基础上加三节 `Events / Observations / Loose ends`，保留 `{{content}}`。

group 声明（只追加新表，不动已有表）：

```toml
[group."concept"]
paths = ["notes/concepts"]
[group."concept".note]
template = "entry.md"
filename = "{{slug title}}"
[group."concept".extra]
type = "concept"
authority = "expert"
```

5 个 group（daily / source / concept / entity / pattern）都按这个形状追加，差别只有 `paths`、`template` 与 `extra`；
`authority` 默认值：source / entity = `official`，concept / pattern = `expert`（`zk_new` 可覆盖）；
`filename` 一律 `{{slug title}}`，只有 daily 用日期模板（Z10：不写这行，笔记就是随机 id）。

**实现落点（2026-10-29）**：模板常量在 `lib/notebook.ts`（`DAILY_TEMPLATE_LAYERED` / `SOURCE_TEMPLATE` / `ENTRY_TEMPLATE`），
`ensureNotebook` 只在文件缺失时写入（用户改过的不覆盖）；5 个 group 由同一个 `groupSection()` 生成，只追加缺失的。
测试断言：三套模板都含 `{{content}}`；`entry.md` 建出的笔记带 `type/title/date` 且正文在；第二次调用 `dirsCreated` / `templatesWritten` / `groupsAdded` 全空。

---

## 7. frontmatter 数据契约

| 字段 | 谁写 | 谁读 | 取值 |
|---|---|---|---|
| `type` | 模板/group | `zk_query` 过滤、agent | daily / source / concept / entity / pattern |
| `date` | 模板 | zk 自带 `--created-*`（默认日期键） | YYYY-MM-DD |
| `status` | 模板（`active`）/ `zk_supersede`（`superseded`） | `zk_query` 在 JS 层过滤（Z6） | active / superseded；**缺省视为 active**（0.1.0 老笔记没有该字段） |
| `authority` | group extra 给默认值，`zk_new` 可覆盖 | `zk_dream` 拒绝规则 | official / expert / informal |
| `superseded-by` | `zk_supersede` | 人、agent | `[[path]]` |
| `tags` | zk（唯一可查询维度） | `zk_search --tag` | 短横线小写 |

固定排除清单（所有查询都带）：`raw`, `inbox`, `cfg.archiveDir`, `AGENTS.md`, `MEMORY.md`, `USER.md`, `DREAMS.md`, `INDEX.md`。
工具层只放**一个常量**（`lib/zk.ts` 的 `excludedNames`），所有查询路径共用；一律传绝对路径（Z4：`-x` 相对 cwd 解析），不传 glob。

检索词的归宿规则（写进 AGENTS.md）：
- 值得检索 → 写进 `tags` 或正文；
- 不值得检索 → 不存在；
- 中文笔记**必须**打 tags —— Z12 下中文正文召回不完整，只靠正文会得到"这条笔记不存在"的假阴性，然后新建重复笔记；
- 这个故障最难排查，因为它看起来像正常工作流，所以不给 `keywords` 留任何位置。

meta 文件放根目录的理由：AGENTS.md 在根目录是给人和其他工具（Codex 等）看的约定；但 **DSH 不会自动加载 vault 根目录的 AGENTS.md**
（M1 结论：只认项目根→cwd 链与用户级两份），所以根目录只剩「人和别的工具能看见」这点价值，读路径一律走插件自己读。

---

## 8. 迁移与兼容

- 0.1.0 → 0.2.0：默认 `flat`。读老配置时 `structure` 缺省按 flat 处理，并**立刻把 `flat` 写回配置文件**（连同 `memoryBudgetWords: 300`、`archiveDir: "archive"`）。这样配置始终是权威值：v0.3 翻默认时老 vault 一个字段都不会变，「缺省」只服务首次创建。
  （2026-10-29 已实现：`config()` 读时补写；测试断言 `structure` 真的落盘。）
- 切到 layered：只建目录与模板；**绝不移动已有笔记**（`notes/` 下的老笔记留在原地，仍然可搜可读）。
- 不做"按 `type` 自动归类"：0.1.0 的老笔记没有 `type`（模板到 v0.2 才带），自动归类对它们无处安放，最后还是人兜底。
  遇到时再挪本身就是一次再评估，质量比批量搬运高。`zk-kit triage`（只列无 `type` 笔记并建议去向）属计划外，未排期。
- 文件命名会混排：0.1.0 的 flat 笔记是 `{{id}}`（随机，如 `0tup.md`），layered 之后新笔记是拼音 slug。老笔记**不自动重命名**——手工改名会断入链（Z11），收益只是好看；后来由 `zk_rename` 提供带预演的重写。
- `config.toml`：只追加不存在的 `[group.*]`；已有同名 group 一字不动（沿用 0.1.0 的幂等断言）。`[note]` 表不动，slug 命名靠 group 级 `filename`。
- 用户手改过模板：已存在的模板文件不覆盖，只报"跳过"（与 0.1.0 的 `templateWritten` 语义一致）。

---

## 9. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| M1 注入机制不存在 | ~~中~~ 已排除 | 记忆层自动化打折 | 2026-10-29 源码确认可注入（§4 M1）；`zk_context` 仍保留，服务没有 `systemPrompt` 的宿主 |
| 模型不遵守"先查重再写" | 高 | 重复笔记 | `zk_new` 在 flat 下按标题查重并直接报错，不靠提示词 |
| MEMORY.md 被模型当成普通笔记改写 | 中 | 记忆污染 | meta 文件排除出检索；`zk_append` 拒写 meta 文件（MEMORY.md 的写入由 agent 按 AGENTS.md 直接改文件，走 git diff 可审） |
| 200 条后上下文吃紧 | 高 | 检索变慢变糊 | `zk_query` 强制 `limit`，默认返回摘要而非全文；INDEX.md 在 150 条时提示生成 |
| 中文长标题 slug 撞名 | 中 | Z8 丢内容 | 撞名即报错，让人改标题；不自动加后缀 |
| 人和 agent 用不同 zk 版本索引同一个 notebook.db | 中 | schema 漂移、索引损坏 | `zk-kit doctor` 显示 zk 来源与版本；文档写明以 `doctor` 看到的为准 |
| 集成测试因 zk 缺失静默 skip，被当成回归通过 | ~~高~~ 已缓解 | 假绿，M0 的「逐字节一致」无法证明 | `bun run test` 先解析 zk，末尾断言 `skip = 0`；直接 `bun test` 无 zk 会留一条红的（2026-10-29 落地） |

---

## 10. 已定结论（2026-10-29 评审）

细节都在对应节里，这里只做索引。

| # | 结论 | 落点 |
|---|---|---|
| 1 | `structure` 默认 flat，设置页手动切；v0.3 满足翻转条件后再翻 | §3 D1 |
| 2 | 注入预算做成设置项（默认 500，初版 300 不够用、已上调），管三份 meta 的总载荷 | §3 D6、§4 M0 |
| 3 | superseded 搬进 archive/（保留原相对路径），同一次调用里重写入链 | §3 D4、§4 M2 |
| 4 | `keywords` 删掉，检索词写进 tags 或正文；中文必须打 tags | §7、§6 |
| 5 | M1 回退 = `zk_context` + `/zk brief` 一起做，验收 ≥10 次首轮机会 | §4 M1 |
| 6 | 人终端走 `zk-kit`，`query` 支持透传但禁破坏不变量的参数 | §4 M3 |
| 7 | meta 文件放 vault 根；是否自动加载由 M1 结论决定，不预先承诺 | §4 M1、§7 |
| 8 | 不给老笔记做自动归类 | §8 |
| 9 | 注入截断纯机械（MEMORY 尾 → USER 尾），不判断相关性 | §3 D6 |
| 10 | 结构模式以配置为准；迁移时显式落盘 `structure`，目录不符只告警 | §3 D1、§8 |

---

## 11. 明确不做

- 向量库 / embedding / 语义检索（全文 + agent 判断已经够用）
- 插件内跑 cron 或后台做梦（应由人/外部调度触发）
- 插件替人做语义判断（矛盾裁决、晋升决定）
- 自动改写/批量重构用户已有笔记
- `[alias]` 写进 config（对 agent 无用，对人有 `zk-kit`）

---

## 12. 完成定义

**基线先看一眼**：`bun run test` 现在 79 pass / 0 fail（zk 0.15.7）。测试入口 `scripts/test.ts` 先按插件顺序解析 zk，再跑 `bun test`，
**出现 skip 即失败**；直接 `bun test` 且没有 zk 时会留一条红的（`zk 不可用`），不会被误读成全绿。

- [x] layered vault 一条命令建好，模板全部生效，`zk list` 干净（无模板、无 meta 文件）—— 2026-10-29
- [x] 同一标题重复创建会报错而不是静默丢内容（layered 靠 slug 文件名，flat 靠 `createNote` 的标题查重）—— 2026-10-29
- [x] supersede 后原笔记在 archive/（保留原相对路径），检索不再命中，git 显示 rename，断链计数不增加 —— 2026-10-29
- [ ] 新会话第一轮能引用 MEMORY.md（注入通道已落地，**端到端待真机验证**）
- [x] `zk_lint` / `zk_dream` 只读，200 条笔记 3 秒内返回 —— 2026-10-29（实测 200 条约 0.9 秒；只读由逐字节快照比对证明）
- [x] 现有测试全绿（79 pass，含不依赖 zk 的配置 / 注入 / 结构测试；flat 模式无回归）—— 2026-10-29
- [x] README / docs/features/memory.md / AGENTS.md 模板 三处口径一致 —— 2026-10-29（模板三条规则与两处文档逐条对应）
- [x] 设置页切 flat → layered 只建目录与模板：弹窗明说、补建要再点一次，`zk-kit doctor` 的预算行证明模板没吃掉全部预算 —— 2026-10-29
- [x] 文档命令可跑：`bun run docs` 在临时 vault 上跑通 README 全部 9 条 `zk-kit` 命令 —— 2026-10-29

---

## 13. 后续增补（2026-10-29，v0.3 之后）

计划定稿后补的两处「写入侧防线」，不改变 §3 的任何结论：

- **`WORKFLOW.md`**：把最初草案里的「修改分类三选一（temporal / context variant / contradiction）+ 先列受影响清单等确认」
  找回来。它不能进 `AGENTS.md`（AGENTS 属于注入预算且永不截断，加一段就把 MEMORY 挤没），
  所以单独一份、不注入、按需读，`AGENTS.md` 只留一行指针；同时进 `META_NAMES`（不进检索、`zk_append` 拒写）。
  落地：`lib/agents-template.ts` 的 `WORKFLOW_TEMPLATE`、`ensureNotebook` 的 `workflowWritten`。
- **`raw/` 只读机械拦截**：`zk_new` / `zk_append` / `zk_link` / `zk_supersede` 的写入入口统一走 `assertWritablePath`。
  原因：raw 被 `excludedNames` 排除，写进去不报错但永远搜不到 —— 静默失败比明确拒绝更难查。
- 测试 79 pass；`bun run test` 仍是 skip = 0 才通过。

## 14. v0.3.1：记忆层体检

`zk_supersede` 只重写 `zk graph` 里的入链，而 `excludedNames` 把 meta 文件排除在图外 ——
`MEMORY.md` / `USER.md` 里的 `[[来源]]` 不会跟着搬，`--broken-links` 也不统计它们。
于是「记忆说 X、库里 X 已废弃」没有任何一层能发现。v0.3.1 只补机械核对（D5 / D6 不变）：

- `zk_lint` 新增 `memoryLinks`：原路径 → 加 `.md` → `archive/` 下同名 → 活笔记标题 / 文件名；
  旧路径在归档下找到同名（或活文件带 `status: superseded`）报 `superseded`，都找不到报 `missing`；
  显式 `archive/` 链接视为有意引用；`unlinked` 只数 MEMORY.md 里没有链接的列表条目。
- `AGENTS.md` 模板加一条约定：MEMORY.md 每条结论后附 `[[来源路径]]`（12 词预算成本）。
- 同一版把模板从 195 词压到 159 词：195/300 = 65%，留给 USER + MEMORY 的只有 105 词，
  再让每条结论都带来源链接，记忆层会长期停在「被截断」状态 —— 规则本身可以写得更紧，当时预算不能涨（D6；
  后来实跑证明 300 不够用，已上调到 500，见 §18）。
- 纯机械，不做语义重复判断、不自动改 MEMORY.md —— 记忆层的写入仍然归 agent。
- `package.json` 补 `repository`（插件市场的仓库校验需要它，之前只有 git remote，注册表读不到）。

## 15. v0.4.0：截断留目录

按位置丢尾段的问题不是「丢了」，是「模型不知道丢了什么」。装配层拿不到 query
（`AssemblyContextLike` 只有 `agent.id`），所以注入层做相关性打分既做不到、也违反 D5。
v0.4.0 把「读哪段」下移给 agent，插件只负责让被丢的内容仍然可发现：

- 截断时把丢掉的 `##` 段合成紧凑目录（`MEMORY.md：§标题、§标题`），最多 5 个标题；
  目录计入预算（`tocWords`，`min(40, 20%)`），超出就按标题数递减。
- 一段都列不出时退化成一句「用 `zk_read` 读 MEMORY.md / USER.md」，不让内容彻底静默。
- `files[].originalWords` + `formatFileShares()`：doctor / 设置页给出每个文件的原词数与保留词数。
- `zk_read` 明确支持读根目录 meta 文件（`readNote` 本来就能直接读文件，补的是工具描述与测试）。
- 不改：截断顺序（MEMORY 尾 → USER 尾 → 首段）、AGENTS 永不截断、词数口径。
- 测试 83 pass（新增：目录内容与上限、`truncatedWords` 只算正文、目录计入预算、
  `zk_read MEMORY.md` 真能取回、目录标题同样转义）；`bun run check` / `bun run smoke` 全绿。

## 16. v0.4.1：废弃原因 + 同名旧结论预警

supersede 只记「哪条替代了哪条」，不记「为什么废」。错误前提最容易以「标题复用」的方式回来：
`zk_new` 的查重只看活笔记，旧结论一归档，标题就空出来了。v0.4.1 只补机械记录与提醒（D5 不变）：

- `zk_supersede` 新增可选 `reason`：单行、≤200 字、YAML 双引号落盘到 `supersede-reason`；
  `dry_run` 也回显，重放返回已有值。
- `zk_new` / `zk-kit new`：归档里同名时返回 `archived`（路径 + 原因）并警告，不拦。
  判断「是不是同一个错误」仍然是 agent 的活。
- `parseFrontmatter` 对双引号值改走 JSON 解析：`\"` 与 `\n` 读回来才是原字符。
- 测试 86 pass；`bun run check` / `bun run smoke` 全绿。

## 17. v0.5.0：dream 的可重放材料

Dream-RSI 的教训是「把过去压缩成结论再注入」不如让 agent 重放材料。dream 不再只给候选标题：

- `newNotes` 增加 `lead`（frontmatter 之后第一段正文，压空白后 ≤200 字；不是 zk 的标题行）
  与 `citedBy`（入链来源前 5 条）；`cited` 计数保留。
- 一次 `zk graph` 同时算计数与来源，不按笔记逐条跑；读失败退回 `NoteRecord.lead`。
- 仍然只读：晋升判断、写 MEMORY.md / DREAMS.md 还是 agent 的活。
- 测试 86 pass；`bun run check` / `bun run smoke` 全绿。

## 18. 默认注入预算 300 → 500（2026-10-30）

初版 D6 选了 300 词，实跑证明不够用：

- `AGENTS.md` 模板约 160 词且永不截断，300 词里只剩 140 词给 USER + MEMORY；
  每条结论都要带 `[[来源]]`，几条就撞顶，截断变成常态而不是告警。
- 截断常态化的副作用比「多花 token」更贵：每轮都挂一份未注入段落的目录，模型长期在残缺记忆上工作，
  「该压缩了」这个信号也失去了意义。
- 500 词 ≈ 700–800 token，对每轮注入长期记忆来说是合理成本；预算仍是硬约束，截断、目录、归因提示都不变。

实现上只改默认值（`DEFAULTS.memoryBudgetWords`）与设置页文案；老配置里显式存过 300 的继续按 300 走 ——
配置是权威值，升级不覆盖用户已有设置。`memoryBudgetWords` 的归一化区间仍是 50–2000。

- 测试 88 pass；`bun run check` 全绿。
