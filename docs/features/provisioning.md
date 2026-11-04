# provisioning（内置 zk 与笔记本自举）

**Purpose.** 「装个插件就有 zk」：二进制自动获取、笔记本自动建好、日记模板与 group 自动补齐 —— 全部幂等。

**Owns.**
- `lib/platform.ts`：`process.platform/arch` → 官方 release 资源名（`zk-v0.15.7-linux-amd64.tar.gz` 等）
- `lib/install.ts`：下载（`ZK_DOWNLOAD_BASE` 可换镜像）→ 系统 `tar` 解包 → `chmod 755` → `zk --version` 验证；
  结果里带 `url` 与 `mirror`，由 `sourceLabel()` 说清这次从哪下的（上游 release 没有 checksums.txt，不做假校验）
- `lib/notebook.ts`：`ensureNotebook` = 建目录 → `zk init`（缺 `.zk/config.toml` 时）→ 写模板 → 追加 group

两种结构（每个笔记本自己的 `Config.structure`，落在 `notebooks` 条目里），默认 `flat`：

| | 目录 | 模板 | group | 根目录文档 |
|---|---|---|---|---|
| `flat`（默认，与 0.1.0 逐字节一致） | `notes/` `journal/` | `daily.md` | 1 个（daily） | 无（可选 `--with-agents` 写精简版 `AGENTS.md`；可选 `--with-contract` 写契约） |
| `layered` | 加 `raw/` `notes/{sources,concepts,entities,patterns}/` `archive/` | `daily.md`（多三节）`source.md` `entry.md` | 5 个（daily/source/concept/entity/pattern） | `AGENTS.md` + `WORKFLOW.md`（契约同样只在 `--with-contract` 时写） |

切到 `layered` **只建目录与模板，不搬已有笔记**；已存在的模板、`AGENTS.md` 与 `WORKFLOW.md` 不覆盖（用户可能改过），只在缺失时写。
`inbox/` 从 0.8.2 起不再创建（P2-8）：它在 layered 下不属于任何 group（写不进），flat 下能写进去却会被排除出索引（写进去就消失）。
盘上已有的 `inbox/` 不删，继续当隔离区；写入口统一拒绝（`assertWritablePath`）。`structureDirs` 也不再列出它，
所以老库的 `inbox/` 不会让 `ready` 变 false。
`WORKFLOW.md` 是「改已有笔记」才读的细则（先列受影响清单等确认，再按 temporal / context variant / contradiction 三分类动手）：
不注入（省预算），但和 meta 文件同口径排除出检索，`AGENTS.md` 里只留一行指针。
因此从 flat 升级时旧 `daily.md` 会保留（没有 Events / Observations / Loose ends 三节）；想要 layered 日记模板，
先备份并删掉 `<notebook>/.zk/templates/daily.md`，再重跑 `zk-kit init` 或点「初始化 / 补建」。
`AGENTS.md` 在 `layered` 下自动写；`flat` 默认**不写**（从 0.1.0 升级来的 vault 不能因为升级多出一个文件，M0 的逐字节回归）。
想要约定与周提醒就显式 opt-in：`zk-kit init --with-agents`、设置页「写入 AGENTS.md 模板」、
或代码里 `ensureNotebook(cfg, signal, { withAgents: true })`；已存在的文件一律不覆盖。
`flat` 用精简版 `AGENTS_TEMPLATE_FLAT`（实测 80 词，锁 ≤90）：不出现 `raw/` / `inbox/` / `archive/` / `WORKFLOW.md`。
`layered` 用完整版 `AGENTS_TEMPLATE`（实测 180 词，锁 ≤190）—— 它属于注入预算且**永不截断**，
写长了 USER / MEMORY 就没位置。两份模板首行都有 `<!-- zdiary-template: vN -->`（`TEMPLATE_MARK`），
`zk_lint` 据此报告老库的模板是否过期（只报告、不覆盖）。
`entry.md` 由 concept / entity / pattern 共用，`type` 与 `authority` 走 `[group.X.extra]` 注入（Z10）；
所有模板必须含 `{{content}}`，否则 stdin 的正文会被丢（Z9）。

**契约模板（`PERSONA.md`）。** 只走显式 opt-in：`zk-kit init --with-contract`、
设置页「写入契约模板」、或 `ensureNotebook(cfg, signal, { withContract: true })`。
两种结构**都不自动写** —— 升级不多一个文件（D10），缺文件 = 契约未启用、不报错。
写入口只在缺失时生效，已存在的文件一字不改（契约允许人改）。
契约不依赖 zk：`writeContractTemplates` 会先 `mkdir` 笔记本目录，所以设置页按钮在建库前也能点
（只建目录与文件，不碰 `.zk`；之后 `ensureNotebook` 幂等接管同一目录）。
首行是独立版本标记 `<!-- zdiary-persona: vN -->`（`PERSONA_TEMPLATE_VERSION`）：
不复用 `TEMPLATE_VERSION` —— 改 `AGENTS.md` 只升旧的，不该让契约误报旧版。
标记与当前版本不等时只报告：低于当前 = `old`；高于当前 = `newer`（插件才是旧的那个，别改文件去配）；
相等但正文还留着旧版内容 = `mismatch`（只改了首行数字，`CONTRACT_TEMPLATE_SENTINELS` 机械可查）。
`PERSONA.md` 进 `META_NAMES`：不进检索、`zk_append` 等写入一律拒绝。
**迁移说明**：根目录曾有同名普通笔记的库，升级后它们会从检索里消失 —— 需要改名或移入子目录。

### group 收敛（配置改了之后）

