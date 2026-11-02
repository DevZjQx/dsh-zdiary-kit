# 计划：笔记本配置收敛与记忆生命周期（v0.9）

**状态**：实施中（2026-11-02 起草；基线 v0.8.3，`bun run test` 144 pass / 0 fail）
**进度**：M1 ✅ 2026-11-02（`notebook-config.ts` 只读解析、`groups [--fix]`、archiveDir 非空变更阻断、doctor / 设置页告警；149 pass）。M2 ✅ 2026-11-02（`memory-format.ts`、按最旧日期截断、退役条目注入省略、`memoryUsage`、dream 余量 / 退役候选、lint `stale`；155 pass）。M3–M4 待实施。
**目标**：收掉两类会“静默坏掉”的问题 —— 配置改了但 `.zk/config.toml` 没跟上；记忆只增不减、截断与退役不可控。
**基线事实**：本机 `~/zdiary` 实测 `285/300` 词（AGENTS 159 · MEMORY 121），内容口径离截断只差十几词；但连同框与提示，实际注入 `336` 词 —— 已经超预算 36 词，只是没人看得见（另一个口径见质量计划 Q3）。参考页（只当样本，不作为验收硬指标）显示 `322/500` 词、MEMORY 已有 1 条退役行。
**不在本计划内**：向量 / embedding；定时器 / cron；MEMORY 写入 API；语义冲突判断；多笔记本按库覆盖布局（见 `6.3` 另案）。

---

## 0. 问题清单

| ID | 问题 | 级别 | 本计划 |
|---|---|---|---|
| N1 | 改 `notesDir` / `dailyDir` / `archiveDir` / `dailyGroup` 后，plugin-owned group 不收敛，甚至生成重复 group | P0 | ✅ M1 |
| N1b | 改 `archiveDir` 后旧归档目录不再被排除，废弃笔记重新进入检索 | P0 | ✅ M1（先阻断危险变更） |
| M1 | MEMORY 截断只按位置，不按日期；flat 模板没写顺序约定 | P1 | ✅ M2 |
| M2 | 退役行仍进入注入载荷，并参与 dream 的“已晋升”标题匹配 | P1 | ✅ M2 |
| M3 | `zk_dream` 不给预算余量、不给退役候选 | P1 | ✅ M2 |
| M4 | 记忆体检结果没有进入人的界面 | P1 | ✅ M3 |
| N2 | layered 切换后，`notes/` 根旧笔记不属于任何 group，没有报告 / 迁移 | P2 | ✅ M4（报告；迁移可选） |
| N3 | 多笔记本只支持 `path + structure`，目录与预算仍全局 | P2 | ⏸ 另案（`6.3`） |

---

## 1. 证据

### 1.1 N1：group 只在缺失时追加，存在就永远跳过

`ensureNotebook` 的循环：

- `src/lib/notebook.ts:338-347`：`if (hasGroup(configText, group.name)) continue` —— 只判名字，不判 `paths` / `template`。
- `src/lib/notebook.ts:258-261`：`hasGroup` 只匹配 `[group."name"]` 头。
- `src/config/store.ts:41-53`：`notesDir` / `dailyDir` / `dailyGroup` / `archiveDir` 是全局字段。
- `src/features/settings/client.ts:138-141`：设置页允许直接改这些字段，并提示“所有笔记本共用”。
- `src/features/settings/feature.ts:133-170`：保存时只有 `active` 变化才自动 `ensureNotebook`；改目录不会自动初始化。

2026-11-02 临时库实测（不改用户数据）：

```text
init → 把 dailyDir 改成 diary、notesDir 改成 kb → 再 init
[group."daily"] paths = ["journal"]        # 完全没变

init → 把 dailyGroup 改成 diary → 再 init
[group."daily"] paths = ["journal"]
[group."diary"] paths = ["journal"]        # 两个 group 抢同一路径
```

影响：

1. 日记的 `daily.md` 模板与日期文件名规则不再按预期匹配（zk 按路径前缀归组）；
2. layered 下新笔记落在新 `notesDir`，但不属于任何 group，等于“无模板”；
3. `archiveDir` 改了以后，旧 `archive/` 不再被 `excludedNames` 排除（`src/lib/zk.ts:299-306`），废弃笔记重新进入检索，`zk_stats` 也会把它们算成活跃；
4. 旧 `journal/` 不再被 `isUnderDir(note.path, cfg.dailyDir)` 识别为 daily，dream 的“日记提及”信号失效；
5. `doctor` 只检查 `dailyGroup` 名字存在（`src/cli.ts:245-249`），仍然显示 ✓。

