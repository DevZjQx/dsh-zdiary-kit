# 计划：笔记本结构与记忆质量（Q1–Q8，附 Q9–Q12 另案）

**状态**：待实施（2026-11-02 起草；基线 v0.8.3）
**目标**：收掉一批「不报错、但每天都在产生坏数据」的问题 —— 来源模板把正文放错小节、日记的未完成项越过窗口就消失、记忆预算只算正文不算提示、标签有两个真相、dream 的使用信号只认 wiki 链。
**基线事实**：
- 测试基线 144 pass / 0 fail（见 `docs/plan-notebook-config-memory-lifecycle.md`）。
- 参考库 `bili-lite-work`（只读页）当前 `322/500` 词、MEMORY 已有 1 条退役行；本计划不把它当验收硬指标，只当样本。
- 本计划与 0.9 计划并行：0.9 覆盖 group 收敛、日期感知截断、退役行、dream 余量、记忆健康页、layered 根笔记报告；本计划**不重复**这些内容，只在 `dream.ts` / `memory.ts` / `lint.ts` 上做增量，实施时按 0.9 的实际落地状态 rebase。

**不在本计划内**：向量 / embedding；定时器 / cron；MEMORY 写入 API；语义冲突判断；多笔记本按库覆盖布局（0.9 §6.3）；机器级 USER 层（§6.3）；source 三段来源链字段（§6.4）。

---

## 0. 问题清单

| ID | 问题 | 级别 | 本计划 |
|---|---|---|---|
| Q1 | `source.md` 的 `{{content}}` 落在 `## Quotes` 下，正文被贴成引文；`Summary` / `Key claims` 常留空 | P1 | ✅ M1 |
| Q2 | `zk_dream` 只扫窗口内日记的 `## Loose ends`，窗口一推进，旧未完成项静默消失 | P1 | ✅ M2 |
| Q3 | 记忆预算只算正文 + 目录，`<system-reminder>` 头、做梦提醒、截断 notice 都不计；`words` 与最终注入文本对不上 | P1 | ✅ M3 |
| Q4 | 模板写 `tags: []`，`zk_new` 只写正文 hashtag；zk 两者都索引，标签有两个真相 | P2 | ✅ M1 |
| Q5 | `zk_dream` 的 `dailyMentions` 只认 `zk graph` 入边；日记里写路径 / 标题纯文本不计 | P2 | ✅ M5 |
| Q6 | 补写旧笔记时 `created` 仍是今天，dream 窗口按 `created` 筛；`zk_new` 没有 `date`，`zk_daily --date` 只改文件名 | P2 | ✅ M4 |
| Q7 | flat 下 `zk_new dir=archive` 能建成功，但 archive 被排除出索引 —— 写进去就消失 | P2 | ✅ M5 |
| Q8 | `zk_lint` 没有「空小节 / 模板骨架」桶；空 `## Content` / `## Key claims` / `## Quotes` 只能靠人手工清 | P2 | ✅ M1 |
| Q9 | 14 个工具的描述合计 1354 词，`zk_lint` 单条 336 词，比默认记忆预算还大 | P2 | ⏸ 备选（§6.1） |
| Q10 | MEMORY 条目没有「单条太长 / 近似重复」检查；一条 300 词的条目无法被截断 | P2 | ⏸ 另案（§6.2） |
| Q11 | `USER.md` / `AGENTS.md` 每库一份，没有机器级层；多库要复制偏好与约定 | P3 | ⏸ 另案（§6.3） |
| Q12 | `source` 模板只有 `authority` 一个字段，装不下「原片 → 搬运 → 我」三段链 | P3 | ⏸ 另案（§6.4） |

---

## 1. 证据

### 1.1 Q1：来源模板把正文放进 `## Quotes`

`src/lib/notebook.ts:60-80`：

```text
## Summary

## Key claims

## Quotes

{{content}}

## Links
```

`## Quotes` 在 `:75`，`{{content}}` 在 `:77`。zk 的 `new` 把 stdin 正文替换到 `{{content}}`，所以 `zk_new({ body })` 建出的来源笔记，正文整段落在 `## Quotes` 下面。

临时库复现（同一份模板 + `zk new ... -i -p`）：

```text
## Summary

## Key claims

## Quotes

正文第一段。

第二段。

## Links
```

而 `zk_new` 自己的入参说明写的是「会插在模板的 `{{content}}` 位置（layered 下在 `## Content` 之下、`## Links` 之前）」（`src/features/zk-tools/feature.ts:541`）—— 对 `entry.md` 成立，对 `source.md` 不成立。`docs/features/zk-tools.md:52` 也按「`{{content}}` 落在 `## Content` 下面」写，文档与模板已经分叉。

影响：

1. 来源笔记的正文语义被标成引文，后续 `## Key claims` / `## Quotes` 的含义被混淆；
2. 每篇来源笔记通常留两个空壳（`Summary` 取决于有没有传 `summary`，`Key claims` 基本必空）；
3. 参考库 11-02 的整理记录里，一轮就清出 7 处空壳 / 5 篇，全部是 `zk_new` 模板残留。

### 1.2 Q2：Loose ends 只扫窗口内日记

