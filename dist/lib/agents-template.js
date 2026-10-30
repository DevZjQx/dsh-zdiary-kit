/**
 * 根目录 AGENTS.md 模板：layered 初始化时写进 vault，已存在就不碰。
 *
 * 为什么单独一个文件：它是「给人读的文档」，不是逻辑；放在这里也方便直接对照
 * docs/features/memory.md 的三条口径（检索词归宿 / 中文必打 tags / 宿主不会自动加载）。
 *
 * 长度是设计约束：AGENTS.md 属于注入预算（默认 500 词，中文 2 字 = 1 词）且**永不截断**，
 * 模板自己吃掉过半预算，USER / MEMORY 就没位置了 —— 所以这里只留规则，不写教程。
 * 目标 ~150 词（195 → 160）：多 10 词，MEMORY 就少 10 词的正文，而规则本来可以写得更紧。
 */
export const AGENTS_TEMPLATE = `# 知识库工作约定

> zdiary 生成；DSH 不会自动加载，由插件每轮注入。

## 目录

raw/ 只读材料 · inbox/ 待归类 · notes/sources/ 来源
notes/{concepts,entities,patterns}/ 原子笔记 · archive/ 废弃（不删）

## 检索词

值得检索 → tags 或正文；不值得 → 不写。
中文必打 tags：全文索引不切中文，只查正文会静默查空，进而建重复笔记。

## 写之前

1. zk_query / zk_search 查重（中文查 tags）。
2. 一条笔记一件事，标题即结论，用英文短 slug（中文标题会生成拼音文件名）；来源进 sources/，结论进 concepts/，zk_link 相连。
3. 结论过时用 zk_supersede（默认预演，带 reason）：不删文件、不改旧结论。
4. 改已有笔记前读 WORKFLOW.md：先列清单等确认，再按三分类动手。

## 每周

把「上次做梦：YYYY-MM-DD」写进 DREAMS.md；到期或缺这行时：
zk_lint → zk_dream → 写 DREAMS.md → 人裁决后改 MEMORY.md。
MEMORY.md 每条结论附 [[来源路径]]，zk_lint 核对。
`;
/**
 * 根目录 WORKFLOW.md：只在「要动已有笔记」时才需要读，所以不注入、不计预算。
 * 放进注入的话，AGENTS.md 一膨胀就会挤掉 MEMORY —— 这些规则低频但重要，适合按需读。
 */
export const WORKFLOW_TEMPLATE = `# 改笔记的工作流（按需读）

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