### 1.2 M1：截断从尾部丢，不看日期

- `src/lib/memory.ts:326-333`：`while (over() && split.sections.length > 1) { const section = split.sections.pop() ... }`。
- `src/lib/agents-template.ts:54`：layered 模板写了“新条目写顶部；超预算从底部往前丢”。
- `src/lib/agents-template.ts:61-77`：flat 模板没有这两句；flat 用户自然在底部追加，超预算时先丢最新结论。
- 日期已经存在（`docs/features/memory.md` 的 P1-3 约定），但 `memory.ts` 没有使用它选丢弃对象。

### 1.3 M2：退役行没有退出注入，也没有退出 dream 的判重

- `src/lib/memory.ts:351-352`：`bodies` 直接用 `original` 原文，退役行原样进入载荷。
- `docs/features/memory.md:34-35`：B 案“过滤退役行”被推迟到“退役行真的出现、预算压力可测之后”。
- `src/lib/dream.ts:249-255`：`promotionsOf` 对 MEMORY 的**所有行**做 `line.includes(title)`；退役行里含旧结论标题。
- `src/lib/zk.ts` 的 `createNote` 明确允许复用归档里的标题（`archivedHits` 只是提醒），所以“退役后重新提出同一标题”会被 dream 误判为已晋升，从此不再进候选。

### 1.4 M3：dream 不知道 MEMORY 还剩多少预算

- `src/lib/dream.ts:119-140`：`DreamResult` 只有候选 / 拒绝 / 积压 / 使用信号，没有记忆用量。
- `src/lib/dream.ts:391-409`：返回结果也没有 `memory` 字段。
- 结果：agent 周审时看到 10 条候选，不知道 MEMORY 只剩 20 词；晋升完直接触发截断，而截断又可能是按位置丢最新。

### 1.5 M4：lint 算出来了，人的界面看不到

- `src/lib/lint.ts:395-447`：`memoryLinkIssues` 已产出 `unlinked` / `undated` / `retired` / `retiredBroken`。
- `src/features/readonly/feature.ts:252-273`：记忆页只渲染用量和四份文件原文，没有健康状态。
- `src/features/settings/feature.ts:69-86`：snapshot 里的 `memory` 只有 `words/budget/truncatedWords/tocWords/files`。
- 本机 lint 报“5 个条目没附来源链接、4 个条目没写日期”，但周审打开记忆页看不到这些信息。

### 1.6 N2：layered 的“无 group 旧笔记”没有出口

- `src/lib/notebook.ts:10`：切到 layered 只建目录与模板，不搬笔记。
- `src/lib/notebook.ts:166-190`：`newNoteDir` 在 layered 下要求笔记落在某个 group 的 paths 里。
- `src/lib/notebook.ts:233-255`：`structureStatus` 只查缺目录 / AGENTS，不查 `notes/` 根下不属于任何 group 的旧笔记。
- `src/lib/lint.ts` 的 `incomplete` 只能间接报“缺 frontmatter”，不会说“这篇不在任何 group 里”。

### 1.7 N3：多笔记本只做了路径与结构

- `src/config/store.ts:41-53`：`notesDir` / `dailyDir` / `dailyGroup` / `archiveDir` / `memoryBudgetWords` / `defaultTags` / `maxReadChars` 都是全局。
- `src/features/settings/client.ts:394`：界面明确写“笔记/日记子目录、归档目录、注入预算是全局的”。
- `src/cli.ts:448-498` / `src/features/settings/feature.ts` 的自动 init：指向已有 zk 笔记本时会补建 `notes/` / `journal/` 并追加 group，没有“接管已有库”的确认。

---

## 2. 设计决策

### D1：配置收敛以“报告 + 显式修复”为主，不自动重写 TOML

**问题**：直接重写 `[group."x"]` 会碰用户自定义的 `paths` / `template` / `extra`；TOML 改写器也不是本项目想引入的依赖。

**决定**：

1. 新增 `src/lib/notebook-config.ts`，只做**只读解析**：
   - `parseGroupBlocks(text)`：识别 `[group."name"]`、`[group."name".note]`、`[group."name".extra]`；
   - `groupPaths` / `groupTemplate` / `groupComment`；
   - 只支持当前 writer 产出的双引号数组，以及常见的单引号写法；解析失败一律返回 `null`，绝不猜测。