`src/lib/dream.ts:325-330`：

```ts
const windowNotes = notes.filter((n) => {
  const at = Date.parse(n.created)
  return Number.isFinite(at) && at >= sinceMs
})
```

`:363-375` 只遍历 `windowNotes` 取 `looseEndsOf(body)`。窗口默认跟着 `DREAMS.md` 的「上次做梦」走（`:220-228`），所以每周整理一次时，上一周没划掉的项会在窗口推进后从 `zk_dream` 里消失。

参考库已经出现手工搬运：11-01 日记的「给大小姐的回复还没发」被重新写进 11-02 的 Loose ends。插件没有报错，也没有提示「还有更早的未完成项」。

### 1.3 Q3：记忆预算没有把提示算进去

`src/lib/memory.ts`：

- `:352` `bodies` 只拼三份文件正文；
- `:354` `finalWords = keptWords + countWords(toc)`；
- `:360-397` 的 `notes`（已截断 / 预算不足 / 记忆已用）只在 `:398` 拼进 `text`，没有回写 `finalWords`；
- `:401-408` 的 `<system-reminder>` 头、`:400` 的做梦提醒、`:398` 的 notice 都在预算之外。

临时夹具（40 条 MEMORY、预算 120 词）：

```text
payload.words       = 117
countWords(payload.text) = 184
```

`docs/features/memory.md:4` 写的是「注入有硬预算，截断多少必须可观测」；当前 `words` 只覆盖正文 + 目录，模型实际收到的文本可以比 `budget` 多 50% 以上。`zk_context`、设置页、`doctor` 读的都是同一个 `words`，所以三处会一起偏小。

### 1.4 Q4：标签有两个真相

- `src/lib/notebook.ts:66`、`:89`：`source.md` / `entry.md` 都写 `tags: []`；
- `src/lib/zk.ts:1718-1732`：`withTags` 只把 `#tag` 追加到正文；
- `src/lib/zk.ts:632-651`：`noteFromDisk` 从正文 hashtag 解析 tags；
- `src/lib/zk.ts:1738`：`taglessCjkWarning` 只看入参 + 正文 hashtag，不看 frontmatter。

zk 0.15.7 实测：frontmatter `tags: [fmTag]` 的笔记能被 `zk list -t fmTag` 命中；正文 `#hashTag` 的笔记能被 `-t hashTag` 命中；两者都不算 `--tagless`。也就是说：

1. 检索不受影响（参考笔记 02:38 的自我更正成立）；
2. 但「文件里写着 `tags: []`、实际却有标签」是事实；
3. 人改 frontmatter 删标签，正文 hashtag 还在；改正文删 hashtag，frontmatter 还在；
4. 只写 frontmatter、正文没有 hashtag 的笔记，不会被 `taglessCjkWarning` 发现（虽然 zk 索引里有）。

### 1.5 Q5：使用信号只认 wiki 入链

`src/lib/dream.ts:273-306`：

```ts
const inbound = new Map<string, string[]>()
for (const edge of edges) { ... }
const usageOf = (rel) => {
  const sources = (inbound.get(rel) ?? []).filter((p) => isUnder(p, cfg.dailyDir))
  ...
}
```

`edges` 来自 `graphEdges`（`src/lib/zk.ts:477`），只包含 `[[链接]]` / Markdown 链接；日记里写 `notes/concepts/xxx` 或直接写标题不产生边。参考库 11-01 日记正文提了很多篇笔记，页面「反链」只有 2 条，`dailyMentions` 基本为 0，`topCited` 实际退化成纯入链排序。

zk 本身有 `zk list --mentioned-by <daily>`（按标题提及过滤），但插件没用；逐篇日记起一个 zk 进程也不划算，应该在已载入的 `notes` 上做一次 JS 匹配。

### 1.6 Q6：补写旧笔记的日期不进 dream 窗口

- `src/lib/dream.ts:326-330` 用 `Date.parse(n.created)` 筛窗口；
- `src/lib/zk.ts:1064-1081` 的 `ensureDailyNote` 把 `--date` 传给 `zk new`，但日记模板没有 frontmatter `date`，文件名才是日期；
- `zk new --date 2020-05-05` 实测：`created` 仍是 `2026-11-02T...`，frontmatter 也是空（fresh 临时库，默认 flat 模板）；
- `src/lib/notebook.ts:63`、`:86` 的 `date: {{format-date now}}` 只会写今天。

结果：用 `zk_daily --date` 补写 10 月底的日记，`dream` 的 `window` 仍把它算成本周新增，旧的 Loose ends 会重新出现；用 `zk_new` 补写旧笔记同理，且没有参数可以修正。

注：zk 在**首次索引**时会用 frontmatter `date` 作为 `created`（实测 `date: 2020-01-01` → `created: 2020-01-01T00:00:00Z`）；但首次索引之后再改 frontmatter，`created` 不会回写（实测 `zk index --force` 也不变），只有 `metadata.date` 会更新。所以本计划以 `noteDate` 读 frontmatter 为准，不试图改 zk 的 `created`。

### 1.7 Q7：flat 下可以把新笔记建进 archive

