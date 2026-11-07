# 10k 成本表（落盘基线）

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

## 复跑

```bash
ZK_BIN=/path/to/zk bun run fixture --notes 10000 --links-per-note 1   # 只需一次
ZK_BIN=/path/to/zk bun run bench --fixture .tmp/fixture/10k-1 --iterations 3 --json --out .tmp/bench-10k-1.json
```

改了工具就按同一口径补测，把新数字并回本表；`bun run bench --list` 看全部用例，
`--cases a,b` 只跑改动相关的几条。
