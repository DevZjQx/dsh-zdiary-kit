# settings（设置页 + 宿主 API）

**Purpose.** 让主人看得见、管得住：zk 在哪、笔记本在哪、有多少笔记、怎么重建、怎么装。

**Owns.** 八条路由（全部 `/dsh-zdiary-kit/api/*`）：
- `GET/POST /settings`：读写配置（白名单 + 归一化在 `config/store`）；GET 返回快照与 `stamp`，POST 带回 `stamp`
  校验（别人改过就 409），成功返回快照与 `warn`；旧 `archiveDir` 非空时改它返回 **400**
  （`ArchiveDirChangeError`，不迁移文件）
- `GET /status`：zk 位置/版本/来源、笔记本是否存在、笔记/标签/断链/孤立计数
- `POST /init`：`ensureNotebook`（幂等；layered 时一并写 `AGENTS.md`）
- `POST /agents`：`writeAgentsTemplate` —— flat 库的 opt-in，已存在不覆盖；返回 `result.written` 与最新快照
- `POST /contract`：`writeContractTemplates` —— `PERSONA.md` 的 opt-in，缺了才写，已存在不覆盖；
  返回 `result.personaWritten` 与最新快照。
  契约不依赖 zk：笔记本还没初始化时也能写（只 `mkdir` 笔记本目录 + 文件，不碰 `.zk`），
  这时回包带 `warn` 提醒「点「初始化 / 补建」建库」；按钮因此不按 `notebook.exists` 隐藏。
- `POST /index`：`zk index`
- `POST /install`：内置 zk（下载 → 解包 → `--version` 验证）；`detail` 里回显下载源（自定义镜像会点名）
- `GET /selftest`：八项真检查（zk、笔记本、模板、group、结构、长期记忆、角色契约、索引）

快照（`GET /settings`、`GET /status`、写操作的回包）除了配置与计数，还带两块**诊断**：
`structure`（配置的模式、缺哪些目录、`extra` 盘上多出来的分层目录、`AGENTS.md` 在不在，
以及 `groups` / `groupsOk` / `groupWarnings` —— 每个期望 group 的 paths 与 `.zk/config.toml` 的对照，
`expectedOverlaps` / `actualOverlaps` —— 两个 group 用同一条路径（父子目录不算））与
`memory`（三份 meta 的保留词数 / 原词数 / 退役词数 / 目录词数 / 预算 / 截断量 / `contract`）。
`contract` 不参与记忆预算：它单独报 `present` / `words` / `budget` / `overBudget` / `files[]`；
缺文件 = 未启用（不算错），只有超预算才是 ✗。
保存后 `groupsOk === false` 时 `warn` 会点名不一致的 group 并建议 `zk-kit groups --fix`；页面顶部也常驻这条告警
（只有路径撞车、没有坏组时改为原样显示 `groupWarnings` 的第一条，因为 `--fix` 修不了配置本身）。
自检的「日记 group」项用同一份解析结果：期望 / 实际不一致即为 ✗；其它 group 不一致会在 detail 里提一句。
`extra` 只在 `flat` 下非空，命中时不把 `ready` 置 false：它表达的是「盘上有分层目录，新建笔记会落在 `notes/` 根」，
不是配置错误。
两者都是纯读：结构不一致只显示告警 + 底部的「初始化 / 补建」（= `POST /init`），**不自动建、不自动删、不改配置**。
快照里的 `workspace` 与 `notebook.path` 按插件进程工作区解析；agent 工具按各自会话工作区解析 ——
空 / 相对路径下两者可能不是同一个目录，界面要如实标出来，别让人以为 agent 一定用的是这一份。

浏览器半边 `client.ts`：声明式字段清单 `FIELDS`（默认是文本键值行；`type: 'bool'` 渲染成复选框，
状态里存真布尔 —— 拼成 `"false"` 字符串会被归一化当成没启用，勾了却存不进）、状态行、动作按钮、输出面板。
笔记本那一块不是 `FIELDS`（它是「名字 → {路径, 结构}」的表，字段清单表达不了）：
当前笔记本下拉 + 每个笔记本一行（路径可改、结构下拉 `flat`/`layered`、可删，至少留一个）+ 新增一行，改完同样靠「保存」落盘。
结构是**每个笔记本自己的**，就摆在那一行上；`flat → layered` 保存前弹窗明确写「只建目录与模板，不搬已有笔记」。
`flat` 且缺 `AGENTS.md` 时，操作区多一个「写入 AGENTS.md 模板」按钮（走 `POST /agents`）；记忆状态行同时提示
「缺 AGENTS.md：约定与周提醒未启用」。已有文件不覆盖，按钮点了也不会动用户的定制。
操作区常驻「写入契约模板」按钮（走 `POST /contract`）：缺 `PERSONA.md` 时写入，
已存在就只回「已存在，没有覆盖」（契约允许人改，插件不做第二份真相）。
这个按钮**不依赖 `notebook.exists`**：建库前也可以先定角色（服务端只建目录与契约，不碰 `.zk`），
成功提示里会带一条「还不是 zk 笔记本，点「初始化 / 补建」」的 `warn` ——
否则自检说「点「写入契约模板」」时，未初始化的库根本没有对应的可点项。
「记忆」分组里多五行配置：契约预算（`contractBudgetWords`，默认 240）、场景预算（`sceneBudgetWords`，80）、
状态窗口（`sceneWindowDays`，30 天）、场景新鲜度（`staleHours`，72 小时）、
合并预算（`totalPromptBudgetWords`，900，记忆载荷 + 场景行，只告警）。
「工具」分组只有一个开关：`aliasTools`（默认关）—— 打开后插件加载时才把 `.zk/config.toml` 的 `[alias]`
注册成 `zk_<名>`。注册发生在加载时，勾完保存还要重载插件（或重启 DSH）才会出现在工具列表里；hint 里写明了。
分组标题直接标作用范围（「笔记本」是每本自己的，其余是全局）；删除笔记本先确认「只删配置，磁盘目录与笔记保留」。
切换「当前笔记本」保存后自动建好目标笔记本（`ensureNotebook` 幂等）；改路径 / 新增不自动建（防手滑）。
但**切的是新会话的默认值**：每个会话第一次用 zk_* 时就把当时的默认值固定下来，之后各走各的 ——
设置页切换不会带着已经跑着的会话走（否则 A 会话切库，B 会话下一句就写到另一个库里，而且没有提示）。
要让某个会话跟过去，在那个会话里用 `zk_use`。这条语义直接写在下拉框的 hint 里。