- `src/lib/notebook.ts:166-181`：flat 分支 `return given || normDir(cfg.notesDir)`，不检查 `archiveDir`；
- `src/lib/zk.ts:597-617` 的 `assertWritablePath` 只拦 `raw/` 与 `inbox/`；
- `src/lib/zk.ts:299-305` 的 `excludedNames` 默认排除 `cfg.archiveDir`。

所以 `zk_new({ dir: 'archive' })` 在 flat 库会成功建文件，然后这篇笔记从检索、统计、反链里全部消失 —— 和 0.9 计划里 `inbox/` 的「写了、没报错、但搜不到」是同一类失败。

### 1.8 Q8：lint 没有空小节桶

`src/lib/lint.ts` 现有桶：解析失败、断链、孤儿、无标签、单向链接、陈旧、重名、疑似重复、记忆链接、frontmatter 缺字段、标签卫生、模板版本（`LintResult` 见 `:205-245`）。没有「标题下面没有正文」的检查。

后果：`zk_new` 留下的 `## Content` / `## Key claims` / `## Quotes` / `## Links` 空壳不会出现在体检里。参考库 11-02 的整理记录里，一轮清 7 处空壳 / 5 篇，全靠人读。

### 1.9 量级参考：工具描述

`buildTools()` + `countWords` 实测（只算 `description`，不含参数与输出 schema）：

```text
zk_lint 336 · zk_new 214 · zk_dream 138 · zk_rename 90
zk_supersede 96 · zk_search 67 · 其余合计 ...
TOTAL 1354 词 / 14 个工具
```

默认记忆预算是 500 词。插件对 MEMORY 的每个词都很克制，对工具描述却没有预算约束；`zk_lint` 一条描述就比大多数库的 MEMORY 还长。这是 §6.1 的备选，不在主计划内。

---

## 2. 设计决策

### D1：模板修正 + 显式迁移，不自动改写旧库

**问题**：直接改 `SOURCE_TEMPLATE` / `ENTRY_TEMPLATE` 只影响新库；已有库的 `.zk/templates/source.md` 不会更新（`ensureTemplates` 只在文件缺失时写，`src/lib/notebook.ts:275-285`）。自动覆盖又会碰用户自定义模板。

**决定**：

1. 新模板顺序固定为：

   ```text
   ## Summary

   ## Content

   {{content}}

   ## Links
   ```

   `## Content` 是正文的语义落点。只保留**有写入路径**的小节：`Summary` 由 `summary` 参数填、`Content` 由 `{{content}}` 填、`Links` 由 `zk_link` / `links` 填。
   `Key claims` / `Quotes` 不再预置 —— 它们没有写入路径，预置等于让每篇新来源笔记天生带两个空壳，正好撞上 Q8 的空小节桶（D7 还要把它们报出来），新笔记从第一分钟起就是「有问题」。
   要写引文的人在正文里自己加小节；lint 仍认这两个标题，专门用来抓旧库与手写的空壳。

2. `source.md` / `entry.md` 都去掉 `tags: []`（Q4）。新笔记的标签只由 `zk_new` 写入正文 `#hashtag`；frontmatter `tags` 仍被 zk 索引，但插件不再生成，手写时由用户自己保证只选一处。`docs/features/zk-tools.md` / README 同步。
   备选是保留 `tags:` 并让 `zk_new` 同时写两处；本计划不选 —— 现有工作流已经在正文写 hashtag，双写只是把「下次手改不同步」藏起来。

3. 新增 `src/lib/templates.ts`（或 `notebook-templates.ts`）：
   - 导出 `SOURCE_TEMPLATE` / `ENTRY_TEMPLATE` / `DAILY_TEMPLATE*` 的新版与 **0.8.3 旧版字符串**（`SOURCE_TEMPLATE_V083`、`ENTRY_TEMPLATE_V083`）；
   - `templateStatus(cfg)` 逐个比较磁盘文件：`current` / `outdated`（等于旧版）/ `customized`（既不等于新版也不等于旧版）/ `missing`；
   - 读不到，或内容不等于新版 / 0.8.3 旧版任何一版，一律算 `customized`，不猜。

4. 新增 CLI：

   ```text
   zk-kit templates            # 默认 --dry-run：打印 current / outdated / customized / missing
   zk-kit templates --fix      # 只替换 outdated；先备份 .zk/templates/<name>.bak
   ```

   `--fix` 只改 `source.md` / `entry.md` / `daily.md` 中状态为 `outdated` 的文件；`customized` 一律不碰。写临时文件后 rename，失败不留下半份。

5. `doctor` 增加一行：`模板：source/entry 旧版 N 个（跑 zk-kit templates --fix）`；设置页「自检」展示同一状态。

6. 旧笔记的正文**不自动搬移**。`## Quotes` 里已经有正文的老来源笔记，空小节 lint 看不到（因为它非空）；发布说明要明确提示「旧 source 笔记需人工看一眼」。可选后续加 `zk-kit lint --misplaced-source` 启发式（不在本计划）。

