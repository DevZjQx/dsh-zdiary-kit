# readonly（只读视图 / RSS / JSON）

**Purpose.** 给「人」一个窗口：不经过 agent、不用另装 zk，浏览器里直接读笔记本。
只读 —— 没有写入、没有初始化、没有安装，所有写操作仍然只走 `zk_*` 工具与 CLI。

**Owns.** 四条 `GET` 路由，全部与 DSH 同端口（不自己 `listen`）：

- `GET /dsh-zdiary-kit/view`：首页（最近更新 / 日记 / 标签）、搜索、标签页、笔记页
  - `?p=note&path=…`：笔记正文 + 反链
  - `?p=memory`：记忆页 —— 契约 / 用户 / 工作约定 / 记忆 / 周审 / 场景六段 + 载荷预览（人周审的入口）
  - `?p=tags` / `?p=tag&tag=…`：标签列表 / 单个标签
  - `?q=…`：搜索（GET 表单，无 JS）
- `GET /dsh-zdiary-kit/feed.xml`：最近 30 篇的 RSS 2.0
- `GET /dsh-zdiary-kit/api/notes?q=&tag=&limit=`：只读列表（`limit` 1–200，默认 50）
- `GET /dsh-zdiary-kit/api/note?path=…`：单篇正文（`path` 必须是笔记本内的相对路径）

查询串路由不是偷懒：宿主的 `webServer.register` 只支持 `exact` / `prefix` 两种匹配，拼不出 `/note/:id`。
设置页「只读视图」按钮直接打开首页。

**与 DSH 信任栅栏的关系。** 设置页路由挂在 app 的 `rejected()` 后面，会经过
`connection.requestRejection()`；它除了 Host/Origin，还会要求 DSH 的浏览器会话 cookie
（没有 cookie → 401）。只读视图**故意绕开这层**：`curl`、RSS 阅读器、未登录的新标签页都拿不到 cookie，
而它们的需求正是「打开就能读」。代价是这一面没有 DSH 的身份认证，安全边界完全由下面第 4 条地址门承担 ——
所以这 4 条路由必须是只读的，将来也**不要**在这里加写接口或返回敏感配置的路由（那类必须走 app 的 `route()`）。
这条绕行在 app 里叫 `routePublic()`，和 `route()` 就差一个 gate。

**只读的四道门**（都在 `features/readonly/feature.ts` 的 `guard` / 各 handler 里）：

1. **方法门**：只放行 `GET` / `HEAD`，其余 `405` + `Allow: GET, HEAD`。默认拒绝，
   不是「没写 POST handler 就算只读」。
2. **副作用门**：只调 `hasNotebook` / `allNotes` / `searchNotes` / `readNote` / `graphEdges`；
   **不调** `ensureNotebook` / `init` / `index` / `install`。没初始化就显示提示，不顺手建库。
3. **面门**：不复用设置页的 `snapshot`，不返回 `zkPath`、配置文件路径、`absPath`；
   `.zk/` 与根目录 meta（`AGENTS.md` / `MEMORY.md` 等）按路径直接打不开。
   记忆页是唯一的例外，但它是**固定白名单**：文件名来自常量（`PERSONA.md` /
   `AGENTS.md` / `USER.md` / `MEMORY.md` / `DREAMS.md`），不接受 `path` 参数，只读这几份。
4. **地址门**：只认回环 —— `Host` 必须是 127.0.0.1 / localhost / [::1]，对端地址也必须是回环
   （`lib/http` 的 `isLoopback`：设置页判 Host + DSH 的 cookie，只读视图两边都判、不看 cookie）。
   DSH 绑到局域网地址时，只读视图既不会跟着上网，在本机也打不开（那种绑定下 Host 与对端都不是回环）；
   要用它，让 DSH 监听回环地址（默认就是）。