2. `StructureStatus` 增加：
   ```ts
   groups: Array<{
     name: string
     expectedPaths: string[]
     actualPaths: string[] | null
     pathsOk: boolean
     template?: string
     templateOk?: boolean
   }>
   groupsOk: boolean
   ```
   `ready` 仍只表示“目录齐全”；`groupsOk` 单独展示，避免把用户有意改过的 group 判成“没装好”。
3. `ensureNotebook` 默认**不重写**任何已有 group，但增加两条保护：
   - 若新 group 的 `paths` 已经被另一个 group 占用（典型：改 `dailyGroup`），不追加第二个，返回 `groupWarnings`；
   - 若已有 group 的 `paths` 与配置期望不一致，返回 `groupWarnings`，不写文件。
4. 新增显式修复入口 `zk-kit groups [--fix] [--dry-run]`：
   - 默认 `--dry-run`：打印每个 group 的 expected / actual；
   - `--fix`：只替换 plugin-owned group 的 `paths = [...]` 行（保留 `template` / `extra` / 注释），写前备份 `.zk/config.toml.bak`，写临时文件后 rename；
   - 不认识的 group 名一律不碰。
5. `archiveDir` 变更先**阻断**：
   - `writeConfig` 在检测到 `archiveDir` 变化、且旧目录存在且非空时，抛出明确错误；
   - 设置页 / CLI 显示“旧 archive 不会自动迁移，改完会让废弃笔记重新进入检索；先手动迁移或保持原值”；
   - 后续若要做迁移，另开 `zk-kit migrate archive`，不塞进本计划。
6. `dailyGroup` 变更：
   - 若旧 plugin group 仍存在且路径等于 `dailyDir`，`groups --fix` 只改 group 头名，不追加新 group；
   - 识别不了就只报告，交给用户。

**被拒**：自动重写所有 group —— 违反“不覆盖用户已有配置”，且一次写坏整份 `config.toml` 的代价太高。  
**被拒**：把 `archiveDir` 直接改成“迁移文件” —— 涉及文件搬移、链接重写、冲突处理，应该独立评审。

### D2：MEMORY 按“最旧日期”丢弃，解析不到才退尾部

**规则**：

1. 只对 `MEMORY.md` 生效；`USER.md` 是偏好清单，继续尾部丢。
2. 丢弃顺序：
   - 在可切分的条目里，选**能解析出 `YYYY-MM-DD` 且日期最旧**的一条；
   - 同日期按文件位置靠后的先丢；
   - 没有任何带日期条目时，退回当前的尾部丢。
3. 日期必须真校验：`2026-99-99` 不算；解析失败按“无日期”处理。
4. 丢弃后重建正文与 TOC 时保持原文件顺序；TOC 按原位置排序，不按丢弃顺序重排。
5. flat 模板**不强行加**“新条目写顶部”：它当前 88 词，锁 `≤90`，加一句会破约束；日期感知已经覆盖“带日期的条目”。若最终仍有大量无日期条目，在截断 notice 里加一句“MEMORY 有 N 条没日期，只能按位置丢”，不改模板。
6. 兼容：所有条目都无日期的老库，行为与现在完全一致（尾部丢）。

**为什么不是只改模板**：模板是约定，不是机制；参考库 / 本机都存在不按日期排序的条目，靠人守顺序不可靠。

### D3：退役行“磁盘保留、注入省略、dream 跳过”

**决定**：

1. 新增 `src/lib/memory-format.ts`，提供唯一口径：
   - `splitMemoryEntries(body)`：列表项 + 缩进续行；
   - `isRetiredEntry(entry)`：`^\s*(?:[-*+]|\d+[.)])\s+\[superseded\b/i` —— 必须带 `i`，与 `lint.ts:435` 同一口径；不带的话 `[Superseded …]` 会被注入过滤、却不被 lint 计为退役；
   - `entryDate(entry)`：首行 `YYYY-MM-DD`，校验真实日期；
   - `stripRetiredEntries(body)`：整条删除，不留下半行。
2. `memory.ts` 在截断前对 `MEMORY.md` 执行 `stripRetiredEntries`；若删了 N 条，注入 notice 增加一行 `已省略 N 条退役条目（见 MEMORY.md）`，这一行计入预算。
3. `dream.ts` 的 `promotionsOf` 分两步，顺序不能反：
   - **链接匹配用原文**：退役行里的 `→ [[新结论]]` 是合法的「已晋升」指针，先 strip 会把新结论重新放回候选；
   - **标题匹配用 `stripRetiredEntries` 之后的正文**：退役行里的旧结论标题不该再算已晋升。
