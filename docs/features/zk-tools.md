# zk-tools（agent 工具）

**Purpose.** 让模型用 zk 思维工作：先查重、再写原子笔记、用双链连起来、每天记一段。

**Owns.** 14 个内置工具定义（`zk_search` / `zk_query` / `zk_recall` / `zk_new` / `zk_append` / `zk_daily` / `zk_link` /
`zk_supersede` / `zk_rename` / `zk_context` / `zk_lint` / `zk_dream` / `zk_stats` / `zk_use`）以及笔记本
`.zk/config.toml` 的 `[alias]` 派生的 `zk_<别名>` 工具：
参数 schema、输出 schema、render、每个工具自己的 `ensureNotebook` 与参数校验。
`zk_context` 例外：它只读根目录三份 meta 文件与角色人格（`PERSONA.md`），并列出已配置笔记本（另读 `DREAMS.md` 的「上次做梦」一行用于周节奏提醒），**不** `ensureNotebook`（读记忆不该依赖 zk）。

**多会话与笔记本归属.** 工具拿配置走 `config/session.ts` 的 `configFor(workspace, sessionId)`，不是直接 `config()`：
会话第一次调用时把当时的 `active`（默认值）快照成自己的 pin，之后设置页 / CLI / 别的会话切库都不带动它；
本会话换库只能显式 `zk_use`。pin 一会话一个文件（`~/.dsh/zdiary/sessions/`），进程重启与会话 resume 都接得上；
指向的笔记本被删掉时静默回到默认值。`zk_context` / `zk_stats` 会在 pin 与默认值不一致时把这件事写出来，
不让模型自己从「笔记不存在」里猜。`zk_append` 找不到路径时还会查其他笔记本里有没有同名，
命中就把「这篇在 X 库里」放进错误提示。

**Does not own.** zk 命令行怎么拼（`lib/zk.ts`）；`[alias]` 怎么解析（`lib/alias.ts`）；笔记本怎么建（`lib/notebook.ts`）；配置读写（`config/store`）；
设置页（`features/settings`）。工具不 import settings，settings 也不 import 工具 —— 只共享 lib 与 config。

**Depends on.** `config/session`（会话固定的笔记本 → 配置；每次调用现读，设置页改完立刻生效）、`lib/notebook`、`lib/zk`、`lib/alias`、`lib/memory`、`lib/tool`。

**Public surface.** `buildTools()`（按默认工作区的笔记本配置构建，测试用）与 `registerZkTools(tools)`（返回撤销函数）。

**Alias tools（`zk_<别名>`）.** 默认**不注册**：`aliasTools` 为 false 时 `buildTools` 连 `.zk/config.toml` 都不读，
内置工具固定 14 个。别名是 `$SHELL -c` 的任意命令，注册成工具等于把它交到模型手里，所以要人显式打开
（设置页「工具」组的复选框，或 `zk-kit config set aliasTools=true`，只认 `true`；拼错的值归一化成 false 并在 `config set` 时回显）。
打开后，插件加载时读所有已配置笔记本的 `.zk/config.toml`，把 `[alias]` 表里未注释的键注册成工具；
同名只取第一本。工具名用下划线而不是点号：DSH 的 function-name 契约是 `[A-Za-z0-9_-]`（`zk.lucky` 会被 provider 拒绝）。
只解析名字 / 命令 / 注释，不跑 `zk config --list aliases`：注册是同步的，而且 zk 可能在首次使用时才装好。
别名名只接受 `[A-Za-z0-9][A-Za-z0-9_-]{0,60}`：首字符不许是 `-`（`zk -h` 会被当 flag 执行），
带空格 / 引号 / 点号的别名（`zk <名>` 仍能用）会被跳过，因为装不进 `zk_<名>`；
与内置 `zk_*` 撞名的别名（如 `search` → `zk_search`）也跳过，不能靠别名覆盖内置工具。
紧邻别名上方的连续 `#` 注释（遇空行即断）优先作为工具说明，没有才用行尾注释；注释掉的别名不算定义。
执行走 `zk <别名> [args]`：`args` 是工具参数里的字符串数组，原样追加，对应别名里的 `$@`；`$SHELL -c`、管道与引用全交给 zk，
插件不拼 shell。`runAlias` 设 `ZK_NOTEBOOK_DIR`（内层 `zk` 找到同一本），并把 zk 所在目录补进 `PATH`（托管二进制不一定在 PATH 上）；
不传 `--no-input` —— 它会出现在 `$@` 里，任意别名命令不一定接受。交互式别名（`edit` 之类）只能靠超时兜底，不适合工具调用。
工具是全局注册的，会话可以随时 `zk_use` 切库：执行前按**当前笔记本**再核对一次，没有这个别名就明确报错，不会跑到别的库里执行。
stdout 原样返回（不做 JSON 解析），超过 `maxReadChars` 截断；exit 0 的 stderr 作为告警附在结果里，非零退出转成 `ZkError`。
新增 / 改名别名后要重载插件（或重启 DSH）才会出现在工具列表里。
别名是 config.toml 里的 shell 命令：注册成工具就等于让 agent 能执行它，只保留自己信得过的别名。
它也不受内置 `zk_*` 的守卫约束：没有 meta 拒写、没有路径校验，`args` 里传 `--notebook-dir`
可以操作当前笔记本以外的库（`ZK_NOTEBOOK_DIR` 只是默认值）。

