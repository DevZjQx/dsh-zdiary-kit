/**
 * 根目录 AGENTS.md 模板：初始化时写进 vault，已存在就不碰。
 *
 * 两份模板：layered 用 AGENTS_TEMPLATE（目录 / group / WORKFLOW 那些路径都存在），
 * flat 用 AGENTS_TEMPLATE_FLAT（只有 notes/ + 日记，不出现 raw / inbox / archive / WORKFLOW）。
 * flat 默认不写（0.1.0 的 vault 升级过来必须一个文件都不多），要的人显式 `zk-kit init --with-agents`
 * 或在设置页点「写入 AGENTS.md 模板」—— 否则默认安装既没有约定、也没有周节奏提醒。
 *
 * 为什么单独一个文件：它是「给人读的文档」，不是逻辑；放在这里也方便直接对照
 * docs/features/memory.md 的三条口径（检索词归宿 / 中文必打 tags / 宿主不会自动加载）。
 * 注意别让运行期消息只指向 docs/：插件发布后文档在 profile 的 node_modules 里，agent 够不着；
 * lint 的旧版提示直接带模板全文（见 lib/lint.ts 的 LintTemplateBucket.currentText）。
 *
 * 长度是设计约束：AGENTS.md 属于注入预算（默认 500 词，中文 2 字 = 1 词）且**永不截断**，
 * 模板自己吃掉过半预算，USER / MEMORY 就没位置了 —— 所以这里只留规则，不写教程。
 * 目标 ≤190 词（AGENTS_TEMPLATE 实测 186、AGENTS_TEMPLATE_FLAT 实测 88），单测里锁住。
 * 首行 `<!-- zdiary-template: vN -->` 是版本标记：lint 据此报告「老库的 AGENTS.md 是旧版」，
 * 只报告不覆盖（模板允许用户改）。
 */
/** 模板版本：改模板就 +1；lint 用它判断老库是否还在用旧契约（v2：去掉 inbox/） */
export const TEMPLATE_VERSION = 2;
/** 首行版本标记（实测 4 词）；不许带日期 —— 带日期的写法实测 6 词，白花 2 词 */
export const TEMPLATE_MARK = `<!-- zdiary-template: v${TEMPLATE_VERSION} -->`;
export const AGENTS_TEMPLATE = `${TEMPLATE_MARK}

# 知识库工作约定

> zdiary 生成；DSH 不会自动加载，插件每轮注入。

## 目录

raw/ 只读材料 · notes/sources/ 来源
notes/{concepts,entities,patterns}/ 原子笔记 · archive/ 废弃（不删）

## 检索词

值得检索 → tags 或正文；不值得 → 不写。
中文必打 tags：全文索引不切中文，只查正文会静默查空、建重复笔记。

## 写之前

1. zk_query / zk_search 查重（中文查 tags）。
2. 一条笔记一件事，标题即结论；文件名用 zk_new 的 name（8–14 字）；来源给 type=source、结论给 type=concept（目录跟 type 走，别落 notes/ 根），zk_link 相连。
3. 结论过时用 zk_supersede（默认预演，带 reason）：不删文件、不改旧结论。
4. 改已有笔记前读 WORKFLOW.md：先列清单等确认，再按三分类动手。

## 每周

每周：DREAMS.md 写「上次做梦：YYYY-MM-DD」；到期 zk_lint → zk_dream → 人裁决改 MEMORY。
MEMORY.md 每条：结论（YYYY-MM-DD）[[来源路径]]；退役写 - [superseded YYYY-MM-DD] 旧结论 → [[新结论]]，行不删。
新条目写顶部；超预算从底部往前丢。
`;
/**
 * flat 结构用的模板：不出现 raw / inbox / archive / WORKFLOW.md 这些 flat 没有的路径。
 * 目标 ≤90 词 —— 它和服务端那份共用同一笔预算，而 flat 用户往往只是想要「有一个约定」。
 */
export const AGENTS_TEMPLATE_FLAT = `${TEMPLATE_MARK}

# 知识库工作约定

> zdiary 生成；DSH 不会自动加载，插件每轮注入。

## 写之前

1. zk_search 查重；中文必打 tags（FTS 不切中文）。
2. 一笔记一件事，标题即结论；文件名 8–14 字。
3. 结论过时用 zk_supersede（默认预演，带 reason）。

## 每周

DREAMS.md 写「上次做梦：YYYY-MM-DD」；到期 zk_lint → zk_dream → 人裁决改 MEMORY。
MEMORY.md 每条：结论（YYYY-MM-DD）[[来源路径]]；退役写 - [superseded] 旧结论 → [[新结论]]。
`;
/**
 * 根目录 WORKFLOW.md：只在「要动已有笔记」时才需要读，所以不注入、不计预算。
 * 放进注入的话，AGENTS.md 一膨胀就会挤掉 MEMORY —— 这些规则低频但重要，适合按需读。
 */
export const WORKFLOW_TEMPLATE = `${TEMPLATE_MARK}

# 改笔记的工作流（按需读）

> 由 dsh-zdiary-kit 生成。AGENTS.md 只放每轮都要用的规则；这一页在要动已有笔记时才读。
> 它不进检索，也不要往里追加内容（整篇重写，git diff 可审）。

## 新信息与旧笔记冲突时，先分类

1. **temporal update** —— 事实随时间变了：改写现行结论，旧值连同日期搬进 Changelog 小节。
2. **context variant** —— 不同情境答案不同：原结论保留，加一节「针对 X：」写条件分支。
3. **contradiction** —— 同期、同情境互相冲突：一个字都不改，把两篇路径与冲突点写进 DREAMS.md，等人裁决。

判断不了就按 3 处理：flag 的成本远低于悄悄改写。

## 动笔前必须出清单

1. 用 zk_search / zk_query 找出可能受影响的笔记；
2. 列出「改哪几篇、每篇按哪一类改」；
3. 等用户确认，再逐篇改。

没有确认范围就动手 = 全库漂移。这条没有例外。

## 什么时候该新建

- 概念 / 实体以后还会遇到 → notes/concepts/ 或 notes/entities/；
- 一次性来源 → 只建 source 笔记；
- 旧结论过时 → zk_supersede（默认预演），不删文件。

## 链接

zk_link 只连真实的概念关联，不连「词面像」。同一篇首次提及时链一次即可。

## 别做的事

- 不写 raw/：它是只读原始材料，写了也搜不到，工具会直接拒绝。
- 不跑无范围的「更新一下 wiki」。
- 不手工改 status、不手工搬文件 —— 走 zk_supersede。
- 不手工 mv / 改文件名 —— 走 zk_rename（默认预演，会重写 [[入链]] 与 MEMORY.md 里的来源）。
`;
