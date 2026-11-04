# 计划：日记时间轴校验与小修（v3.1）

**状态**：待实施（2026-11-04 起草；基线 v3.0.1）
**目标**：只收掉两类「不报错、但会静默变坏」的问题 —— 日记时间轴没人校验；两个写入 / 日期边界会制造查不到的笔记或错误的周审窗口。
**范围**：本文是唯一在做的计划。已完成、已放弃的计划已从 `docs/` 删除，原因见 §6。

---

## 0. 本轮做什么

| ID | 问题 | 级别 | 本轮 |
|---|---|---|---|
| T1 | 日记时间轴无校验：空块、倒序、`## HH:MM` / `### HH:MM` 混用、条目落在 `## Observations` / `## Loose ends` 之后，全部静默 | P1 | ✅ M0 |
| T2 | 只读视图把空标题渲染成空 `<h3>`，页面不提示时间轴问题 | P1 | ✅ M1 |
| Q7 | flat 下 `zk_new dir=archive` 能建成功，但 archive 被排除出索引，写进去就消失 | P2 | ✅ M2 |
| Q6 | 补写旧日记时 `created` 仍是今天，dream 的窗口按 `created` 筛，旧日记被算成本周新增 | P2 | ✅ M3 |
| Q1 | `source.md` 的 `{{content}}` 落在 `## Quotes` 下，正文语义被标成引文 | P3 | ⏸ 先确认（§2 D8） |

**不做**：usage 日志、MEMORY 分型、`metaPointers`、记忆页按需列表、dream 的 AGENTS 大节、lifecycle M3/M4、quality 其余项。理由见 §6。

---

## 1. 证据

### 1.1 时间轴

参考库 `journal/2026-11-04.md`：5 个空块、2 处倒序、1 处 `11:5x`、4 个时间块落在 `## Events` 外，共 12 处：

```text
## Events

### 11:46                 ← 空块
### 12:49                 ← 空块
### 12:45（…）            ← 排在 12:49 之后
### 12:50                 ← 空块
### 12:50（…）
### 13:00                 ← 空块
### 12:57（…）            ← 排在 13:00 之后
### 13:04                 ← 空块
### 13:04（…）
### 13:13
### 13:44

## 11:5x（…）             ← h2，且在 Events 外；格式不合法
## 12:30（…）             ← h2，在 Events 外
## 12:36（…）             ← h2，在 Events 外
## Observations
## Loose ends（…）
## 12:47（…）             ← h2，且在 Loose ends 之后
## 13:39（…）             ← h2，且在 Loose ends 之后
```

代码侧：

- `src/lib/zk.ts:1074-1150` 的 `appendToNote` 只做「追加到 section 末尾」；找不到 `## Events` 就退回文件末尾写 `## HH:MM`。它不排序、不去空块、不检查层级。
- `src/lib/lint.ts:849-1016` 没有日记时间轴桶；`lintNotebook` 只把日记从 orphan / tagless / similar / incomplete 中排除，没有结构检查。
- `src/features/readonly/html.ts:218-232` 把任何 `###` 都渲染成 `<h3>`；空标题就是空的 `<h3>`，页面不会提示。

### 1.2 Q7：flat 下新建能落进 archive

- `src/lib/notebook.ts:175-190` 的 flat 分支 `return given || normDir(cfg.notesDir)`，不检查 `archiveDir`。
- `src/lib/zk.ts:652` 的 `assertWritablePath` 只拦 `raw/` 与 `inbox/`。
- `src/lib/zk.ts:299-305` 的 `excludedNames` 默认排除 `cfg.archiveDir`。

结果：`zk_new({ dir: 'archive' })` 在 flat 库能建成功，然后这篇笔记从检索、统计、反链里全部消失 —— 写了、没报错、但搜不到。

### 1.3 Q6：补写旧日记仍进本周窗口

- `src/lib/dream.ts:402-407` 的 `windowNotes` 用 `Date.parse(n.created)` 筛窗口。
- `src/lib/dream.ts:450` 的 `dailyLooseEnds.date` 用 `localDate(note.created)`。
- `zk_daily --date` 写出的日记文件名是旧日期，但 `created` 是今天。

