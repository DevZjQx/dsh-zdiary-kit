/**
 * 根目录 AGENTS.md 模板：layered 初始化时写进 vault，已存在就不碰。
 *
 * 为什么单独一个文件：它是「给人读的文档」，不是逻辑；放在这里也方便直接对照
 * docs/features/memory.md 的三条口径（检索词归宿 / 中文必打 tags / 宿主不会自动加载）。
 *
 * 长度是设计约束：AGENTS.md 属于注入预算（默认 300 词，中文 2 字 = 1 词）且**永不截断**，
 * 模板自己吃掉大半预算，USER / MEMORY 就没位置了 —— 所以这里只留规则，不写教程。
 */
export const AGENTS_TEMPLATE = `# 知识库工作约定

> 由 dsh-zdiary-kit 生成。DSH 不会自动加载本文件，是插件每轮把它注入。

## 目录

raw/ 原始材料（只读）· inbox/ 待归类 · notes/sources/ 来源
notes/{concepts,entities,patterns}/ 原子笔记 · archive/ 废弃笔记（不删）

## 检索词的归宿

值得检索 → 写进 tags 或正文；不值得 → 不写（keywords 不被索引）。
中文笔记必须打 tags：全文索引不切中文，只查正文会静默查空，于是你会建重复笔记。

## 写之前

1. 先 zk_query / zk_search 查重（中文查 tags）。
2. 一条笔记一件事，标题就是结论；来源进 sources/，结论进 concepts/ 等，用 zk_link 连起来。
3. 结论过时用 zk_supersede（默认预演）：不删文件、不在旧结论上改写。

## 每周

zk_lint → zk_dream → 写 DREAMS.md（晋升/拒绝/待查）→ 人裁决后改 MEMORY.md。
`