**被拒**：自动覆盖所有模板 —— 用户可能改过 `source.md` / `entry.md`，一次写坏所有新笔记的 frontmatter。  
**被拒**：在模板里加 `<!-- zdiary-template: vN -->` 版本标记 —— 它会被复制进每一篇笔记，白占记忆/正文预算；用旧版字符串比较已经够用。

### D2：Loose ends 跨窗口保留，窗口内语义不变

**决定**：

1. `DreamResult` 保留 `dailyLooseEnds`（窗口内，现有语义不变），新增：

   ```ts
   carriedLooseEnds: Array<{
     path: string
     date: string          // YYYY-MM-DD
     daysOld: number
     items: string[]
   }>
   counts.carriedLooseEnds: number
   ```

2. 扫描范围：`notes` 里所有 `isUnderDir(path, cfg.dailyDir)` 的笔记，最多 `MAX_DAILY_SCAN = 400` 篇；超出时置 `looseEndsTruncated: true` 并只报已扫到的。窗口内仍进 `dailyLooseEnds`；窗口外进 `carriedLooseEnds`，按日期升序（最老在前），最多 `MAX_BACKLOG`（10）条。

3. 只读：不自动把旧项写进新日记、不自动生成 DREAMS。`zk_dream` 文本输出加一行：

   ```text
   窗口外还有 3 条未完成（最早 2026-10-20）：...
   ```

4. 复用 `looseEndsOf`（`src/lib/dream.ts:150-165`），`- [x]` 仍跳过；日记正文读取缓存与 Q5 共用。

**为什么不是只扩大窗口**：窗口是「这次整理看哪段」的语义，扩大窗口会把「本周新增」也一起放大；跨窗口未完成项是另一类信号，应该分栏。

### D3：预算口径拆成「内容词」与「总词」

**决定**：

1. `MemoryPayload` 增加：
   ```ts
   totalWords: number      // countWords(text)，含框、做梦提醒、notice
   overheadWords: number   // totalWords - words
   totalRatio: number      // totalWords / budget
   ```
   `words` 保持现有语义（正文 + 目录），避免改动 `files[].words`、`ratio` 和现有测试；新增字段是 additive。

2. `zk_context` 的 output schema / render、只读记忆页、设置页、`doctor` 统一显示：

   ```text
   记忆内容 117/300 词 + 提示 67 词 = 184 词
   ```

   截断提示仍按内容词报告（`truncatedWords` 不变），但不再让人以为 117 就是全部。

3. 不在本轮强行把总词压进预算：`overhead` 由框、做梦提醒、截断说明组成，长度随状态变化；硬压需要预留固定额度，会把 500 词预算再切一刀。先让口径一致，是否预留另案（§6.1 的预算测试可以顺带评估）。

4. `memoryUsage(cfg)`（0.9 D4 计划新增）如果先落地，返回 `{ words, totalWords, budget, headroom }`；本计划实施时按实际函数名对齐，不新增第二套计数。

**被拒**：直接把 `words` 改成总词 —— 会让 `files[].words` 与 `words` 的加和不成立，现有测试、设置页、0.9 的 `memoryUsage` 都要一起改，收益只是少一个字段。

### D4：日期以 `noteDate` 为准，窗口与排序都用它

**决定**：

1. 新增 `noteDate(cfg, note): string`（`src/lib/dream.ts` 内部或 `src/lib/zk.ts` 导出）：
   - 日记：文件名是 `YYYY-MM-DD` → 用它；
   - 其他笔记：frontmatter `metadata.date` 是合法 `YYYY-MM-DD` → 用它；
   - 否则退回 `localDate(note.created)`。
   日期必须真校验（`2026-99-99` 不算），解析失败按无日期处理。

2. `dreamNotebook` 的 `windowNotes`、`backlog`、`candidateOf.created`、`dailyLooseEnds.date` 全部改用 `noteDate`；`usageOf` 里日记日期已经用文件名，保持。

3. `zk_new` 增加可选 `date`（`YYYY-MM-DD`）：
   - 只对 layered 生效：建完后把 frontmatter 的 `date:` 行替换成给定值，再 `refreshIndexQuietly`；
   - **只保证 `noteDate` 正确，不保证 zk 的 `created` 回写**：`created` 是首次索引时间，事后改 frontmatter 不会变（实测 `zk index --force` 也不变），但 `metadata.date` 会更新，`noteDate` 读的是它；
   - 模板里没有 `date:` 行（自定义模板）→ 返回 warning，不改文件；
   - flat 不支持（flat 笔记没有 frontmatter；给了 `date` 返回 warning，提示「flat 请手动编辑或切 layered」）。
   - `zk_daily` 不改：日记日期由文件名承载，dream 用 `noteDate` 读取。

4. `zk_new` / `zk_daily` 的 description 同步说明；`date` 参数不传时行为完全不变。

**为什么不是改 zk**：zk 首次索引已经会读 frontmatter `date`，插件只需要把值写进 frontmatter；`created` 的不可变性是 zk 的既有行为，本计划用 `noteDate` 绕开，不去重建索引。若以后要让 `zk list created` 也正确，另案用「建前临时模板」把日期在首次索引前写进去，不在本轮做。

### D5：使用信号合并「链接」与「提及」

**决定**：