结果：补写 10 月底的日记，dream 仍把它算成本周新增；Loose ends 的日期也显示成今天。

### 1.4 Q1：source 模板的正文落点

`src/lib/notebook.ts:69-89` 的 `SOURCE_TEMPLATE`：

```text
## Summary

## Key claims

## Quotes

{{content}}

## Links
```

注释写的是「原始材料：保留 Key claims / Quotes」，但没说正文是不是引文。先确认语义，再决定改不改模板。

---

## 2. 设计

### D1：时间轴严格 `HH:MM`，layered / flat 分开

- **layered**（有 `## Events`）：时间条目必须是 `### HH:MM`，且位于 `## Events` 与下一个 `##` 之间。`## HH:MM` 是错的；`### HH:MM` 在 `## Observations` / `## Loose ends` 之后也是错的。
- **flat**（没有 `## Events`）：时间条目必须是 `## HH:MM`，按文件顺序追加；`### HH:MM` 报位置错。
- 时间格式只认 `00:00`–`23:59` 的两位 `HH:MM`；标题可以跟在全角 / 半角括号里：`### 12:45（…）`、`### 12:45(…)`。`11:5x`、`9:5`、`24:00`、`12:60`、`12:45 标题`（无括号）都算格式错。
- 结构判定 `auto`：先找第一个 `## Events`（跳过围栏代码与 frontmatter）；有就用 layered，没有就用 flat。

**为什么分开**：flat 是默认结构，`appendDaily` 在 flat 下写的就是 `## HH:MM`；统一要求 `## Events` 会让所有 flat 日记一次性全红。

### D2：只报告，不自动修

- 新 `src/lib/timeline.ts` 是纯函数；`zk_lint` 只把 issue 放进新桶，不改文件。
- 不提供 `zk_fix_journal` / 自动重排 / 自动删空块。修不修、怎么修，由 agent 或人决定。
- 理由：时间轴是人的工作面；自动移动条目会改正文顺序，diff 不可审。

### D3：页面原样 + 顶部警告

- 笔记页仍然按原 markdown 渲染，空标题保持空 `<h3>`；不隐藏、不重排。
- 如果这篇在 `cfg.dailyDir` 下且有 issue，在 `<h1>` 与正文之间插一个 `.notice`：
  - 一行汇总：`时间轴：12 处（空块 5 · 倒序 2 · 格式 1 · 位置 4）`；
  - `<details><summary>明细</summary>` 里列 `行 N：<标题> — <原因>`。
- 用现有的 `.notice` 样式；不引 JS、不新增 CSP 例外。

### D4：`zk_lint` 只查最近 90 天，页面警告看当前篇

- `zk_lint` 的 `timeline` 桶只扫最近 90 天的日记（按文件名 `YYYY-MM-DD` 的日期；不是这个形状就退回 `localDate(note.created)`）。
- 页面警告不受 90 天限制：打开哪篇查哪篇。
- 90 天是常量 `TIMELINE_WINDOW_DAYS = 90`，不复用 `staleDays`。

**为什么不是全部**：一年 365 篇日记，一次 lint 报几百条旧问题，输出会被 50 条上限截断，反而看不见今天的问题。

### D5：同分钟允许，`11:5x` 报格式

- 同一分钟多条：只要相邻、各自有正文，就允许；不报重复。
- `11:5x` / `9:5` / `24:00` 是格式错；要写 `11:50`，或写成 `11:00–12:00` 这种范围标题（仍然必须落在合法时间位置上）。
- 空块：合法时间标题下、下一个同级或更高级标题之前，只有空行 → `empty`。

### D6：新建不得落在 archive（Q7）

- `createNote` 在 `mkdir` 之前检查目标相对路径：落在 `cfg.archiveDir` 下直接 `ZkError`，文案说明「archive 只放 supersede 搬进去的废弃笔记；新笔记请写 notes/ 或 journal/」。
- `newNoteDir` 的 flat 分支同样提前拒绝，给 `zk_new` 更早的错误；两处共用一个 `assertNotArchiveCreate`。
- `supersedeNote` 的 `fs.rename` 不受影响；`zk_rename` 到 archive 仍允许（人明确要归档），但结果里提示。
- 不把 archive 加进全局 `assertWritablePath`：`zk_append` 对 archive 里旧笔记的修正不在本轮范围，避免误伤。