**Rejected.** 把工具做成"一个 `zk` 大工具 + action 参数" —— 拒绝：模型的参数猜测会更多，
且每个动作的 schema 不同（搜索有 tags/since/sort，写入有 path/text），分开才能让参数自解释。
用 shell 拼字符串调 zk —— 拒绝：一律 `execFile` 数组参数，笔记标题里的引号/空格不会变成注入。
在 `zk_query` 里加语义判断（"哪条更相关"）—— 拒绝：那是 agent 的活，插件只按字段过滤。
（R1 / R3 加的是 zk 自带的 FTS 相关性与按词覆盖度的机械排序，不是让插件替模型判断语义。）
保留 `zk_read` 做「按搜索词读最相关的一篇」—— 拒绝：`zk_search` + 原生 `read` 两步就够，
而多一层包装会让模型在两条读取路径之间选，路径解析也多一套。

**Exceptions.** 输入校验自己写：DSH 只对 `defineTool` 注册的工具做输入校验，
裸 JSON Schema 注册的工具要自己兜（`lib/tool.ts`），换来运行时零依赖。
所有查询都带 `excludedNames(cfg)` 的**绝对路径**排除（`raw` / `inbox` / `archive` + 七个 meta 文件）：
`-x` 是相对 cwd 解析的，传相对名在换工作目录后会静默失效。`zk_query` 的 `include_archived: true` 会去掉 archive 排除；
如果没显式给 `status`，此时也不再默认卡 `active`（否则归档里的 `superseded` 永远查不出来）。
`status` / `type` 只能靠 `metadata` 在 JS 层过滤（zk 的 `--match` 不索引 frontmatter）。
带这两个过滤时不再只取前 200 条：zk 没有 offset，改为一次取到 `MAX_SCAN + 1`（10k 约 2 MB / 2.6 s，JSON 是 17.2 MB），
过滤后再按 `limit` 截断 —— 否则「前 200 条里没有 active、全库其实有 50 条」就是静默漏结果。
结果带 `completeness`（`complete` / `partial` / `unknown`）、`hasMore` 与 `scanned`：
`partial` 说明还有命中没返回（`limit` 或扫描上限），`unknown` 表示解析 / 补充检索失败、不能当作「没有」。
`total` 是精确命中总数，只在 `complete` 时给（见下面 R2 的口径）。带 `query` 的过滤检索用
`SEARCH_LEAN_TEMPLATE`，比全量扫描的精简格式多一列 `{{snippets}}`；无 `query` 时不加，避免全库多背正文。
`status` 缺省按 `active` 算（`include_archived: true` 且未显式给 status 是例外）：0.1.0 的老笔记没有 frontmatter，不这样兜，flat vault 上一条都查不出来。
`type: daily` 按 `cfg.dailyDir` 路径匹配：layered 日记模板没有 frontmatter，老日记也没有；只按 `metadata.type` 比对的话，枚举里的 `daily` 永远命中 0 条。
`zk_new` 撞名直接报错（`zk new` 遇到同名文件是 exit 0 + 不写内容，Z8），不自动加后缀。
flat 的随机 `{{id}}` 文件名撞不上，所以在建之前按标题查重一次（只查可见笔记，归档旧结论可复用标题）；
layered 同目录同名靠 `{{slug title}}` 文件名拦住，不同目录允许同名（交给 `zk_lint` 提示）。
文件名默认来自标题 slug：中文标题会生成很长的拼音文件名，所以 `zk_new` 支持 `name` 直接给 basename
（只换文件名，标题和正文不动）。改名后 zk 的 slug 撞名失效，所以给了 `name` 时会在建之前按「同目录 + 同标题」补查一次。
老笔记不自动改名；**手工 `mv`** 会断路径式入链，要改名用 `zk_rename`（它会重写入链 / meta 来源 / 自身相对链接）。
`type` / `authority` 只有 layered 模板（`{{extra.*}}`）会写进 frontmatter；flat 的 `default.md` 没有占位符，传了也不会落盘。
layered 的落点必须在某个 group 里：`zk_new` 不给 `dir` 就按 `type` 选目录（source → notes/sources、concept → notes/concepts…），
连 `type` 都没有直接报错；显式给的 `dir` 也不再信任 —— 不在任何 group 的 `paths` 下（`notes/` 根、`notes/concept` 这种错字）同样报错，
group 的子目录照旧放行（zk 按路径前缀归组）。理由：`notes/` 根不属于任何 group，zk 会退回内置模板 ——
没有 frontmatter、文件名是随机 `{{id}}`，以前会静默建出来，只有回头看路径才发现。
校验用的是 `layeredGroups()` 这份唯一真相，所以 `journal/`（日记 group）也在白名单里。
`tags` 只追加正文里还没出现过的 `#tag`：正文自己写了一行标签、入参又给一遍时，以前末尾会多出一行一模一样的；
边界按标签字符判断，`#素材库` 不会挡住 `#素材`。
`summary` 写进模板的 `## Summary`：这一节模板里天生是空的，而 `{{content}}` 落在 `## Content` 下面 —— 不给 `summary`，
它没有任何写入路径能填。flat / 自定义模板没有这一节时，在一级标题下面补一节；正文里自己写了 Summary 就不覆盖，
一个字都不改，返回 `summaryApplied: false` 和 `summaryWarning`（工具层与 CLI 都据此告警）。
没有告警时输出里不带 `summaryWarning` 这个键：宿主按无损 JSON 校验工具输出，值为 `undefined` 的字段会让整次调用报
`invalid output` —— 文件已经建好，模型却拿不到 `path`。
只填不删：正文里多写一节 `## Content` 之类属于排版噪音，靠 `body` 的入参说明去避免，不在建完收尾时静默改正文。
`tagWarning`（P2-9）：标题或正文含 CJK、而最终标签为空（入参 / 默认标签 / 正文 hashtag 都没有）时给一句提示 ——
写路径是唯一便宜的修复点；一周后才在 `zk_dream` 里被「无标签」拒绝时，那篇已经进不了晋升候选，只能靠全文检索找回来。
代价不在搜索：P2-7 之后中文查询会并上子串匹配，正文照样搜得到；问题在标签是唯一能确定性筛选的维度（`zk_query -t`、
`byTag` 分布都用不上它）。
只提示、不阻断、不自动打标签：索引页与临时对照本来就不需要标签，自动生成的标签只是新的噪音。
`zk_append` 拒写根目录的 meta 文件（AGENTS / USER / MEMORY / DREAMS / INDEX / WORKFLOW，清单来自 `lib/meta.ts`）：追加会把记忆变成流水账，
也让「这条记忆是谁改的」失去审计线索；子目录里的同名文件是普通笔记，照常可写。
同一道守卫也覆盖 `zk_new`（不能新建根目录 meta）、`zk_link`（meta 不能作为来源或目标）与 `zk_supersede`（不能废弃 meta，否则会把它搬进 archive/）。
`raw/` 与 `inbox/` 是只读目录：`zk_new` / `zk_append` / `zk_link` / `zk_supersede` / `zk_rename` 的写入入口都走 `assertWritablePath`，
往里写会直接报错 —— 两者都被排除出索引，写进去的笔记不会报错、只是永远搜不到，那比失败更难查。
`inbox/` 从 0.8.2 起不再创建、也不再宣传（P2-8）：layered 下它不属于任何 group，flat 下能写进去但从索引里消失；
盘上已有的 `inbox/` 不删，继续当隔离区（读得到、搜不到、写不进）。
`archive/` 同理只放 `zk_supersede` 搬进去的旧结论：`zk_new` 建在 `archive/`（或它的子目录）下会直接报错，
flat 在 `newNoteDir` 就拦、layered / 直接调用 `createNote` 在 `mkdir` 前拦；`zk_rename` 把笔记改名进归档一律拒绝
（归档只由 `zk_supersede` 写入，它是重写入链的目标，搬动会让历史链接再断一次）。
这是 3.1 唯一有意的写入收紧 —— 新建进 archive 不报错、却会从检索与统计里消失。
`zk_stats` 除笔记 / 标签 / 断链 / 孤立外，还给 `archived`（索引里 archive/ 下的笔记数）与
`superseded`（全部笔记中 `status: superseded` 的数量，含已归档与手工标的）—— 一次 `allNotes(includeArchived)`
从索引算，不扫磁盘、也不逐篇读全文。`byDir` / `byTag`（P2-11）是同一份 live 上算出的实时分布
（顶层目录 → 篇数，根目录文件记作 `.`；标签取前 10）：静态 `INDEX.md` 会过期，还要决定谁负责更新，
而 150 篇正是检索开始变糊的拐点 —— 所以 `zk_lint` 只在「≥150 篇且没有 INDEX.md」时提示一句，不生成文件。
篇数**不含日记**：日记按天自动增长，一年就能把任何库顶到 150 篇，而知识量并没有涨。
`zk_supersede` 默认 `dry_run: true`：一句「更新一下 wiki」不该让全库漂移。
`reason` 会做单行规范化（≤200 字）并以 YAML 双引号标量写进归档的 `supersede-reason`：带冒号或引号也不会写坏
frontmatter；预演也回显，重放返回已记录的原因。双引号值读回来走 JSON 解析（`\"`、`\n` 还原成原字符），
YAML 独有的转义（`\N`、`\_`）不是合法 JSON，退回「去掉引号」—— 与改动前同行为，只是不再尝试解码。
`zk_rename` 也默认 `dry_run: true`，理由同上；默认只返回「搬到哪里、哪些入链会改」。
入链按**实际解析结果**匹配，不按字面量：zk 的 wiki 路径是笔记本根相对、只写文件名时按全局文件名匹配（实测 `../` 不建边），
所以同目录写成 `[[文件名]]` 的入链也能认出来；Markdown 链接则只相对来源文件解析。
改名后一律写成根路径（`[[notes/patterns/x]]`），避免新文件名与别的笔记撞名时产生歧义；`#锚点`、`\|别名`、图片一起保留。
被搬走那篇自己的 wiki 链接不用动（按根 / 文件名解析），但相对 Markdown 链接会按新目录重算。
根目录 meta 文件里的 `[[来源]]` 不在 `zk graph` 里，单独读进来一起改 —— 否则 `zk_lint` 的记忆层体检会立刻报漂移。
归档里的入链也一起改（默认图排除了 archive，改名时单独带上）：归档不进 lint，断了没人会看见。
拒绝的情况：目标路径已存在（不覆盖）、换成 meta 文件名、换扩展名、改 `journal/YYYY-MM-DD` 的日记（`zk_daily` 会另建一篇）、
改 `raw/`（只读）、改 `archive/`（改名不能进归档；归档由 `zk_supersede` 写入）。`zk graph` 说某篇有入链但正文里找不到可改写的写法时，
列进 `missingLinks`，不猜。
`zk_new` 不拦归档同名（归档本来就不参与标题查重），但会把 `archived`（路径 + 废弃原因）放进输出并警告 ——
允许复用标题，但先读旧结论。「是不是同一个错误」仍然由 agent 判断，插件只负责把材料摆出来。
代价是每次 `zk_new` 多一次全库 `zk list --include-archived`（扫描上限 1 万篇，按比例放大）——
用一次读换一条「不会静默复用的错误结论」；zk 跑不起来时 layered 照建（归档提醒降级），flat 直接报错（标题查重是写入前的硬门槛，fail-closed）。
`similar`（v3.3）：同一次全库扫描顺带算「同目录、改一两个字」的相似标题 —— 归一化后按字符二元组算 Jaccard ≥ 0.6，
或短串（≥ 6 字）被长串包含；最多 3 条、分数降序，放进输出的 `similar` 并渲染
`⚠️ 疑似已有：标题（path，0.72）`。阈值与 `zk_lint` 的 `similarTitles` 是同一份实现（`lib/similar.ts`），
两边分数逐条一致；**只提示、不阻断、不自动 `zk_link`、不改标题** —— 误报会挡住正常写作，合并与否仍由 agent 判断。
精确同名仍走上面的硬查重（`similar` 里不会重复报），不同目录不比，归档不参与。
**读取交给宿主。** 不提供 `zk_read`：DSH 原生 `read` 已经处理行号、分页、沙箱与 read-before-write。
`zk_search` / `zk_query` 的每条笔记、`zk_new` / `zk_daily` 的返回都带 `absPath`（相对笔记本的 `path` 仍在，
双链与 `zk_*` 参数用得上），模型直接把 `absPath` 传给 `read`；根目录 meta 文件（`MEMORY.md` / `USER.md`）
同理，注入截断时留下的目录就是让 agent 用 `read` 取回原文。前提是宿主提供了 `read` 工具
（默认 web profile 有；精简 / headless 宿主没挂 `read` 时，读取路径不存在 —— 这是有意的取舍，
不为了兼容它再维护第二套读文件工具）。

