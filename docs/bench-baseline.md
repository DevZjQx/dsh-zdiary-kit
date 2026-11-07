# 成本表（落盘基线）

**口径来源**：`docs/plan.md` §0.5 第 2 条 —— 每条用例一行，记子进程数 / 传输字节 / 峰值 RSS / p50 / p95 /
超时 / 超限行为 / **库的篇数与链接数**。这是「新增或改动工具时按口径补测」的基线，
不是每次 PR 的硬性闸门；`bench` 只手动跑，不进 `check` / CI。

**环境**：zk 0.15.7（`/home/glm-agent/.dsh/zdiary/bin/zk`）、linux/x64（WSL）、bun 1.4.4。
**夹具**：`.tmp/fixture/10k-1`，10 000 篇 / 10 000 链（1 链/篇，其中 9 500 有效链 + 500 断链），
seed 42，由 `bun run fixture --notes 10000 --links-per-note 1` 生成；索引已热（本次没有冷建）。
**测量**：`bun run bench --fixture .tmp/fixture/10k-1 --iterations 3 --json --out .tmp/bench-10k-1.json`，
每条用例 3 轮，p95 = 第 ⌈0.95n⌉ 轮；子进程 / 字节来自 `execStats`（本进程），峰值 RSS 是 `comm=zk` 的采样峰值。
`notes` / `links` 每行都带，读自夹具的 `.fixture.json` 真实统计，不是 CLI 参数。

## 全表

| 用例 | 工具 | 子进程 | 字节 | p50 | p95 | 峰值RSS | 超时 | 超限 |
|---|---|---|---|---|---|---|---|---|
| `search.cjk` | zk_search | 2 | 30 KB | 1.8 s | 2.2 s | 33 MB | 60 s | partial |
| `search.cjk.multi` | zk_search | 2 | 15 KB | 1.9 s | 1.9 s | 32 MB | 60 s | partial |
| `search.cjk.single` | zk_search | 1 | 14 KB | 992.2 ms | 1.2 s | 33 MB | 60 s | complete |
| `search.ascii` | zk_search | 1 | 19 KB | 932.5 ms | 1.2 s | 34 MB | 60 s | - |
| `scan.10k` | 首页 / 标签页 / lint / dream | 1 | 2.0 MB | 4.6 s | 5.3 s | 63 MB | 60 s | complete |
| `search.filtered` | zk_query | 1 | 2.0 MB | 4.0 s | 4.2 s | 62 MB | 60 s | partial |
| `list.10k` | zk_search / 首页 | 1 | 15.1 MB | 3.7 s | 4.3 s | 71 MB | 60 s | partial |
| `list.2k` | 首页 / 标签页 | 1 | 2.7 MB | 1.4 s | 1.8 s | 36 MB | 60 s | partial |
| `list.200` | zk_search | 1 | 208 KB | 639.0 ms | 667.7 ms | 31 MB | 60 s | partial |
| `graph.full` | bidi / zk_lint | 1 | 13.9 MB | 25.5 s | 26.5 s | 70 MB | 60 s | complete |
| `lint` | zk_lint | 5 | 3.3 MB | 13.8 s | 17.9 s | 62 MB | 180 s | complete |
| `dream` | zk_dream | 1 | 2.0 MB | 7.1 s | 7.5 s | 62 MB | 180 s | partial |
| `backlinks` | bidi | 1 | 0 KB | 1.4 s | 1.6 s | 31 MB | 60 s | complete |
| `stats` | zk_stats | 3 | 3.0 MB | 8.0 s | 10.4 s | 66 MB | 60 s | - |
| `context` | zk_context | 0 | 0 KB | 0.6 ms | 0.6 ms | n/a | - | - |
| `index.warm` | zk-kit index | 1 | 0 KB | 464.3 ms | 663.1 ms | 30 MB | 120 s | - |

