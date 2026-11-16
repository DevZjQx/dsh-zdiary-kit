# 成本基线

**用途**：新增或改动工具后按同一口径补测，把新数字并回本表。**不是**每次 PR 的闸门 —— `bench` 只手动跑，
不进 `check` / CI（一条 `graph.full` 在 10k 上就是 30 s，冷建索引几分钟）。

**口径**：每条用例一行，记子进程数 / 回传字节 / 峰值 RSS / p50 / p95 / 超时 / 超限行为 / 库的篇数与链接数。
子进程与字节取自 `execStats`（本进程），峰值 RSS 是 `comm=zk` 的采样峰值，p95 = 第 ⌈0.95n⌉ 轮。
「超限」是工具自己的口径：列表看 `hasMore` / `completeness`，图看它自己的标志；`-` 表示该用例不涉及。

**本表来源**：2026-11-17 一次完整实跑（19 条用例 × 3 轮），
zk 0.15.7（`/usr/bin/zk`）、linux/x64、bun 1.4.4；
夹具 `.tmp/fixture/10k-1` —— 10 000 篇 / 10 000 链（9 500 有效 + 500 故意断链），seed 42，
`links.format = 'stem'`（wikilink 用文件名 stem，zk 才解析得到），索引已热。

## 10k 全表

| 用例 | 工具 | 子进程 | 字节 | p50 | p95 | 峰值RSS | 超时 | 超限 |
|---|---|---|---|---|---|---|---|---|
| `search.cjk` | zk_search | 2 | 30 KB | 1.7 s | 1.9 s | 34 MB | 60 s | partial |
| `search.cjk.multi` | zk_search | 2 | 14 KB | 1.9 s | 2.0 s | 33 MB | 60 s | partial |
| `search.cjk.single` | zk_search | 1 | 12 KB | 938.2 ms | 1.7 s | 35 MB | 60 s | complete |
| `search.ascii` | zk_search | 1 | 20 KB | 860.9 ms | 1.2 s | 35 MB | 60 s | - |
| `scan.10k` | 首页 / 标签页 / lint / dream | 1 | 2.2 MB | 3.3 s | 5.3 s | 62 MB | 60 s | complete |
| `search.filtered` | zk_query | 1 | 2.2 MB | 6.7 s | 7.0 s | 63 MB | 60 s | partial |
| `list.10k` | zk_search / 首页 | 1 | 15.9 MB | 3.7 s | 5.2 s | 69 MB | 60 s | partial |
| `list.2k` | 首页 / 标签页 | 1 | 2.8 MB | 1.2 s | 1.5 s | 37 MB | 60 s | partial |
| `list.200` | zk_search | 1 | 215 KB | 853.7 ms | 1.2 s | 33 MB | 60 s | partial |
| `graph.full` | bidi / zk_lint | 1 | 17.8 MB | 30.4 s | 30.6 s | 78 MB | 60 s | complete |
| `lint` | zk_lint | 65 | 3.3 MB | 57.7 s | 58.5 s | 62 MB | 180 s | partial |
| `dream` | zk_dream | 1 | 2.2 MB | 3.5 s | 4.0 s | 62 MB | 180 s | partial |
| `backlinks` | bidi | 1 | 12 KB | 633.9 ms | 660.5 ms | 32 MB | 60 s | complete |
| `outlinks` | zk_walk (out) | 1 | 4 KB | 601.4 ms | 644.1 ms | 32 MB | 60 s | complete |
| `walk.both` | zk_walk (both) | 2 | 15 KB | 1.2 s | 1.3 s | 32 MB | 120 s | complete |
| `walk.title` | zk_walk (title seed) | 3 | 15 KB | 1.7 s | 1.8 s | 32 MB | 120 s | complete |
| `stats` | zk_stats | 3 | 2.6 MB | 4.1 s | 4.3 s | 65 MB | 60 s | - |
| `context` | zk_context | 0 | 0 B | 0.6 ms | 0.6 ms | n/a | - | - |
| `index.warm` | zk-kit index | 1 | 0 B | 530.0 ms | 575.3 ms | 30 MB | 120 s | - |

**怎么读这张表**

- **读路径可用，全图与冷建不可用**：`graph.full` 30 s / 17.8 MB、`list.10k` JSON 15.9 MB，而精简格式的
  `scan.10k` 只有 2.2 MB。全图超过 `graphBudgetNotes`（默认 2000 篇）时工具会跳过它、改按篇反查。
- **`lint` 的 65 个子进程来自按篇反查**：10k 超过全图上限，单向链接改成「每个候选目标两次 `--link-to` / `--linked-by`」，
  上限 50 个目标 / 60 个子进程（加自身扫描）。这是 `lint` 在 10k 上的真实成本，别把小库上的数字外推。
- **CJK 双跑约 2 个进程**：`search.cjk` 1.7 s / 2 进程，`search.cjk.single`（单进程 FTS 对照）0.94 s / 1 进程。
  纯 ASCII 查询只跑一个进程。