4. `lint.ts` 复用同一套 `isRetiredEntry` / `entryDate`，输出口径不变。
5. 记忆页仍显示磁盘原文（含退役行），但加视觉标记；不改变“页面 = 文件”的事实。

**为什么现在做**：B 案的触发条件已经满足 —— 参考库出现退役行，本机 `285/300` 内容词、实际注入 336 词已经超预算；再等就只能在预算被吃掉之后才看见。

### D4：dream 输出“记忆余量 + 退役材料”

**决定**：

1. `memory.ts` 增加 `memoryUsage(cfg)`，返回 `{ words, totalWords, budget, headroom, files }`：
   - 它只是 `buildMemoryPayload(cfg)` 的投影，**不重读、不重算** —— 否则就是第三个计数口径；
   - `words` 直接取 `payload.words`（与 doctor / 设置页 / 记忆页同一口径，含「记忆已用」提示行）；
   - `totalWords = countWords(payload.text)`：框、做梦提醒、notice 都在里面，是模型真正收到的量；
   - `headroom = budget - totalWords`，**可以为负**（内容词没超、加上提示超了，正是本机现状）。
2. `DreamResult` 增加：
   ```ts
   memory: { words: number; totalWords: number; budget: number; headroom: number }
   retireCandidates: Array<{
     entry: string          // 首行摘要，最多 100 字
     date: string           // YYYY-MM-DD；无日期为空
     age: number | null
     reason: 'stale' | 'source-missing' | 'source-superseded'
   }>
   ```
3. 退役候选只做机械规则：
   - 有日期且 `age > staleDays`（默认 90）→ `stale`；
   - 条目里的 `[[来源]]` 解析不到活笔记 → `source-missing` / `source-superseded`；
   - 无日期、无链接不作为“退役”候选（它们已经由 lint 的 `undated` / `unlinked` 报告）。
4. `zk_dream` 的文本输出增加一行 `记忆：C/Y 词 + 提示 H = T 词（余 Z）` 和 `可考虑退役：…`；只给材料，不写文件。
   余量按总词算 —— 只报 `words` 等于告诉 agent「还有 15 词」，而框和提示早就把它吃完了（本机 T 比 C 多 51 词）。
5. 不做：自动退役、自动改 MEMORY。

### D5：记忆健康进入记忆页 / 设置页

**决定**：

1. `LintMemoryBucket` 增加 `stale`：
   ```ts
   stale: {
     total: number
     items: Array<{ source: string; entry: string; date: string; age: number }>
   }
   ```
   `memoryLinkIssues(cfg, notes, { max, staleDays })`；`lintNotebook` 把现有 `staleDays` 传进去。
2. `formatMemoryLinks` 增加 `N 条超过 N 天未复核`，CLI / `zk_lint` 共用。
3. 只读记忆页：
   - 在用量行下面加一个“记忆健康”摘要：`无来源 N · 无日期 N · 已退役 N · 超过 90 天 N`；
   - 列一个最多 10 条的“需要看一眼”的小表（来源文件 / 条目摘要 / 原因）；
   - 退役行在渲染时加淡色 / 删除线；不改变内容本身。
4. 设置页快照增加**轻量**计数（只读 meta 文件，不跑 zk）：
   `memoryHealth: { entries, undated, retired, unlinked }`；
   完整链接核对仍只在记忆页 / lint 里做（需要 notes 与 `wikiIndex`）。
5. 不做：在页面里直接编辑 MEMORY.md。写入仍只走人和 agent 的文件编辑，保持 `docs/features/memory.md` 的边界。

### D6：layered 先报告，迁移后置

**决定**：

1. `StructureStatus` 增加 `rootNotes: string[]`：layered 下直接位于 `notesDir` 根、不在任何分类子目录的 `.md` 文件（最多列 20 个，另给总数）。
2. `LintResult` 增加 `outsideGroups`（仅 layered）：
   - 用 `.zk/config.toml` 的实际 group paths 判断；
   - 配置缺失 group 时退回 `layeredGroups(cfg)` 的期望路径；
   - 日报、archive、raw、meta 不算。