「超限」是工具自己的口径：列表看 `hasMore` / `completeness`，图看它自己的标志；`-` 表示该用例不涉及。

## 与 §0.5.1 首测的对照

§0.5.1 的首测是一次连续探测（临时夹具、约 9 741 篇 / 1.06 链/篇），用于给常量定标；
本表是固定 seed 的可复现夹具。差异来自链接目标集中度、机器负载与磁盘缓存，不改结论：

- **读路径可用，冷建索引与全图不可用**：`graph.full` 25.5 s / 13.9 MB，`list.10k` JSON 15.1 MB，
  而精简格式的 `scan.10k` 只有 2.0 MB。全图统计仍走按篇反查（`backlinks` 1.4 s）。
- **CJK 双跑约 2 进程**：`search.cjk` 1.8 s / 2 进程、单进程 FTS 对照 0.99 s / 1 进程。
  两次复跑 p95 在 1.9–2.7 s 之间波动，贴着甚至略超 §0.5 的 `zk_search` 10k p95 ≤ 2 s 目标；
  **这是既有双跑的机器波动，不是某个改动引入的回归**。
- **`zk_context` 与篇数无关**：0 个子进程、0.6 ms（`scan.10k` 的 4.6 s 与它无关）。

## R3 gate 补测（§10.4 第 4 项）

`search.cjk.multi` = `记忆 召回`：多词切词 + 转义后的 alternation + `coverage` 覆盖度排序。
对照 `search.cjk`（整串正则双跑）：

| | 子进程 | 字节 | p50 | p95 |
|---|---|---|---|---|
| 整串双跑（R3 之前） | 2 | 30 KB | 1.8 s | 2.2 s |
| 多词 alternation（R3） | 2 | 15 KB | 1.9 s | 1.9 s |

**结论：增量成本约等于零，gate 通过，不启用降级开关。** 进程数不变，`coverage` 只是 JS 内一次
O(命中数 × 词数) 计算，没有第二次全库扫描。另两轮复跑（3 / 5 轮）多词 p95 为 2.6 s / 2.0 s，
整串双跑为 2.7 s / 2.2 s，同量级。若低配机上长期超预算，降级开关应对**整个 CJK 双跑**生效
（FTS 命中 ≥ N 条就不再跑 regex，或按库规模开关），不是只关多词 —— 见 `docs/plan.md` §0.5.2。

## 稳定 ID 后补测（§10.4 第 7 项，2026-11-07）

`lib/zk.ts` 的 LEAN 模板多一列 `{{metadata.id}}`（全量扫描 / 结构化检索），按 §0.5 第 2 条补测 10k：

```
ZK_BIN=/path/to/zk bun run bench --fixture .tmp/fixture/10k-1 --cases scan.10k,search.filtered,list.10k --iterations 3 --json --out .tmp/bench-stable-id.json
```

| 用例 | 子进程 | 字节 | p50 | p95 | 峰值 RSS | 上表基线（字节 / p95） |
|---|---|---|---|---|---|---|
| `scan.10k` | 1 | 2.03 MB | 2.5 s | 3.1 s | 63 MB | 2.0 MB / 5.3 s |
| `search.filtered` | 1 | 2.03 MB | 2.4 s | 2.4 s | 63 MB | 2.0 MB / 4.2 s |
| `list.10k` | 1 | 15.1 MB | 2.8 s | 2.9 s | 70 MB | 15.1 MB / 4.3 s |

夹具 10 000 篇 / 10 000 链，笔记**全都没有 frontmatter `id`**（第 4 项生成的夹具），所以新列为空：
字节与基线同量级（多出的是控制字符分隔符），`list.10k` 走 `--format json`、不经过 LEAN 模板，数字不变。
真库里每篇有 id 会多约 11 字节（10 位 hex + 分隔符），10k 约 +110 KB，不改变成本量级。
这次 p50 / p95 整体低于基线是机器负载与磁盘缓存波动，不是本项带来的优化；
子进程数不变（1），`parseLeanList` 多切一列是 JS 内 O(n) 字符串操作，不新增 zk 进程。

