# 计划：记忆预算截断与写路径硬化（v3.3）

**状态**：M0–M4 已全部实施（含评审修订），发布 3.3.0（2026-11-05）；检索召回 / 记忆管理 / 笔记本管理的评审补充见 §7（下一轮候选）。
**目标**：收掉记忆侧两处「不报错、但会静默变坏」的问题 —— ① 单 `##` 小节的 MEMORY 完全绕过预算；
② 条目没日期 / 没来源时，注入与周审页都看不见，按日期淘汰空转。另把相似标题查重从周审提前到写路径（只警告，不阻断）。
**范围**：`lib/memory.ts`、`lib/similar.ts`（新增）、`lib/lint.ts`、`lib/zk.ts`、`features/zk-tools`、
`features/readonly`、`test/zk.test.ts`、`docs/features/memory.md`、`docs/features/readonly.md`。
上一轮 v3.1 已实施，摘要与遗留见 §6；本轮之外的评审补充见 §7。

---

## 0. 本轮做什么

| ID | 问题 | 级别 | 本轮 |
|---|---|---|---|
| M0 | 只有一个 `##` 小节时，MEMORY 一条都丢不掉，整篇超预算注入 | P0 | 已完成（2026-11-05） |
| M1 | MEMORY 条目没日期 / 没来源，注入与记忆页都不提示 | P1 | 已完成（2026-11-05） |
| M2 | `zk_new` 只查精确同名，相似标题要等周审 lint 才发现 | P2 | 已完成（2026-11-05） |

本轮覆盖 M0–M4；§7 的 R / G / N 项是下一轮候选，其中 R1–R3 是小改动，可下一轮先做。

**不做**：语义判重 / LLM 合并、自动补日期、自动改 MEMORY、`usage` 日志、MEMORY 分型、机器级 USER 层（见 §6）。

---

## 1. 证据

### 1.1 单 `##` 小节绕过预算（P0）

参考库 `llm-research` 的 `MEMORY.md` 正是最常见、也是模板推荐的形状：

```markdown
# MEMORY

> 策展核心：这个笔记本此刻的现行结论。

## 结论

- **瓶颈在写路径，不在检索。** …
- **两层结构。** …
（共 9 条）
```

代码路径：

- `src/lib/memory.ts:176`：只要命中任意 `##` 就返回 `sections` 模式，不再尝试条目切分；
- `src/lib/memory.ts:420`：丢弃循环的条件是 `split.sections.length > 1`；
- `src/lib/memory.ts:438`：兜底 `firstSection()` 对单节文件返回的是「head + 这一节」= 整篇。

于是「按日期丢最旧一条」一次都不会执行。用 `buildMemoryPayload` 直接复现（预算 500，AGENTS 89 词，MEMORY 为单 `## 结论` + N 条）：

| 条目数 | MEMORY 实注入 | 总载荷 | `truncatedWords` | 目录 |
|---|---|---|---|---|
| 12 | 350 | 444/500 | 0 | 无 |
| 15 | 436 | 525/500 | 0 | 无 |
| 16 | 464 | 553/500 | 0 | 无 |
| 18 | 521 | 610/500 | 0 | 无 |

越过 500 之后没有任何自愈路径：每条新增结论都继续整篇注入，只有一句「预算不足」。
参考库当前是 **471/500（94%）**（AGENTS 176 · MEMORY 290，9 条），再晋升一两条就会进入这个状态。

**测试缺口**：`test/zk.test.ts:456` 只锁了「完全没有 `##`、只有条目」的 P0-1 场景；
没有「只有一个 `##`」的用例，所以这次回归没被发现。

**同类残留**：多节文件丢到只剩一节后循环也会停下；剩下一节自己超预算时同样丢不动。

### 1.2 日期与来源不可见（P1）

- 参考库 9 条结论**全部没有** `YYYY-MM-DD`；它的 `AGENTS.md` 也是旧版模板（注入文本里没有 v8 的
  「结论（YYYY-MM-DD）」和「先 read 核对来源」）。`zk_lint` 能报 `template.stale` 与 `memoryLinks.undated`，
  但只有有人主动跑 lint 才看得见。
- `src/lib/memory.ts:470` 只在「已经按位置丢」时才说「N 条没日期」；
  94% 用量、尚未截断时，注入里只报用量，不说淘汰键是坏的。
- 记忆页（`src/features/readonly/feature.ts:310`）只显示总词数与文件份额，
  没有 undated / 无来源 / 模板版本。周审入口看不到「格式债」。
