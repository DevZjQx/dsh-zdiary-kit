# zk-tools（agent 工具）

**Purpose.** 让模型用 zk 思维工作：先查重、再写原子笔记、用双链连起来、每天记一段。

**Owns.** 14 个工具定义（`zk_search` / `zk_query` / `zk_read` / `zk_new` / `zk_append` / `zk_daily` / `zk_link` /
`zk_supersede` / `zk_rename` / `zk_context` / `zk_lint` / `zk_dream` / `zk_stats` / `zk_use`）：
参数 schema、输出 schema、render、每个工具自己的 `ensureNotebook` 与参数校验。
`zk_context` 例外：它只读根目录三份 meta 文件与两份契约（`PERSONA.md` / `POLICY.md`）并列出已配置笔记本（另读 `DREAMS.md` 的「上次做梦」一行用于周节奏提醒），**不** `ensureNotebook`（读记忆不该依赖 zk）。

**多会话与笔记本归属.** 工具拿配置走 `config/session.ts` 的 `configFor(workspace, sessionId)`，不是直接 `config()`：
会话第一次调用时把当时的 `active`（默认值）快照成自己的 pin，之后设置页 / CLI / 别的会话切库都不带动它；
本会话换库只能显式 `zk_use`。pin 一会话一个文件（`~/.dsh/zdiary/sessions/`），进程重启与会话 resume 都接得上；
指向的笔记本被删掉时静默回到默认值。`zk_context` / `zk_stats` 会在 pin 与默认值不一致时把这件事写出来，
不让模型自己从「笔记不存在」里猜。`zk_read` / `zk_append` 找不到路径时还会查其他笔记本里有没有同名，
命中就把「这篇在 X 库里」放进错误提示。

**Does not own.** zk 命令行怎么拼（`lib/zk.ts`）；笔记本怎么建（`lib/notebook.ts`）；配置读写（`config/store`）；
设置页（`features/settings`）。工具不 import settings，settings 也不 import 工具 —— 只共享 lib 与 config。

**Depends on.** `config/session`（会话固定的笔记本 → 配置；每次调用现读，设置页改完立刻生效）、`lib/notebook`、`lib/zk`、`lib/memory`、`lib/tool`。

**Public surface.** `buildTools()`（纯数据，测试用）与 `registerZkTools(tools)`（返回撤销函数）。

**Rejected.** 把工具做成"一个 `zk` 大工具 + action 参数" —— 拒绝：模型的参数猜测会更多，
且每个动作的 schema 不同（搜索有 tags/since/sort，写入有 path/text），分开才能让参数自解释。
用 shell 拼字符串调 zk —— 拒绝：一律 `execFile` 数组参数，笔记标题里的引号/空格不会变成注入。
在 `zk_query` 里加语义判断（"哪条更相关"）—— 拒绝：那是 agent 的活，插件只按字段过滤。

**Exceptions.** 输入校验自己写：DSH 只对 `defineTool` 注册的工具做输入校验，
裸 JSON Schema 注册的工具要自己兜（`lib/tool.ts`），换来运行时零依赖。
所有查询都带 `excludedNames(cfg)` 的**绝对路径**排除（`raw` / `inbox` / `archive` + 六个 meta 文件）：
`-x` 是相对 cwd 解析的，传相对名在换工作目录后会静默失效。`zk_query` 的 `include_archived: true` 会去掉 archive 排除；
如果没显式给 `status`，此时也不再默认卡 `active`（否则归档里的 `superseded` 永远查不出来）。
`status` / `type` 只能靠 `metadata` 在 JS 层过滤（zk 的 `--match` 不索引 frontmatter），
所以带这两个过滤时会先按 `--limit 200` 多取再截断 —— 否则「前 10 条里没有 active」会被误读成「没有结果」。
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
`zk_read` 的"没找到"走 throw（isError），不返回 `found:false` —— 模型看到错误比看到空字段更容易改对。
`zk_read` 也能读根目录 meta 文件（`MEMORY.md` / `USER.md`）：注入截断时留下的目录就是让 agent 用这个取回原文。
`zk_context` 的 `files[].originalWords`（截断前词数）、`files[].retiredWords`（退役条目占的词数，只算在 `MEMORY.md` 上）、
`tocWords`（目录占的词数）与 `ratio`（用量 = `words / budget`，两位小数，> 1 表示超预算）只用于解释预算，不改变注入内容。
`originalWords` 含退役条目；展示层的「原 X」会先减掉 `retiredWords`，所以退役不会再被当成截断报出来。
契约单独一组：`contract.present / words / budget / overBudget / files[]`，外加 `totalWords`（`countWords(payload.text)`）与
`overheadWords`（框 / 做梦提醒 / notice 等开销）；场景段本批只落形状（`scene.present` 恒 false），M3 起由 `STATE` 填。
契约**不参与** `memoryBudgetWords` 的截断，超了只告警；总 prompt 超 `totalPromptBudgetWords` 时只点名，不自动截契约。