## 10k 三档链接密度补测（§12.4 R8 `limit` 代理口径，2026-11-07）

**缘起**：`docs/plan.md` §12.4 把「R8 `limit` 上限 200 在 10k / 3 档链接密度下的字节与 p95 仍须实测后定」列为未决。
R8（`zk_walk`）未排期、未实现，bench 用例表里没有对应项，因此用现有 `backlinks` 用例（`backlinksOf` →
`zk list --link-to`，默认 `MAX_LINK_NOTES = 200`）做**代理口径**测量。

```bash
ZK_BIN=/path/to/zk bun scripts/fixture.ts --notes 10000 --links-per-note 0.2 --out .tmp/fixture/10k-0.2 --json
ZK_BIN=/path/to/zk bun scripts/fixture.ts --notes 10000 --links-per-note 3 --out .tmp/fixture/10k-3 --json
ZK_BIN=/path/to/zk bun run bench --fixture .tmp/fixture/10k-<x> --cases backlinks --iterations 3 --json --out .tmp/bench-10k-<x>.json
```

`<x>` = `0.2` / `1` / `3`（`10k-1` 是已有夹具，只重跑）；落盘 `.tmp/bench-10k-0.2.json` /
`.tmp/bench-10k-1-backlinks.json` / `.tmp/bench-10k-3.json`。三档都是 10 000 篇、seed 42，
真实链接数 2 000 / 10 000 / 30 000（读 `.fixture.json`）；**bench JSON 里的 `linksPerNote` 是 CLI 默认值 1，
显式 `--fixture` 时没传该参数，不代表真实密度，以 `links` 字段为准**。

| 档 | 链接数 | 冷建索引 | 子进程 | 字节 | p50 | p95 | 峰值RSS | count | 超限 |
|---|---|---|---|---|---|---|---|---|---|
| 0.2 链/篇 | 2 000 | 115.6 s | 1 | 0 KB | 390.5 ms | 396.4 ms | 25.3 MB | 0 | complete |
| 1 链/篇 | 10 000 | 已热 | 1 | 0 KB | 627.4 ms | 1293.5 ms | 31.3 MB | 0 | complete |
| 3 链/篇 | 30 000 | 999.7 s | 1 | 0 KB | 772.3 ms | 833.4 ms | 53.7 MB | 0 | complete |

p95 非单调（396 / 1294 / 833 ms）是机器负载与磁盘缓存波动，不是随链接密度的规律；冷建 3 链/篇
实测 999.7 s，与 §0.5.1「建索引成本 ≈ 6.6 s + 26 ms × 链接数」同量级。

**关键发现：这个代理口径测不到 R8 的传输字节。** 三档 `count` 都是 0、`bytes` 都是 0，原因不在链接密度：

- 夹具生成的 wikilink 目标是 frontmatter `title`（如 `[[检索方法 0]]`，含空格），而 zk 0.15.7 按**文件名 stem**
  解析（`检索方法-0.md`）。查 `10k-1/.zk/notebook.db` 的 `links` 表：10 003 条链接的 `target_id`
  **全部为 null**，即一条都没落到笔记上。这也解释了全表里 `backlinks` 为什么是 0 KB。
- bench 的 `pickSample` 取 `notes/concepts` 排序第一篇，恰好是边界笔记 `dup-title-a.md`，本身也没有链接。
- 直接验证：`--link-to` 传**绝对路径**（`linkedNotes` 的现行做法）返回 0 条；传相对路径则过滤条件被忽略、
  退化为全库 201 条 / 214 KB —— 正是 `docs/plan.md` §12.1 第 5 条警告的坑在夹具上复现。
  换用普通原子笔记作种子，结果同样是 0 条。