- 结果：即使修好 1.1，`oldestIndex()` 对这类库仍返回 null，淘汰退化成按位置丢 —— D2 想避免的行为照旧发生。

### 1.3 相似查重只在周审（P2）

- `src/lib/zk.ts:855` 建笔记前只做 `normalizeTitle` 全等查重；
- `src/lib/lint.ts:364` 的 `similarTitles` 已经算了二元组 Jaccard ≥ 0.6 / 短串包含（≥ 6 字），
  但只在 `zk_lint` 里跑，频率是每周一次。
- `src/lib/lint.ts:357` 的注释明确「`zk_new` 不用它拦人」—— 本轮只加**不阻断的 warning**，不改这条决定。
- 参考库自己的头号结论是「瓶颈在写路径」；这里正好已有实现，只差把它挪到写的那一刻。

---

## 2. 设计

### D1：单节降级为条目（P0）

`splitSections` 命中 `##` 且只有 **1 节** 时，尝试把这一节再切一层：

1. 首行（`## 结论` 这类标题）并入 `head`，不参与丢弃；
2. 剩余正文按顶层列表项切分（缩进续行归上一条，围栏内的 `- ` 不算）；
3. 切出 ≥ 2 条才降级，模式记为 `items`；不足 2 条保持原样；
4. 截断循环每轮重新判定形态：`sections.length > 1` → 丢节；只剩 1 节且可降级 → 冻结该节标题、按条目继续丢。

`firstSection()` 的「兜底只留首段」同步改成「head + 第一节的第一条」——
否则单节形状下它仍等于整篇，兜底等于没裁。

不变的部分：AGENTS.md 永不截断；MEMORY 先按日期丢最旧、无日期才按位置；
退役条目先省略不计预算；目录、notice、`truncatedWords` 的口径全部不动。

### D2：格式债可见（P1）

只加三处显示，不自动修：

1. **注入 near/over 提示**：在已有的「记忆已用 N/M」或「已截断」行上追加格式债
   `MEMORY 9 条没日期 · 3 条没来源`。只在对应用量 > 0 时写；先量词数，**放不下就整条不加**
   （和「记忆已用」同一条规则：提示自己也要吃饭）。
2. **记忆页格式行**：`记忆 471/500 词` 下面加一行
   `格式：9/9 条没日期 · 0 条没来源 · AGENTS 模板 v5（当前 v8）`。模板版本只读首行 marker，不跑 lint；
   两个数直接取载荷里的 `formatDebt` / `templateVersion`（`buildMemoryPayload` 已经算过），不重读文件。
3. **不补日期、不猜来源**：日期与 `[[来源]]` 仍由人和 agent 写；插件只把缺口摆到周审入口。

实现只用现有纯函数：`splitMemoryEntries` / `isRetiredEntry` / `entryDate` + 一个匹配 `[[` 的正则 + 首行 marker 比对。
`memoryFormatDebt` 是**唯一口径**：注入提示、记忆页、`zk_lint.memoryLinks` 的 `undated` / `unlinked` 都取它
（退役条目不计、`[[   ]]` 不算来源），否则同一份 MEMORY 会给出三个数。
不读 `zk_lint`（那是子进程），保证注入仍是纯读盘 + 词数。

### D3：写路径相似提醒（P2）

1. 把 `similarKey` / `bigrams` / `jaccard` / 阈值（`0.6` / `6` 字）从 `lint.ts` 抽到 `lib/similar.ts`，
   `lint.ts` 与 `zk.ts` 都 import —— 不能反向 import `lint.ts`（它已 import `zk.ts`，会成环）。
   模块内函数不对外导出，外部只用 `similarKeyOf` / `similarScore` / `similarCandidates`。
2. `createNote` 复用建笔记前那次全库 `snapshot`（已经是含归档的扫描），
   算新标题在**同目录**内的相似候选：排除归档、排除归一化后全等、最多 3 条，带 score。
   候选标题与 `similarTitles` 同口径（`title || basename`），否则两边候选集不一样。
3. `NewNoteResult` 增加可选 `similar: Array<{ title, path, score }>`；`zk_new` 输出 schema 同步加字段，
   render 一行 `⚠️ 疑似已有：标题（path，0.72）`。**不阻断、不自动 zk_link、不改 title**。
4. `zk_lint` 的 `similarTitles` 数字必须与改动前逐条一致（同一份实现），只换 import。

### D4：只报告，不修

沿用既有边界：发现的日期 / 来源 / 相似标题都只报告。删条目、合并、退役、补日期都是语义判断，
由人或 agent 按 `WORKFLOW.md` 走；插件不写 MEMORY.md。