`.zk/config.toml` 里的 group 是 zk 套模板 / 文件名的依据，但它是 zk 的文件，插件只追加、不重写：

- `ensureNotebook` 遇到已存在的 group 一律跳过；paths 与配置不一致时只进 `EnsureResult.groupWarnings`；
- 新 group 的 paths 已被别的 group 占着（典型：只改 `dailyGroup` 不改 `dailyDir`）时**不追加** ——
  否则两个 group 用同一条路径，模板命中就只剩 zk 的实现细节了；
  判定只认「同一条路径」：父子目录是合法的（zk 0.15 按最具体的路径归组，
  `notes` 与 `notes/concepts` 共存时子目录里的笔记走后者，真机验证过）。
  没写 `paths` 的 group 按**同名目录**占位（zk 的语义：omitting `paths` is equivalent to
  providing a single path equal to the name of the group），同样算占用；
- `structureStatus` 增加 `groups` / `groupsOk` / `groupWarnings` / `expectedOverlaps` / `actualOverlaps`，
  只读解析 `.zk/config.toml`（`lib/notebook-config.ts`：双 / 单引号 / **裸键**组头（`[group.daily]`）、
  行尾注释、`.note.template`、组头前注释；`pathsState` 区分「写了 / 没写 / 解析不了」，解析不了返回
  `null` 不猜）；`groupsOk` 要求每个期望 group 都在、paths 一致，且没有任何
  两个 group 共用一条路径（期望里冲突算配置问题，文件里已冲突算 `actualOverlaps`）。
- 显式修复走 `zk-kit groups --fix` → `fixGroupConfig(cfg)`：
  - 只碰组头前有 `dsh-zdiary-kit` 注释的 group；
  - 只替换 `paths` 行，或把同路径的旧组头改名（连同 `.note` / `.extra` 子表）；
  - 会让两个 group 用同一条路径时不写：期望本身冲突 → 整轮不改；期望路径被用户 / 旧 group 占着 → 只跳过那一个；
  - 自定义 `template` / `extra` / 注释 / 未知 group 一字不动；写前备份 `.zk/config.toml.bak`，写临时文件后 rename。
- `archiveDir` 的非空变更由 `config/store.writeConfig` 直接拒绝（`ArchiveDirChangeError`）：
  旧归档不会自动迁移，改了会让废弃笔记重新进入检索。空目录 / 不存在的目录允许改。

**Does not own.** 解析用哪个 zk（`lib/zk.ts` 的四级优先：配置 → `$ZK_BIN` → PATH → 内置）。
「安装成功」的判定不在这里的下载逻辑里，而在 `zk --version` 的真实输出里。

**Depends on.** `lib/exec`（`tar` 与 `zk`）、`config/paths`（`BIN_DIR` / `CACHE_DIR`）、`config/store`（版本、目录名）。

**Public surface.** `installZk(version)`（返回 `path` / `version` / `asset` / `url` / `mirror`）、`sourceLabel(mirror)`、`zkAsset(version)`、`ensureNotebook(cfg)`、`DAILY_TEMPLATE` / `DAILY_TEMPLATE_LAYERED`、
`SOURCE_TEMPLATE`、`ENTRY_TEMPLATE`、`AGENTS_TEMPLATE`、`AGENTS_TEMPLATE_FLAT`、`WORKFLOW_TEMPLATE`、
`TEMPLATE_VERSION` / `TEMPLATE_MARK`、`writeAgentsTemplate(cfg)`；
`structureDirs(cfg)` / `structureStatus(cfg)`（只报告，不建不改；`extra` 列出 flat 库里多出来的分层目录，
`groups` / `groupsOk` / `groupWarnings` 报告与 `.zk/config.toml` 的差异）、
`expectedGroups(cfg)`、`fixGroupConfig(cfg)`（`groups --fix` 的实现）。
`ensureNotebook` 返回 `dirsCreated` / `templatesWritten` / `groupsAdded` / `groupWarnings` / `agentsWritten` / `workflowWritten`，
设置页据此显示「本次真正做了什么」（第二次调用五项都是空的；`groupWarnings` 只报告，不改文件）。
`structureStatus` 是设置页「初始化 / 补建」的依据：「配置为准，磁盘只用来显示缺什么」，它自己不建目录。
`extra` 只收 `raw` / `inbox` / `notes/{四类}`；`archive` 不算 —— flat 库做过一次 supersede 就会自建它，
放进来会让每本用过 supersede 的 flat 库都被误报。`ready` 不因 `extra` 变 false（配置仍是权威）。
切换笔记本（`zk-kit notebooks use`、`remove` 的自动切换、设置页保存时换 `active`）会顺手 `ensureNotebook` ——
幂等所以放心调，切过去即就绪；改路径与新增**不**自动建目录（防手滑把库建到打错的路径上）。

**Rejected.** 随包分发二进制 —— 拒绝：三平台 × 两架构 × 10 MB，仓库和 npm 都受不了，且发布新版本要重打包。
用 npm 的 `zk` 包 —— 不存在官方包。写一个 tar.gz 解压器 —— 拒绝：系统 tar（Linux/macOS/Win10+）就够，
少一个自研解析器的攻击面。覆盖用户已有的 `config.toml` —— 拒绝：只在缺 group 时**追加**，
用户自己的模板、过滤、别名一字不动（测试里断言了「第二次调用文件不变」）；
配置改了要显式跑 `zk-kit groups --fix`，不静默重写。

**Exceptions.** `ensureDailyNote` 用"目录快照前后对比"判断今天这篇是不是新建的 ——
zk 的日期模板不给文件名，无法预先算；两次 `readdir` 比解析模板可靠。
