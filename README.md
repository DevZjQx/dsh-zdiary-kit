# dsh-zdiary-kit 3.4.0

> 给 [DSH](https://github.com/deepseek-ai/deepseek-harness) 装一个**内置 [zk](https://github.com/zk-org/zk) 的知识库 / 日记本**：
> 插件提供一键安装 zk（官方 release；设置页按钮或 `zk-kit install`）、自动建笔记本（zk init + 日记模板 + 日记 group），
> 然后给 agent 一组 `zk_*` 工具 —— 查、写、记日记、连双链，全部走 zk 自己的索引。
>
> 装好 zk 后不用先配环境：agent 第一次调用工具时就把笔记本建好；设置页里再调路径、重建索引、跑自检。

## 它给 agent 什么

| 工具 | 干什么 |
|---|---|
| `zk_search` | 全文 / 标签 / 日期 / 断链 / 孤立笔记检索，返回标题、相对路径、绝对路径、标签、摘要；中文查询自动并用子串匹配（`matchStrategy` 说明用了 `fts` / `regex` / `mixed`，补上全文索引漏掉的笔记） |
| `zk_query` | 结构化检索：按 type / status / 标签 / 目录 / 日期过滤，默认只看 active 且不含归档；`include_archived` 连归档一起查（此时未显式给 status 则不再默认过滤 active） |
| `zk_new` | 新建原子笔记（zk 生成文件名、套模板、写索引），可带摘要、标签与双链；`summary` 填进模板的 `## Summary`（正文里已写了这一节就不动，返回 `summaryApplied: false`）；`name` 可直接指定短文件名（不给则按标题生成，中文标题得到拼音长名）；layered 下不给 `dir` 就按 `type` 落位（source → notes/sources），两者都没有、或给的 `dir` 不在任何 group 里都直接报错；`tags` 只补正文里没有的；flat 下按标题查重，重复直接报错；归档里有同名旧结论只警告并带出废弃原因；type / authority 只有 layered 模板会写进 frontmatter；`raw/`、`inbox/`、`archive/` 与根目录 meta 文件一律拒写（写进去会被排除出索引 / 被当成人写的工作面；归档只放 `zk_supersede` 搬进去的旧结论）；同目录里有「改一两个字」的相似标题时在 `similar` 里提示（带分数，只提示、不阻断）；中文笔记没有任何标签时在 `tagWarning` 里提示（只提示，不阻断） |
| `zk_append` | 往已有笔记末尾续写（自动补空行，可先起二级标题）；根目录 meta 文件拒写 |
| `zk_daily` | 打开/创建某天的日记，并追加一条带时间的记录（layered 模板写进 `## Events` 的 `### HH:MM`，flat 追加到文件末尾的 `## HH:MM`） |
| `zk_link` | 在两篇笔记间加 `[[…]]` 双链（已存在不重复加；目标不存在会给出候选；链接追加到文末，已有 Links/链接 小节则不重复起标题）；meta 文件不作为来源或目标 |
| `zk_supersede` | 废弃过时结论：标 `superseded` + 写 `reason` + 搬进 `archive/` + 重写能精确匹配的 `[[旧路径]]` 入链（其它写法列进 `missingLinks`）；默认只预演；meta 文件不能废弃 |
| `zk_rename` | 改名 / 换目录并修断链：入链（`[[…]]` 与 Markdown 链接，保留 `#锚点` 与 `\|别名`）按实际解析结果改到新路径，根目录 meta 里的 `[[来源]]` 一起改，被搬走那篇自己的相对 Markdown 链接按新位置重算；默认只预演 |
| `zk_context` | 读知识库根目录的 `AGENTS.md` / `USER.md` / `MEMORY.md`（按注入预算截断）与角色人格 `PERSONA.md`（单独成段、不截断），并列出已配置的笔记本（名字 / 路径 / 结构 / 当前）；宿主支持注入时这些内容每轮已自动带进系统提示 |
| `zk_lint` | 体检：解析失败 / 断链 / 孤儿 / 无标签 / 单向链接 / 陈旧 / 重名标题 / 疑似重复标题 / 记忆链接失效 / frontmatter 缺字段 / 标签卫生 / 模板版本 / 人格（缺失·旧版·比插件新·标记与内容不符·未填占位符）/ 日记时间轴（最近 90 天的空块·倒序·格式·位置），每类最多 50 条；非日记笔记到 150 篇且没有 `INDEX.md` 时提示一句；只报告不改写 |
| `zk_dream` | 晋升材料：窗口新增（机械筛掉 `informal` 与无标签，带正文摘要与入链来源）、已在 MEMORY 的、窗口外积压、daily 未完成项、被引最多（先按「被日记提到几天」排）；只报告 |
| `zk_stats` | 笔记数 / 标签数 / 断链 / 孤立 / 归档（superseded），以及顶层目录与前 10 个标签的实时分布 |
| `zk_use` | 切换**本会话**用的笔记本（只影响这个会话，不改全局默认）；不带参数就列出现有的与当前固定的 |
| `zk_<别名>` | 笔记本 `.zk/config.toml` 的 `[alias]` 里定义的自定义命令（例如 `lucky = "zk list --quiet --format full --sort random --limit 1"`）注册成工具：调用等于 `zk <别名> [args]`，`args` 追加到命令里的 `$@`；输出按原样返回。紧邻别名上方的注释（或行尾注释）作为工具说明；改完 config.toml 要重载插件才会出现新工具。**默认关闭**，见下 |

别名工具在插件加载时读取各笔记本 `.zk/config.toml` 的 `[alias]` 段，把每个**未注释**的别名注册成 `zk_<别名>`（与内置 `zk_*` 撞名的别名会跳过）：
执行交给 `zk <别名>`，`$@`、管道与 `$SHELL` 语义都由 zk 处理，插件不拼 shell；交互式命令（如 `edit`）不适合工具调用。
工具名用 `zk_` 前缀而不是 `zk.`：DSH 的 function-name 契约只接受 `[A-Za-z0-9_-]`，点号会被 provider 拒绝。
别名是 config.toml 里的 shell 命令 —— 注册成工具就等于让 agent 能执行它，只保留自己信得过的别名。
它也不受内置 `zk_*` 的守卫约束：没有 meta 拒写、没有路径校验，`args` 里传 `--notebook-dir` 可以操作当前笔记本以外的库。
**默认不注册**（`aliasTools` 默认 false，关着时不读 config.toml）：在设置页「工具」组勾选，或 `zk-kit config set aliasTools=true`，再重载插件；
值只认 `true`（拼错的值会被归一化成 false 并在 `config set` 时回显）。

读全文不再包一层工具：`zk_search` / `zk_query` 的每条笔记、`zk_new` / `zk_daily` 的返回都带 `absPath`，直接传给 DSH 原生 `read` 即可；相对笔记本的 `path` 仍然保留，给双链和 `zk_*` 参数用。前提是宿主挂载了 DSH 的 fs 工具（默认 web profile 有）；精简 / headless 宿主没挂 `read` 时，读笔记要另配文件工具。

写笔记前 agent 会先 `zk_search` 查重；flat 笔记本的 `zk_new` 还会按标题再查一次，重复直接报错。
layered 笔记本的文件名是标题的 slug：英文标题自然得到英文文件名，短不短看标题本身；中文标题会变成很长的拼音名，要短名就在 `zk_new` 时传 `name`；老笔记不自动改名，**手工 `mv` 会断入链**，要改名用 `zk_rename`（默认预演，会重写引用）。
layered 下每篇笔记都要落在 group 里：`zk_new` 不给 `dir` 就按 `type` 选目录（source → notes/sources），没给 `type` 会直接报错；显式给的 `dir` 也要在某个 group 下（`notes/sources` 及其子目录，写 `notes/concept` 这种错字一样拦）—— `notes/` 根不属于任何 group，建在那里的笔记不套模板（没有 frontmatter，文件名是随机 id），所以这条路径一律不放过。
双链用相对路径（zk 的 `link-format = "wiki"` 认这个），所以 `--broken-links` 不会因为「按标题链接」而误报。

**多会话**：每个会话第一次调工具时，会把当时配置里的默认笔记本**固定**下来（落在 `~/.dsh/zdiary/sessions/`，
一个会话一份）。之后别的会话或设置页 / `zk-kit notebooks use` 切库，都不会把这个会话带到另一个库里 ——
记忆注入也跟着这个会话固定的那本走。要跟着换，就在**那个会话里**说「切到 X 库」（agent 调 `zk_use`）。
每轮系统提示里还会带一行当前笔记本（名字 / 路径 / 结构）和其余已配置库 —— 模型不用先调工具就知道自己在哪本、还能切到哪本。
设置页保存时带文件指纹，别处刚改过配置会 409 并要求确认，不会拿旧表单把别人的 `active` 覆盖回去。
路径找不到时，`zk_append` 还会顺手查别的笔记本里有没有同名笔记，并告诉你它在哪一本。

**长期记忆**：笔记本根目录放 `AGENTS.md`（工作约定）、`USER.md`（偏好）、`MEMORY.md`（精炼记忆），
插件会在每个 step 把它们注入系统提示（预算默认 500 词，设置页「记忆 → 注入预算」可改；
超了先丢 MEMORY 里**日期最旧**的一条（都没写日期才退回从尾部往前丢），
按 `##` 小节 → 顶层列表项 → 空行段落 三级降级切分（`# 记忆` + 要点列表这种最常见的写法也算数），
丢掉的条目 / 段落留一份目录（标题）—— 需要时用原生 `read` 读 `<笔记本>/MEMORY.md` 取回；
同日期按文件里靠后的先丢，所以带日期的条目不会因为写在底部就先被删；
同时明确告诉你截了多少、谁已经没法再丢）。用到预算 80% 以上时还会回显一行「记忆已用 246/300 词（82%）」
（数字已含这行提示本身）—— 先合并或退役旧条目，别等第一次截断。
笔记本提示是单独的一段，不占这 500 词预算。
DSH 自带的 AGENTS.md 加载只看「项目根 → 当前目录」链，**不会**读笔记本根目录，所以别指望宿主帮你加载 —— 是插件自己读、自己注入。
记忆条目的格式约定在 `AGENTS.md` 里：每条写 `结论（YYYY-MM-DD）[[来源路径]]`；退役写成
`- [superseded YYYY-MM-DD] 旧结论 → [[新结论]]`，行留在原处。注入时会**省略退役条目**（并回显省略了几条），
但文件本身不动 —— git 与记忆页仍看得到「这里曾经有过什么」。
`flat` 结构默认**不写** `AGENTS.md`（从 0.1.0 升级过来的库一个文件都不多）；要约定与周提醒就显式
`zk-kit init --with-agents`，或在设置页点「写入 AGENTS.md 模板」—— 已存在的文件绝不覆盖。
模板首行有 `<!-- zdiary-template: vN -->` 版本标记：老库的 `AGENTS.md` 是旧版时 `zk_lint` 只提示，不自动改；标记比插件新时提示升级插件；标记等于当前版本但正文还留着旧句时按「标记与内容不符」报（只改数字不算合并）。

**角色人格**：根目录还可以放 `PERSONA.md`（名字 / 身份 / 语气 / 边界）。它与 `MEMORY.md` 同级：人和 agent 直接编辑，`zk_append` / `zk_new` 一律拒写，
**缺文件 = 未启用**（旧库行为一个词不变）。它单独成段、永远在记忆段之前注入，**不参与记忆预算的截断**：
超了只告警（`zk_context` / `doctor` / 记忆页都会点名），不会静默丢掉半份人设。
两个上限可以分开调（设置页「记忆」组）：记忆 500 · 人格 240。
人格超了只在**人看的界面**点名（`zk_context` 回复、`doctor`、记忆页、设置页），不写进系统提示，也不自动截断；没有人格的库不多一个词。
写入是 opt-in：`zk-kit init --with-persona` 或设置页「写入人格模板」，已存在的文件绝不覆盖。
设置页的按钮不依赖 zk 初始化：笔记本还没建好时也能先写人格文件（只建根目录与文件，不碰 `.zk`），
写完会提醒你仍需要点「初始化 / 补建」建库。
**边界**：M1 是「一本笔记本一份」人格；多个 agent 共用一个库时先别启用，等 M4 的 per-agent persona ——
否则 A 的人格会串到 B。

**从 1.x 升级**：根目录的 `POLICY.md` 不再解析或注入（2.0.0 移除）；文件不会被删，但会按普通笔记处理
（可检索、计入统计，不再受 meta 写保护）。建议删除，或把「别自动发布 / 别花钱」这类边界写进 `AGENTS.md` / `PERSONA.md`。
**AGENTS.md 模板升到 v7**（精简模板）：已有文件不会被覆盖，
`zk_lint` 会把它报成旧版、并把新版全文附在报告里 —— 自己挑要哪几条搬过去。

维护用 `zk_lint`（结构体检 + 记忆链接核对）和 `zk_dream`（晋升候选 / 拒绝原因 / 未完成项）：两个工具都**只读**，
写 `MEMORY.md` / `DREAMS.md` 由 agent 按 `AGENTS.md` 自己决定 —— 机械活留在插件，语义判断留在可审计的地方。
`zk_dream` 会先读一遍 `MEMORY.md`：已经晋升过的（`[[链接]]` 命中，或条目里直接写了标题）移出候选、单列「已在 MEMORY」，
不会每周原样重复（退役行里的旧标题不算已晋升，但退役行里的 `→ [[新结论]]` 仍算）；
窗口外仍未晋升的进 `backlog`，漏做一次不会永久掉队；不传 `days` 时窗口 = 距 `DREAMS.md`
「上次做梦」的天数（没有就 7 天）。被引排行先按「被日记提到几天」（`daysMentioned`）排，入链数只作并列次序 ——
日记是这个插件里唯一按时间记录真实工作的层，空信号只说明日记里没写过，不等于没被用过。
`zk_dream` 还会回一行**记忆余量**（内容词 + 提示 = 总量，余量按总量算，可以为负）和「可考虑退役」的条目
（来源已归档 / 不存在、或超过 90 天没复核）—— 只给材料，不写任何文件。
库超过全图统计上限时不再建全图统计入链（默认 2000 篇，设置页「工具 → 全图统计上限」可调；
0 = 永不建全图）：结果带 `graphSkipped: true` 与生效的 `graphBudget`，
被引数与 `topCited` 为空 —— 那是「没算」，不是「没人引」。
`zk_lint` 会核对 `MEMORY.md` / `USER.md` 里的 `[[来源路径]]` 是否还指向活笔记 ——
`zk_supersede` 只重写笔记之间的入链，meta 文件不在图里，链接不会跟着搬，`--broken-links` 也看不见。
改名同理：`zk_rename` 会把入链（按篇反查 `--link-to`，不再建全图）和根目录 meta 的 `[[来源]]` 一起改到新路径，被搬走那篇自己的相对 Markdown 链接也按新位置重算 —— 手工 `mv` 会一次断掉这三处。
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

重启后三处可见：

- **工具**：会话里直接问「用 zk 帮我记一条：……」，模型就能看到 `zk_*` 工具；
- **设置页**：DSH「设置 → 知识库（zk）」；
- **只读视图**：`http://127.0.0.1:<DSH 端口>/dsh-zdiary-kit/view`（设置页底部「只读视图」直达）。

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
3. 点 **自检** 看八项：zk、笔记本、日记模板、日记 group、结构、长期记忆、角色人格、索引。
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
| 记忆 | 人格上限 | PERSONA.md 240（不截断、超了告警） |
| 写入 | 默认标签 / 单次读取上限 | 新笔记自动带标签；`zk-kit read` 与别名工具的输出上限 |
| 工具 | 全图统计上限（篇） | 库超过这个篇数时不再建全图：`zk_dream` 跳过入链统计，`zk_lint` 的单向链接改按篇反查；默认 2000（0–10000，上限 = 扫描上限），0 = 永不建全图 |
| 工具 | 把 `[alias]` 注册成工具 | 复选框，默认关。打开后 `.zk/config.toml` 的 `[alias]` 变成 `zk_<名>` 工具；**加载时才注册**，勾完保存要重载插件 |
| zk | zk 路径 / 内置版本 | 路径空 = 自动找；版本默认 0.15.7 |

按钮：**保存** · **初始化 / 补建（按钮上带当前笔记本名）** · **重建索引** · **安装内置 zk** · **自检** · **只读视图** · **刷新**；
同一个按钮随状态换字：没建过叫「初始化笔记本 *名*」，缺目录 / 缺 `AGENTS.md` 叫「补建 *名* 的目录」。
分组标题直接标了作用范围：**笔记本**那组是每个笔记本自己的，其余分组都是全局（所有笔记本共用）。
字段是先改在本地、点保存才落盘 —— 不点保存 = 什么都没发生；保存后工具下一次调用就用新值（配置每次现读）。

## 只读视图（人看的）

笔记本不只是 agent 的：浏览器打开 `/dsh-zdiary-kit/view` 就能读，和 DSH 同一个端口，**不另开端口**。
页面是服务端渲染的 Web 1.0 风格：无 JS、无前端构建、可打印、`curl` / `lynx` 也能看。

| 地址 | 内容 |
|---|---|
| `GET /dsh-zdiary-kit/view` | 首页：最近更新、日记、标签；`?q=` 搜索，`?p=note&path=…` 正文 + 反链，`?p=tags` / `?p=tag&tag=…` 标签，`?p=memory` 四份记忆文件 + 预算 |
| `GET /dsh-zdiary-kit/feed.xml` | 最近 30 篇的 RSS 2.0 |
| `GET /dsh-zdiary-kit/api/notes?q=&tag=&limit=` | 只读列表（`limit` 1–200，默认 50） |
| `GET /dsh-zdiary-kit/api/note?path=…` | 单篇正文（笔记本内相对路径） |

**只读是真的只读**：只放行 GET / HEAD（其余 405），不调 `ensureNotebook` / `init` / `index` / `install`，
不返回 zk 路径、配置文件路径与文件系统绝对路径，`.zk/` 和根目录 meta 文件按路径也打不开。
**不要求登录、也不套 DSH 的浏览器 cookie**：`curl` 和 RSS 阅读器直接就能读；代价是它只认回环
（Host 与对端地址都要是 127.0.0.1 / localhost / ::1）。所以 DSH 必须监听回环地址（默认就是）：
绑到局域网 IP 时这个视图在本机也打不开，同时也绝不会暴露到网上。
正文全部转义、不解析原始 HTML；markdown 只渲染标题 / 段落 / 列表 / 引用 / 代码块，链接只放行 http(s)、mailto 与站内路径。
没初始化或 zk 跑不起来时，页面给一句提示，`feed.xml` 与 `api/*` 回 503 —— 不喂 200 的空频道，免得阅读器把「插件坏了」缓存成「没有新笔记」。

视图没有会话，只能看**插件进程工作区**解析出的那本笔记本（与设置页一致）；写入仍然只走 agent 的 `zk_*` 与 CLI。
细节见 [docs/features/readonly.md](docs/features/readonly.md)。

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
- **共享的是全局项**：笔记 / 日记子目录、`daily` group、归档目录、注入预算、全图统计上限 —— 这些不按笔记本分开。
  改子目录 / group 名后要跑 `zk-kit groups --fix` 让 `.zk/config.toml` 跟上；归档目录非空时不允许改（不自动迁移文件）。

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

### 改了目录 / group 之后

插件**不会自动重写**已有的 `[group.*]`：你改过 `notesDir` / `dailyDir` / `dailyGroup` 后，
`zk-kit init` 只追加缺失的 group，不会把旧 paths 改掉（也不会有两个 group 抢同一路径）。
差异由 `doctor` / `groups` / 设置页报告，确认后用显式修复：

```bash
zk-kit groups           # 默认 dry-run：逐组打印期望 / 实际
zk-kit groups --fix     # 只改 dsh-zdiary-kit 自己写的 group：paths 行或旧组头改名
```

`--fix` 写前备份 `.zk/config.toml.bak`，只改 paths 与组头；自定义的 `template` / `extra` / 注释 / 别的 group 一字不动。
两个 group 要落到**同一条路径**时它拒绝写（整轮不改，并在 `groups` / `doctor` / 设置页里报出来）——
那样 zk 命中哪个模板就只剩实现细节了。父子目录不算冲突：`dailyDir=notes` 与 `notes/concepts` 可以共存；
没写 `paths` 的 group 按同名目录算（zk 的语义），同样算抢同一路径。
`dailyGroup` 改名且 `dailyDir` 没变时，`--fix` 直接把旧组头改成新名字（连同 `.note` / `.extra` 子表），不追加第二个日记组。

`archiveDir` 是另一条硬规则：**旧归档目录非空时拒绝改**。插件不迁移归档文件，改了会让废弃笔记重新进入检索、
统计也会把它们算成活跃 —— 先手动迁移，或保持原值。空目录 / 不存在的目录可以改。

### 分层结构（可选）

给某个笔记本选 `layered`：设置页笔记本那一行的结构下拉，或切到它后 `zk-kit config set structure=layered`
（等价于改 `~/.dsh/zdiary/zdiary.config.json` 里**那个条目**的 `structure` —— 结构是每个笔记本自己的），
再点 **初始化 / 补建**（或 `zk-kit init`）会补出：

```
<notebook>/
├── raw/            # 原始材料，只读
├── AGENTS.md       # 工作约定（模板由插件写入；插件每轮注入）
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
以及根目录两份模板：**`AGENTS.md`**（检索词归宿、中文必须打 tags 两件事）
与 **`WORKFLOW.md`**（改已有笔记前先列受影响清单等确认，再按 temporal / context variant / contradiction 三分类动手）。
`WORKFLOW.md` 不进每轮注入 —— 它低频但重要，塞进 `AGENTS.md` 会把 500 词预算挤到 MEMORY 没位置。
**只建目录与模板，不搬已有笔记**；已存在的模板与 `AGENTS.md` / `WORKFLOW.md` 一律不覆盖。
`inbox/`（0.8.2 起）不再创建，也不再接受写入：layered 下它不属于任何 group，flat 下能写进去却会被排除出索引（写进去就消失）。
盘上已有的 `inbox/` 不删，继续当隔离区 —— 读得到、搜不到，`zk_new` / `zk_append` 会直接拒绝。
`flat` 也可以有工作约定：`zk-kit init --with-agents`（或设置页「写入 AGENTS.md 模板」）写一份精简版
（≤90 词，不出现 `raw` / `inbox` / `archive` / `WORKFLOW.md`），已存在不覆盖；不想要就一个字节都不多。
反过来，配置是 `flat` 但盘上留着 `notes/concepts` 之类的分层目录时，`doctor` / 设置页 / 每轮注入都会提示
「新建笔记会落在 `notes/` 根」—— 只报告，不搬文件、不改配置（`archive/` 不算漂移：跑过一次 supersede 就会自建）。
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
zk-kit init --with-agents            # flat 库也写一份精简版 AGENTS.md（已存在不覆盖）
zk-kit init --with-persona           # 写 PERSONA.md 人格模板（缺了才写，已存在不覆盖）
zk-kit persona                       # 人格状态：用量 / 上限 / 体检（只读）
zk-kit groups                        # 对照配置与 .zk/config.toml 的 group（默认 dry-run）
zk-kit groups --fix                  # 只改插件建的 group 的 paths / 组头（写前备份 .zk/config.toml.bak）
zk-kit new --title "示例笔记" --body "正文" --tags demo --type concept
zk-kit search --tags demo --limit 5
zk-kit daily --entry "今天把 zk-kit 跑了一遍"
zk-kit lint --stale-days 90          # 体检（只读）
zk-kit dream --days 7                # 晋升材料（只读）
zk-kit query -- -t demo --limit 5    # 透传 zk list：--notebook-dir / --format / -x 会被替换掉
zk-kit index
zk-kit config get structure          # 看一个配置项（不传键 = 全量）
zk-kit config set structure=layered  # 只落盘配置，不建目录 —— 目录要 zk-kit init 补
zk-kit doctor                        # 自检：zk / 笔记本 / 模板 / group / 结构 / 记忆 / 人格 / 索引
```

按路径用的子命令（`<…>` 要换成真实路径，所以不放进可跑清单）：

| 子命令 | 用法 |
|---|---|
| 读 | `zk-kit read notes/f2sj.md`，或 `zk-kit read --query 搜索词`；`--max-chars` 可调 |
| 续写 | `zk-kit append notes/f2sj.md --text "追一段" --heading 后续` |
| 双链 | `zk-kit link notes/a.md "某篇标题"` |
| 指定目录 | `zk-kit new --title 标题 --dir notes/concepts`（layered 下 type 由目录所属 group 决定，目录必须在 group 下）；也可以只给 `--type concept`，目录跟着类型走；两者都没有、或目录不在 group 里都会报错 |
| 指定文件名 | `zk-kit new --title 很长的中文结论标题 --name 短文件名`（只换文件名，标题与正文不动；不给就是拼音 slug） |
| 带摘要 | `zk-kit new --title 标题 --summary "一句话"`（写进模板的 `## Summary`；正文里已写了就不覆盖并告警） |
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
| 工具报「索引还没建好 / 索引不完整」 | 大库第一次建索引，或上次建到一半被中断：插件在后台跑 `zk index`，最多先等 15 秒就返回，过一会儿重试即可；**不要同时再手动跑 `zk index`**。反复失败就点「重建索引」看完整报错 |
| 自检报「✗ 长期记忆：N/预算 词」 | AGENTS + USER + MEMORY 写太长：先压缩，或在设置页调高「注入预算」（超预算时注入先丢 MEMORY 里日期最旧的条目，一条日期都没有才退回从末尾往前丢） |
| 体检报「记忆链接：N 条失效」 | `MEMORY.md` / `USER.md` 里的 `[[来源]]` 指向的笔记已归档或删除：改成 `archive/` 下的新路径，或改指活笔记；显式写 `archive/` 的链接不算失效 |
| 体检报「N 个条目没写日期 / 已退役」 | 按 `AGENTS.md` 的格式补 `结论（YYYY-MM-DD）[[来源路径]]`；退役行写 `- [superseded …] 旧结论 → [[新结论]]`，行留着不删（注入时会省略退役条目，文件本身不动）。只报告 |
| 体检报「N 条超过 90 天未复核」 | 条目的日期太旧：确认结论还成立就改日期，否则按退役格式写一行 `- [superseded …]`。`zk_dream` 的「可考虑退役」会给同一批材料 |
| 体检报「AGENTS.md 是旧版 / 无版本标记 / 标记与内容不符」 | 模板升级过，老库不会自动覆盖（可能有你自己的改动）：`zk_lint` 的输出里会直接附上新版模板全文，按需合并到自己的 `AGENTS.md`；合并完内容再改首行标记，只把数字改成 vN 会被正文哨兵发现。不合并也能用，只是少新加的约定 |
| 体检报「人格版本比插件新」 | 文件里的标记来自更新版本的插件：插件才是旧的那个，别改文件里的版本号，升级插件后再看 |
| 体检报「疑似重复标题」 | 同目录里有两篇标题只差一两个字（二元组相似度 ≥ 0.6，或短标题被长标题包含）。只报告：确认是同一结论就用 `zk_supersede` 合并，不是就留着 |
| 体检提示「笔记已到 150 篇（不含日记）」 | 检索开始变糊的拐点，但插件不生成 `INDEX.md`（静态索引会过期）。用 `zk_stats` 看目录 / 标签分布决定先读哪里；真要总索引就自己写，提示会消失 |
| 中文搜索只回来几条 | `zk_search` 对含中文的查询会 FTS + 子串各跑一次并合并（`matchStrategy: mixed`）；`zk_query` 是 `zk list` 的透传，仍只在 0 命中时兜底 —— 查中文优先用 `zk_search`，或配合 tags |
| 体检报「frontmatter 缺字段」（layered） | 缺 `type` / `status` / `authority`：索引把缺失落成空串，`authority=informal` 这类机械门对它们静默失效。按模板补上即可；flat 不查这一项 |
| `doctor` 提示「记忆在跑，但缺 AGENTS.md」 | `flat` 默认不写工作约定：跑 `zk-kit init --with-agents`，或设置页点「写入 AGENTS.md 模板」（已存在不覆盖） |
| 提示「盘上有分层目录，但配置是 flat」 | 以前是 layered、后来改成 flat（或手工搬过目录）：新建笔记会落在 `notes/` 根、不套模板。要么把配置改回 layered，要么把这些目录移走；插件只提示，不动文件 |
| `read` / `edit` 笔记本报 `file access denied under workspace-write mode` | 笔记本被指到了工作区外。读也只能走原生 `read`（`zk_read` 已移除）：把笔记本放回工作区（默认 `<工作区>/zdiary` 就是为此选的），或把目录加进 `additionalWritableRoots`，或开会话到 `danger-full-access` |
| 设置页出现「结构是 layered，但缺目录」 | 配置与磁盘不一致（换过机器 / 手动删过目录）：点「补建 *名* 的目录」，别手改配置去将就磁盘 |
| 切了笔记本，笔记数对不上 | 每个笔记本各自一份 `.zk/` 索引与笔记：切换是换库，不是合并；`zk-kit notebooks` 看当前是哪个 |
| 新建时提示「归档里有同名旧结论」 | 允许复用标题，但先 `read` 归档那篇，确认不是同一个错误；插件只警告、不拦 |
| 往 `raw/` 或 `inbox/` 写笔记报「只读」 | 两者都被排除出索引，写进去的笔记不会报错、只是永远搜不到；所以 `zk_new` / `zk_append` / `zk_link` / `zk_supersede` / `zk_rename` 直接拒绝。结论写到 `notes/`；原文留在原位，用原生 `read` 读 `raw/xxx.md` 或直接读文件对照。`inbox/` 是停用入口，老目录只读保留 |
| `config set notebook=…` 报「派生值」 | `notebook` 是 `notebooks[active]` 解析后的派生值、不落盘也不可写：改路径用 `zk-kit notebooks add 名 路径`，切换用 `use` |

## 开发

- 源码全是 `.ts`；宿主半边用 `tsc` 编到 `dist/`（普通 ESM，DSH 用 Node 加载）；
  浏览器半边 `client.ts` 零 import，`postbuild` 把 tsc 补的 `export {}` 删掉，并检查没有顶层声明
  （DSH 会把多个插件的 `client.js` 拼进同一个 combo 脚本，顶层 `const` / `function` 会撞名导致插件不激活）。
- `bun run typecheck` · `bun run build` · `bun run test`（真起 zk）·
  `bun run smoke`（加载 dist：13 个内置工具各跑一遍 + 12 条路由（设置 8 + 只读 4）都发真实请求（`/install` 只验非法版本，不下载），并检查输出 schema 在 DSH 支持的子集内）·
  `bun run docs`（把 README / docs 里 `zk-kit …` 代码块在临时 vault 上逐条真跑；`smoke` 末尾会带上）·
  `bun run fixture`（生成 1k / 10k 规模夹具，比例与边界样本见 `docs/plan.md` §0.5；
  `--links-per-note` 决定链接密度 —— 建索引成本主要花在链接上，产出目录自带 `.zk/config.toml`，进去 `zk index` 即可）·
  `bun run bench`（成本表：逐用例真起 zk，记子进程数 / 回传字节 / 峰值 RSS / p50 / p95；默认 1k、3 轮）
- **耗时差两个数量级**：`bun run test` 约 50 s（208 个用例，真起 zk）；`fixture` 百毫秒级；`bench` 默认 1k 约十几秒，
  10k 上光一条 `graph.full` 就是 30 s、冷建索引几分钟。所以 `bench` **不在** `check` / CI 里，跟测试完全分开，不会因为你跑测试而变慢。
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
│   ├── alias.ts                  # 读 .zk/config.toml 的 [alias]（工具注册用，不执行）
│   ├── frontmatter.ts            # 只改 status / superseded-by 这类标量，其余行原样保留
│   ├── meta.ts                   # meta 文件清单（注入 3 份 / 排除 7 份，一个真相）
│   ├── lint.ts / dream.ts        # 巡检与做梦：只报告，绝不写文件
│   ├── notebook.ts               # 自举：zk init + 日记模板 + group 配置（幂等）
│   ├── install.ts / platform.ts  # 内置 zk：平台映射、下载、解包、验证
│   ├── tool.ts                   # 最小 JSON Schema 构造 + 输入校验（裸注册工具自己兜）
│   ├── lock.ts                   # 跨进程文件锁（写配置时用，O_EXCL + stale 清理）
│   ├── dsh.ts                    # 宿主契约（纯类型，编译后为空）
│   └── exec.ts / http.ts / json-file.ts
├── features/
│   ├── zk-tools/feature.ts       # 13 个内置工具 + [alias] 别名工具
│   ├── settings/                 # 宿主 API + 浏览器 section
│   └── readonly/                 # 只读视图：GET-only 路由 + Web 1.0 渲染（无 JS）
└── cli.ts                        # zk-kit 命令行
```

## 卸载

```bash
dsh plugin --profile web remove dsh-zdiary-kit
rm -rf ~/.dsh/zdiary          # 内置 zk + 配置；笔记本在工作区里（<工作区>/zdiary），要删自己来
```

## License

MIT