**为什么删 `zk_read`、却留着 `zk_append`.** 读文件是宿主的事；追加不是：原生 `edit` 没有 append，而且要求
先整篇 `read`、`old_string` 唯一匹配 —— 追加一行会变成「读全篇 + 找锚点」。`zk_append` 保留一次调用完成
「补空行 / 二级标题 / 写入指定小节」的语义，守卫（meta / `raw/` / `inbox/`）也仍然在。
`zk_context` 的 `files[].originalWords`（截断前词数）、`files[].retiredWords`（退役条目占的词数，只算在 `MEMORY.md` 上）、
`tocWords`（目录占的词数）与 `ratio`（用量 = `words / budget`，两位小数，> 1 表示超预算）只用于解释预算，不改变注入内容。
`formatDebt`（`total / undated / unlinked`，与记忆页、`zk_lint.memoryLinks` 同一个 `memoryFormatDebt`）
与 `templateVersion`（AGENTS.md 首行标记；0 = 没标记或没文件，用 `files[].present` 区分）是同一批只读元数据。
`originalWords` 含退役条目；展示层的「原 X」会先减掉 `retiredWords`，所以退役不会再被当成截断报出来。
人格单独一组：`persona.present / contentWords / words / noticeWords / budget / overBudget / overWords / files[]`（`contentWords` 含 `## PERSONA.md` 标题），
外加 `totalWords`（`countWords(payload.text)`）与 `overheadWords`（框 / 做梦提醒 / notice / 人格告警等开销）。
人格**不参与** `memoryBudgetWords` 的截断，超了只告警；`overWords` 是所有展示的唯一超量口径，别拿 `words` 再做减法。
`zk_dream` 的 `memory.personaWords` 是整段人格注入量；`headroom` 只扣记忆侧（`totalWords - personaWords`），人格不占记忆预算。
`memory.files[]` 与 `zk_context` 同形（`name / present / words / originalWords / retiredWords`）：`memoryUsage` 返回什么，schema 就得声明什么 ——
少一个 key，宿主校验直接整次 invalid output。