---

## 3. 实施里程碑

### M0（P0，单节截断，已完成 2026-11-05）

1. `memory.ts`：单节降级 + 循环每轮重判形态 + `firstSection` 收紧（D1）。
2. `test/zk.test.ts`：新增单 `##` 用例（§4 第 1–4 条）；现有「无 `##`」用例保持通过。
3. 验收：`llm-research` 形状 15/16/18 条在 500 词预算下 `words ≤ 500`、`truncatedWords > 0`、目录非空。

### M1（P1，格式债，已完成 2026-11-05）

1. `memory.ts`：near / truncation notice 追加格式债（放不下不加）。
2. `features/readonly/feature.ts`：记忆页格式行。
3. 验收：参考库记忆页显示 `9/9 条没日期`；注入在 94% 时多一句且仍 ≤ 500 词。

### M2（P2，写路径相似，已完成 2026-11-05）

1. 新增 `lib/similar.ts`；`lint.ts` 改为复用，行为不变。
2. `zk.ts` / `zk-tools` / 输出 schema / render（D3）。
3. 验收：同目录近似标题返回 `similar` 且笔记照常建成；精确同名仍然报错；不新增子进程。

### M3（文档 / 版本，已完成 2026-11-05）

1. `docs/features/memory.md` 补「单节降级」与「格式债」；`docs/features/readonly.md` 补记忆页格式行；
2. `docs/features/zk-tools.md` 补 `similar` 输出；
3. `package.json` 3.2.0 → 3.3.0；`bun run check` / `bun run smoke` 全绿。

### M4（评审修订，已完成 2026-11-05）

发布前自查发现三处「同一件事多个口径」，均已修：

1. **格式债收成一份。** `lint.ts` 的 `memoryLinks.unlinked` / `undated` 改取 `memoryFormatDebt()`
   （以前 `unlinked` 把退役条目也算、还用 `includes('[[')` 手判；`memory.ts` 的「N 条没日期」另数了一遍）。
   实测同一份 MEMORY（2 条活条目 + 2 条退役）以前给出 `unlinked` 1 与 2 两个数，现在三处一致。
2. **记忆页不再重读文件。** `MemoryPayload` 新增 `formatDebt` / `templateVersion`（不参与词数、不进 `text`），
   记忆页直接用；同时声明进 `zk_context` 的 output schema（输出 key 不得超出 schema）。
3. **目录按文件位置排。** `DroppedSection.order` 从「小节 / 条目序号」改成原文里的字符偏移
   （`pristine.indexOf`）—— 以前「多节 → 降成条目」会把两套坐标系混在一起，目录顺序会乱；新增回归用例。
4. **写路径候选集对齐 `similarTitles`：** 无 frontmatter 标题的旧笔记用文件名参与比较；新增单元用例。
5. **验收口径写死：** 测试里对 `words`（业务预算，不含框与 notice）与 `totalWords` 的关系显式断言，
   免得「载荷 ≤ 预算」被当成硬上限；§4 / §5 同步。

---

## 4. 测试计划

1. **单节 + 有日期**：`# MEMORY` + `## 结论` + 12 条带日期，预算压到超；断言 `truncatedWords > 0`、
   `words`（业务预算口径，不含框与 notice 开销）≤ 预算、丢的是**日期最旧**那条。
   同时断言 `totalWords === countWords(text)` 且 `totalWords > words` —— 真实注入会比 `words` 多出
   框与 notice（既有设计，见 `overheadWords` / 负 `headroom`），不要把「载荷 ≤ 预算」读成硬上限。
2. **单节 + 无日期**：同一形状去掉日期；断言按位置丢尾部，notice 出现「N 条没日期，只能按位置丢」。
3. **两节降到一节**：两个 `##` 都超；断言先丢整节，再继续按条目丢，最终 `words` ≤ 预算。
   目录按**文件位置**排（字符偏移），不按丢弃顺序 —— 降级前后共用同一套坐标。
4. **不回归**：无 `##` 的列表 / 散文 / 围栏用例逐字不变；预算内单节文件输出与改动前逐字节一致。
5. **提示预算**：只差 1–2 词放不下格式债时，断言整条提示不出现（不能说一半）。
6. **记忆页**：`undated` / `unlinked` / 模板版本三个数正确；0 时不写、不出现空「格式：」；
   这三个数与注入提示、`zk_lint.memoryLinks` 逐条一致（同一个 `memoryFormatDebt`，退役条目都不算）。