3. 设置页 flat → layered 的确认弹窗追加：“`notes/` 根有 N 篇旧笔记不会被搬；它们不在任何 group 里，新建笔记必须选目录”。
4. `zk-kit migrate --dry-run`（可选，M4 后置）：
   - 扫描 root notes，按 frontmatter `type` 建议 `notes/{sources,concepts,entities,patterns}/`；
   - 无 type 默认 `concepts`；
   - 检查同名冲突，列出“从 → 到”；
   - `--write` 逐篇调用 `renameNote`（复用已有的入链重写），不直接 `fs.rename`。
5. 本计划先交付 1–3；4 若时间不够就只保留 lint 报告，不阻塞版本。

### D7：多笔记本布局另案

**决定**：本计划不把 `notesDir` / `dailyDir` / `archiveDir` / `memoryBudgetWords` 搬进 `NotebookEntry`。

理由：

- 这会改变配置形状、设置页布局、CLI 的 patch 语义，影响面大于本计划的所有记忆改动；
- 当前更急的是“已有的全局字段改了之后不收敛”，不是“每个库要不同布局”；
- 若强行一起做，测试面会从配置收敛扩展到多库迁移，容易拖垮 P0。

**但做两件小事**：

1. 文档明确写“多库必须同构：目录 / 归档 / 预算全局”；
2. `notebooks add` / 设置页新增指向已有 zk 笔记本时，先检查目标是否有 `.zk/config.toml` 与已有 group，提示“会补建 notes/ journal/ 并追加 group”，给用户取消机会。

后续另案再评估 `NotebookEntry.layout?` 与 `memoryBudgetWords?`。

---

## 3. 实施里程碑

### M1（P0，配置收敛）

**落点**：

- 新增 `src/lib/notebook-config.ts`
- `src/lib/notebook.ts`：`StructureStatus.groups` / `groupsOk` / `groupWarnings`
- `src/config/store.ts`：`archiveDir` 变更保护
- `src/cli.ts`：`zk-kit groups [--fix] [--dry-run]`、doctor 输出
- `src/features/settings/feature.ts` / `client.ts`：快照与告警
- `test/zk.test.ts`

**任务**：

1. 实现 group block 解析（只读；解析失败返回 null）。
2. `structureStatus` 计算 `groups`；`ensureNotebook` 不再追加同路径 group，返回 `groupWarnings`。
3. `writeConfig` 阻断非空 `archiveDir` 变更；新增错误文案。
4. `zk-kit groups`：默认 dry-run，`--fix` 只改 plugin-owned 的 paths，写前备份。
5. doctor：列出每个 group 的 expected/actual；缺 group 为 ✗，路径不一致为 ⚠️。
6. 设置页：保存后若 `groupsOk === false`，显示“配置与 .zk/config.toml 不一致，跑 `zk-kit groups --fix`”；先不加按钮。
7. 测试：
   - 改 `dailyDir` / `notesDir` 后 `groupsOk=false`，`--fix` 后 paths 更新；
   - 改 `dailyGroup` 不产生重复路径 group；
   - 用户自定义 template / extra 不被 `--fix` 覆盖；
   - `archiveDir` 非空变更被拒；空目录 / 不存在目录允许；
   - flat 0.1.0 初始化产物逐字节不变。

**验收**：

- 临时库复现步骤不再产生 `[group."diary"]` 重复段；
- `doctor` 能指出“daily 期望 journal，实际 diary”；
- `--fix` 后 `zk-kit daily` 重新套用 daily 模板与日期文件名；
- 改 `archiveDir` 被明确拒绝，不再静默让旧归档进入检索。

### M2（P1，记忆生命周期）

**落点**：

- 新增 `src/lib/memory-format.ts`
- `src/lib/memory.ts`：日期感知截断、退役行过滤、`memoryUsage`
- `src/lib/dream.ts`：跳过退役行、`memory` / `retireCandidates`
- `src/lib/lint.ts`：复用 parser、`stale`
- `test/zk.test.ts`

**任务**：

1. `memory-format.ts`：条目切分 / 日期 / 退役 / `stripRetiredEntries`。
2. `memory.ts`：
   - 截断时选最旧日期条目；
   - 过滤退役条目并加一行省略提示；
   - 新增 `memoryUsage(cfg)`。
3. `dream.ts`：
   - `promotionsOf` 链接匹配用原文、标题匹配用 strip 退役行后的正文（顺序见 D3.3）；
   - 结果加 `memory` 与 `retireCandidates`；
   - `zk_dream` 文本输出加余量 / 退役行。