### D7：dream 用 `noteDate`（Q6）

- 新增 `noteDate(cfg, note): string`：
  - 日记：文件名是 `YYYY-MM-DD` → 用它；
  - 其他笔记：frontmatter `metadata.date` 是合法 `YYYY-MM-DD` → 用它；
  - 否则退回 `localDate(note.created)`。
- `dreamNotebook` 的 `windowNotes`、`backlog`、`candidateOf.created`、`dailyLooseEnds.date` 全部改用 `noteDate`。
- 不改 `zk_new` 的 `date` 参数（quality 计划 M4 的扩展，本轮不做）；`zk_daily --date` 已经由文件名承载日期，够用。

### D8：source 模板先确认（Q1）

- 如果来源笔记的正文就是引文：不改，补一句注释说明「正文默认落在 Quotes」。
- 如果正文是内容：把 `{{content}}` 移到 `## Content`，`Key claims` / `Quotes` 不再预置；旧库不自动迁移。
- 本轮默认不动；确认后再开一行改动。

---

## 3. 实施里程碑

### M0（P0，时间轴库 + `zk_lint` 桶）

**落点**：
- 新 `src/lib/timeline.ts`
- `src/lib/lint.ts`：`LintTimelineIssue` / `LintTimelineBucket` / `LintResult.timeline` / `timelineIssues` 调用 / `formatLintExtras`
- `src/features/zk-tools/feature.ts`：`zk_lint` output schema / render
- `src/cli.ts`：`doctor` 时间轴行
- `test/zk.test.ts`

**任务**：
1. `timelineIssues(body, structure = 'auto', max = 50)`：
   - 剥 frontmatter、遮围栏代码；行号保留原文行号（剥掉的部分用空行占位）。
   - 解析 headings；`auto` 看第一个 `## Events`。
   - 合法时间：`^(?:[01]\d|2[0-3]):[0-5]\d(?:\s*[（(].*[）)])?$`。
   - 报 `empty` / `order` / `format` / `placement` 四类；`placement` 的 detail 说明「不在 ## Events 下」或「层级应为 ###」。
   - 同分钟相等不报；只报 `t < prev`。格式错的标题不参与排序。
   - 空块判断：合法时间标题到下一个同级/更高级标题之间没有非空行。
2. `lintNotebook` 加 `timeline` 桶：
   - 只扫 `cfg.dailyDir` 下、日期在最近 90 天的日记；
   - 每篇最多 50 条 issue；桶里 `{ scanned, notes, total, items }`；
   - 读文件失败 / 超过 2 MiB 跳过，不误报。
3. `zk_lint` 文本输出：`时间轴：12 处（1 篇；扫描 1 篇）` + 明细；`doctor` 加 `· 时间轴：N 处（zk_lint 看详情）`，不翻退出码。
4. 测试：layered / flat 分开、空块、倒序、`11:5x`、`## HH:MM` 在 layered、围栏代码、同分钟、90 天窗口、空 `## Events`。

**验收**：
- 参考库 `2026-11-04` 日记报出 §1.1 的 12 处；文件一个字节没改。
- flat 日记 `## 09:05` 不报；`### 09:05` 报位置。
- 围栏代码里的 `## 12:00` 不报。
- 90 天以前的旧日记不进 `zk_lint`，但打开那篇页面仍然提示。
- `doctor` 只多一行 `·`，退出码不变。

### M1（P0，笔记页顶部警告）

**落点**：
- `src/features/readonly/feature.ts`：`handleNote`
- `src/features/readonly/html.ts`：复用 `.notice`；必要时加一条 `.notice details` 的窄样式
- `test/zk.test.ts`

**任务**：
1. `handleNote` 里判断 `isUnderDir(loaded.rel, cfg.dailyDir)`；是日记就调 `timelineIssues(content, 'auto')`。
2. 有 issue 时，在 `<p class="meta">` 之后、`<article>` 之前插 `.notice`：汇总 + `<details>` 明细；所有内容走 `esc`。
3. 明细里 `行 N：<标题> — <原因>`；行号是文件原文行号。
4. 正文仍是 `renderMarkdown(content)`，不排序、不隐藏空块。
5. 测试：layered 日记页含 `.notice` 和 `空块 5`；非日记页不含；无 issue 的日记页不含；转义 `</details>` 等文本。