1. 在 `dreamNotebook` 里建立 `mentionCounts: Map<targetPath, Set<dailyPath>>`：
   - 遍历所有 daily 笔记（与 D2 同一批，最多 `MAX_DAILY_SCAN`），每个正文读一次并缓存；
   - 对每篇非日记笔记，取 `normalizeTitle(title)`（长度 ≥ `MIN_TITLE_MATCH`，复用现有 6 字门槛）和去掉 `.md` 的相对路径；
   - `normalizeTitle(dailyBody).includes(key)` 命中即记一条 `(daily, target)`；
   - 同一篇日记里重复出现只算一次；同一目标被多篇日记提到，按不同日记 / 不同日期计数。

2. `usageOf(rel)` 的数据来源改为「入边来源 ∪ 提及来源」，再按 `isUnder(dailyDir)` 过滤、按日记文件名取日期；`dailyMentions` / `daysMentioned` / `lastMentioned` 的语义不变。

3. 性能：`D × N` 次 `includes`，`D ≤ 400`、`N ≤ MAX_SCAN`；在 200 篇笔记 / 100 篇日记的规模下可接受。超过上限时 `usageTruncated: true`，只报已扫部分。

4. `cited`（入链数）仍只算 `zk graph` 的边；提及只影响 `dailyMentions` / `daysMentioned` 与 `topCited` 的排序，不冒充反链。

**被拒**：逐篇日记跑 `zk list --mentioned-by` —— 100 篇日记就是 100 个进程；已有 `notes` 全量，JS 匹配更便宜，也避免 zk 的 cwd / 路径坑。

### D6：新建笔记不得落在 archive

**决定**：

1. `createNote` 在 `mkdir` 之前检查目标相对路径：落在 `cfg.archiveDir` 下直接 `ZkError`，文案说明「archive 只放 supersede 搬进去的废弃笔记；新笔记请写 notes/ 或 journal/」。
2. `newNoteDir` 的 flat 分支同样提前拒绝（给 `zk_new` 更早的错误）；两处共用一个 `assertNotArchiveCreate`。
3. `supersedeNote` 的 `fs.rename` 不受影响；`zk_rename` 到 archive 仍允许（人明确要归档），但会在结果里提示。
4. 测试覆盖：`dir=archive`、`dir=archive/sub` 拒绝；`supersede` 正常；flat 0.1.0 产物不变。

### D7：空小节只报「模板已知标题」，不猜语义

**决定**：

1. `LintResult` 增加：

   ```ts
   emptySections: {
     total: number                 // 有问题的笔记数
     items: Array<{
       title: string
       path: string
       sections: string[]          // 空的小节标题，按文件顺序
     }>
   }
   ```

2. 只检查已知模板标题（大小写不敏感、去首尾空白）：`Summary`、`Content`、`Key claims`、`Quotes`、`Links`。不报任意自定义空标题，避免把「故意留白」当问题。
   清单比新模板宽：`Key claims` / `Quotes` 已从模板移除（D1），仍留在清单里专门抓旧库与手写的空壳。

3. 跳过日记（`isUnderDir(path, cfg.dailyDir)`）：`## Observations` 在每篇日记里本来就会空着，报出来只会淹没真问题。

4. 判定规则：
   - 围栏代码块里的 `##` 不算标题（复用 `zk.ts` 的 fenced 逻辑，必要时导出）；
   - 小节内直到下一个同级或更高级标题为止，没有非空、非标题行 → 空；
   - 如果只有更深的子标题，递归看子标题是否有内容；全空才算空；
   - 只报 `##` 级别（模板小节都是 `##`），不报 `###`。

5. `zk_lint` 文本输出加一行 `空小节：N 处 / M 篇（空壳；用 zk_append 或编辑器补/删）`；`LINT_EMPTY` schema 加到工具输出。只报告，不改文件。

**被拒**：建完自动删空小节 —— 会静默改正文，且手写的 `## Quotes` 可能正是人准备填的骨架；报告 + 人裁决更符合现有边界。

---

## 3. 实施里程碑

建议顺序：M1 → M2 → M3 → M4 → M5。M1 的模板迁移独立于 0.9；M2 / M4 / M5 都改 `dream.ts`，如果 0.9 的 M2 / M3 同批落地，先合 0.9 的 `memory-format.ts` / `memoryUsage`，再按本计划的字段做增量，避免两套 `dream` 结果结构。

### M1（P1/P2，模板与空小节）

**落点**：
- `src/lib/templates.ts`（新）：模板字符串、旧版字符串、`templateStatus`
- `src/lib/notebook.ts`：`ensureTemplates` 用新模板；`SOURCE_TEMPLATE` / `ENTRY_TEMPLATE` re-export 兼容
- `src/cli.ts`：`zk-kit templates [--fix] [--dry-run]`；`doctor` 模板行
- `src/lib/lint.ts`：`emptySections`
- `src/features/zk-tools/feature.ts`：`zk_lint` schema / render
- `src/features/settings/feature.ts` / `client.ts`：快照与自检展示
- `docs/features/zk-tools.md`、`docs/features/provisioning.md`、`README.md`
- `test/zk.test.ts`

