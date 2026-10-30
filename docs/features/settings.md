# settings（设置页 + 宿主 API）

**Purpose.** 让主人看得见、管得住：zk 在哪、笔记本在哪、有多少笔记、怎么重建、怎么装。

**Owns.** 六条路由（全部 `/dsh-zdiary-kit/api/*`）：
- `GET/POST /settings`：读写配置（白名单 + 归一化在 `config/store`）；GET 返回快照与 `stamp`，POST 带回 `stamp`
  校验（别人改过就 409），成功返回快照与 `warn`
- `GET /status`：zk 位置/版本/来源、笔记本是否存在、笔记/标签/断链/孤立计数
- `POST /init`：`ensureNotebook`（幂等；layered 时一并写 `AGENTS.md`）
- `POST /index`：`zk index`
- `POST /install`：内置 zk（下载 → 解包 → `--version` 验证）
- `GET /selftest`：七项真检查（zk、笔记本、模板、group、结构、长期记忆、索引）

快照（`GET /settings`、`GET /status`、写操作的回包）除了配置与计数，还带两块**诊断**：
`structure`（配置的模式、缺哪些目录、`AGENTS.md` 在不在）与 `memory`（三份 meta 的保留词数 / 原词数 / 目录词数 / 预算 / 截断量）。
两者都是纯读：结构不一致只显示告警 + 底部的「初始化 / 补建」（= `POST /init`），**不自动建、不自动删、不改配置**。
快照里的 `workspace` 与 `notebook.path` 按插件进程工作区解析；agent 工具按各自会话工作区解析 ——
空 / 相对路径下两者可能不是同一个目录，界面要如实标出来，别让人以为 agent 一定用的是这一份。

浏览器半边 `client.ts`：声明式字段清单 `FIELDS`（文本键值行）、状态行、动作按钮、输出面板。
笔记本那一块不是 `FIELDS`（它是「名字 → {路径, 结构}」的表，字段清单表达不了）：
当前笔记本下拉 + 每个笔记本一行（路径可改、结构下拉 `flat`/`layered`、可删，至少留一个）+ 新增一行，改完同样靠「保存」落盘。
结构是**每个笔记本自己的**，就摆在那一行上；`flat → layered` 保存前弹窗明确写「只建目录与模板，不搬已有笔记」。
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
`notebook` 与 `structure` 是派生的（`notebooks[active]`），不落盘。

**Does not own.** 工具的注册与执行；zk 命令的正确性；模板 / group / `AGENTS.md` 的写入与结构检查（`lib/notebook`）。
「字段加在哪」：labels/hints 加在 `client.ts` 的 `FIELDS`，键加在 `config/store.ts` 的 `DEFAULTS` ——
白名单直接取 `DEFAULTS` 的键，不存在第三处。

**Depends on.** `lib/http`、`lib/install`、`lib/notebook`、`lib/zk`、`config/store`、`config/paths`；
app 注入 `route` 与 `isTrusted`（信任栅栏在 app，feature 只消费）。栅栏做三层：
回环判定 → `connection.requestRejection`（不可用即 503，fail-closed）→ 跨站写请求（Origin / Sec-Fetch-Site）一律 403 ——
否则任何一个网页都能 POST `/install` 让插件下载并执行二进制。

**Public surface.** `registerSettings({ route, isTrusted })`；`./client` 由包导出。

**Rejected.** 把信任栅栏放进 feature —— 拒绝：路由门必须是唯一的（app 里一个 `route()` 包住所有 handler，
feature 拿不到"没设防的路由"这个选项）。用已有的 `ctx.configForms` 做表单 —— 拒绝：那套要求插件声明
Config schema（schemastery）并走宿主配置编辑器，而本插件的配置热改、路径在 agent 工具里也要读，
自己一份 JSON 更直接（代价：要自己写字段清单）。

**Exceptions.** `client.ts` 必须单文件零 import（`__ModuleLoader__` 当普通脚本加载，只提供 `require("react")`），
因此它不 import 本包任何模块；两侧靠 API 路径 + 配置键对齐。`dist/.../client.js` 由 `scripts/postbuild.ts`
删掉 tsc 补的 `export {}`，并检查**没有顶层声明**：DSH 把多个插件的 `client.js` 拼进同一个 combo 脚本
（`/plugins/??a/client.js,b/client.js`）当普通脚本跑，顶层 `const loader = window.__ModuleLoader__` 这种写法
会和其他插件撞名，整个 combo 报 `Identifier 'loader' has already been declared`，本插件直接不激活。
所以顶层只写表达式语句（`window.__ModuleLoader__.load({...})`），要局部变量就包 IIFE。