7. **zk_new**：相似候选返回但不阻断；`duplicate` 仍 throw；归档同名仍走 `archived` 提醒；`similarTitles` 输出与改动前一致；
   无 frontmatter 标题的旧笔记用文件名参与比较（与 `similarTitles` 同口径）。
8. **基线**：实施前记录一次 `bun run check` 的 pass/fail，目标不新增 fail、不新增 skip。

---

## 5. 兼容与迁移

1. **只在超预算时改变输出**：预算内的载荷逐字节不变；缓存键不变，不引入新的失效条件。
2. **`truncatedWords` / `retiredWords` / `tocWords` 口径不变**：截断仍只算正文，退役仍单列。
3. **预算只管内容与提示自身（`words`）**：框文本、做梦提醒、notice 都在 `totalWords` / `overheadWords` 里，
   `totalWords` 可以超预算 —— 既有口径，本轮不改；`headroom` 为负是正常的。
4. **`memoryLinks.unlinked` / `undated` 的定义收紧**：改为 `memoryFormatDebt`（退役条目不计、
   `[[   ]]` 不算来源）。旧库里如果只有退役条目没写来源，`unlinked` 会变小 —— 那本来就是噪声。
3. **磁盘不动**：不写 MEMORY / USER / AGENTS，不搬 archive，不改 frontmatter。
4. **`zk_new` 输出是增量字段**：`similar` 缺失时旧客户端不受影响；schema 放宽为可选。
5. **载荷新增只读字段**：`formatDebt` / `templateVersion` 给记忆页与后续 `zk_memory_check` 用，
   不参与词数、不进 `text`。
6. **版本**：3.3.0（P0 是行为修复，P1/P2 是新增提示，无破坏性变更、无配置迁移）。

---

## 6. 上一轮（v3.1，已实施）与遗留

v3.1.0 已落地：日记时间轴校验（`zk_lint` 的 `timeline` 桶 + 笔记页顶部警告）、
`zk_new dir=archive` 守卫、`zk_dream` 改用 `noteDate`（日记看文件名、其他看 frontmatter `date`）。
Q7 / Q6 关闭；时间轴只报告、不自动修。

**遗留待确认（不在本轮）**：

- **Q1**：`source.md` 的 `{{content}}` 落在 `## Quotes` 下，正文语义是否算引文 ——
  先确认，再决定改不改模板（`notebook.ts` 的 `SOURCE_TEMPLATE`）。

---

## 7. 评审补充：检索召回、记忆管理与笔记本管理

**状态**：评审记录（2026-11-05），未排期；不改变 v3.3 的 M0–M4 范围。
**结论**：架构方向与参考库 `llm-research` 的骨架一致（常驻策展层 + 按需检索、写路径守卫、显式周审），
不缺大构件；缺口集中在「召回质量」与「写路径的反馈闭环」。zk 本身已有 `--related` / `--mention` /
`--link-to` 等关系过滤，R5 直接复用，不另造图遍历。以下按优先级分组，每项给证据、设计、验收。

### 7.1 检索召回

#### R1（P1）query 存在时不要按创建时间排序

**证据**：`zk_search` / `zk_query` 带 query 也默认 `sort: 'created-desc'`
（`features/zk-tools/feature.ts:487` / `:568`），最终传 `--sort created-`；zk 的排序项只有
`created / modified / path / title / random / word-count`，**没有 relevance**。实测同一组笔记
`zk list -m` 的默认顺序与 `--sort created-` 不同，说明后者覆盖了 FTS 的相关性顺序。

**设计**：

1. `SearchOptions.sort` 增加 `relevance`；工具层：有 query 且未显式给 `sort` → 不传 `--sort`；
   无 query → 仍 `created-desc`；显式 `created-desc` / `modified-desc` 等照旧。
2. schema 的 `sort` 枚举加 `relevance`，说明「只在有 query 时有效；无 query 回退 created-desc」。
3. `zk_query` 同步；`zk_query` 的 `query` + 结构化过滤也走 relevance。
4. CJK 的 `mixed` 仍按「FTS 命中在前、正则补漏在后」；真正的混合排序交给 R3 的覆盖度。

**验收**：旧但高度相关的笔记排在新的弱匹配之前；显式 `sort` 不被改写；无 query 的结果与改动前逐条一致。

#### R2（P1）把 zk 已返回的命中片段 / 条数信息接出来