**dream 的入链统计有预算**（M5.0b）：`zk_dream` 的 `cited` / `citedBy` / `topCited` 来自一次全量建图，
而全图在 10k 上要 26–31 s / 17 MB。超过全图统计上限（`graphBudgetNotes`，默认 2000，设置页可调；
0 = 永不建全图）时不再建图，结果带 `graphSkipped: true` 与生效的 `graphBudget`，
render 明说「被引数与 topCited 是空的，不代表没人引用」—— 那是「没算」，不是「没人引」。
其余材料（窗口候选、拒绝原因、Loose ends、退役候选、记忆余量）不受影响。
全局被引的增量口径留给 plan §7 G2，别在这一步用全图硬撑。

`zk_lint` / `zk_dream` 是**只读**工具，没有 `dry_run` 参数：不给只读工具留一个「看起来能写」的开关（D7）。
`zk_lint` = 1 次 `zk list` + 三个 zk 原生过滤器（`--orphan` / `--broken-links` / `--tagless`）+ 单向链接的边，
**顺序执行**：zk 每次都会顺手补索引，并发进程会撞 SQLite 写锁；200 条笔记约 0.9 秒（验收线 3 秒）。

**单向链接的边从哪来**（M5.0b）：≤ 全图统计上限（`graphBudgetNotes`，默认 2000）时一次 `zk graph`
（1k 实测 0.45 s，还能拿到 `snippetStart`）。超过上限改按篇反查：`--missing-backlink` 给候选目标，每个目标 `--link-to` 取来源、`--linked-by` 判回链；
上限 50 个目标 / 60 个子进程（取先到者，实际约 30 个目标），触顶置 `edgesTruncated`。10k / 1 链夹具实测整次巡检 6.6 s
（改动前只全图就 26–31 s / 17 MB）。反查路径没有偏移量，`where` 改成扫源文件判断，相对路径写法可能落到 `body`。