`zk_lint` / `zk_dream` 是**只读**工具，没有 `dry_run` 参数：不给只读工具留一个「看起来能写」的开关（D7）。
`zk_lint` = 1 次 `zk list` + 三个 zk 原生过滤器（`--orphan` / `--broken-links` / `--tagless`）+ 1 次 `zk graph`，
**顺序执行**：zk 每次都会顺手补索引，并发进程会撞 SQLite 写锁；200 条笔记约 0.9 秒（验收线 3 秒）。
「陈旧」在 JS 里算（`stale_days` 默认 90）—— zk 的 `stale` 不是内置过滤器，只在用户的 `[filter]` 里定义过才存在。
「重名标题」按「压空白 + 小写」归一化后分组。孤儿与无标签**排除 daily 目录**：日记按天写，天然没入链没标签，
全报会淹掉真问题；断链仍包含日记。
`similarTitles`（P2-10）是「改一两个字」的疑似重复：NFKC + 去标点后按字符二元组算 Jaccard ≥ 0.6，
或短串（≥ 6 字）被长串包含；只在同目录内比较，短于 4 字的标题跳过（`RAG` / `RAG 2` 的二元组太少，噪声大于信号）。
与 `duplicateTitles` 分开报：全等的直接进重名，不再进疑似；只在内存里比较，同目录超过 300 篇或扫描触顶时置 `truncated`。只报告，合并由人裁决。
**日记与纯数字标题不参与**：日记标题就是日期（`2026-10-01` / `2026-10-02` 的二元组相似度是 0.86），
不排除的话一年日记能吐出上千组误报、把真问题淹掉；按日期 / 编号命名的笔记同理（`isDaily` 在调用方过滤，纯数字 key 在函数内跳过）。
「单向链接」（`oneWayLinks`）在 JS 里按 `zk graph` 的边算：存在 S→X、X 没回链 S，且 **S、X 都不是日记**。
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
一次最多扫 10000 篇，到顶时两个工具都返回 `truncated: true` 并在文本里告警：笔记扫描少一篇只会漏报。
边是另一条上限：`zk graph --limit 10000`（数的是笔记载入数）到顶时 `oneWayLinks.edgesTruncated` 为 true —— 缺掉的回链边会把双向误判成单向，
这是巡检里唯一可能**误报**的截断，看到告警先归档旧笔记或调大上限再重跑。
`memoryLinks` 单独查**记忆层**：`MEMORY.md` / `USER.md` 里的 `[[来源]]` 是否还指向活笔记。
解析顺序固定：原路径 → 加 `.md` → `archive/` 下同名 → 活笔记标题 / 文件名；旧路径在 `archive/` 下找到同名，
或活文件带 `status: superseded`，报 `superseded`；都找不到报 `missing`。**显式写 `archive/` 路径的链接是有意引用**
（supersede 重写入链就是这个形状），不算漂移。归档标题不反查（归档默认不进检索，反查就成了第二套索引），
「语义重复」不查。为什么必须有：`zk_supersede` 只重写 `zk graph` 里的入链，meta 文件被 `excludedNames`
排除在图外 —— 链接不会跟着搬，`--broken-links` 也统计不到；记忆说 X、库里 X 已废弃，这是两层脱节的入口。
`unlinked` 只数 **MEMORY.md** 的列表条目里没有 `[[链接]]` 的（USER.md 是偏好清单，本来大多没有来源，
不计；散文段落也不算，避免把自由文本变成告警噪音）。
同一份条目解析还数 `undated`（首行没有真校验过的 `YYYY-MM-DD`，退役行不计）、`retired`（`- [superseded …]` 条目数）
与 `retiredBroken`（退役行的 `→ [[新结论]]` 解析不到活笔记），以及 `stale`（有日期且超过 `stale_days`，默认 90 天未复核）——
都只报告；注入从 0.9 起省略退役条目（notice 说明省略数），文件本身不动。条目切分与日期解析统一走 `lib/memory-format`。
文案由 `lib/lint` 的 `formatMemoryLinks()` / `formatLintExtras()`（缺字段 / 标签卫生 / 模板版本 / 疑似重复 / INDEX 提示）统一生成，`zk_lint` 与 `zk-kit lint` 共用一份 —— 两处各写一遍，下次改措辞只会改到一半。
`incomplete`（P2-13）：`type` / `status` / `authority` 缺任一的笔记（**只在 layered 下查**：flat 的笔记
本来就不写这三个字段，整库标红不是「可发现的状态」而是噪音）。索引把缺失落成空串，
于是「没写 authority」=「authority 正常」，dream 的 informal 门对它们静默失效。
只能逐篇读 frontmatter（索引里区分不出「没写」与「空值」）；护栏是只读 live 且非日记，扫描触顶时置 `truncated`。
`tags`（P2-14）：标签总数 ≥ 30 才报；`caseVariants` 是忽略大小写后同形的组（`#Agent` 3 篇 + `#agent` 2 篇 → 一组、总 5），
`singletons` 是只出现一次的那批。只报告，不合并 —— 在别的库里它们可能就是两个概念。
`template`（P2-15）：读根目录 `AGENTS.md` 首行的 `<!-- zdiary-template: vN -->`；无标记按 v0 算，
与 `TEMPLATE_VERSION` 不等时提示，并把当前结构对应的模板全文放进 `currentText`。只报告，不覆盖（模板允许用户改）。
`version < current` 才给全文；`version > current`（插件被降级过）只报「模板比插件新」，不给旧模板 —— 否则 agent 会照旧版合并、把标记改回去。
v2 去掉了 `inbox/`（P2-8），老库会在下次 `zk_lint` 看到「旧版模板」+ 新模板全文 —— 这是有意的：
它每轮注入，停旧版本等于按旧路径写；而插件安装后 docs 在包内、工作区外读不到，不能只给相对路径。
`zk_dream` 的拒绝规则只有两条（`authority=informal`、无标签），日记不进候选/拒绝（它的未完成项单独一栏）：
再加第三条就是语义判断，违反 D5。`topCited` 用一次 `zk graph` 数入链，不按笔记逐条跑。
**使用信号（P2-12）**：入链数衡量的是作者写笔记时的中心性，不是「后来被用到」。日记是这个插件里唯一
按时间记录真实工作的层，所以从同一次 `zk graph` 里再取「来源在 dailyDir 下的边」：候选与被引排行都带
`dailyMentions`（被几篇日记提到）、`daysMentioned`（覆盖几个不同日期）、`lastMentioned`（最近日期）。
日期优先取日记文件名（`YYYY-MM-DD`）—— 补写旧日记时 zk 的 `created` 会全是今天；文件名不是日期形状才退回 `created`。
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
`totalWords` 含框 / 做梦提醒 / notice，`headroom = budget - totalWords` 可以为负 —— 只报内容词等于说
「还有 15 词」，而框和提示早就把它吃完了。`retireCandidates` 是机械规则给的「可考虑退役」：有日期且 > 90 天（`stale`）、
`[[来源]]` 指向归档 / 不存在（`source-superseded` / `source-missing`）；显式写 `archive/` 的链接是有意引用旧结论，
不算来源断了（与 `memoryLinks` 同口径），无日期无链接的不算候选。
`zk_dream` 只输出这两栏，不写任何文件。
`zk-kit query` 的透传在 0 命中且给了 `-m` 时退回 `-M re`：FTS5 不切中文，不兜底会静默返回空（Z12）。
`zk_search`（P2-7）更进一步：**查询含 CJK 时 FTS 与 `-M re` 各跑一次**，按路径去重合并，`matchStrategy` 返回
`fts` / `regex` / `mixed`。只兜 0 命中是不够的 —— FTS 命中 1–2 条时模型会以为「库里只有这些」，然后建重复笔记；
纯 ASCII 查询仍只跑一个进程，不付这份开销。`mixed` 只在正则补到的笔记**真的进了返回**时才报：FTS 占满 `limit` 时
两者按 `limit` 合并会把补的分片切掉，那时仍报 `fts`，界面文案不会谎称「已补上」。
正则这一路单独兜错：子串匹配超时 / 报错时退回 FTS 的结果并按 `fts` 报，不让一次检索整体失败（FTS 0 命中时则返回空）。
`zk_query` 是 `zk list` 的透传接口，保持原语义。