**证据**：`zk list --format json` 的每条已经带 `snippets`、`body`、`rawContent`；
`toRecord` 只保留 `lead`（`lib/zk.ts:321`，200 字）。命中在正文深处时 `lead` 可能完全无关
（实测：lead 不含关键词，`snippets[0]` 定位到命中句）。另外 `zk_search` 的 `count` 是 `limit` 之后的条数，
`--quiet` 又关掉了 zk 的总数；命中 50 条、`limit=10` 时模型会以为只有 10 条。

**设计**：

1. `NoteRecord` 增加 `snippet`：取 `raw.snippets[0]`，压空白、截 240 字；没有就空串。
2. `zk_search` / `zk_query` 输出增加可选 `snippet`、`words`（`NoteRecord.words` 已有，只是没透出）；
   内部没有片段时 `snippet` 为空串，输出只在非空时出现，避免宿主 JSON schema 的 undefined 问题。
3. 截断可见：无 JS 过滤时请求 `limit + 1` 条，返回前 `limit` 条并给 `hasMore`；
   有 `status` / `type` 过滤时沿用 `fetchLimit=200`，过滤后仍超 `limit` 也给 `hasMore`，
   原始结果达到 200 条时给 `fetchTruncated: true`（不额外跑进程）。
4. `total` 只在能从 zk 输出稳定拿到时给；拿不到就不给，不用 `count` 冒充总数。
5. render 增加「可能还有更多」提示；`snippet` 一行替代/补充 `lead`。

**验收**：长笔记的命中句出现在结果里；宽查询 `limit=10` 且有更多命中时 `hasMore=true`；
不新增子进程；ASCII / 无 query 路径的输出除新增字段外不变。

#### R3（P1）中文多词查询切词 + 更新过时的 zk_query 描述

**证据**：CJK 查询现在跑 FTS + `-M re` 两遍，但整串直接当正则；`记忆 召回` 只匹配字面量，
找不到「记忆系统的召回」（实测）。`zk_query` 的描述还写着「中文召回不完整，尽量配合 tags 使用」
（`features/zk-tools/feature.ts:515`），代码已有 CJK 兜底，这句在劝退模型用中文查询。

**设计**：

1. 新增 `splitCjkQuery(query)`：按空白 / 标点切词，去重，保留长度 ≥ 2 的词，最多 4 个；
   少于 2 个词或纯 ASCII 时走现有路径。
2. 多词时正则用转义后的 alternation `(?:词1|词2|…)`，一次进程召回；用 `rawContent`（JSON 已带）
   算每个命中覆盖了几个词，按 `coverage` 降序 → FTS 顺序 → created 排序；不做逐词 N 次进程。
3. 正则元字符先转义；词数超过 4 时退回整串查询，避免组合爆炸。
4. `zk_query` 描述改成和 `zk_search` 一致：「中文会自动并用子串，多词按覆盖度合并」。
5. 纯 ASCII / 单词 CJK 不改变现有两遍策略。

**验收**：`记忆 召回` 同时命中「记忆系统的召回」和「记忆 召回」，且覆盖 2 个词的结果排在只覆盖 1 个词之前；
`.*` 等正则元字符不会报错；纯 ASCII 查询仍只跑一个进程。

#### R4（P2，规模触发）召回装配层

**证据**：`zk_search` 返回 top-k 元数据 + lead，没有按预算/类别拼装，也没有跨回合去重；
参考库自己的结论就是「召回之后还有装配」，插件目前停在 top-k。

**触发**：非日记笔记 > 100 篇，或一次任务需要连续 read 3 篇以上。

**设计**：

1. 只读 `zk_recall`（或 `zk_search` 的 `assemble: true`）：query + 过滤条件 + `budget`（词数，复用 `countWords`）。
2. 先走 R1–R3 的检索，按 path 去重；每条取 `snippet` / `lead` / `words`；
   按类型或标签分组，填预算；放不下就整条丢弃，不切半句。
3. 输出 `{ text, used, budget, notes: [{ title, path, absPath, included, reason }] }`；0 命中返回空 text。
4. v1 不做向量、不做 LLM rerank、不做跨回合 dedup（留 session 缓存钩子，默认关）。
5. 每条都要带 `absPath`，需要全文时仍由原生 `read` 取。

**验收**：`used <= budget`；每个 included 的笔记都有 path/absPath；0 命中不编造；
不读全文、不新增 zk 进程（除检索本身）。

#### R5（P2）用 zk 原生关系过滤器做「相关笔记」与链接建议