响应统一带 `CSP`（`default-src 'none'`、`frame-ancestors 'none'`、`form-action 'self'`）、
`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`，且不发 CORS 头。
笔记正文一律转义，不解析原始 HTML；markdown 只认标题 / 段落 / 列表 / 引用 / 分隔线 / 围栏代码，
链接只放行 http(s) / mailto / 站内相对路径 —— `javascript:` / `data:` 只当纯文字。
独占一行的 `<!-- … -->` 注释整行跳过（不显示、也不切开段落）：`AGENTS.md` 首行是
`<!-- zdiary-template: vN -->` 版本标记，转义成正文等于把内部约定摆在页面最上面。

**读语义。**

- 首页 / 标签页一次载入最多 2000 篇索引；到顶会在页脚写明，不装作全量。
- 搜索走 `searchNotes`：zk 的 FTS 不切中文，0 命中时自动退回正则子串（和 `zk_search` 同一套兜底）。
  `q` 与 `tag` 同时给就是两个条件一起收（AND），不会静默丢掉其中一个。
- 笔记页：正文 + 入链（`zk graph`，读不出来就不显示）；`[[目标]]` 按路径 → 去扩展名路径 → 标题 → 文件名解析。
- 记忆页（`?p=memory`）：分**契约 / 用户 / 工作约定 / 记忆 / 周审 / 场景**六段 + 载荷预览，
  顶部一行 `记忆 N/预算 词（AGENTS … · MEMORY …（退役 N））`，复用 `buildMemoryPayload` /
  `formatFileShares`；文件按常量直接读盘（**不走 `loadNote`** —— 它自己就拒绝 meta），
  缺失的显示「还没写」而不是 404；正文与笔记页同一套转义 + 双链白名单，
  `[[…]]` 只在该笔记存在时变成链接，其余保持不可点的 `<span class="wikilink">`。
  契约文件的版本标记与 frontmatter 不显示成正文，改成一行字段（name / role / updated / audit）；
  记忆段的退役条目整条加删除线 + `retired` 徽标（磁盘保留、注入省略），不再看起来像活条目；
  场景段显示投影原文、事件条数、规则版本与最近 5 条事件（不含敏感值，也不回全量日志）；
  （`&lt;system-reminder&gt;` 整段转义、折叠、只读），与 `zk_context` 同源，含
  `契约正文 / 记忆 / 记忆载荷（含开销）/ 场景 = 合计/合并预算` 的词数拆解（契约正文含 `PERSONA.md` 标题），
  超合并预算时多一行只读告警。
  载荷预览**分两段**：记忆段（`buildMemoryPayload.text`）与场景段（`buildScene(cfg).text`），
  因为它们在系统提示里也是两个独立 section。
- 正文超过 200 000 字符截断并提示；磁盘文件超过 2 MiB 直接拒绝（`readNote` 会整篇读进内存）。
- 视图没有会话上下文，只能看**插件进程工作区**解析出的笔记本（和设置页一致，不跟某个会话走）。
- 状态码：笔记不存在 → 404，路径不合法 / meta / 扩展名 / 超大 → 400；
  `feed.xml` 与 `api/*` 在没初始化、zk 跑不起来时回 503（页面回带提示的 200，让人看得懂）。
  不给 200 的空频道：阅读器会把空 feed 当成功缓存，用户只会以为「没有新笔记」。

**Known limits.**

- `zk` 首次查询可能自己建 `.zk/index`（这是 zk 的缓存写盘）—— HTTP 层只读，不代表 zk 进程零写盘。
- 不支持分页、图片、表格、嵌套列表；这是「Web 1.0 只读浏览」不是 markdown 预览器。
- 只认 `.md` / `.markdown` —— 和 zk 的索引口径一致。zk 默认不索引 `.org` / `.txt`，
  放进来只会得到「能直连、搜不到、还被 markdown 渲染坏」的页面；这两种格式 agent 仍可用 `zk_read` 读。
- 路径判定是词法的（`absPathOf` 只比字符串前缀）：笔记本里一个指向外部的符号链接会被当成笔记本内的文件读。
  威胁模型是「本机进程 + 回环浏览器」，这不是沙箱边界，别拿它当隔离。
- 没有登录 / token：回环之外一律拒绝。也正因如此，DSH 必须监听回环地址 —— 绑到局域网 IP 时这个视图不可用。
  要在局域网读，是另一个决定（显式开关 + token），不在一期。