**能补上的部分：200 条钳制的传输上界。** 绕开链接过滤，直接量 `linkedNotes` 用的
`--format json --limit 201`（含 `rawContent`）满载输出：

| 档 | `--limit 201` 满载字节 | 单条约 |
|---|---|---|
| 0.2 链/篇 | 212 851 B（≈208 KB） | 1 059 B |
| 1 链/篇 | 214 173 B（≈209 KB） | 1 066 B |
| 3 链/篇 | 214 701 B（≈210 KB） | 1 068 B |

即 `limit` 钳在 200 后，单方向最坏传输量约 210 KB，远小于 `graph.full` 的 13.9 MB；三档几乎相同
（笔记长度相近，与链接密度无关）。R8 设计里 `both` 方向会各调一次 `backlinksOf` / `outlinksOf`，
按 **2 个子进程 / 约 2× 字节外推**，这是外推不是实测。

**阶段结论**：上节只补到「按篇反查 1 个子进程的 p95 + 200 条传输上界」，`--link-to` 的
直接实测见下节（1 链/篇可解析副本）。

### 直接实测（`.tmp` 可解析副本，2026-11-07）

> **已被下一节取代（2026-11-07）**：同一修正已并入 `scripts/fixture.ts`，本节的可解析副本探针只作历史记录；
> 三档直接实测与当前可复现口径见「夹具链接可解析化后的三档实测」。

代理口径测不到 `--link-to` 的真实输出，因此在 `.tmp` 下做一次性副本补测：
`.tmp/r8-probe.ts` 把 `.tmp/fixture/10k-1` 复制成 `.tmp/r8-fixture/10k-1-linked`，
把 9 502 条 `[[title]]` 改成 `[[stem]]`（保留 501 条故意断链 / meta 链接），
**不改 `scripts/fixture.ts`、不动既有 10k 基线**。首次构建冷建索引 278.1 s；
重建后 `links` 表 10 003 条里 `target_id` 为 null 的从 10 003 降到 **501**，链接已能被 zk 解析。
结果落盘 `.tmp/bench-r8-direct.json`（3 轮，p95 = 第 ⌈0.95n⌉ 轮）。

| 用例 | 种子 | 子进程 | 字节 | p50 | p95 | count | 超限 |
|---|---|---|---|---|---|---|---|
| `backlinksOf`（in，limit 200） | 入链最多的原子笔记（7 条入链） | 2* | 12 255 B | 556.9 ms | 627.6 ms | 7 | complete |
| `backlinksOf`（in，limit 10，R8 默认） | 同上 | 1 | 12 245 B | 544.4 ms | 550.6 ms | 7 | complete |
| `outlinksOf`（out，limit 200） | 出链最多的原子笔记（2 条出链） | 1 | 3 366 B | 534.9 ms | 540.3 ms | 2 | complete |
| `both`（`zk_walk` direction=both，**单种子**） | 同第一行种子 | 2 | 13 986 B | 1086.7 ms | 1095 ms | 8 | complete |

\* `calls` 取 3 轮最大值；首行偶发 2 个子进程是读路径的索引状态 / 写后可读补索引，其余行都是 1。
种子按替换后的 `[[stem]]` 频次选，出链种子过滤掉 meta（`MEMORY.md` 等）。
重跑时索引已热、链接已是 stem 形式，JSON 里的 `coldIndexMs: null` / `replaced: 0` /
`already: 9502` 是重跑结果，首次构建数字见上段。

**结论**：

- `limit=200` 在这类均匀分布库上**不会触顶**（10k 篇 / 10k 链，最大入链仅 7 条），
  实测 7 条约 12 KB（约 1.75 KB/条）；200 条最坏情况仍以上节 `--limit 201` 满载的
  212–215 KB 为准。R8 默认 `limit=10` 与 200 的输出字节相同（结果只有 7 条）。
- `both` 方向直接实测 **2 个子进程 / 13 986 B / p95 1.1 s**，与上节「2 进程 / 约 2× 字节」的
  外推方向一致，不再只是外推；p95 约为单向之和（两次 `zk` 顺序执行）。