**证据**：zk 的 `list` 已支持 `--related`（共同邻居、尚未直连）、`--mention` / `--mentioned-by`
（标题/别名提及，正反两向）、`--link-to` / `--linked-by`（入链/出链）、`--recursive` +
`--max-distance`（有界多跳），见 note-filtering 文档的「Find related notes」
（https://zk-org.github.io/zk/notes/note-filtering.html#find-related-notes）。
插件目前只用 `-m` / `-t` / `-x` / `--orphan` / `--broken-links`；`zk_link` 的候选只靠全文搜索，
`zk_lint` / `zk_dream` 自己用 `zk graph` 算边，没有利用这些原生过滤器。
`--related` 的语义是结构性的（共同邻居），不是语义相似。

**设计**：

1. 新增只读 `zk_related`：`path`（种子）+ `mode`（`related` / `mention` / `mentioned_by` /
   `link_to` / `linked_by`）+ `depth`（默认 1，最大 3，仅 link 模式）+ `limit`；
   输出 `{ title, path, absPath, relation, distance?, lead }`，按关系类型分组。
2. `zk_search` / `zk_query` 不堆图参数；需要「以某篇为种子」时统一走 `zk_related`。
   默认排除 archive/raw/meta；`include_archived` 可选。
3. `zk_link` 在现有全文搜索之前，先跑 `--related <source>` 和
   `--mention <source> --no-linked-by <source>`：前者给「共同邻居但还没连」的候选，
   后者给「正文提过、但还没链」的候选；合并去重，render 标出 `related` / `unlinked-mention`。
   不自动 link，仍由 agent 决定。
4. `zk_new` 建成后可返回 `related`（共同邻居）前 3 条作为「可能该连」的提示；不阻断、不自动 link。
5. R4 的装配层可用 `--linked-by -r --max-distance 2` 从种子做有界扩展；默认关闭，避免把图走炸。
6. 标题/别名提及以 zk 的 frontmatter `aliases` 为准；`lib/alias.ts` 是 zk 命令别名，不是笔记别名，不要混用。
7. 性能与误报：`--related` 只做结构，不保证内容相关；`--mention` 可能因标题泛化误报，
   用 `--no-linked-by` / `--no-link-to` 过滤已链；深度 >2 必须配 `limit`。
8. 同一批文档里还有 `-M exact`（字面量查询）、`--modified-*`（修改时间范围）、tag 的
   OR / NOT / glob 表达式和多个 `--match` 的 AND；先记录，不单列里程碑，按需补。

**验收**：`zk_related(mode=related)` 返回共同邻居且不含已直连的笔记；
`mode=mentioned_by` 能发现正文提到但未 `[[链接]]` 的笔记；
`zk_link` 的候选里出现 `related` / `unlinked-mention` 且不自动写入；
深度 2 + `max-distance` 有界，结果不重复；不新增状态、不新增子进程依赖（除 zk 本身）。

### 7.2 记忆管理

#### G1（P2）写 MEMORY 前的容量检查

**证据**：MEMORY 由 agent 用原生 edit 直接改；插件只在下一轮注入时回显 94%，
`zk_context` 有 `ratio` 但不会说「再加一条会丢谁」。参考库 9 条全无日期，
即使 §1.1 修好，`oldestIndex()` 也选不出日期。

**设计**：

1. 只读 `zk_memory_check`：参数 `proposed_entry?` / `extra_words?`；
   返回 `words / totalWords / budget / headroom / wouldTruncate / dropCandidates / format / suggestion`。
2. `dropCandidates` 复用 `splitMemoryEntries` + `entryDate`：有日期按最旧、无日期按尾部；
   每条给首行摘要、词数、会丢的原因；`format` 给 `undated` / `unlinked` / `retired`。
3. 纯读 + `buildMemoryPayload`，不跑 zk、不写文件；与注入同一口径。
4. `WORKFLOW.md`（不注入）加一行「改 MEMORY 前先 zk_memory_check」；
   AGENTS 模板只在放得下时加指针，不挤预算。
5. `zk_dream` 的 `memory` 栏补 `undated` / `unlinked` / `retired`，周审入口直接看到格式债。

**验收**：参考库调用返回内容 471/500、总载荷 513/500、headroom -13；
加一条 30 词的 `proposed_entry` 返回 `wouldTruncate=true` 并列出候选；
`zk_dream.memory` 与 `zk_lint.memoryLinks` 的计数一致；不写任何文件。

#### G2（P2）使用信号：日记标题提及 + 退役保护

**证据**：`dailyMentions` / `daysMentioned` 只统计 `zk graph` 里日记的边（`lib/dream.ts:389-405`），
日记正文直接写标题不算；`retireCandidatesOf` 只看 >90 天或来源断（`:323-345`），
最近天天被引用的旧条目仍可能被建议退役。参考库的晋升结论是「看是否一直被用到」。
zk 原生已有 `--mentioned-by` / `--mention`（标题/别名提及，正反两向），能覆盖「正文写标题、没建双链」的情况；
G2 不必从零实现，但要先验证多篇日记批量时能否保留「哪一天提到」。