**任务**：
1. 新 `source.md` / `entry.md`：`Summary → Content → {{content}} → Links`；去掉 `tags: []` 与 `Key claims` / `Quotes` 空壳。
2. `templateStatus(cfg)` 支持 `current / outdated / customized / missing`；`--fix` 只替换 `outdated`，备份 `.bak`，写临时文件后 rename。
3. `doctor` 与设置页展示模板状态；`--fix` 不碰 `customized`。
4. `emptySections`：已知标题、跳过日记、fenced 安全、最多 50 条；`formatLintExtras` 与 `zk_lint` 输出。
5. 文档更新：`{{content}}` 的位置、标签只走正文 hashtag、旧库迁移命令。

**验收**：
- 新 layered 库建 source 笔记，正文在 `## Content` 下，且不再生成空的 `## Key claims` / `## Quotes`；
- 旧库 `zk-kit templates` 报 `outdated`，`--fix` 后新建笔记用新模板，旧笔记一个字没动；
- 自定义过的 `source.md` 报 `customized`，`--fix` 不覆盖；
- `zk_lint` 能报出参考库里的空 `## Content` / `## Key claims` / `## Quotes` / `## Links`；
- flat 0.1.0 初始化产物逐字节不变（flat 只写 `daily.md`，本轮不改）。

### M2（P1，Loose ends 跨窗口）

**落点**：
- `src/lib/dream.ts`：`carriedLooseEnds`、`MAX_DAILY_SCAN`、`looseEndsTruncated`、`counts.carriedLooseEnds`
- `src/features/zk-tools/feature.ts`：`zk_dream` output schema / render
- `src/cli.ts`：`dream` 文本输出
- `test/zk.test.ts`

**任务**：
1. 抽 `dailyBodies(cfg, notes)`：一次读取所有 daily 正文并缓存，供 Loose ends 与 Q5 共用。
2. 窗口内仍进 `dailyLooseEnds`；窗口外进 `carriedLooseEnds`（升序、最多 10 条、带 `daysOld`）。
3. `counts.carriedLooseEnds` 与 `looseEndsTruncated` 进结果；`zk_dream` 文本加一行。
4. 测试：窗口外旧项出现、`- [x]` 跳过、超过 10 条截断、无日记库为空、扫描上限标记。

**验收**：
- 把一篇 30 天前的日记留在库里，`zk_dream` 的 `carriedLooseEnds` 能看到它；
- 旧项不会因为 `DREAMS.md` 更新而消失；
- 不写任何文件。

### M3（P1，预算口径）

**落点**：
- `src/lib/memory.ts`：`totalWords` / `overheadWords` / `totalRatio`
- `src/features/zk-tools/feature.ts`：`zk_context` schema / render
- `src/features/readonly/feature.ts`：记忆页用量行
- `src/features/settings/feature.ts` / `client.ts`：快照与状态行
- `src/cli.ts`：`doctor` 记忆行
- `docs/features/memory.md`、`README.md`
- `test/zk.test.ts`

**任务**：
1. `computePayload` 结束时算 `totalWords = countWords(text)`、`overheadWords = max(0, totalWords - words)`；`totalRatio` 用 `budget` 为分母。
2. `zk_context` 返回新字段；render 显示「内容 X/Y + 提示 Z = T 词」。
3. 记忆页 / 设置页 / `doctor` 用同一个口径；`words` 仍用于 `files` 与截断逻辑。
4. 文档说明两个数字的差别；`zk_context` 的 `ratio` 保持内容比，新增 `totalRatio`。
5. 测试：`totalWords === countWords(text)`；有截断时 `overheadWords > 0`；无文件时全 0；`words` 不变。

**验收**：
- 临时夹具从「117/120」变成「内容 117/120 + 提示 67 = 184」，三处显示一致；
- 截断行为、`truncatedWords`、`tocWords` 与 0.8.3 一致；
- 0.9 的 `memoryUsage` 如果已落地，直接复用，不出现第二套计数。

### M4（P2，日期）

**落点**：
- `src/lib/dream.ts`：`noteDate`，窗口 / 排序 / `candidateOf.created`
- `src/lib/zk.ts`：`createNote` 的 `date` 入参、frontmatter `date:` 替换、`refreshIndexQuietly`
- `src/features/zk-tools/feature.ts`：`zk_new` 的 `date` 参数 / output warning
- `test/zk.test.ts`

**任务**：
1. `noteDate(cfg, note)`：日记文件名 → frontmatter `date` → `created`；严格校验。
2. `dreamNotebook` 的 `windowNotes` / `backlog` / `candidateOf.created` / `dailyLooseEnds.date` 改用 `noteDate`。
3. `zk_new({ date })`：只对 layered 且模板有 `date:` 行生效；替换后刷新索引；模板没有该行返回 `dateWarning`；flat 返回 warning 不改文件。
4. 测试：`zk_daily --date` 补写的旧日记不进窗口；`zk_new date` 后 frontmatter `date` 是给定日期、`noteDate` 读到它；非法日期拒绝；flat 不产生 frontmatter。