**冷启动与半库**（M5.0a）：第一次读一个还没有索引的大库时，zk 会自己全量重建（10k / 1 链实测 202 s），
原来的 60 s 超时把它杀在写事务里，留下 `notebook.db-journal` 的半库，下一次读又从零重来。
现在所有命令先过 `ensureIndexReady`：≤ 200 篇让这条命令自己建（给 30 min 建库预算）；
更大的库在后台起 `zk index`，最多等 15 s —— 等不到返回 `index-building`（带篇数与已等秒数），
不会再起一条注定被杀的读命令。`-journal` / `-wal` 还在、db 又没在长 = 上次被杀：
判 `interrupted` 后同样走后台重建，明说「索引不完整」；建库失败报 `index-failed`（错误码都在 `ZkError.code`）。
遇到这两种错误过一会儿重试即可，**不要同时手动跑 `zk index`**。
「陈旧」在 JS 里算（`stale_days` 默认 90）—— zk 的 `stale` 不是内置过滤器，只在用户的 `[filter]` 里定义过才存在。
「重名标题」按「压空白 + 小写」归一化后分组。孤儿与无标签**排除 daily 目录**：日记按天写，天然没入链没标签，
全报会淹掉真问题；断链仍包含日记。
`similarTitles`（P2-10）是「改一两个字」的疑似重复：NFKC + 去标点后按字符二元组算 Jaccard ≥ 0.6，
或短串（≥ 6 字）被长串包含；只在同目录内比较，短于 4 字的标题跳过（`RAG` / `RAG 2` 的二元组太少，噪声大于信号）。
与 `duplicateTitles` 分开报：全等的直接进重名，不再进疑似；只在内存里比较，同目录超过 300 篇或扫描触顶时置 `truncated`，
并在 `completeness = partial` 的同时报 `droppedGroups`（有几组只比较了前 300 篇）。只报告，合并由人裁决。
**日记与纯数字标题不参与**：日记标题就是日期（`2026-10-01` / `2026-10-02` 的二元组相似度是 0.86），
不排除的话一年日记能吐出上千组误报、把真问题淹掉；按日期 / 编号命名的笔记同理（`isDaily` 在调用方过滤，纯数字 key 在函数内跳过）。
`timeline`（3.1）查日记时间轴，只报告、不改文件：layered（有 `## Events`，大小写不敏感，与 `appendDaily` 找小节的口径一致）
要求 `### HH:MM` 落在 Events 与下一个 `##` 之间；
flat（没有 `## Events`）要求 `## HH:MM`，顺序检查跨全文。时间只认 `00:00–23:59` 的两位 `HH:MM`（可跟全角 / 半角括号说明）：
`11:5x` / `9:5` / `24:00` / `12:45 标题` 报格式，layered 里的 `## HH:MM`、或落在 `## Observations` / `## Loose ends` 之后的时间块报位置；
空块与倒序只报位置正确的条目，同分钟相邻允许。围栏代码与 frontmatter 里的标题不算。
`zk_lint` 只扫最近 90 天（`TIMELINE_WINDOW_DAYS`；按文件名 `YYYY-MM-DD` 判日期，非日期形状退回创建时间），
`total` / `counts` 按全量算、`items` 里每篇最多 50 条明细（整个桶最多 50 篇），所以四项分类相加始终等于 `total`；
超过 2 MiB 或读不到的文件不会静默略过：计入 `skipped`，输出里点名「跳过 N 篇」。
笔记页的时间轴警告不受这个窗口限制 —— 打开哪篇查哪篇。自动重排会改正文顺序、diff 不可审，所以不给自动修复开关。
「单向链接」（`oneWayLinks`）按边算：存在 S→X、X 没回链 S，且 **S、X 都不是日记**。
不用 zk 的 `--missing-backlink`：它的原义是「至少有一条单向链接」，日记天然是一串出边，
日记提过的每篇笔记都会常年挂在桶里 —— 那不是「没接上」，是正常的引用方向，桶就再也清零不了。
普通笔记链到日记（"今天做了 X"）同理，不要求日记回链。
`oneWayLinks.items` 是缺回链的目标 X（不是来源），`from` 是没被 X 回链的来源 S；`edges` 是全部单向边数（`items` 截到 50 条时仍计全量），
`where` / `bodyOnly` 标出其中来自正文引用（不在 `## Links` / `## 链接` 小节）的部分 —— 正文引用天然常单向，
单独计数，方便判断该不该补回链。`zk_lint(links_only=true)` / `zk-kit lint --links-only` 只列 Links 小节的单向边，
正文引用只进 `bodyOnly`；默认 `false`，仍然全报。
`parseErrors` 单列一类：frontmatter 写坏（典型是 `tags: [#你好世界]` —— YAML 里 `#` 不是 tag 前缀，要写 `tags: ["你好世界"]`）
时 zk 以 exit 0 跳过那篇、只往 stderr 打一行 `error parsing note content`，于是它不在索引里 ——
搜不到，也不会出现在上面任何一个桶里（表现成邻居突然孤儿 / 断链）。`zk()` 收 exit 0 的 stderr warning，
按 `excludedNames` 同一套口径过滤（归档 / raw / inbox / meta 的坏文件本来就不参与检索，报了只会淹掉真问题），
`zk_lint` 与 `zk-kit doctor` 各回一行；`doctor` 用 ⚠️ 标，不影响它的退出码。
一次最多扫 10000 篇，到顶时两个工具都返回 `truncated: true`、`completeness: partial`（带 `scanLimit`）并在文本里告警：
笔记扫描少一篇只会漏报。三态是新字段，旧客户端可忽略 `completeness`，但不能再把「返回条数」当「结果数」。
边是另一条上限：小库的 `zk graph --limit 10000`（数的是笔记载入数）到顶、或大库的按篇反查触到
50 个目标 / 60 个子进程时，`oneWayLinks.edgesTruncated` 为 true —— 缺掉的回链边会把双向误判成单向，
这是巡检里唯一可能**误报**的截断，看到告警先归档旧笔记或缩小排查范围再重跑。
`memoryLinks` 单独查**记忆层**：`MEMORY.md` / `USER.md` 里的 `[[来源]]` 是否还指向活笔记。
解析顺序固定：原路径 → 加 `.md` → `archive/` 下同名 → 活笔记标题 / 文件名；旧路径在 `archive/` 下找到同名，
或活文件带 `status: superseded`，报 `superseded`；都找不到报 `missing`。**显式写 `archive/` 路径的链接是有意引用**
（supersede 重写入链就是这个形状），不算漂移。归档标题不反查（归档默认不进检索，反查就成了第二套索引），
「语义重复」不查。为什么必须有：`zk_supersede` 只重写 `zk graph` 里的入链，meta 文件被 `excludedNames`
排除在图外 —— 链接不会跟着搬，`--broken-links` 也统计不到；记忆说 X、库里 X 已废弃，这是两层脱节的入口。
`unlinked` 只数 **MEMORY.md** 的活条目里没有有效 `[[链接]]` 的（USER.md 是偏好清单，本来大多没有来源，
不计；散文段落也不算，避免把自由文本变成告警噪音；退役行不计，`[[   ]]` 空目标不算来源）。
它与 `undated` 取自 `memoryFormatDebt()`，和注入提示、记忆页是同一个数。
同一份条目解析还数 `undated`（首行没有真校验过的 `YYYY-MM-DD`，退役行不计）、`retired`（`- [superseded …]` 条目数）
与 `retiredBroken`（退役行的 `→ [[新结论]]` 解析不到活笔记），以及 `stale`（有日期且超过 `stale_days`，默认 90 天未复核）——
都只报告；注入从 0.9 起省略退役条目（notice 说明省略数），文件本身不动。条目切分与日期解析统一走 `lib/memory-format`。
文案由 `lib/lint` 的 `formatMemoryLinks()` / `formatLintExtras()`（缺字段 / 标签卫生 / 模板版本 / 疑似重复 / 时间轴 / INDEX 提示）统一生成，`zk_lint` 与 `zk-kit lint` 共用一份 —— 两处各写一遍，下次改措辞只会改到一半。
`incomplete`（P2-13）：`type` / `status` / `authority` 缺任一的笔记（**只在 layered 下查**：flat 的笔记
本来就不写这三个字段，整库标红不是「可发现的状态」而是噪音）。索引把缺失落成空串，
于是「没写 authority」=「authority 正常」，dream 的 informal 门对它们静默失效。
只能逐篇读 frontmatter（索引里区分不出「没写」与「空值」）；护栏是只读 live 且非日记，扫描触顶时置 `truncated`。
`tags`（P2-14）：标签总数 ≥ 30 才报；`caseVariants` 是忽略大小写后同形的组（`#Agent` 3 篇 + `#agent` 2 篇 → 一组、总 5），
`singletons` 是只出现一次的那批。只报告，不合并 —— 在别的库里它们可能就是两个概念。
`template`（P2-15）：读根目录 `AGENTS.md` 首行的 `<!-- zdiary-template: vN -->`；无标记按 v0 算，
与 `TEMPLATE_VERSION` 不等时提示，并把当前结构对应的模板全文放进 `currentText`。只报告，不覆盖（模板允许用户改）。
`version < current` 才给全文；`version > current`（插件被降级过）只报「模板比插件新」，不给旧模板 —— 否则 agent 会照旧版合并、把标记改回去。
`version === current` 时再查正文哨兵（`TEMPLATE_SENTINELS`）：正文还留着当前版本删掉的句子 → `mismatch`，仍给全文，提示「疑似只改了版本号」。
v2 去掉了 `inbox/`（P2-8），老库会在下次 `zk_lint` 看到「旧版模板」+ 新模板全文 —— 这是有意的：
它每轮注入，停旧版本等于按旧路径写；而插件安装后 docs 在包内、工作区外读不到，不能只给相对路径。
`zk_dream` 的拒绝规则只有两条（`authority=informal`、无标签），日记不进候选/拒绝（它的未完成项单独一栏）：
再加第三条就是语义判断，违反 D5。`topCited` 用一次 `zk graph` 数入链，不按笔记逐条跑。
**使用信号（P2-12）**：入链数衡量的是作者写笔记时的中心性，不是「后来被用到」。日记是这个插件里唯一
按时间记录真实工作的层，所以从同一次 `zk graph` 里再取「来源在 dailyDir 下的边」：候选与被引排行都带
`dailyMentions`（被几篇日记提到）、`daysMentioned`（覆盖几个不同日期）、`lastMentioned`（最近日期）。
日期优先取日记文件名（`YYYY-MM-DD`）—— 补写旧日记时 zk 的 `created` 会全是今天；文件名不是日期形状才退回 `created`。
同一口径（3.1）也用在窗口 / `backlog` / 候选的 `created` / `dailyLooseEnds.date`：统一走 `noteDate()` ——
日记看文件名，其他笔记看 frontmatter `date`（严格 `YYYY-MM-DD`），都没有才退回 `created`。
补写 10 月的日记不会再被算成本周新增，Loose ends 的日期也不会显示成今天。
`topCited` 排序改为 `daysMentioned → dailyMentions → cited → 标题`（跨天复现比同一天多篇更强）：日记里没写过就是 0，排序自动退回原来的
「入链降序」，不引入任何新状态，也不需要 recall 日志。局限写在文档里：**空信号不等于没被用过**。
**晋升是一道门，门要知道门里有什么。** `zk_dream` 会读 `MEMORY.md`，把「已经晋升过」的移出候选、单列 `alreadyPromoted`：
两条都是字符串比较 —— `[[链接]]` 经 `lib/wikilink` 解析到活笔记（`promotedBy: 'link'`），
或者候选标题（归一化后 ≥ 6 字）出现在 MEMORY 的某一行里（`promotedBy: 'title'`，真机 7 条里 6 条是这种纯文字条目）。
短标题（「RAG」）不做包含匹配：任意句子里都可能撞上，宁可重复报，不猜。归档链接不算晋升。
退役条目（0.9 D3）让这两条略微分叉：链接匹配仍用**原文**（退役行的 `→ [[新结论]]` 是合法的已晋升指针），
标题匹配用 `stripRetiredEntries` 之后的正文（退役行里的旧标题不该再算已晋升）。
不这样做的后果是可推演的：同一批笔记每周原样重复，人跳过几次之后 `DREAMS.md` 的日期不再更新，整套回路就断了。
窗口默认也不再固定 7 天：`days` 省略时 = 距 `DREAMS.md`「上次做梦」的日历天数（1–365，没有或日期不合法才退回 7），
所以漏做一周窗口会自然变大；窗口外仍未晋升、且过机械门的笔记进 `backlog`（按被引数取前 10，`counts.backlog` 给总数），
漏一次不会永久掉队。显式 `days` 仍然优先。
候选的 `lead` 是 frontmatter 之后第一段正文（200 字内）—— 不是 zk 的 `lead`（那只是标题行）；
`citedBy` 是同一次 `zk graph` 得到的入链来源前 5 条。给 agent 的是可重放的上下文（谁引了它、摘要是什么），
不是「这条该晋升」的结论。
**记忆余量与退役材料（0.9 D4）。** 结果的 `memory` 与注入同一口径：`words` 是内容词（含「记忆已用」提示行），
`personaWords` 是整段人格注入量，`totalWords` 含人格 / 框 / 做梦提醒 / notice，
`headroom = budget - (totalWords - personaWords)` 可以为负 —— 只报内容词等于说
「还有 15 词」，而框和提示早就把它吃完了；人格是独立层，不占记忆预算。`retireCandidates` 是机械规则给的「可考虑退役」：有日期且 > 90 天（`stale`）、
`[[来源]]` 指向归档 / 不存在（`source-superseded` / `source-missing`）；显式写 `archive/` 的链接是有意引用旧结论，
不算来源断了（与 `memoryLinks` 同口径），无日期无链接的不算候选。
`zk_dream` 只输出这两栏，不写任何文件。
`zk-kit query` 的透传在 0 命中且给了 `-m` 时退回 `-M re`：FTS5 不切中文，不兜底会静默返回空（Z12）。
`zk_search`（P2-7）更进一步：**查询含 CJK 时 FTS 与 `-M re` 各跑一次**，按路径去重合并，`matchStrategy` 返回
`fts` / `regex` / `mixed`。只兜 0 命中是不够的 —— FTS 命中 1–2 条时模型会以为「库里只有这些」，然后建重复笔记；
纯 ASCII 查询仍只跑一个进程，不付这份开销。`mixed` 只在正则补到的笔记**真的进了返回**时才报：FTS 占满 `limit` 时
两者按 `limit` 合并会把补的分片切掉，那时仍报 `fts`，界面文案不会谎称「已补上」。
正则这一路单独兜错：子串匹配超时 / 报错时退回 FTS 的结果并按 `fts` 报，不让一次检索整体失败（FTS 0 命中时则返回空）。
这种情况下 `completeness = unknown`：结果可能少了正则补的那部分，不能当成「全部命中」。
`zk_query` 与 `zk_search` 共用 `searchNotesDetailed`，中文同样双跑；差别只在结构化过滤（见上）。