- **只补了 1 链/篇这一档**：0.2 / 3 档的可解析副本未建（3 档冷建约 17 分钟），
  `docs/plan.md` §12.4 的 R8 `limit` 项算**部分闭合**；副本是一次性探针，未并入产品夹具生成器，
  既有 10k 基线的链接不可解析问题仍在，`docs/plan.md` §11 三项仍不具备「进 §10.4」的条件。

## 夹具链接可解析化后的三档实测（2026-11-07，§12.4 R8 闭合）

**根因与修法**：旧夹具用 frontmatter `title` 生成 wikilink（`[[检索方法 0]]`，含空格），而 zk 0.15.7
按**文件名 stem** 解析（`检索方法-0.md`）——`links.target_id` 全为 null，`--link-to` 恒 0 条 / 0 字节，
链接密度参数等于白设。修正落在夹具生成器本身，不再依赖一次性副本：

- `scripts/fixture.ts`：wikilink 改用 `slug(title)`（即文件名 stem），仍是 5% 故意断链（`幽灵笔记 k`）；
  `.fixture.json` 新增 `links.format = 'stem'` 与 `samples`（入链最多 / 出链最多的笔记，同数按下标小者，固定种子可复现）。
- `scripts/bench.ts`：`pickSample` 读 `samples.inbound` / `samples.outbound`（老夹具无此字段时退回目录扫描）。
  原来固定取 `notes/concepts` 排序第一篇，恰好是边界笔记 `dup-title-a.md` / `long-note.md`，本身没有链接，
  `backlinks` 一行永远是 0 条 —— 测的不是反查。
- 新增两条用例：`outlinks`（`outlinksOf` / `--linked-by`）与 `walk.both`（单种子 `backlinksOf` + `outlinksOf`
  顺序两次，即 R8 `zk_walk direction=both` 的成本代理）。用例总数 16 → **18**。

**复现**（三档各一次；`--force` 会重建夹具，随后 bench 自己冷建索引并把 `coldIndexMs` 记进 JSON）：

```bash
ZK_BIN=/path/to/zk bun scripts/fixture.ts --notes 10000 --links-per-note <0.2|1|3> --force --json
ZK_BIN=/path/to/zk bun run bench --fixture .tmp/fixture/10k-<x> \
  --cases backlinks,outlinks,walk.both --iterations 3 --json --out .tmp/bench-10k-<x>-walk.json
```

落盘：`.tmp/fx-10k-<x>.json`（夹具清单）、`.tmp/bench-10k-<x>-walk.json`（三行结果）。
10 000 篇、seed 42；链接数 2 000 / 10 000 / 30 000（valid 1 900 / 9 500 / 28 500，断链 100 / 500 / 1 500）。

| 档 | 链接 | 冷建索引 | 用例 | 种子（入链 / 出链） | 子进程 | 字节 | p50 | p95 | count | 超限 |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.2 链/篇 | 2 000 | 81.1 s | `backlinks`（in） | `同步拆解-1853`（4 / 1） | 1 | 5 882 B | 488.7 ms | 610.3 ms | 4 | complete |
| | | | `outlinks`（out） | 同篇 | 1 | 1 993 B | 550.3 ms | 578.8 ms | 1 | complete |
| | | | `walk.both` | 同篇 | **2** | 7 195 B | 994.3 ms | 1 324.3 ms | 5 | complete |
| 1 链/篇 | 10 000 | 248.3 s | `backlinks`（in） | `摘要观察-172`（7 / 2） | 1 | 11 600 B | 538.4 ms | 546.3 ms | 7 | complete |
| | | | `outlinks`（out） | 同篇 | 1 | 4 037 B | 535.6 ms | 544.0 ms | 2 | complete |
| | | | `walk.both` | 同篇 | **2** | 15 076 B | 1 045.6 ms | 1 052.4 ms | 9 | complete |
| 3 链/篇 | 30 000 | 745.0 s | `backlinks`（in） | `周审方法-1288`（12 / 5） | 1 | 23 526 B | 923.5 ms | 939.5 ms | 12 | complete |
| | | | `outlinks`（out） | 同篇 | 1 | 9 655 B | 878.2 ms | 914.0 ms | 5 | complete |
| | | | `walk.both` | 同篇 | **2** | 32 341 B | 1 794.2 ms | 1 824.7 ms | 17 | complete |