**验收**：
- 补写 2026-10-01 的日记不会出现在本周 `windowNotes`；
- `zk_new date: 2026-10-01` 建出的 layered 笔记，frontmatter `date` 是 2026-10-01，`zk_dream` 的 `noteDate` 用它；zk 的 `created` 可能仍是今天（已知限制，不影响 dream）；
- 不传 `date` 时行为与 0.8.3 完全一致。

### M5（P2，提及信号与 archive 守卫）

**落点**：
- `src/lib/dream.ts`：`mentionCounts`、`usageOf` 合并、`usageTruncated`
- `src/lib/zk.ts` / `src/lib/notebook.ts`：`assertNotArchiveCreate`
- `src/features/zk-tools/feature.ts`：`zk_new` 错误文案 / `zk_dream` 输出
- `test/zk.test.ts`

**任务**：
1. `mentionCounts` 基于 `dailyBodies` 缓存，标题（≥6 字）与去扩展名路径两种 key；同日记去重。
2. `usageOf` 改为「入边 ∪ 提及」；`cited` 不变；`topCited` 排序自然生效。
3. 超过 `MAX_DAILY_SCAN` 时 `usageTruncated=true`，只报已扫部分。
4. `assertNotArchiveCreate(cfg, rel)`：`createNote` / `newNoteDir` flat 分支拒绝 `archive/`；`supersede` 不受影响。
5. 测试：纯文本 `notes/concepts/x` 计数、标题提及计数、短标题不误报、链接 + 提及不重复、archive 拒绝。

**验收**：
- 参考库 11-01 那种「正文写路径、不写 `[[链接]]`」的日记能提高 `dailyMentions` / `daysMentioned`；
- `zk_new dir=archive` 报错，`zk_supersede` 仍能把旧笔记搬进 archive；
- 现有 `topCited` 在没有日记提及的库上排序不变。

---

## 4. 测试计划

**自动测试（`bun run test`）**：

| 类别 | 用例 |
|---|---|
| 模板 | 新 source 正文在 `## Content` 下；不再生成 `## Key claims` / `## Quotes` 空壳；entry 不变；`tags: []` 不再生成 |
| 模板迁移 | `current / outdated / customized / missing` 四态；`--fix` 只改 outdated；备份存在；自定义不覆盖 |
| 空小节 | 已知标题空壳被报；自定义空标题不报；日记 `## Observations` 不报；fenced `##` 不算；嵌套子标题有内容不算空 |
| Loose ends | 窗口外旧项进 `carriedLooseEnds`；`- [x]` 跳过；最多 10 条；`looseEndsTruncated`；无日记为空 |
| 预算 | `totalWords === countWords(text)`；`overheadWords > 0`；`words` / `truncatedWords` 不变；三处显示一致 |
| 标签 | 新笔记无 `tags:` 字段；正文 hashtag 可被 `zk_query(tags)` 命中；手写 frontmatter tags 仍可检索 |
| 日期 | `zk_new date` 写 frontmatter；`noteDate` 跟随；zk `created` 不回写也不影响 dream；非法日期拒绝；flat 不改；`zk_daily --date` 不进窗口 |
| 提及 | 纯文本路径 / 标题命中；短标题不命中；同日记去重；链接 + 提及合并；`usageTruncated` |
| archive | `zk_new dir=archive` / `archive/sub` 拒绝；`supersede` 正常；flat 0.1.0 产物不变 |
| 回归 | 现有 144 条全绿；`bun run check` / `bun run smoke` 全绿 |

**手工验收**：

1. 临时 layered 库：建 source 笔记（带 body、不给 summary）→ 正文在 Content，不再有 Key claims / Quotes；`zk_lint` 只报空 `## Summary`，传了 summary 就不报。
2. 旧模板库复制一份：`zk-kit templates` 报 outdated → `--fix` → 新建笔记用新模板；旧笔记 diff 为空。
3. 参考库只读副本：`zk_dream` 出现窗口外未完成项；`zk_context` 显示内容 + 提示 + 总数。
4. 补写一篇 30 天前的日记：不进 `windowNotes`，但它的 Loose ends 在 `carriedLooseEnds`。
5. 日记里写 `notes/concepts/xxx` 不写链接：`zk_dream` 的 `dailyMentions` 增加。
6. `zk_new dir=archive` 被拒；`zk_supersede` 仍能归档。

**基线**：144 pass / 0 fail；目标 ≥ 158 pass。

---

## 5. 兼容与迁移