**召回质量四件套（§10.4 第 4 项：R1 / R2 剩余 / R3 / R7）。**
- **R1 相关性排序**：有 `query` 且没显式给 `sort` 时不再传 `--sort created-`（zk 只有 `created / modified / path / title / random / word-count`，没有 relevance），保住 FTS 的 BM25 顺序；`sort` 枚举加 `relevance`，说明「只在有 query 时有效，无 query 回退 `created-desc`」。工具层 / `zk-kit search` 都按这个默认值；显式 `sort` 一律不改写。CLI 与 `zk_query` 同步。
- **R2 `snippet` / `total`**：`NoteRecord` 加 `snippet`。zk 0.15.7 的 `snippets[0]` 实测**就是首段**（长笔记里与 `lead` 逐字相同），并不定位深处的命中句 —— 所以 `buildSnippet` 先看片段里有没有查询词，没有就从 `rawContent` 取「最早命中 ±80 字」的窗口，压空白截 240 字。带 `status` / `type` 过滤走精简字段格式，那里没有 `rawContent`，于是只在**有 query 时**多用一列 `{{snippets}}`（`SEARCH_LEAN_TEMPLATE`），无 query 的全库扫描不背这段正文。`zk_search` / `zk_query` 输出透出 `snippet`（空串时整个键不出现）与 `words`，render 在 `snippet` 比 `lead` 多信息时替换 `lead`。
  `total` 是**精确命中总数（含结构化过滤后），只在 `completeness === 'complete'` 时给**：zk 的 `Found N notes` 会被 `--limit` 截断（实测 115 命中、`--limit 10` 时只报 `Found 10 notes`），拿不到 limit 之外的真实总数，额外起一个进程去数又违反「不新增子进程」。`partial` / `unknown` 时 `total` 缺失，`hasMore` / `completeness` 已经说明「还有多少不知道」，不拿 `count` 冒充。