1k 口径复跑（`bun run bench --iterations 3`，18 条全绿 / exit 0）：`backlinks` 1 进程 / 12 241 B / p95 98.6 ms（7 条）、
`outlinks` 1 / 3 648 B / 92.5 ms（2 条）、`walk.both` 2 / 14 056 B / 183.5 ms（8 条）。落盘 `.tmp/bench-1k-18.json`。

**结论**：

- R8 的成本口径在**产品夹具**上闭合：三档都实测到 `both` = **2 个子进程**、字节 = in + out 之和、
  p95 0.18–1.82 s（1k → 10k/3 链），与先前副本探针的 1 链/篇结果（2 进程 / 13 986 B / 1 095 ms）同量级，
  外推不再是外推。
- 夹具修好后，`--link-to` 与 `--linked-by` 都能真正按密度出结果：`links` 表里 null `target_id` 只剩故意断链
  + 3 条 MEMORY 标题式链接（1k：1003 条中 53 条 null = 50 断链 + 3 meta）。
- **冷建索引新数字 81.1 / 248.3 / 745.0 s** 与旧代理表（115.6 / 热 / 999.7 s）同量级（机器与磁盘缓存波动）；
  链接密度仍是冷建的主成本项。
- **夹具没有 hub**：链接目标是均匀随机，最大入链只有 4 / 7 / 12 条，三档都**触不到 `limit=200`**，
  因此 `partial` 分支和 200 条满载传输在这套夹具上测不出来。最坏传输仍以 `--limit 201` 满载的
  212–215 KB（上节）为界；R8 的 `partial` / 触顶行为须在测试内自建 hub 库验证（或后续给夹具加一篇 hub 边界笔记，
  那会改变 `samples` 与三档数字，须整档重跑，本轮不做）。
- 全表里 `backlinks` 一行（0 条 / 0 KB）是**修正前**的数字，其余行（`scan` / `list` / `graph` / `lint` / `dream` /
  `search`）与链接文本形式无关、仍然可用；重建后 `graph.full` 的边数从 0 变成 950（1k：旧夹具的 wikilink
  一条都解析不到，传输量仍主要来自节点列表，量级不变）。
  若要更新全表需重跑一次 10k，本轮只重跑反查三行。

## 1k 复跑（3.8.0 发布后基线核对，2026-11-07）

**命令 / 口径**：`ZK_BIN=/home/glm-agent/.dsh/zdiary/bin/zk bun run bench` —— 不指定 `--fixture` 时默认取
`.tmp/fixture/1k-1`（seed 42，1 000 篇 / 1 000 链、1 链/篇，索引已热、无冷建），3 轮；
zk 0.15.7 / linux-x64（WSL）/ bun 1.4.4，与全表同一台机器、同一个 zk。
**本节是 1k 口径，与全表及 R3 / 稳定 ID 补测的 10k 数字不可直接比绝对值**；用途是确认 3.8.0 发布后
16 条现有用例全部可跑、无报错（当时用例表还没有 `zk_walk` / R8；现为 18 条，见上一节），
`docs/plan.md` §11 的提案仍未排期、未实现（§12 六轮评审打回）。
一次运行 19 s、exit 0、表格无 `✗` 行；数字取自终端表格，本次未另落盘 JSON（要落盘可加
`--json --out .tmp/bench-1k-1.json`）。