**设计**：

1. `usageOf` 增加 `titleMentions` / `titleDays`：优先用 `zk list --mentioned-by <daily>` 逐篇取
   「这篇日记提到的笔记」（支持 frontmatter `aliases`）；如果多路径批量不能保留来源日期，
   再退回读正文 + `normalizeTitle`（≥6 字）的 JS 匹配。两种口径都只读 `dailyDir`，按日期去重；
   保留 `dailyMentions` 原义（双链边）。
2. 同一篇日记里链接与标题同时出现只算一次日期，避免两项重复计数。
3. 读正文设上限（单篇 ≤2 MiB、总扫描 ≤ `MAX_SCAN`），触顶置 `truncated`；不新增文件、不新增状态。
4. `retireCandidatesOf` 接收 usage：最近 `RETIRE_GUARD_DAYS`（默认 30）内有 `lastMentioned`
   （取双链日期与标题日期的最大值），或 `daysMentioned + titleDays >= 2` 的条目不进候选；结果里给 `usedRecently` 计数。
5. `topCited` 排序改为 `daysMentioned → titleDays → dailyMentions → cited → 标题`；
   没有日记的库全部为 0，自动退回原排序。
6. 字段是增量；`zk_dream` 输出 schema 同步，旧客户端不受影响。

**验收**：只在日记正文写标题、不建双链的笔记得到 `titleDays > 0` 并进入 topCited；
100 天前但昨天被提到的 MEMORY 条目不进 retireCandidates；无日记库的排序与改动前一致。

#### G3（P2）周审带去重材料

**证据**：`similarTitles` 只在 `zk_lint`（`lib/lint.ts:364`），`zk_dream` 的候选/拒绝/积压/被引
都不带相似簇；参考库的巩固阶段核心之一就是合并重复。

**设计**：

1. 依赖 M2 的 `lib/similar.ts`（同一套 `similarKey` / bigrams / Jaccard 阈值）。
2. `zk_dream` 增加 `similar: Array<{ a: {title,path}, b: {title,path}, score }>`，最多 10 组；
   只在同目录、非日记、非归档之间比较；与 `duplicateTitles` 去重。
3. 只报告，不自动合并、不自动 link、不写 MEMORY；`counts.similarGroups` 给总数。
4. 不新增子进程：复用已载入的 notes 标题。

**验收**：同一组相似标题在 `zk_dream.similar` 与 `zk_lint.similarTitles` 中得分一致；
日记/归档不参与；无相似时字段为空数组或省略；不改变既有输出字段。

### 7.3 笔记本管理

#### N1（P2）跨库检索 + 库级可观测性

**证据**：每个会话 pin 一本；`zk_search` / `zk_query` 没有 `notebook` 参数；
`zk_context` 的 `notebooks` 只有 name/path/structure/active，`zk_use` 只给名字列表。
多库时「记得内容、忘了在哪本」只能逐本切。

**设计**：

1. `zk_search` / `zk_query` 增加 `notebook?: string`（单库）和 `all_notebooks?: boolean`；
   默认当前库，不改变会话 pin；目标不存在时报错并列出可用名字。
2. 跨库结果的每条笔记增加可选 `notebook`（名字）；顶层加 `searched: string[]`；
   同一标题在不同库各自保留，不合并。
3. `zk_context.notebooks` 增加 `initialized`（`.zk/config.toml` 是否存在）与
   `lastModified`（目录 mtime，cheap）；`zk_use` 的输出同步。篇数不在这里算（需要逐库 zk）。
4. 跨库检索只读；不自动切换、不写任何库。

**验收**：`all_notebooks` 返回 2 个库的命中并标注来源库；默认调用结果与改动前一致；
缺失库名报错并列出名字；不改变 pin。

#### N2（P2，产品取舍）raw/ 显式可检索

**证据**：`excludedNames` 永远排除 `raw` / `inbox`（`lib/zk.ts:354`），`raw` 只能 read、不能搜；
参考库的出处大量指向 `raw/`，核对原文时检索层完全看不见。参考笔记的做法是
「untrusted 内容可以存、可以索引、可以被显式搜到，但进不了自动注入」。

**设计**：

1. `SearchOptions.includeRaw`；`excludedNames(cfg, { includeArchived, includeRaw })`，
   只放开 `raw`，`inbox` 仍排除（已停用的待归类区）。