`POST /settings` 是**乐观并发**：GET 回 `stamp`（配置文件指纹），页面保存时带回；
期间别的会话 / CLI 改过配置（指纹变了）就返回 **409 + 最新配置与 stamp**，客户端把最新值铺回表单，
提示「已刷新，请确认后重新保存」。不这样做的话，设置页整份回传的表单会把别人刚切的 `active` 静默覆盖回去。
服务端合并写本身也在跨进程文件锁（`lib/lock`）里读-合并-写，两个进程同时保存不会丢更新。

命令行 `zk-kit config get|set` 读写的是同一份配置、同一套归一化与告警口径（**都只改配置不建目录**），
只是没有浏览器：改完要自己跑 `zk-kit init`（对应设置页的「初始化 / 补建」）。
`config set structure=…` 改的是**当前笔记本**的结构；派生键 `notebook` / `notebooks` 不接受单键赋值（报错并指路）。
多笔记本走 `zk-kit notebooks [add 名 路径 | use 名 | remove 名]`：它改的是 `notebooks` 与 `active`，
`use` / `remove` 触发的切换会自动建好目标笔记本；`remove` 只移除配置条目，磁盘目录与笔记保留。
改目录 / `dailyGroup` 后，`.zk/config.toml` 不会自动跟着变：`zk-kit groups` 看差异，`--fix` 只改插件建的 group（写前备份）。
`notebook` 与 `structure` 是派生的（`notebooks[active]`），不落盘。

**Does not own.** 工具的注册与执行；zk 命令的正确性；模板 / group / `AGENTS.md` 的写入与结构检查（`lib/notebook`）。
「字段加在哪」：labels/hints 加在 `client.ts` 的 `FIELDS`，键加在 `config/store.ts` 的 `DEFAULTS` ——
白名单直接取 `DEFAULTS` 的键，不存在第三处。

**Depends on.** `lib/http`、`lib/install`、`lib/notebook`、`lib/zk`、`lib/lint`、`config/store`、`config/paths`；
app 注入 `route` 与 `isTrusted`（信任栅栏在 app，feature 只消费）。栅栏做三层：
`connection.requestRejection`（Host/Origin + 浏览器会话；不可用即 503，fail-closed）→ 写入口再判 `isTrusted`（回环直通）→
跨站写请求（Origin / Sec-Fetch-Site）一律 403 ——
否则任何一个网页都能 POST `/install` 让插件下载并执行二进制。

**Public surface.** `registerSettings({ route, isTrusted })`；`./client` 由包导出。

**Rejected.** 把信任栅栏放进 feature —— 拒绝：路由门必须集中在 app（settings 只拿到设防的 `route()`；
绕过栅栏的 `routePublic()` 只给只读视图，且那面的边界由它自己的回环门兜）。用已有的 `ctx.configForms` 做表单 —— 拒绝：那套要求插件声明
Config schema（schemastery）并走宿主配置编辑器，而本插件的配置热改、路径在 agent 工具里也要读，
自己一份 JSON 更直接（代价：要自己写字段清单）。

**Exceptions.** `client.ts` 必须单文件零 import（`__ModuleLoader__` 当普通脚本加载，只提供 `require("react")`），
因此它不 import 本包任何模块；两侧靠 API 路径 + 配置键对齐。`dist/.../client.js` 由 `scripts/postbuild.ts`
删掉 tsc 补的 `export {}`，并检查**没有顶层声明**：DSH 把多个插件的 `client.js` 拼进同一个 combo 脚本
（`/plugins/??a/client.js,b/client.js`）当普通脚本跑，顶层 `const loader = window.__ModuleLoader__` 这种写法
会和其他插件撞名，整个 combo 报 `Identifier 'loader' has already been declared`，本插件直接不激活。
所以顶层只写表达式语句（`window.__ModuleLoader__.load({...})`），要局部变量就包 IIFE。