| 用例 | 工具 | 子进程 | 字节 | p50 | p95 | 峰值RSS | 超时 | 超限 |
|---|---|---|---|---|---|---|---|---|
| `search.cjk` | zk_search | 2 | 28 KB | 271.1 ms | 371.3 ms | 26 MB | 60 s | partial |
| `search.cjk.multi` | zk_search | 2 | 14 KB | 238.6 ms | 258.1 ms | 25 MB | 60 s | partial |
| `search.cjk.single` | zk_search | 1 | 17 KB | 123.2 ms | 135.8 ms | 25 MB | 60 s | complete |
| `search.ascii` | zk_search | 1 | 17 KB | 172.5 ms | 180.3 ms | 26 MB | 60 s | - |
| `scan.10k` | 首页 / 标签页 / lint / dream | 1 | 207 KB | 373.1 ms | 426.4 ms | 29 MB | 60 s | complete |
| `search.filtered` | zk_query | 1 | 207 KB | 310.9 ms | 419.6 ms | 29 MB | 60 s | partial |
| `list.10k` | zk_search / 首页 | 1 | 1.6 MB | 366.1 ms | 384 ms | 33 MB | 60 s | complete |
| `list.2k` | 首页 / 标签页 | 1 | 1.6 MB | 390.3 ms | 467.6 ms | 33 MB | 60 s | complete |
| `list.200` | zk_search | 1 | 273 KB | 159.7 ms | 237.7 ms | 25 MB | 60 s | partial |
| `graph.full` | bidi / zk_lint | 1 | 1.5 MB | 560.9 ms | 706.3 ms | 33 MB | 60 s | complete |
| `lint` | zk_lint | 5 | 1.8 MB | 1.5 s | 1.8 s | 33 MB | 180 s | complete |
| `dream` | zk_dream | 2 | 1.7 MB | 860.6 ms | 907.2 ms | 34 MB | 180 s | complete |
| `backlinks` | bidi | 1 | 0 KB | 104.9 ms | 124 ms | 23 MB | 60 s | complete |
| `stats` | zk_stats | 3 | 304 KB | 647.8 ms | 663.3 ms | 29 MB | 60 s | - |
| `context` | zk_context | 0 | 0 KB | 1.7 ms | 1.7 ms | n/a | - | - |
| `index.warm` | zk-kit index | 1 | 0 KB | 84.6 ms | 101.8 ms | 22 MB | 120 s | - |

与 10k 全表的**预期差异**（不是回归）：

- 1k 库装不进任何 `limit` 上限：`scan.10k` / `list.10k` / `list.2k` 都是 `complete`（10k 下前两者触顶为 `partial`）；
  `search.cjk` / `search.cjk.multi` / `search.filtered` / `list.200` 的 `partial` 是工具自身的结果条数 / 过滤口径，与库规模无关。
- `dream` 2 个子进程、`complete`：1k 未超 `graphBudgetNotes`（默认 2 000），仍会建全图；
  10k 跳过全图（`graphSkipped`），所以是 1 进程 / `partial`。
- `list.10k` 字节 1.6 MB vs 10k 的 15.1 MB、`stats` 304 KB vs 3.0 MB、`context` 1.7 ms vs 0.6 ms，
  都是库规模 / 机器波动，口径同 §0.5 第 2 条。

## 复跑

```bash
ZK_BIN=/path/to/zk bun run fixture --notes 10000 --links-per-note 1   # 只需一次
ZK_BIN=/path/to/zk bun run bench --fixture .tmp/fixture/10k-1 --iterations 3 --json --out .tmp/bench-10k-1.json
ZK_BIN=/path/to/zk bun run bench                                      # 1k 复跑（默认夹具 / 3 轮，见上一节）
```

改了工具就按同一口径补测，把新数字并回本表；`bun run bench --list` 看全部用例，
`--cases a,b` 只跑改动相关的几条。