- **`zk_context` 与篇数无关**：0 个子进程、0.6 ms。
- **`walk.*` 恒 2 / 3 个子进程**：路径种子 `both` = 2（`--link-to` + `--linked-by`），标题种子多一次解析（3）。
  字节恒为两笔传输之和，200 条上限的最坏传输约 210 KB（远小于 `graph.full`）。

## 链接密度（10 000 篇，2026-11-07 三档实测）

链接数是**冷建索引的主成本项**；运行期查询基本不受影响（只在 3 链/篇时略涨）。
夹具 `links.format = 'stem'`，三档都是 10 000 篇 / seed 42，链接数 2 000 / 10 000 / 30 000（含 5% 故意断链）：

| 链接/篇 | 链接数 | 冷建索引 | `backlinks` p95 | `outlinks` p95 | `walk.both` p95 / 字节 |
|---|---|---|---|---|---|
| 0.2 | 2 000 | 81.1 s | 610.3 ms | 578.8 ms | 1 324.3 ms / 7 195 B |
| 1 | 10 000 | 248.3 s | 546.3 ms | 544.0 ms | 1 052.4 ms / 15 076 B |
| 3 | 30 000 | 745.0 s | 939.5 ms | 914.0 ms | 1 824.7 ms / 32 341 B |

`walk.both` 恒 2 个子进程，字节 = 入链 + 出链两笔之和。夹具是均匀随机链（最大入链 4 / 7 / 12 条），
三档都**触不到** `limit = 200`，所以 `partial` 分支和满载传输得在测试里自建 hub 库验
（满载上界：`--limit 201` + `--format json` 约 210 KB）。

## 不在 `bench.ts` 里的用例

`bench.ts` 只记子进程与传输字节，所以下面这些纯本地读的用例另用一次性探针测（p95 = 第 ⌈0.95n⌉ 轮）。

| 用例 | 子进程 | 夹具 | p50 | p95 | 说明 |
|---|---|---|---|---|---|
| `zk_memory_write`（默认 dry_run） | 1（首轮 2） | 10k | 2 924.5 ms | 3 151.3 ms | 那 1 个子进程是 `scanNotes`（核实 `[[来源]]` 指向活笔记）；容量 / 日期 / 格式 / 并发门全是纯 JS。首轮多的 1 次是写后可读的增量索引 flush |
| `zk_memory_write`（默认 dry_run） | 1 | 1k | 286.9 ms | 434.6 ms | 字节随篇数线性：10k 2.13 MB / 1k 0.21 MB |
| 死胡同探针（`counterEntries`） | 0 | 10k / 800 篇归档 | 49.5 ms | 64.5 ms | 按**归档篇数**线性增长，与库的笔记数无关；上界 `MAX_ARCHIVE_SCAN` = 2000 篇 |
| 入口卡（`entryPoints`，`via=query`） | 0 | 10k | 0.7 ms | 3.1 ms | 纯内存字符串比对，与库规模无关 |
| `attachSummaries`（limit 10） | 0 | 10k | 2.53 ms | 16.53 ms | 只读可见命中，`readFileSync` |
| `attachSummaries`（limit 200） | 0 | 10k | 18.35 ms | 145.33 ms | 上界 200 次本地读 |
| 召回 sidecar 读（10k 稳态 1.32 MB） | 0 | 10k | 34 ms | 75–87 ms | 默认关；打开后每次 `zk_context` 付这笔解析 |
| 召回 sidecar 写（10k 稳态 + 10 命中） | 0 | 10k | 47–51 ms | 53–74 ms | 每次命中检索重写整份 sidecar（tmp + rename） |
| 依据回对（`evidence`） | 0 | 1k 篇带 `## 出处` | 52.9 ms | 87.6 ms | 约 53 µs/篇；单次 `zk_dream` 最坏 80 篇 ≈ 4.2 ms |

## 复跑

```bash
# 夹具只需生成一次（--force 才重建；重建后 bench 会冷建索引并把 coldIndexMs 记进 JSON）
ZK_BIN=/path/to/zk bun run fixture --notes 10000 --links-per-note 1
ZK_BIN=/path/to/zk bun run bench --fixture .tmp/fixture/10k-1 --iterations 3 --json --out .tmp/bench-10k-1.json

# 1k 口径（默认夹具，十几秒；与 10k 数字不可直接比绝对值）
ZK_BIN=/path/to/zk bun run bench
```

`bun run bench --list` 看全部用例，`--cases a,b` 只跑改动相关的几条。
**改了工具就按同一口径补测，把新数字并回本表** —— 一次跑出一整张表，别把几轮的零散结果摞在一起
（上一版就是这么变成测量日志的，已归档到 [`docs/archive/bench-baseline-2026-11-17.md`](archive/bench-baseline-2026-11-17.md)）。
