# dsh-zdiary-kit 0.1.0

> 给 [DSH](https://github.com/deepseek-ai/deepseek-harness) 装一个**内置 [zk](https://github.com/zk-org/zk) 的知识库 / 日记本**：
> 插件自己装 zk（官方 release，一条命令）、自己建笔记本（zk init + 日记模板 + 日记 group），
> 然后给 agent 一组 `zk_*` 工具 —— 查、读、写、记日记、连双链，全部走 zk 自己的索引。
>
> 不用先配环境：agent 第一次调用工具时就把笔记本建好；设置页里再调路径、重建索引、跑自检。

## 它给 agent 什么

| 工具 | 干什么 |
|---|---|
| `zk_search` | 全文 / 标签 / 日期 / 断链 / 孤立笔记检索，返回标题、路径、标签、摘要 |
| `zk_query` | 结构化检索：按 type / status / 标签 / 目录 / 日期过滤，默认只看 active 且不含归档 |
| `zk_read` | 读一篇全文（按路径，或先按词找最相关的一篇）；超长会截断并标注 |
| `zk_new` | 新建原子笔记（zk 生成文件名、套模板、写索引），可带标签、type / authority 与双链；标题撞名直接报错 |
| `zk_append` | 往已有笔记末尾续写（自动补空行，可先起二级标题） |
| `zk_daily` | 打开/创建某天的日记，并追加一条 `## HH:MM` 记录 |
| `zk_link` | 在两篇笔记间加 `[[…]]` 双链（已存在不重复加；目标不存在会给出候选） |
| `zk_supersede` | 废弃过时结论：标 `superseded` + 搬进 `archive/` + 重写所有入链；默认只预演 |
| `zk_context` | 读知识库根目录的 `AGENTS.md` / `USER.md` / `MEMORY.md`（按注入预算截断）；宿主支持注入时每轮已自动带进系统提示 |
| `zk_stats` | 笔记数 / 标签数 / 断链 / 孤立笔记 |

写笔记前 agent 会先 `zk_search` 查重；双链用相对路径（zk 的 `link-format = "wiki"` 认这个），
所以 `--broken-links` 不会因为「按标题链接」而误报。

**长期记忆**：笔记本根目录放 `AGENTS.md`（工作约定）、`USER.md`（偏好）、`MEMORY.md`（精炼记忆），
插件会在每个 step 把它们注入系统提示（默认预算 300 词，超了先丢 MEMORY 的尾部整段，并明确告诉你截了多少）。
DSH 自带的 AGENTS.md 加载只看「项目根 → 当前目录」链，**不会**读笔记本根目录，所以别指望宿主帮你加载。

## 装

```bash
# 1) 装插件（本地目录 / 发布后的包名都行；仓库带 dist，装的时候不编译）
dsh plugin --profile desktop add "link:/path/to/dsh-zdiary-kit"
# 发布后：dsh plugin --profile desktop add dsh-zdiary-kit

# 2) 重启一次 DSH（bundle 层要重启才组装）
```

> 从源码跑：`bun install && bun run build`（只在你改过源码时才需要）。

重启后两处可见：

- **工具**：会话里直接问「用 zk 帮我记一条：……」，模型就能看到 `zk_*` 工具；
- **设置页**：DSH「设置 → 知识库（zk）」。

> 不想让插件装 zk 也行：系统里有 `zk`（`brew install zk` / `go install github.com/zk-org/zk@latest`）
> 就直接用；也可以把路径填进设置页的「zk 路径」。

## 第一次用

什么都不用点：

1. agent 第一次调 `zk_new` / `zk_daily` / `zk_search`，插件先 `ensureNotebook`——
   建目录 → `zk init` → 写 `.zk/templates/daily.md` → 往 `config.toml` 补 `[group."daily"]`；
2. 如果本机没有 zk，工具会明确告诉你「找不到 zk 可执行文件」，此时去设置页点
   **安装内置 zk**（从 GitHub 官方 release 下 `zk-v<版本>-<平台>.tar.gz`，解到 `~/.dsh/zdiary/bin`，
   装完真跑一次 `zk --version` 才算成功）；
3. 点 **自检** 看五项：zk、笔记本、日记模板、日记 group、索引 —— 每项都真跑，不做样子。

## 设置页里有什么

| 分组 | 字段 | 说明 |
|---|---|---|
| 笔记本 | 笔记本目录 | 空 = `~/.dsh/zdiary/notebook`；也可以指向任何已有 zk 笔记本 |
| 笔记本 | 笔记子目录 / 日记子目录 | 默认 `notes` / `journal` |
| 笔记本 | 日记 group 名 | 默认 `daily`，初始化时自动补配置 |
| 写入 | 默认标签 / zk_read 上限 | 新笔记自动带标签；单次读取字符上限 |
| zk | zk 路径 / 内置版本 | 路径空 = 自动找；版本默认 0.15.7 |

按钮：**保存** · **初始化笔记本** · **重建索引** · **安装内置 zk** · **自检** · **刷新**。
字段是先改在本地、点保存才落盘 —— 不点保存 = 什么都没发生。

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

配置里把 `structure` 设成 `layered`（设置页开关在 M4，现在直接改
`~/.dsh/zdiary/zdiary.config.json`），下次 `ensureNotebook` 会补出：

```
<notebook>/
├── raw/            # 原始材料，只读
├── inbox/          # 还没想好归属的碎片
├── notes/
│   ├── sources/
│   ├── concepts/
│   ├── entities/
│   └── patterns/
└── archive/        # superseded 的笔记搬到这里（保留原相对路径）
```

外加 `source.md` / `entry.md` 两套模板与 source / concept / entity / pattern 四个 group
（`entry.md` 三处共用，`type` 与 `authority` 由 `[group.X.extra]` 注入）。
**只建目录与模板，不搬已有笔记**；已存在的模板不覆盖。`raw/` `inbox/` `archive/`
与根目录的 `AGENTS.md` / `MEMORY.md` / `USER.md` / `DREAMS.md` / `INDEX.md` 一律不进检索与统计
（`-x` 传绝对路径：它是相对 cwd 解析的，传相对名在换工作目录后会静默失效）。

## zk 从哪来（优先级）

1. 设置页「zk 路径」（显式指定，最优先）
2. `$ZK_BIN`
3. `PATH` 里的 `zk`
4. 插件内置：`~/.dsh/zdiary/bin/zk`（Windows 为 `zk.exe`）

四级都找不到就报错并给出安装提示。内置安装只信「跑得起来」：
下载 → `tar -xzf`（需要系统 tar，Win10+ 自带）→ `chmod 755` → `zk --version` 通过才算装好。
国内网络可设 `ZK_DOWNLOAD_BASE` 换镜像（默认 `https://github.com`）。

## 命令行（人也能用）

```bash
bun src/cli.ts doctor                    # 自检（= 设置页的自检）
bun src/cli.ts install                   # 装内置 zk
bun src/cli.ts init                      # 建库 / 补齐模板与 group
bun src/cli.ts new --title "标题" --body "正文" --tags a,b
bun src/cli.ts search "关键词" --tags a --since "last week" --limit 5
bun src/cli.ts read notes/f2sj.md
bun src/cli.ts daily --entry "今天……"
bun src/cli.ts link notes/a.md "某篇标题"
bun src/cli.ts index
```

加 `--json` 输出结构化结果。装好插件后也可以直接用 `node <插件目录>/dist/cli.js …`
（包里声明了 `bin: zk-kit`）。

## 权限

所有落盘都在 `~/.dsh/zdiary/`（配置、内置 zk、缓存）和笔记本目录里。
会话权限保持「工作区读写 / workspace-write」即可，不需要 `danger-full-access`。
如果笔记本指到工作区外，记得把那个目录加进 `additionalWritableRoots`。

## 排错

| 症状 | 真正原因 |
|---|---|
| 工具列表里没有 `zk_*` | 宿主没有 `tools` 服务（或插件没启用）；看 DSH 日志里的 `[zdiary]` 行 |
| 「找不到 zk 可执行文件」 | 没装也没点「安装内置 zk」；或填了错的「zk 路径」 |
| 「这个目录还不是 zk 笔记本」 | 笔记本目录配错了，点「初始化笔记本」 |
| 设置页 404 | `cordis.patch.yml` 里的 `name:` 与安装后的包名不一致 |
| 设置页 503 | 宿主没有 `connection` 服务，信任栅栏按 fail-closed 拒绝（工具不受影响） |
| 安装 zk 报「解包失败」 | 系统没有 `tar`；手动解包后把 `zk` 放进 `~/.dsh/zdiary/bin` |
| 搜索结果不全 | 索引落后：点「重建索引」（`zk index`），或确认文件没被 `.zk/config.toml` 的 `exclude` 排除 |

## 开发

- 源码全是 `.ts`；宿主半边用 `tsc` 编到 `dist/`（普通 ESM，DSH 用 Node 加载）；
  浏览器半边 `client.ts` 零 import，`postbuild` 把 tsc 补的 `export {}` 删掉。
- `bun run typecheck` · `bun run build` · `bun run test`（真起 zk）·
  `bun run smoke`（加载 dist：跑一遍 10 个工具 + 发 6 条 HTTP 请求，并检查输出 schema 在 DSH 支持的子集内）
- `bun run test` 会先按插件自己的顺序找 zk（配置 → `ZK_BIN` → PATH → `~/.dsh/zdiary/bin`），跑完要求 **skip = 0**：
  集成测试跳过一律按失败处理，否则「全绿」可能是「什么都没跑」。要换 zk 就 `ZK_BIN=/path/to/zk bun run check`。
- `dist/` 随仓库提交：`dsh plugin add github:…` 不会触发安装时构建（pnpm 默认禁止 git 依赖跑构建脚本）。

### 目录

```
src/
├── app/plugin.ts                 # 装配：信任栅栏、工具注册、路由门（唯一组合点）
├── config/                       # paths（唯一路径真相）+ store（默认值/白名单/归一化）
├── lib/
│   ├── zk.ts                     # zk 唯一的调用面：解析二进制、list/new/append/link/daily/graph、路径守卫
│   ├── frontmatter.ts            # 只改 status / superseded-by 这类标量，其余行原样保留
│   ├── notebook.ts               # 自举：zk init + 日记模板 + group 配置（幂等）
│   ├── install.ts / platform.ts  # 内置 zk：平台映射、下载、解包、验证
│   ├── tool.ts                   # 最小 JSON Schema 构造 + 输入校验（裸注册工具自己兜）
│   ├── dsh.ts                    # 宿主契约（纯类型，编译后为空）
│   └── exec.ts / http.ts / json-file.ts
├── features/
│   ├── zk-tools/feature.ts       # 10 个工具
│   └── settings/                 # 宿主 API + 浏览器 section
└── cli.ts                        # zk-kit 命令行
```

## 卸载

```bash
dsh plugin --profile desktop remove dsh-zdiary-kit
rm -rf ~/.dsh/zdiary          # 内置 zk + 配置；笔记本若在别处请自己保留
```

## License

MIT