**验收**：
- 打开参考库 `2026-11-04`，顶部能看到「时间轴：12 处…」，正文与现在逐字一致。
- 打开一篇普通笔记，页面没有任何时间轴提示。
- 页面没有新增 JS、没有新增 CSP 例外。

### M2（P2，archive 写入守卫）

**落点**：
- `src/lib/zk.ts`：`assertNotArchiveCreate` / `createNote` 调用
- `src/lib/notebook.ts`：`newNoteDir` flat 分支调用
- `src/features/zk-tools/feature.ts`：`zk_new` 错误文案
- `test/zk.test.ts`

**任务**：
1. `assertNotArchiveCreate(cfg, rel)`：`rel === archiveDir` 或 `startsWith(archiveDir + '/')` → `ZkError`。
2. `createNote` 在 `mkdir` 前调用；`newNoteDir` flat 分支提前调用。
3. `supersedeNote` 不受影响；`zk_rename` 到 archive 仍允许并在结果里提示。
4. 测试：`dir=archive`、`dir=archive/sub` 拒绝；`supersede` 正常；flat 0.1.0 产物不变。

**验收**：
- `zk_new dir=archive` 报错，提示写到 `notes/` 或 `journal/`。
- `zk_supersede` 仍能把旧笔记搬进 `archive/`。

### M3（P2，dream 日期）

**落点**：
- `src/lib/dream.ts`：`noteDate`，窗口 / 排序 / `candidateOf.created` / `dailyLooseEnds.date`
- `test/zk.test.ts`

**任务**：
1. `noteDate(cfg, note)`：日记文件名 → frontmatter `date` → `created`；严格校验 `YYYY-MM-DD`，非法日期按无日期处理。
2. `dreamNotebook` 的 `windowNotes` / `backlog` / `candidateOf.created` / `dailyLooseEnds.date` 改用 `noteDate`。
3. 测试：补写 2026-10-01 的日记不进本周窗口；`dailyLooseEnds.date` 是 2026-10-01；非法日期不误报；无日期退回 `created`。

**验收**：
- 补写旧日记不会出现在本周 `windowNotes`。
- Loose ends 的日期与日记文件名一致。

### M4（文档 / 测试 / 版本）

**落点**：
- `docs/features/readonly.md`：笔记页时间轴警告。
- `docs/features/zk-tools.md`：`zk_lint` 的 `timeline` 桶；`zk_new` 的 archive 错误。
- `docs/features/memory.md`：dream 的日期口径（Q6）。
- `README.md`：`zk_lint` / `zk_new` 行。
- `package.json`：3.1.0；`bun run version` / `bun run docs` 同步。

**任务**：
1. 文档统一用词：**时间轴**（日记的 `## Events` / `HH:MM`）、**归档**（只放 supersede 的旧结论）。
2. 写清 `zk_lint` 只查最近 90 天，页面警告不受窗口限制。
3. 版本升 3.1.0；`bun run check` 全绿。

**验收**：
- `bun run check` 全绿；`bun run smoke` 全绿。
- 文档里的例子与实现一致：`11:5x` 报格式、同分钟允许、90 天窗口。
- 没有新增依赖、没有新增写接口。

---

## 4. 测试计划

| 类别 | 用例 |
|---|---|
| 时间轴 / layered | 合法 `### 09:05` / `### 09:05（标题）` 不报；空块报 `empty`；倒序报 `order`；`## 12:30` 报 `placement`；`## 11:5x` 报 `format`；`## 12:47` 在 Loose ends 后报 `placement` |
| 时间轴 / flat | `## 09:05` 不报；`### 09:05` 报 `placement`；没有 `## Events` 不要求 Events；顺序检查跨全文 |
| 时间轴 / 边界 | 围栏代码里的 `## 12:00` 不报；frontmatter 里的 `12:00` 不报；同分钟两条都有正文不报；同分钟一条空报 `empty`；`24:00` / `12:60` / `9:5` 报 `format` |
| 时间轴 / 窗口 | 90 天内旧日记进 `timeline`；90 天外不进 `zk_lint`；页面警告不受窗口限制；读文件失败 / 2 MiB 跳过 |
| 时间轴 / 页面 | 日记页有 `.notice` + `详情`；普通笔记没有；无 issue 没有；`</details>` 被转义 |
| archive | `zk_new dir=archive` / `archive/sub` 拒绝；`supersede` 正常；flat 0.1.0 产物不变 |
| dream 日期 | 补写旧日记不进窗口；`dailyLooseEnds.date` 用文件名；非法日期不误报；无日期退回 `created` |
| 回归 | 现有测试全绿；`bun run check`；`bun run smoke` |