- **R3 中文多词**：`splitCjkQuery` 按空白 / 标点切词、去重、保留 ≥2 字、最多 4 个；少于 2 词、纯 ASCII 或超过 4 词都退回原来的「整串正则」两遍策略。多词时正则这一路换成转义后的 `(?:词1|词2|…)` **一次进程召回**（不逐词起进程），再用 `rawContent` 算每个命中覆盖了几个词，按 `coverage` 降序 → 原 FTS 顺序 → `created-desc` 排序；精简格式路径没有 `rawContent`，用 `title / lead / snippet` 算覆盖度（best effort）。`zk_query` 的旧描述「中文召回不完整，尽量配合 tags 使用」已改成与 `zk_search` 一致。
- **R7 0 命中**：CJK 查询 0 命中时 render 追加「中文全文不切词：换更短的词，或按 tags 查」（`zk_query` 提示 `tags` 参数）；纯 ASCII 0 命中文案不变，提示不动 `notes` / `count`。

**召回装配（R4，§10.4 第 5 项）.** 新增只读 `zk_recall`（`lib/recall.ts`）：检索之后按词数预算把命中笔记拼成一段可直接读的上下文，补上「召回之后还有装配」，插件此前停在 top-k。
- 只做机械装配：不读全文、不做向量 / LLM rerank / 跨回合 dedup、不新增 zk 进程；一次 `searchNotesDetailed` 取候选（默认 30 条），其余全在内存里拼。
- 分组轮转：按 `type` → 首个标签 → 「未分类」分组，各组轮流取一条，组内保持检索顺序；预算不会被排在最前的那一类全吃掉。
- 每条取 `title` / `path` / `absPath` / `words` 与 `snippet`（比 `lead` 多信息时用它），`budget` / `used` 走 `countWords` 口径（中文 2 字 1 词）。放不下就**整条丢弃、不切半句**，`notes[].reason` 明写 `included` / `duplicate` / `empty` / `over-budget`；`used` 是对最终整段文本算的（分隔符也计入），所以一定 `<= budget`。
- 0 命中返回空 `text` / 空 `notes` / `used = 0`，不编造；`completeness` / `hasMore` 沿用检索三态 —— 装配过的只是本次候选，不代表库里没有别的。需要全文仍由宿主原生 `read` 按 `absPath` 取。
- 命令行 `zk-kit recall [词] [--budget 500] [--limit 30] [--json]`，与工具走同一份 `assembleRecall`。