1. **模板**：新库自动用新模板（去掉 `Key claims` / `Quotes` 空壳与 `tags: []`）；旧库保持原文件，`zk-kit templates --fix` 显式迁移，只替换与 0.8.3 旧版逐字相等的文件；`customized` 不动。旧笔记正文不搬移。
2. **标签**：只改模板生成；已有笔记的 `tags: []` 原样保留。zk 仍索引 frontmatter tags，手动写法不被禁止；文档说明「新笔记用正文 hashtag，别两处都写」。
3. **空小节**：新增只读桶，默认最多 50 条；不会改任何笔记。日记跳过。
4. **Loose ends**：`dailyLooseEnds` 语义不变；新增 `carriedLooseEnds` / `counts.carriedLooseEnds` 是 additive。`zk_dream` 文本多一行，结构化输出多字段。
5. **预算**：`words` / `ratio` / `files` / `truncatedWords` 不变；新增 `totalWords` / `overheadWords` / `totalRatio`。设置页与 `doctor` 的展示文字变化，不改变预算逻辑。
6. **日期**：`zk_new` 的 `date` 是可选参数；不传时行为不变。它只写 frontmatter `date`，不改变 zk 的 `created` 语义；`noteDate` 只在 `dream` 内使用。flat 不支持 `date`。
7. **archive**：`zk_new` 从「能建但搜不到」变成明确报错；发布说明写清楚。`supersede` / `rename` 不变。
8. **flat 不变式**：flat 仍只建 `notes/` + 日记 + `daily.md`；本轮不改 flat 模板，0.1.0 产物逐字节不变。
9. **版本**：建议 0.9.1（若与 0.9 同批则并入 0.9.0）。`docs/features/*` 与 `scripts/docs.ts` 的计数同步。

---

## 6. 不做 / 备选 / 另案

### 6.1 备选：工具描述预算（Q9）

当前 `buildTools()` 的 description 合计 1354 词，`zk_lint` 336 词。建议单开一个文档级整理，不在本计划里做，因为：

- 工具描述是模型正确调用工具的主要依据，删减需要逐条评估；
- 本计划的 M1 还会给 `zk_lint` 加一个桶，描述只会更长。

若要做，建议：

1. 目标 `description` 合计 ≤ 1000 词（按 `countWords`），单条 ≤ 180 词；
2. `zk_lint` 只保留「查什么、输出有哪些桶、只读」；桶的解释移到 `docs/features/zk-tools.md`；
3. 加一条测试 `buildTools()` 的描述总词数上限，防止回涨；
4. 不新增 `zk_help` 工具（它自己也要占描述）。

### 6.2 另案：MEMORY 条目长度与近似重复（Q10）

0.9 计划会新增 `memory-format.ts`（条目切分 / 日期 / 退役）。在它之上再加两个只读桶更合适：

- `longEntries`：单条 > `min(80, budget / 4)` 词；一条太长时三级切分丢不掉，只能整篇超预算；
- `similarEntries`：复用 `similarTitles` 的 bigram，标题/首行相似度 ≥ 0.6，只报告。

不在本计划做：条目是句子，误报率需要真实库校准；先让 0.9 的 `memory-format.ts` 落地。

### 6.3 另案：机器级 USER / AGENTS 层（Q11）

现在 `memory.ts` 的 `readMeta` 只读 `cfg.notebook` 根目录（`src/lib/memory.ts:236-245`），多笔记本用户要把 USER 偏好、AGENTS 约定复制 N 份。

可评估的形状：

- `~/.dsh/zdiary/USER.md`（机器级）+ `<notebook>/USER.md`（库级）；
- 注入顺序：全局 AGENTS → 本库 AGENTS → 全局 USER → 本库 USER → MEMORY；
- 同名小节以后者覆盖，或只做拼接 + 目录；
- 预算归因要能区分「全局吃掉的」和「本库吃掉的」；
- 配置里加开关，默认关闭，避免改变现有单库行为。

这会改注入语义、预算和 `zk_context` 输出，单独评审。

### 6.4 另案：source 三段来源链（Q12）

参考库的约定是「原片 → 搬运 → 我」，`authority` 只评原片；现在 `source.md` 只有 `authority` 一个字段，装不下。

可评估：

```yaml
authority: expert      # 只评 origin
origin: BV...          # 原片
via: 中配 / 搬运        # 二手路径
```

- `zk_new` 增加可选 `origin` / `via`，写进 frontmatter；
- `zk_lint` 对 `type=source` 且缺 `origin` 的笔记提示（只提示）；
- `zk_query` 暂不支持按 extra 过滤，若要做「BV 索引」需要另加参数或标签约定。

这是模板 schema 的扩展，不是本计划的结构修复；先不动。

---

## 7. 验收清单

- [ ] 新建 layered source 笔记：正文在 `## Content` 下，不再有 `## Key claims` / `## Quotes` 空壳；`tags: []` 不再生成。
- [ ] `zk-kit templates` 能区分 current / outdated / customized / missing；`--fix` 只改 outdated 并备份。
- [ ] `zk_lint` 报出已知模板空小节；日记 `## Observations` 不报；自定义空标题不报。
- [ ] `zk_dream` 的 `carriedLooseEnds` 能看到窗口外未完成项，且不写文件。
- [ ] `zk_context` / 记忆页 / 设置页 / `doctor` 的「内容 + 提示 = 总词」一致，`totalWords === countWords(text)`。
- [ ] 新笔记用正文 hashtag，`zk_query(tags)` 命中；手写 frontmatter tags 仍可检索。
- [ ] `zk_new date` 生效；补写旧日记不进 dream 窗口；非法日期拒绝。
- [ ] 日记正文写路径/标题（不写 `[[链接]]`）能提高 `dailyMentions` / `daysMentioned`。
- [ ] `zk_new dir=archive` 被拒；`zk_supersede` 仍能归档。
- [ ] `bun run check` 全绿；`bun run smoke` 全绿；flat 0.1.0 产物逐字节不变。