4. `lint.ts`：
   - 复用 `isRetiredEntry` / `entryDate`；
   - `memoryLinkIssues` 增加 `stale`；
   - `formatMemoryLinks` 增加“超过 N 天未复核”。
5. 测试：
   - 日期乱序：最旧一条被丢，TOC 顺序保持原位置；
   - 无日期：退回尾部丢，行为与 0.8.3 一致；
   - 退役行：不出现在 payload，notice 有省略数，dream 不再误判复用标题；
   - 退役行的 `→ [[新结论]]` 仍算已晋升（链接匹配在 strip 前）；`[Superseded …]` 大小写都算退役；
   - `memoryUsage` 的 `words` 与 `zk_context` 的 `payload.words` 完全一致（含提示行）；`totalWords` 才是含框与提示的总量；
   - `stale`：90 天边界、非法日期不误报。

**验收**：

- 一个“新条目在底部 + 旧条目在顶部”的 MEMORY，超预算时丢的是旧条目；
- 退役行不再占正文预算，但仍能在磁盘 / 记忆页看到；
- `zk_dream` 输出“记忆：内容 285/300 + 提示 51 = 336 词（余 -36）”与“可考虑退役：…”，且不写任何文件。

### M3（P1，可见性）

**落点**：

- `src/features/readonly/feature.ts` / `html.ts`
- `src/features/settings/feature.ts` / `client.ts`
- `src/lib/lint.ts` 文案
- `docs/features/memory.md` / `settings.md` / `provisioning.md` / `zk-tools.md`
- `test/zk.test.ts`

**任务**：

1. 记忆页加载 `memoryLinkIssues(cfg, all, { staleDays: 90 })`，渲染摘要与小表；退役行加样式。
2. 设置页 snapshot 增加轻量 `memoryHealth`；客户端显示一行“记忆健康：无来源 5 · 无日期 4 · 已退役 1”。
3. `zk_lint` / `zk-kit lint` 输出 stale 行；文档同步。
4. 测试：记忆页包含摘要与原因；meta 仍不能按路径打开；页面无写路由。

**验收**：

- 本机 `~/zdiary` 打开记忆页能看到“5 个无来源 / 4 个无日期”；
- 设置页不用跑 CLI 就能看到记忆健康计数；
- 只读视图仍然 GET-only。

### M4（P2，layered 旧笔记）

**落点**：

- `src/lib/notebook.ts`：`rootNotes`
- `src/lib/lint.ts`：`outsideGroups`
- `src/cli.ts` / 设置页确认文案
- （可选）`src/cli.ts`：`migrate --dry-run`
- `test/zk.test.ts`

**任务**：

1. `structureStatus` 统计 layered 下 notes 根笔记；设置页切换确认与 doctor 使用。
2. `LintResult.outsideGroups`：按实际 group paths 判断，列出前 20 篇。
3. （可选）`zk-kit migrate --dry-run` 给出建议；`--write` 复用 `renameNote`。
4. 测试：
   - layered 下 `notes/x.md` 进 outsideGroups；`notes/concepts/x.md` 不进；
   - flat 不报 outsideGroups；
   - 没有 group 的配置退回期望路径，不误报 group 内笔记；
   - migrate dry-run 不写文件；写入后链接不断。

**验收**：

- flat 老库切 layered 后，lint 直接说“N 篇不在任何 group”；
- 设置页切换前能看到这个 N；
- 不实施 migrate 也不阻塞，报告已经能防止“新建必须选目录”的困惑。

---

## 4. 测试计划

**自动测试（`bun run test`）**：

| 类别 | 用例 |
|---|---|
| group 解析 | 双引号 / 单引号 / 缺 paths / 重复 group / 注释与空行 |
| 配置收敛 | 改 dailyDir、notesDir、dailyGroup、archiveDir；fix 只改 plugin-owned paths |
| archive 保护 | 非空旧 archive 拒绝；空 / 不存在允许；错误文案 |
| 日期截断 | 乱序日期、同日、非法日期、全无日期、TOC 顺序 |
| 退役 | 单行 / 多行 / 缩进续行；大小写；payload 省略；dream 排除旧标题但保留 `→ [[新]]`；复用标题 |
| memoryUsage | `words` 等于 `payload.words`；`totalWords === countWords(text)`；有提示时 `headroom` 可以为负 |
| stale | 89 / 90 / 91 天；非法日期不报 |
| 记忆页 | 摘要、问题表、退役样式、meta 拒绝、无写路由 |
| outsideGroups | layered / flat；group 子目录；缺失 group 回退 |
| 回归 | flat 0.1.0 产物；现有 144 条全绿 |

