# readonly（只读视图 / RSS / JSON）

**Purpose.** 给「人」一个窗口：不经过 agent、不用另装 zk，浏览器里直接读笔记本。
只读 —— 没有写入、没有初始化、没有安装，所有写操作仍然只走 `zk_*` 工具与 CLI。

**Owns.** 四条 `GET` 路由，全部与 DSH 同端口（不自己 `listen`）：

- `GET /dsh-zdiary-kit/view`：首页（最近更新 / 日记 / 已归档 / 标签）、搜索、标签页、笔记页
  - `?p=note&path=…`：笔记正文 + 出链 + 反链（按篇反查 `--link-to` / `--linked-by`，不建全图；超过 200 条只列前 100 条并注明）
  - `?p=memory`：记忆页 —— 人格 / 用户 / 工作约定 / 记忆 / 周审五段 + 载荷预览（人周审的入口）
  - `?p=tags` / `?p=tag&tag=…`：标签列表 / 单个标签，都吃 `type=` / `status=` 过滤（纯 GET 查询串，无 JS）
  - `?q=…`：搜索（GET 表单，无 JS）
- `GET /dsh-zdiary-kit/feed.xml`：最近 30 篇的 RSS 2.0（与首页「最近更新」同一份口径，不含归档）
- `GET /dsh-zdiary-kit/api/notes?q=&tag=&type=&status=&limit=`：只读列表（`limit` 1–200，默认 50；`type` / `status` 与页面同一份过滤口径：带了这两个条件就连归档一起查，不带则不含归档）
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
2. **副作用门**：只调 `hasNotebook` / `scanNotes` / `searchNotes` / `readNote` / `backlinksOf` / `outlinksOf`；
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

- 首页 / 标签页一次扫描最多 10000 篇（`MAX_SCAN`）；触顶时篇数 / 标签数带 `≥`、页脚写明「只扫描了前 N 篇」，不再用 2000 篇截断计数。
  扫描连归档一起（`includeArchived`）：被 `zk_supersede` 搬进 `archive/` 的旧结论也是库的一部分，
  排除口径吞掉它们，「已归档（superseded）」一节就永远空着 —— 与 agent 的 `include_archived` 同一份口径：
  `zk_*` 查得回，人看的页面也看得见。「最近更新」「日记」与标签计数各自滤回 active，归档只在自己的小节里出现；
  「已归档（superseded）」一节只列最近 50 篇（按修改时间，`ARCHIVE_PREVIEW`），其余给一句总数 —— 与旁边两节一样有界。
- `feed.xml` 取「最近 30 篇」时滤掉归档：RSS 是「最近更新」的订阅面，
  被 supersede 的旧结论刚被改写、mtime 反而最新，混进去会把真正的更新挤下去。
- `api/notes` 的 `type=` / `status=` 跟着归档一起查（`includeArchived: Boolean(type || status)`）：
  不带上它，`?status=superseded` 与归档里的 `?type=source` 恒为空 —— 静默空结果最难查；
  不带过滤条件的默认列表口径不变（不含归档）。
- 列表与详情露出 zk 索引里的 `type` / `status`：每行标题后跟 `type` 小字（原始 zk 值：`source` / `concept` / `daily`…；
  不翻译、不猜，老笔记没有就写「笔记」），
  非 active 的 `status` 上徽标（`superseded` / `retired` 各一个 class）。满屏 active 徽标等于没有徽标，active 不上。
- 标签页 / 标签页可按 `type=` / `status=` 收窄（`?p=tags&status=superseded`、`?p=tag&tag=…&type=concept`）：
  纯 GET 查询串、无 JS，与现有 Web 1.0 口径一致；未知值不猜，原样传给 zk 的 JS 层过滤，匹配不到就是空结果。
- 搜索走 `searchNotes`：zk 的 FTS 不切中文，0 命中时自动退回正则子串（和 `zk_search` 同一套兜底）。
  `q` 与 `tag` 同时给就是两个条件一起收（AND），不会静默丢掉其中一个。
