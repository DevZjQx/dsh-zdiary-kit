# settings（设置页 + 宿主 API）

**Purpose.** 让主人看得见、管得住：zk 在哪、笔记本在哪、有多少笔记、怎么重建、怎么装。

**Owns.** 六条路由（全部 `/dsh-zdiary-kit/api/*`）：
- `GET/POST /settings`：读写配置（白名单 + 归一化在 `config/store`），返回快照与告警
- `GET /status`：zk 位置/版本/来源、笔记本是否存在、笔记/标签/断链/孤立计数
- `POST /init`：`ensureNotebook`（幂等）
- `POST /index`：`zk index`
- `POST /install`：内置 zk（下载 → 解包 → `--version` 验证）
- `GET /selftest`：五项真检查（zk、笔记本、模板、group、索引）

浏览器半边 `client.ts`：声明式字段清单 `FIELDS`、状态行、动作按钮、输出面板。

**Does not own.** 工具的注册与执行；zk 命令的正确性；模板与 group 的写入（`lib/notebook`）。
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
删掉 tsc 补的 `export {}`。