**写后可读（R6，3.6.0）.** `zk_append` / `zk_link` / `zk_new` 的 `summary` 回填 / 改名 / 搬归档之后，
插件在 `.zk/dsh-index-state.json` 记 `generation`（每次写入 +1）与 `indexedGeneration`（最近一次成功 `zk index` 覆盖到的快照）。
两者不等就是 dirty，下一个 `zk()` 读（检索 / lint / dream / stats / 反查都算）之前自动补一次 `zk index`，最多等 15 秒：
建完就读到新内容；建不完 / 失败 / 另一个进程在建则「完整但可能过期」回退，打一条 `[zdiary]` 告警（同一 generation 只打一次），
dirty 留到下次读。**回退只允许落在完整 db 上**：db 不完整（missing / interrupted）时 flush 不接手，交给 `ensureIndexReady` 的冷建守卫，
不把 M5.0a 修掉的「读→杀→半库→再读」循环放回来。跨进程 single-flight 靠 `.zk/dsh-index.lock`（O_EXCL + pid / mtime 判 stale，
锁文件刚建好但 token 没写完的几秒内不当 stale，否则会把别人刚建的锁当垃圾删掉 → 两个 `zk index` 并发）；
读路径与显式重建都先抢这把锁，不并发起第二个 `zk index`。
`zk_new` 本身不需要标脏：`zk new` 自己会把新文件写进索引；只有摘要回填（`fs.writeFileSync` 绕过了 zk）才补标。
外部编辑不被感知：`indexLagHint`（doctor / `zk_lint` 的 `indexLag`）只比 `notebook.db` 与笔记本**顶层**条目的 mtime，
约十次 stat 而不是 10⁴ 次；目录 mtime 只在新增 / 删除 / 改名时变，**改已有笔记的正文一定漏报**（不是「可能漏报」）。