2. `zk_search` / `zk_query` 增加 `include_raw: false`；结果标 `untrusted: true`（或 `source: 'raw'`）。
3. `zk_stats` / `zk_lint` / 自动注入仍然排除 raw；`zk_new` / `zk_append` / `zk_link` / `zk_supersede`
   的 raw 写保护不变。
4. 大文件：结果带 `words`，`snippet` 只取首段；必要时对单条 `lead/snippet` 截断，避免把 raw 全文塞进输出。

**验收**：默认检索不返回 raw；`include_raw` 返回 raw 且带 `untrusted`；raw 仍不可写；
注入载荷与改动前逐字节一致；`zk_stats` 默认计数不含 raw。

#### N3（P3，规模触发）目录摘要 / INDEX.md

**证据**：`zk_lint` 只在非日记笔记 ≥150 篇且没有 `INDEX.md` 时提示一句，不生成；
`zk_stats` 只有 byDir/byTag 计数。参考笔记的「摘要挂目录」需要可浏览的目录级摘要。

**触发**：非日记笔记 ≥150 篇，或用户明确要求。

**设计**：

1. 新增 opt-in `zk_index`（或 `zk_stats --write-index`）：生成人类可编辑的 `INDEX.md`，
   按目录分组，列标签计数与每条笔记的 `lead`；默认 `dry_run: true`。
2. `INDEX.md` 是 meta：不注入、不进检索；只在显式调用时重写，不随写入自动更新。
3. `zk_lint` 增加「INDEX.md 可能过期」的只读提示（比较笔记数 / mtime），不自动修。
4. v1 不用 LLM 生成摘要，直接用 `lead`，避免成本和不可审计。

**验收**：150 篇时生成目录/标签/条目清单；默认不写文件；`zk_lint` 只提示过期；
`INDEX.md` 不出现在检索与注入里。

### 7.4 不做

- **向量库 / 语义检索**：当前规模收益低于 R1–R3；先做 R4 的装配层，仍不够再评估。
- **自动写 MEMORY / 自动合并 / 自动补齐日期**：保持「插件只报告、人和 agent 裁决」的边界（§D4）。
- **把 `--related` 当语义相似**：不做；它是共同邻居，只用于结构发现，内容相关仍靠检索与 agent 判断。
- **默认开启 recall 日志**：G2 先用日记标题提及这个零新增状态的信号；recall 日志只作为可选的后续项。
- **自动生成 INDEX.md**：只在 N3 的规模触发 + 显式调用时写。
- **per-agent persona**：仍按 `docs/features/memory.md` 的后续 M4 边界，不在本节展开。

### 7.5 建议顺序

1. **v3.3 M0 + M1**（P0/P1）：先让单节 MEMORY 真正能截断、格式债可见；否则后面的日期淘汰仍空转。
2. **R1 + R2 + R3**（P1）：排序、片段、截断可见、中文多词，都是小改动，可并入 v3.3 的 M3 前。
3. **R5**（P2）：把 `--related` / `--mention` 接到 `zk_link` 与 `zk_related`；它同时给 G2 提供原生提及能力。
4. **G1 + G2**（P2）：写前容量检查、使用信号；`M2 → G3`（相似标题 → 周审去重）可同批。
5. **N2 → N1**（P2）：raw 可检索是产品取舍，先定边界；跨库检索再做。
6. **R4**（100+ 篇）、**N3**（150+ 篇）：规模触发，不提前建。

### 7.6 测试补充

- R1：同一查询下旧高相关笔记排在新弱匹配前；显式 sort 不变。
- R2：长笔记命中句出现在 snippet；`hasMore` / `fetchTruncated` 在宽查询与 200 条上限时正确。
- R3：`记忆 召回` 覆盖两条不同写法；正则元字符不报错；纯 ASCII 仍单进程。
- R5：`zk_related` 的 related/mention/link 三种 mode；`zk_link` 候选带 relation 且不自动写；depth 2 有界。
- G1：参考库 471/500、总载荷 513、headroom -13；加 30 词条目触发 wouldTruncate；不写文件。
- G2：仅标题提及（含 `aliases`）的笔记进入 topCited；最近提到的旧条目不进 retireCandidates。
- G3：dream 与 lint 的相似分组得分一致。
- N1：跨库结果带 notebook 标签；默认结果不变。
- N2：默认不返回 raw；`include_raw` 返回且标 untrusted；注入不变。
- N3：150 篇生成 INDEX.md；默认 dry-run；lint 只提示过期。