- 笔记页：正文 + 出链 + 入链（`--link-to` / `--linked-by` 按篇反查，不建全图；读不出来就不显示）；出链原来只存在于 agent 的 `zk_walk` 里，
  人看的这一面一直只有反链。出链与反链都 `includeArchived`：指向被 supersede 旧结论的边，
  正是「为什么换了结论」的线索，不因目标在归档目录就消失。归档页指出被谁取代（`superseded-by`）与为什么（`supersede-reason`）。
  `[[目标]]` 按路径 → 去扩展名路径 → 标题 → 文件名解析。
  日记页在有 timeline 问题（空块 / 倒序 / 格式 / 位置）时，在标题下插一条 `.notice`：
  一行 `时间轴：12 处（空块 5 · 倒序 2 · 格式 1 · 位置 4）` + 可折叠的逐行明细；正文仍按原 markdown 渲染，
  空块保持空 `<h3>`，不排序、不隐藏。普通笔记与没有问题的日记页逐字不变；不受 `zk_lint` 的 90 天窗口限制。
- 记忆页（`?p=memory`）：分**人格 / 用户 / 工作约定 / 记忆 / 周审**五段 + 载荷预览，
  顶部一行 `记忆 N/预算 词（AGENTS … · MEMORY …（退役 N））`，下面可能还有一行格式债
  `格式：9/9 条没日期 · 0 条没来源 · AGENTS 模板 vN（当前 vM）` 与一行位置债
  `位置（工作约定核对）：1 条新条目没写顶部（最新在第 3 条） · 8 条并列最旧（2026-11-01，按位置决胜）`
  （只读标记、不跑 lint；各自都干净时不出现）；
  用量行复用 `buildMemoryPayload` / `formatFileShares`，格式行取载荷里的 `formatDebt` /
  `templateVersion`、位置行取 `orderDebt`（与注入同一份计算，不重读文件、不跑 lint）—— 与 `zk_lint.memoryLinks` 的
  `undated` / `unlinked` / `outOfOrder` / `oldestTies` 分别同源于 `memoryFormatDebt` / `memoryOrderDebt`，四处不会各报一个数；
  文件按常量直接读盘（**不走 `loadNote`** —— 它自己就拒绝 meta），
  缺失的显示「还没写」而不是 404；正文与笔记页同一套转义 + 双链白名单，
  `[[…]]` 只在该笔记存在时变成链接，其余保持不可点的 `<span class="wikilink">`。
  人格文件的版本标记与 frontmatter 不显示成正文，改成一行字段（name / role / updated / audit）；
  记忆段的退役条目整条加删除线 + `retired` 徽标（磁盘保留、注入省略），不再看起来像活条目；
  载荷预览（`<system-reminder>` 整段转义、折叠、只读）与 `zk_context` 同源，含
  `人格正文 / 记忆 / 记忆载荷（含开销）` 的词数拆解（人格正文含 `PERSONA.md` 标题）。
- 正文超过 200 000 字符截断并提示；磁盘文件超过 2 MiB 直接拒绝（`readNote` 会整篇读进内存）。
- 视图没有会话上下文，只能看**插件进程工作区**解析出的笔记本（和设置页一致，不跟某个会话走）。
- 状态码：笔记不存在 → 404，路径不合法 / meta / 扩展名 / 超大 → 400；
  `feed.xml` 与 `api/*` 在没初始化、zk 跑不起来时回 503（页面回带提示的 200，让人看得懂）。
  不给 200 的空频道：阅读器会把空 feed 当成功缓存，用户只会以为「没有新笔记」。

**Known limits.**

- `zk` 首次查询可能自己建 `.zk/index`（这是 zk 的缓存写盘）—— HTTP 层只读，不代表 zk 进程零写盘。
- 不支持分页、图片、表格、嵌套列表；这是「Web 1.0 只读浏览」不是 markdown 预览器。
- 只认 `.md` / `.markdown` —— 和 zk 的索引口径一致。zk 默认不索引 `.org` / `.txt`，
  放进来只会得到「能直连、搜不到、还被 markdown 渲染坏」的页面；这两种格式 agent 仍可用原生 `read` 读。
- 路径判定是词法的（`absPathOf` 只比字符串前缀）：笔记本里一个指向外部的符号链接会被当成笔记本内的文件读。
  威胁模型是「本机进程 + 回环浏览器」，这不是沙箱边界，别拿它当隔离。
- 没有登录 / token：回环之外一律拒绝。也正因如此，DSH 必须监听回环地址 —— 绑到局域网 IP 时这个视图不可用。
  要在局域网读，是另一个决定（显式开关 + token），不在一期。