**手工验收**：
1. 参考库只读副本：打开 `2026-11-04`，顶部出现 12 处时间轴警告；正文不变；`zk_lint` 的 `timeline` 桶数字一致。
2. 打开一篇 flat 日记：`## HH:MM` 不报；把一条改成 `### HH:MM`，报位置。
3. flat 库跑 `zk_new dir=archive`，应报错；`zk_supersede` 仍能归档。
4. 补写一篇旧日记，`zk_dream` 的窗口与 Loose ends 日期都不把它算成今天。
5. `bun run check` 全绿；`bun run smoke` 全绿。

**基线**：实施前记录当次 `bun run check` 的 pass/fail；目标是不新增 fail、不新增 skip。

---

## 5. 兼容与迁移

1. **时间轴**：纯新增桶，不改变现有 lint 语义；`timeline` 为空时不占行。已有日记一个字不改。
2. **页面警告**：只在日记页、且有 issue 时出现；普通笔记与无 issue 的日记页逐字不变。
3. **archive 守卫**：新笔记不能建进 archive；`supersede` / `rename` 的既有路径不变。这是有意的行为收紧，发布说明要写清楚。
4. **dream 日期**：只影响窗口 / 排序 / Loose ends 的日期来源；不传 `date` 的旧笔记行为不变（没有文件名日期就退回 `created`）。
5. **版本**：3.1.0（新增桶 / 字段 / 页面段，无破坏性变更；archive 守卫是唯一的写入收紧）。

---

## 6. 已删除 / 明确不做

| 计划 | 处置 | 为什么 |
|---|---|---|
| `plan-memory-layers.md` | 已删除 | 0.2.0 已完成；历史在 git 里 |
| `plan-memory-hardening.md` | 已删除 | 0.8.1 / 0.8.2 全部落地，§11.3 无剩余；§6 暂缓项保持暂缓 |
| `plan-notebook-config-memory-lifecycle.md` | 已删除 | M1/M2 已完成；M3/M4 只是把 lint 已有数字搬到页面，收益低 |
| `plan-notebook-memory-quality.md` | 已删除 | 基线 v0.8.3 已过期；Q3 已落地；Q6/Q7 收进本文；其余低价值或另案 |
| `plan-timeline-and-meta-pointers.md` | 已合并 | 只留 M0/M1；M2–M4（按需列表 / metaPointers / dream 大节）不做 |
| `plan-usage-and-memory-kinds.md` | 已删除 | 与 `plan-memory-hardening.md:611,632,834` 的「不用 usage 日志」决定冲突；原生 `read` 看不见，答不了「有没有被用过」；MEMORY 分型与 PERSONA / USER / AGENTS 的现有分层重复 |

**本轮明确不做**：

- 检索 / 读取的 JSONL 日志、`usageLog` 配置、`zk-kit usage`；
- MEMORY 的 `## 身份` / `## 项目` 分型、TTL 淘汰、`composition` 预算分账；
- `metaPointers` lint 桶、AGENTS / PERSONA 的按需指针列表；
- `zk_dream` 的 AGENTS 大节候选；
- 时间轴自动修复、`zk_fix_journal`；
- 插件自带领域 skill / `zk_skill` / 写 `~/.dsh/skills`；
- 多笔记本按库覆盖布局（lifecycle §6.3）、机器级 USER 层（quality §6.3）、source 三段来源链（quality §6.4）。

**为什么**：这些要么与既有决策冲突，要么只在参考库这一本笔记本上成立，要么只是「把已有数字再展示一遍」。本轮只修会静默产生坏数据的地方。
