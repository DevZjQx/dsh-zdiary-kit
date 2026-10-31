# dsh-zdiary-kit 0.7.3

> 给 [DSH](https://github.com/deepseek-ai/deepseek-harness) 装一个**内置 [zk](https://github.com/zk-org/zk) 的知识库 / 日记本**：
> 插件提供一键安装 zk（官方 release；设置页按钮或 `zk-kit install`）、自动建笔记本（zk init + 日记模板 + 日记 group），
> 然后给 agent 一组 `zk_*` 工具 —— 查、读、写、记日记、连双链，全部走 zk 自己的索引。
>
> 装好 zk 后不用先配环境：agent 第一次调用工具时就把笔记本建好；设置页里再调路径、重建索引、跑自检。

## 它给 agent 什么

| 工具 | 干什么 |
|---|---|
| `zk_search` | 全文 / 标签 / 日期 / 断链 / 孤立笔记检索，返回标题、路径、标签、摘要 |
| `zk_query` | 结构化检索：按 type / status / 标签 / 目录 / 日期过滤，默认只看 active 且不含归档；`include_archived` 连归档一起查（此时未显式给 status 则不再默认过滤 active） |
| `zk_read` | 读一篇全文（按路径，或先按词找最相关的一篇）；超长会截断并标注 |
| `zk_new` | 新建原子笔记（zk 生成文件名、套模板、写索引），可带标签与双链；`name` 可直接指定短文件名（不给则按标题生成，中文标题得到拼音长名）；flat 下按标题查重，重复直接报错；归档里有同名旧结论只警告并带出废弃原因；type / authority 只有 layered 模板会写进 frontmatter；`raw/` 与根目录 meta 文件一律拒写（写进去会被排除出索引 / 被当成人写的工作面） |
| `zk_append` | 往已有笔记末尾续写（自动补空行，可先起二级标题）；根目录 meta 文件拒写 |
| `zk_daily` | 打开/创建某天的日记，并追加一条带时间的记录（layered 模板写进 `## Events` 的 `### HH:MM`，flat 追加到文件末尾的 `## HH:MM`） |
| `zk_link` | 在两篇笔记间加 `[[…]]` 双链（已存在不重复加；目标不存在会给出候选；链接追加到文末，已有 Links/链接 小节则不重复起标题）；meta 文件不作为来源或目标 |
| `zk_supersede` | 废弃过时结论：标 `superseded` + 写 `reason` + 搬进 `archive/` + 重写能精确匹配的 `[[旧路径]]` 入链（其它写法列进 `missingLinks`）；默认只预演；meta 文件不能废弃 |
| `zk_rename` | 改名 / 换目录并修断链：入链（`[[…]]` 与 Markdown 链接，保留 `#锚点` 与 `\|别名`）按实际解析结果改到新路径，根目录 meta 里的 `[[来源]]` 一起改，被搬走那篇自己的相对 Markdown 链接按新位置重算；默认只预演 |
| `zk_context` | 读知识库根目录的 `AGENTS.md` / `USER.md` / `MEMORY.md`（按注入预算截断），并列出已配置的笔记本（名字 / 路径 / 结构 / 当前）；宿主支持注入时记忆每轮已自动带进系统提示 |
| `zk_lint` | 体检：解析失败 / 断链 / 孤儿 / 无标签 / 单向链接 / 陈旧 / 重名标题 / 记忆链接失效，每类最多 50 条；只报告不改写 |
| `zk_dream` | 晋升材料：窗口新增（机械筛掉 `informal` 与无标签，带正文摘要与入链来源）、daily 未完成项、被引最多；只报告 |
| `zk_stats` | 笔记数 / 标签数 / 断链 / 孤立 / 归档（superseded） |
| `zk_use` | 切换**本会话**用的笔记本（只影响这个会话，不改全局默认）；不带参数就列出现有的与当前固定的 |

写笔记前 agent 会先 `zk_search` 查重；flat 笔记本的 `zk_new` 还会按标题再查一次，重复直接报错。
layered 笔记本的文件名是标题的 slug：英文标题自然得到英文文件名，短不短看标题本身；中文标题会变成很长的拼音名，要短名就在 `zk_new` 时传 `name`；老笔记不自动改名，**手工 `mv` 会断入链**，要改名用 `zk_rename`（默认预演，会重写引用）。
双链用相对路径（zk 的 `link-format = "wiki"` 认这个），所以 `--broken-links` 不会因为「按标题链接」而误报。

**多会话**：每个会话第一次调工具时，会把当时配置里的默认笔记本**固定**下来（落在 `~/.dsh/zdiary/sessions/`，
一个会话一份）。之后别的会话或设置页 / `zk-kit notebooks use` 切库，都不会把这个会话带到另一个库里 ——
记忆注入也跟着这个会话固定的那本走。要跟着换，就在**那个会话里**说「切到 X 库」（agent 调 `zk_use`）。
每轮系统提示里还会带一行当前笔记本（名字 / 路径 / 结构）和其余已配置库 —— 模型不用先调工具就知道自己在哪本、还能切到哪本。
设置页保存时带文件指纹，别处刚改过配置会 409 并要求确认，不会拿旧表单把别人的 `active` 覆盖回去。
路径找不到时，`zk_read` / `zk_append` 还会顺手查别的笔记本里有没有同名笔记，并告诉你它在哪一本。

**长期记忆**：笔记本根目录放 `AGENTS.md`（工作约定）、`USER.md`（偏好）、`MEMORY.md`（精炼记忆），
插件会在每个 step 把它们注入系统提示（预算默认 500 词，设置页「记忆 → 注入预算」可改；
超了先丢 MEMORY 的尾部整段，并留一份未注入段落的目录（段落标题）—— 需要时用 `zk_read MEMORY.md` 取回；
同时明确告诉你截了多少、以及是不是 AGENTS 吃掉了大半预算）。
笔记本提示是单独的一段，不占这 500 词预算。
DSH 自带的 AGENTS.md 加载只看「项目根 → 当前目录」链，**不会**读笔记本根目录，所以别指望宿主帮你加载 —— 是插件自己读、自己注入。

维护用 `zk_lint`（结构体检 + 记忆链接核对）和 `zk_dream`（晋升候选 / 拒绝原因 / 未完成项）：两个工具都**只读**，
写 `MEMORY.md` / `DREAMS.md` 由 agent 按 `AGENTS.md` 自己决定 —— 机械活留在插件，语义判断留在可审计的地方。
`zk_lint` 会核对 `MEMORY.md` / `USER.md` 里的 `[[来源路径]]` 是否还指向活笔记 ——
`zk_supersede` 只重写笔记之间的入链，meta 文件不在图里，链接不会跟着搬，`--broken-links` 也看不见。
改名同理：`zk_rename` 会把 `zk graph` 里的入链和根目录 meta 的 `[[来源]]` 一起改到新路径，被搬走那篇自己的相对 Markdown 链接也按新位置重算 —— 手工 `mv` 会一次断掉这三处。
插件不跑定时任务：`DREAMS.md` 开头写一行 `上次做梦：YYYY-MM-DD`，注入里就会按 7 天节奏提醒该整理
（没做过就提示先跑一次；没有 `AGENTS.md` 的库不提醒）。

## 装

```bash
# 1) 装插件（本地目录 / 发布后的包名都行；仓库带 dist，装的时候不编译）
dsh plugin --profile web add "link:/path/to/dsh-zdiary-kit"
# 发布后：dsh plugin --profile web add dsh-zdiary-kit

# 2) 重启一次 DSH（bundle 层要重启才组装）
```

> 从源码跑：`bun install && bun run build`（只在你改过源码时才需要）。

重启后两处可见：

- **工具**：会话里直接问「用 zk 帮我记一条：……」，模型就能看到 `zk_*` 工具；
- **设置页**：DSH「设置 → 知识库（zk）」。

> 不想让插件装 zk 也行：系统里有 `zk`（`brew install zk` / `go install github.com/zk-org/zk@latest`）
> 就直接用；也可以把路径填进设置页的「zk 路径」。

## 第一次用

装好 zk 的前提下，什么都不用点：

1. agent 第一次调 `zk_new` / `zk_daily` / `zk_search`，插件先 `ensureNotebook`——
   建目录 → `zk init` → 写 `.zk/templates/daily.md` → 往 `config.toml` 补 `[group."daily"]`；
2. 如果本机没有 zk，工具会明确告诉你「找不到 zk 可执行文件」，此时去设置页点
   **安装内置 zk**（从 GitHub 官方 release 下 `zk-v<版本>-<平台>.tar.gz`，解到 `~/.dsh/zdiary/bin`，
   装完真跑一次 `zk --version` 才算成功）。装完会回显下载源：设了 `ZK_DOWNLOAD_BASE` 就明确标成
   「自定义镜像」并给出实际 URL —— 上游 release 不带校验和，至少让你知道刚才信任了谁；
3. 点 **自检** 看七项：zk、笔记本、日记模板、日记 group、结构、长期记忆、索引。
   zk / 索引会真起进程，笔记本 / 模板 / group / 结构直接读磁盘与配置，长期记忆会重算一遍载荷。

## 设置页里有什么

| 分组 | 字段 | 说明 |
|---|---|---|
| 笔记本 | 当前笔记本（下拉） | 切换 = 改**新会话的默认值**（`active`）；每个会话首次使用时固定一本，跑着的会话不跟着变 —— 要跟过去用 `zk_use`。切换保存后自动建好目标笔记本（幂等，不动已有笔记） |
| 笔记本 | 每个笔记本一行：路径 + 结构 | 路径空 = `<会话工作区>/zdiary`（在工作区内，agent 能直接读写）；相对路径按工作区解析；也可以指向任何已有 zk 笔记本。结构（`flat` / `layered`）是**每个笔记本自己的**，行里直接选。**删除只移除配置，磁盘目录与笔记保留** |
| 目录与 group | 笔记子目录 / 日记子目录 | 默认 `notes` / `journal`（全局共用，不按笔记本分开） |
| 目录与 group | 日记 group 名 | 默认 `daily`，初始化时自动补配置 |
| 目录与 group | 归档目录 | `supersede` 后搬到这里（保留原相对路径），默认 `archive` |
| 记忆 | 注入预算（词） | AGENTS + USER + MEMORY 的合计上限，默认 500（中文按 2 字 1 词） |
| 写入 | 默认标签 / zk_read 上限 | 新笔记自动带标签；单次读取字符上限 |
| zk | zk 路径 / 内置版本 | 路径空 = 自动找；版本默认 0.15.7 |

按钮：**保存** · **初始化 / 补建（按钮上带当前笔记本名）** · **重建索引** · **安装内置 zk** · **自检** · **刷新**；
同一个按钮随状态换字：没建过叫「初始化笔记本 *名*」，缺目录 / 缺 `AGENTS.md` 叫「补建 *名* 的目录」。
分组标题直接标了作用范围：**笔记本**那组是每个笔记本自己的，其余分组都是全局（所有笔记本共用）。
字段是先改在本地、点保存才落盘 —— 不点保存 = 什么都没发生；保存后工具下一次调用就用新值（配置每次现读）。

## 多个笔记本

配置里可以放好几个笔记本。`active` 是**新会话的默认值**：还没 pin 的会话、以及设置页的计数与自检看它；已经有 pin 的会话看自己那本（下面会讲）：

```json
{
  "notebooks": {
    "default": { "path": "", "structure": "flat" },
    "work": { "path": "~/work/zdiary", "structure": "layered" }
  },
  "active": "work"
}
```

- `notebooks`：名字 → `{path, structure}`。名字只接受字母、数字、`_` 与 `-`（1-32 字符）；路径为空就是 `<会话工作区>/zdiary`，相对路径按工作区解析。老写法（名字 → 裸路径字符串）照常读，结构继承全局缺省。
- **路径与结构都是笔记本自己的属性**：`work` 可以是 layered 而 `default` 还是 flat，互不牵连。
- `active`：**默认**笔记本的名字（新会话用）。每个会话第一次调工具时会把当时的 `active` 固定成自己的 pin
  （`~/.dsh/zdiary/sessions/`），之后改这里不会带动已开的会话；本会话换库在会话里说一声（`zk_use`）。名字不存在、非法时退回 `default`。
- 顶层 `notebook` 与 `structure` 是**派生的**（`notebooks[active]` 解析后的绝对路径 / 该条目的结构），只在内存里、不落盘也不可写；可写的是条目里的 `notebooks[名].structure`（`zk-kit config set structure=…` 改的就是当前笔记本那一条）—— 磁盘上笔记本只有一个真相，就是 `notebooks` + `active`。
  老配置里那个单独的 `notebook` 字段（和全局 `structure`）读进来会**一次性**迁进 `notebooks.default`，之后不再互相覆盖。
- **共享的是全局项**：笔记 / 日记子目录、`daily` group、归档目录、注入预算 —— 这些不按笔记本分开。

```bash
zk-kit notebooks                     # 列出所有笔记本（* 是当前那个；[flat/layered] 是各自的结构）
zk-kit notebooks add work work-zdiary
zk-kit notebooks use work            # 切换并自动建好目标笔记本（幂等）
zk-kit notebooks
zk-kit notebooks remove work         # 从配置移除（只删配置，磁盘目录与笔记保留；至少留一个；删的是当前那个就自动切到剩下的第一个）
zk-kit notebooks
```

设置页里改「当前笔记本」下拉、改路径 / 结构、新增 / 删除，最后点 **保存** 落盘；命令行 `zk-kit notebooks …` 改的是同一份配置。
保存带文件指纹：页面打开期间别处（别的会话 / CLI）改过配置就 409，页面刷新成最新值再让你确认一次，不会拿旧表单覆盖。
删除笔记本只是从配置里移除条目（设置页会先确认）：磁盘上的目录与笔记原样保留，加回同名条目就能继续用。
空 / 相对路径按**会话工作区**解析：设置页显示的是**插件进程工作区**下的解析结果，agent 在别的会话里调用时可能落在它自己的工作区 —— 要固定位置就写绝对路径。
**切换即就绪**：`use`（和设置页保存时切换）会顺手把目标笔记本建好 —— `ensureNotebook` 幂等，缺了才补，不动已有笔记；
改路径 / 新增**不**自动建目录（防手滑把库建到打错的路径上），切过去再建。
新笔记本的结构跟当前那个一致；要改某个笔记本的结构，切到它再 `zk-kit config set structure=layered`（或用设置页那一行的下拉）。

## 笔记本长什么样

```
<notebook>/
├── .zk/
│   ├── config.toml          # zk init 生成；插件只追加缺失的 group，别的一字不动
│   ├── notebook.db          # 索引（SQLite；zk list / tag / graph 都靠它）
│   └── templates/
│       ├── default.md       # zk 自带：# {{title}}

{{content}}
│       └── daily.md         # 插件写：# {{format-date now "%Y-%m-%d"}}

{{content}}
├── notes/                   # 普通笔记（文件名由 zk 生成，如 notes/f2sj.md）
└── journal/2026-10-29.md    # 一天一篇，文件名就是日期
```

追加到 `config.toml` 的只有这一段（已有同名 group 就跳过）：

```toml
[group."daily"]
paths = ["journal"]

[group."daily".note]
filename = '{{format-date now "%Y-%m-%d"}}'
template = "daily.md"
```

### 分层结构（可选）

给某个笔记本选 `layered`：设置页笔记本那一行的结构下拉，或切到它后 `zk-kit config set structure=layered`
（等价于改 `~/.dsh/zdiary/zdiary.config.json` 里**那个条目**的 `structure` —— 结构是每个笔记本自己的），
再点 **初始化 / 补建**（或 `zk-kit init`）会补出：

```
<notebook>/
├── raw/            # 原始材料，只读
├── inbox/          # 还没想好归属的碎片
├── AGENTS.md       # 工作约定（模板由插件写入；agent 每轮读它，DSH 不会自动加载）
├── WORKFLOW.md     # 改已有笔记的细则：先列清单、三分类（不注入，按需读）
├── notes/
│   ├── sources/
│   ├── concepts/
│   ├── entities/
│   └── patterns/
└── archive/        # superseded 的笔记搬到这里（保留原相对路径）
```

外加 `source.md` / `entry.md` 两套模板与 source / concept / entity / pattern 四个 group
（`entry.md` 三处共用，`type` 与 `authority` 由 `[group.X.extra]` 注入），
以及根目录两份模板：**`AGENTS.md`**（检索词归宿、中文必须打 tags、"插件不保证宿主自动加载本文件"三件事）
与 **`WORKFLOW.md`**（改已有笔记前先列受影响清单等确认，再按 temporal / context variant / contradiction 三分类动手）。
`WORKFLOW.md` 不进每轮注入 —— 它低频但重要，塞进 `AGENTS.md` 会把 500 词预算挤到 MEMORY 没位置。
**只建目录与模板，不搬已有笔记**；已存在的模板与 `AGENTS.md` / `WORKFLOW.md` 一律不覆盖。
切回 `flat` 同理：只改配置，已建出来的 `raw/` `archive/` 不会被删 —— 所以切换是「随时可逆」的，代价只是目录留在那里。
`zk-kit config set` 会把被归一化改掉的值回显出来（例如 `structure=xyz` → 实际 `flat`），不会"命令成功但没生效"。
注意：从 flat 升级时旧的 `daily.md` 已存在，因此不会自动换成带 Events / Observations / Loose ends 的 layered 日记模板；
想要三节模板，先备份并删掉 `<notebook>/.zk/templates/daily.md`，再点「初始化 / 补建」。
设置页的结构**以配置为准**：配置是 `layered` 但磁盘缺目录时只显示告警（底部按钮会变成「补建 *名* 的目录」），不自动建、不自动删。`raw/` `inbox/` `archive/`
与根目录的 `AGENTS.md` / `MEMORY.md` / `USER.md` / `DREAMS.md` / `INDEX.md` / `WORKFLOW.md` 不进检索与笔记 / 标签 / 断链 / 孤立统计；
`archive/` 的归档数由 `zk_stats` 单独统计（`archived` / `superseded`）。`-x` 传绝对路径：它是相对 cwd 解析的，传相对名在换工作目录后会静默失效。

## zk 从哪来（优先级）

1. 设置页「zk 路径」（显式指定，最优先）
2. `$ZK_BIN`
3. `PATH` 里的 `zk`
4. 插件内置：`~/.dsh/zdiary/bin/zk`（Windows 为 `zk.exe`）

四级都找不到就报错并给出安装提示。内置安装只信「跑得起来」：
下载 → `tar -xzf`（需要系统 tar，Win10+ 自带）→ `chmod 755` → `zk --version` 通过才算装好。
国内网络可设 `ZK_DOWNLOAD_BASE` 换镜像（默认 `https://github.com`）。

## 命令行（人也能用）

装好插件后命令叫 `zk-kit`（包里声明了 `bin`）；从源码跑就把 `zk-kit` 换成 `bun src/cli.ts`。
下面这一块是**可跑清单**：`bun run docs` 会在临时 vault 上逐条真跑（`bun run smoke` 也会带上），
拼错子命令、漏必填参数、引用不存在的路径都会当场变红。

```bash
zk-kit init                          # 建库 / 补齐目录、模板、group、AGENTS.md（幂等）
zk-kit new --title "示例笔记" --body "正文" --tags demo
zk-kit search --tags demo --limit 5
zk-kit daily --entry "今天把 zk-kit 跑了一遍"
zk-kit lint --stale-days 90          # 体检（只读）
zk-kit dream --days 7                # 晋升材料（只读）
zk-kit query -- -t demo --limit 5    # 透传 zk list：--notebook-dir / --format / -x 会被替换掉
zk-kit index
zk-kit config get structure          # 看一个配置项（不传键 = 全量）
zk-kit config set structure=layered  # 只落盘配置，不建目录 —— 目录要 zk-kit init 补
zk-kit doctor                        # 自检：zk / 笔记本 / 模板 / group / 结构 / 记忆 / 索引
```

按路径用的子命令（`<…>` 要换成真实路径，所以不放进可跑清单）：

| 子命令 | 用法 |
|---|---|
| 读 | `zk-kit read notes/f2sj.md`，或 `zk-kit read --query 搜索词`；`--max-chars` 可调 |
| 续写 | `zk-kit append notes/f2sj.md --text "追一段" --heading 后续` |
| 双链 | `zk-kit link notes/a.md "某篇标题"` |
| 指定目录 | `zk-kit new --title 标题 --dir notes/concepts`（layered 下 type 由目录所属 group 决定） |
| 指定文件名 | `zk-kit new --title 很长的中文结论标题 --name 短文件名`（只换文件名，标题与正文不动；不给就是拼音 slug） |
| 装 zk | `zk-kit install 0.15.7`（下载约 10 MB → `~/.dsh/zdiary/bin`，不在可跑清单里） |

除 `doctor` / `help` / `config set` 外，其余子命令加 `--json` 输出结构化结果。
`config set` 只认白名单键，值会被同一份归一化处理（`structure=xyz` 落盘成 `flat` 并回显），
与设置页共用一套告警口径。区别只有一处：`config set` **只改配置不建目录**；设置页保存时如果把 `active` 切到另一本，会顺手 `ensureNotebook` 建好目标库。`structure` 改的是**当前笔记本**的结构。
派生键不接受单键赋值：`notebook=…`（纯派生）与 `notebooks=…`（整体映射）会直接报错并指路 `zk-kit notebooks …`。
装好插件后也可以直接用 `node <插件目录>/dist/cli.js …`。

## 权限

分两处落盘，会话文件策略对它们的影响不一样：

| 位置 | 里面是什么 | `workspace-write` 下 |
|---|---|---|
| `<工作区>/zdiary`（默认笔记本） | 笔记、日记、AGENTS.md | 在工作区内：agent 直接 `Read` / `Edit` 就行 |
| `~/.dsh/zdiary` | 配置、内置 zk、缓存 | 在工作区外：agent 写会被拒；插件自己在宿主进程里读写，不受影响 |

所以普通用法保持 `workspace-write` 即可，不需要 `danger-full-access`。两点例外：

- **笔记本故意放到工作区外**（多个项目共用一个库）：agent 直接 `Read` / `Edit` 会被拒，报
  `file access denied under workspace-write mode`。要么把那个目录加进 `additionalWritableRoots`
  （只解决写），要么开会话到 `danger-full-access`。就算不放开，`zk_*` 工具照常能用 ——
  它们走插件自己的 `node:fs` 和 `zk` 子进程，不经这层策略。
- **工作区按会话算**：`zk_*` 每次调用都从宿主拿这次会话的 cwd（`exec.agent.id` → `sessions.get(id).header.cwd`），
  默认笔记本就是 `<会话工作区>/zdiary` —— 同一个宿主进程开多个工作区，各看各的，不用重启也不用改配置。
- **注入与工具同口径**：系统提示里的 AGENTS / USER / MEMORY 也按会话工作区解析（装配上下文带 agent 时），
  记忆注入和 `zk_*` 看的永远是同一份；不带 agent 的裸装配（预览之类）才退回进程工作区。
- **显式配置优先**：笔记本写绝对路径就钉死；写相对路径（如 `zdiary`）则按上面那个工作区解析。
- 拿不到会话上下文的调用（设置页、`zk-kit` 命令行）退回**进程工作区**：
  `$DSH_WORKSPACE` → 进程 cwd（每次现读，不是启动时定死）。

## 排错

| 症状 | 真正原因 |
|---|---|
| 工具列表里没有 `zk_*` | 宿主没有 `tools` 服务（或插件没启用）；看 DSH 日志里的 `[zdiary]` 行 |
| 「找不到 zk 可执行文件」 | 没装也没点「安装内置 zk」；或填了错的「zk 路径」 |
| 「这个目录还不是 zk 笔记本」 | 笔记本目录配错了，点「初始化 / 补建」 |
| 设置页 404 | `cordis.patch.yml` 里的 `name:` 与安装后的包名不一致 |
| 设置页 503 | 宿主没有 `connection` 服务，信任栅栏按 fail-closed 拒绝（工具不受影响） |
| 安装 zk 报「解包失败」 | 系统没有 `tar`；手动解包后把 `zk` 放进 `~/.dsh/zdiary/bin` |
| 搜索结果不全 | 索引落后：点「重建索引」（`zk index`），或确认文件没被 `.zk/config.toml` 的 `exclude` 排除 |
| 自检报「✗ 长期记忆：N/预算 词」 | AGENTS + USER + MEMORY 写太长：先压缩，或在设置页调高「注入预算」（超预算时注入会先丢 MEMORY 尾部整段） |
| 体检报「记忆链接：N 条失效」 | `MEMORY.md` / `USER.md` 里的 `[[来源]]` 指向的笔记已归档或删除：改成 `archive/` 下的新路径，或改指活笔记；显式写 `archive/` 的链接不算失效 |
| `Read` / `Edit` 笔记本报 `file access denied under workspace-write mode` | 笔记本被指到了工作区外。改用 `zk_*` 工具（不经这层策略），或把目录加进 `additionalWritableRoots`，或开会话到 `danger-full-access` |
| 设置页出现「结构是 layered，但缺目录」 | 配置与磁盘不一致（换过机器 / 手动删过目录）：点「补建 *名* 的目录」，别手改配置去将就磁盘 |
| 切了笔记本，笔记数对不上 | 每个笔记本各自一份 `.zk/` 索引与笔记：切换是换库，不是合并；`zk-kit notebooks` 看当前是哪个 |
| 新建时提示「归档里有同名旧结论」 | 允许复用标题，但先 `zk_read` 归档那篇，确认不是同一个错误；插件只警告、不拦 |
| 往 `raw/` 写笔记报「只读」 | `raw/` 是原始材料：写进去的笔记会被排除出索引，表现成「写了但搜不到」；所以 `zk_new` / `zk_append` / `zk_link` / `zk_supersede` / `zk_rename` 直接拒绝 | 结论写到 `notes/`；原文留在原位，用 `zk_read raw/xxx.md` 或直接读文件对照 |
| `config set notebook=…` 报「派生值」 | `notebook` 是 `notebooks[active]` 解析后的派生值、不落盘也不可写：改路径用 `zk-kit notebooks add 名 路径`，切换用 `use` |

## 开发

- 源码全是 `.ts`；宿主半边用 `tsc` 编到 `dist/`（普通 ESM，DSH 用 Node 加载）；
  浏览器半边 `client.ts` 零 import，`postbuild` 把 tsc 补的 `export {}` 删掉，并检查没有顶层声明
  （DSH 会把多个插件的 `client.js` 拼进同一个 combo 脚本，顶层 `const` / `function` 会撞名导致插件不激活）。
- `bun run typecheck` · `bun run build` · `bun run test`（真起 zk）·
  `bun run smoke`（加载 dist：跑一遍 14 个工具 + 覆盖 6 条设置路由，并检查输出 schema 在 DSH 支持的子集内）·
  `bun run docs`（把 README / docs 里 `zk-kit …` 代码块在临时 vault 上逐条真跑；`smoke` 末尾会带上）
- `bun run test` 会先按插件自己的顺序找 zk（配置 → `ZK_BIN` → PATH → `~/.dsh/zdiary/bin`），跑完要求 **skip = 0**：
  集成测试跳过一律按失败处理，否则「全绿」可能是「什么都没跑」。要换 zk 就 `ZK_BIN=/path/to/zk bun run check`。
- `dist/` 随仓库提交：`dsh plugin add github:…` 不会触发安装时构建（pnpm 默认禁止 git 依赖跑构建脚本）。
  所以 `bun run check` 里串了一道 **dist 漂移闸**（`bun run check:dist`）：dist 有未提交改动、而 src 已经干净时报错
  （源码提交了、dist 没跟上）；src 也还脏时跳过 —— 本地改源码时 dist 本来就是脏的，那不是漂移。
- CI（`.github/workflows/ci.yml`）在 ubuntu 上装 zk 后跑 `check` + `smoke`，和本地两条命令完全一样。
  它兑现的是那两个安全网：测试 **skip = 0**、README 里的命令**真跑** —— 靠人记得跑是不够的。

### 目录

```
src/
├── app/plugin.ts                 # 装配：信任栅栏、工具注册、路由门（唯一组合点）
├── config/                       # paths（唯一路径真相）+ store（默认值/白名单/归一化）+ session（会话级笔记本）
├── lib/
│   ├── zk.ts                     # zk 唯一的调用面：解析二进制、list/new/append/link/daily/graph、路径守卫
│   ├── frontmatter.ts            # 只改 status / superseded-by 这类标量，其余行原样保留
│   ├── meta.ts                   # meta 文件清单（注入 3 份 / 排除 6 份，一个真相）
│   ├── lint.ts / dream.ts        # 巡检与做梦：只报告，绝不写文件
│   ├── notebook.ts               # 自举：zk init + 日记模板 + group 配置（幂等）
│   ├── install.ts / platform.ts  # 内置 zk：平台映射、下载、解包、验证
│   ├── tool.ts                   # 最小 JSON Schema 构造 + 输入校验（裸注册工具自己兜）
│   ├── lock.ts                   # 跨进程文件锁（写配置时用，O_EXCL + stale 清理）
│   ├── dsh.ts                    # 宿主契约（纯类型，编译后为空）
│   └── exec.ts / http.ts / json-file.ts
├── features/
│   ├── zk-tools/feature.ts       # 14 个工具
│   └── settings/                 # 宿主 API + 浏览器 section
└── cli.ts                        # zk-kit 命令行
```

## 卸载

```bash
dsh plugin --profile web remove dsh-zdiary-kit
rm -rf ~/.dsh/zdiary          # 内置 zk + 配置；笔记本在工作区里（<工作区>/zdiary），要删自己来
```

## License

MIT
