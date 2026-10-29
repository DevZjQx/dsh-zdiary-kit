# zk-tools（agent 工具）

**Purpose.** 让模型用 zk 思维工作：先查重、再写原子笔记、用双链连起来、每天记一段。

**Owns.** 10 个工具定义（`zk_search` / `zk_query` / `zk_read` / `zk_new` / `zk_append` / `zk_daily` / `zk_link` /
`zk_supersede` / `zk_context` / `zk_stats`）：
参数 schema、输出 schema、render、每个工具自己的 `ensureNotebook` 与参数校验。
`zk_context` 例外：它只读根目录三份 meta 文件，**不** `ensureNotebook`（读记忆不该依赖 zk）。

**Does not own.** zk 命令行怎么拼（`lib/zk.ts`）；笔记本怎么建（`lib/notebook.ts`）；配置读写（`config/store`）；
设置页（`features/settings`）。工具不 import settings，settings 也不 import 工具 —— 只共享 lib 与 config。

**Depends on.** `config/store`（每次调用现读，设置页改完立刻生效）、`lib/notebook`、`lib/zk`、`lib/memory`、`lib/tool`。

**Public surface.** `buildTools()`（纯数据，测试用）与 `registerZkTools(tools)`（返回撤销函数）。

**Rejected.** 把工具做成"一个 `zk` 大工具 + action 参数" —— 拒绝：模型的参数猜测会更多，
且每个动作的 schema 不同（搜索有 tags/since/sort，写入有 path/text），分开才能让参数自解释。
用 shell 拼字符串调 zk —— 拒绝：一律 `execFile` 数组参数，笔记标题里的引号/空格不会变成注入。
在 `zk_query` 里加语义判断（"哪条更相关"）—— 拒绝：那是 agent 的活，插件只按字段过滤。

**Exceptions.** 输入校验自己写：DSH 只对 `defineTool` 注册的工具做输入校验，
裸 JSON Schema 注册的工具要自己兜（`lib/tool.ts`），换来运行时零依赖。
所有查询都带 `excludedNames(cfg)` 的**绝对路径**排除（`raw` / `inbox` / `archive` + 五个 meta 文件）：
`-x` 是相对 cwd 解析的，传相对名在换工作目录后会静默失效。`zk_query` 的 `include_archived: true` 只去掉 archive 一条。
`status` / `type` 只能靠 `metadata` 在 JS 层过滤（zk 的 `--match` 不索引 frontmatter），
所以带这两个过滤时会先按 `--limit 200` 多取再截断 —— 否则「前 10 条里没有 active」会被误读成「没有结果」。
`status` 缺省按 `active` 算：0.1.0 的老笔记没有 frontmatter，不这样兜，flat vault 上一条都查不出来。
`zk_new` 撞名直接报错（`zk new` 遇到同名文件是 exit 0 + 不写内容，Z8），不自动加后缀。
`zk_supersede` 默认 `dry_run: true`：一句「更新一下 wiki」不该让全库漂移。
`zk_read` 的"没找到"走 throw（isError），不返回 `found:false` —— 模型看到错误比看到空字段更容易改对。
