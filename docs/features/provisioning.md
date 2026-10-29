# provisioning（内置 zk 与笔记本自举）

**Purpose.** 「装个插件就有 zk」：二进制自动获取、笔记本自动建好、日记模板与 group 自动补齐 —— 全部幂等。

**Owns.**
- `lib/platform.ts`：`process.platform/arch` → 官方 release 资源名（`zk-v0.15.7-linux-amd64.tar.gz` 等）
- `lib/install.ts`：下载（`ZK_DOWNLOAD_BASE` 可换镜像）→ 系统 `tar` 解包 → `chmod 755` → `zk --version` 验证
- `lib/notebook.ts`：`ensureNotebook` = 建目录 → `zk init`（缺 `.zk/config.toml` 时）→ 写模板 → 追加 group

两种结构（`Config.structure`），默认 `flat`：

| | 目录 | 模板 | group |
|---|---|---|---|
| `flat`（默认，与 0.1.0 逐字节一致） | `notes/` `journal/` | `daily.md` | 1 个（daily） |
| `layered` | 加 `raw/` `inbox/` `notes/{sources,concepts,entities,patterns}/` `archive/` | `daily.md`（多三节）`source.md` `entry.md` | 5 个（daily/source/concept/entity/pattern） |

切到 `layered` **只建目录与模板，不搬已有笔记**；已存在的模板不覆盖（用户可能改过），只在缺失时写。
`entry.md` 由 concept / entity / pattern 共用，`type` 与 `authority` 走 `[group.X.extra]` 注入（Z10）；
所有模板必须含 `{{content}}`，否则 stdin 的正文会被丢（Z9）。

**Does not own.** 解析用哪个 zk（`lib/zk.ts` 的四级优先：配置 → `$ZK_BIN` → PATH → 内置）。
「安装成功」的判定不在这里的下载逻辑里，而在 `zk --version` 的真实输出里。

**Depends on.** `lib/exec`（`tar` 与 `zk`）、`config/paths`（`BIN_DIR` / `CACHE_DIR`）、`config/store`（版本、目录名）。

**Public surface.** `installZk(version)`、`zkAsset(version)`、`ensureNotebook(cfg)`、`DAILY_TEMPLATE` / `DAILY_TEMPLATE_LAYERED`、
`SOURCE_TEMPLATE`、`ENTRY_TEMPLATE`。`ensureNotebook` 返回 `dirsCreated` / `templatesWritten` / `groupsAdded`，
设置页据此显示「本次真正做了什么」（第二次调用三者都是空数组）。

**Rejected.** 随包分发二进制 —— 拒绝：三平台 × 两架构 × 10 MB，仓库和 npm 都受不了，且发布新版本要重打包。
用 npm 的 `zk` 包 —— 不存在官方包。写一个 tar.gz 解压器 —— 拒绝：系统 tar（Linux/macOS/Win10+）就够，
少一个自研解析器的攻击面。覆盖用户已有的 `config.toml` —— 拒绝：只在缺 group 时**追加**，
用户自己的模板、过滤、别名一字不动（测试里断言了「第二次调用文件不变」）。

**Exceptions.** `ensureDailyNote` 用"目录快照前后对比"判断今天这篇是不是新建的 ——
zk 的日期模板不给文件名，无法预先算；两次 `readdir` 比解析模板可靠。