**手工验收**：

1. 临时 vault：N1 复现步骤 → `doctor` 报错 → `groups --fix` → 新建日记检查 frontmatter / 文件名。
2. 本机 `~/zdiary`：`zk-kit lint` 的 unlinked / undated 与记忆页一致；`zk_dream` 有余量行。
3. 参考库（只读副本）：退役行不出现在注入文本，但记忆页仍可见。
4. 只读视图：`curl` 记忆页 / API，确认没有写入口、没有绝对路径泄漏。

**基线**：当前 144 pass / 0 fail。目标 ≥ 160 pass；`bun run check` 与 `bun run smoke` 全绿。

---

## 5. 兼容与迁移

1. **配置**：不新增必填键；`groups` / `rootNotes` / `memoryHealth` 都是派生视图，不落盘。
2. **archiveDir**：从“可自由改”变成“旧目录非空时拒绝”；这是有意的破坏性收紧，发布说明要写清楚。
3. **MEMORY**：无日期条目行为不变；退役行从载荷消失，但磁盘、git、记忆页仍保留；notice 明确说明省略了几条。
4. **dream**：新增字段是 additive；旧的 `newNotes` / `alreadyPromoted` 语义不变。
5. **只读视图**：新增展示，不新增写路由；安全头 / GET-only / 回环门不变。
6. **flat 不变式**：仍只建 `notes/` + 日记 + daily 模板；不新增 AGENTS / WORKFLOW / 目录。
7. **版本**：建议 0.9.0；`docs/features/*` 与 README 的记忆预算 / lint 字段说明同步；`scripts/docs.ts` 计数更新。

---

## 6. 不做 / 备选 / 另案

### 6.1 不做

- 自动重写整份 `config.toml`：风险高于收益；只做显式 `groups --fix`。
- 自动移动 `archiveDir` 旧文件：涉及文件搬移与链接重写，独立评审。
- 自动退役 MEMORY 条目：语义判断是 agent / 人的活；插件只给候选。
- 在注入里保留完整退役行：与“退役行不占预算”冲突；保留一行省略提示即可。
- 按语义判断 MEMORY 条目冲突：不做，保持机械边界。

### 6.2 备选

- **MEMORY 重复条目检测**：可复用 `similarTitles` 的 bigram 思路，但条目是句子，误报率需要实测；本计划先不做，等 stale 上线后再评估。
- **每库预算**：见 6.3；如果多库需求变强，再设计 `NotebookEntry` 可选覆盖。
- **记忆页逐条 badge**：本计划先做摘要 + 问题表；逐条 badge 需要自定义列表渲染，放到后续。

### 6.3 另案：多笔记本布局

若要做，建议形状：

```ts
interface NotebookEntry {
  path: string
  structure: Structure
  notesDir?: string
  dailyDir?: string
  dailyGroup?: string
  archiveDir?: string
  memoryBudgetWords?: number
}
```

`normalizeConfig` 解析 active 条目时，条目值优先、全局值兜底；`writeConfig` 的 patch 语义要同时支持“改全局默认”和“改某库覆盖”，设置页需要每行展开。这个改动会碰配置、CLI、设置页、记忆注入、所有 zk 工具的 cfg 解析，建议单独计划。

---

## 7. 验收清单

- [ ] `bun run check` 全绿（typecheck / build / dist / test）。
- [ ] `bun run smoke` 全绿。
- [ ] 临时库 N1 复现步骤不再产生重复 group；doctor 能定位；--fix 后模板生效。
- [ ] 非空 archiveDir 变更被拒，旧归档不再进入检索。
- [ ] MEMORY 乱序日期时丢最旧；全无日期时行为与 0.8.3 一致。
- [ ] 退役行不出现在 payload，notice 有省略数；dream 不再误判复用标题。
- [ ] `zk_dream` 输出记忆余量与退役候选，且不写文件。
- [ ] 记忆页 / 设置页能看到 unlinked / undated / retired / stale。
- [ ] layered 旧 notes 根笔记被 lint 报为 outsideGroups。
- [ ] flat 0.1.0 产物逐字节不变；只读视图仍 GET-only。
