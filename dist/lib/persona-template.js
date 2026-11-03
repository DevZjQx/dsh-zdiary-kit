/**
 * 根目录 PERSONA.md / POLICY.md 模板：opt-in 写入（`zk-kit init --with-contract`、
 * 设置页「写入角色契约模板」、ensureNotebook(..., { withContract: true })），已存在绝不覆盖。
 *
 * 与 AGENTS.md 模板同一条规矩：首行版本标记独立（`zdiary-persona` / `zdiary-policy`，
 * 不复用 zdiary-template —— AGENTS 改版不该让契约误报旧版）。
 * 版本标记后**紧跟** frontmatter：M3 解析 POLICY / PERSONA 前先 `stripContractMarker()`，
 * 再复用 `lib/frontmatter` —— 不要让「机器可读字段」依赖一个只在本模块才认的自定义语法。
 * 缺文件 = 未启用，不报错；doctor / zk_lint 只给只读提示。
 *
 * 长度是设计约束：两份合计默认预算 240 词（contractBudgetWords，中文 2 字 = 1 词），
 * 契约不参与截断，超了只告警 —— 所以模板只留骨架，占位符 `{{...}}` 由人填，
 * lint 据此报告「未填」。
 */
/** PERSONA.md 模板版本：改模板就 +1（独立于 TEMPLATE_VERSION） */
export const PERSONA_TEMPLATE_VERSION = 3;
/**
 * POLICY.md 模板版本：改模板就 +1。
 * 注意与模板 frontmatter 里的 `version:` 区分：那个是**机器可读 schema 版本**（表头 / 字段语义变了才升），
 * 不随模板版本走 —— 模板 v1→v2 时它一直是 1。M3 解析按 `version` 分支，别把两者混成一条线。
 */
export const POLICY_TEMPLATE_VERSION = 3;
/**
 * 去掉首行契约版本标记，剩下的可以直接交给 `parseFrontmatter()`。
 * M3 的 policy / persona 解析必须走这里，别自己再写一套「跳过第几行」的规则。
 */
export function stripContractMarker(body) {
    return String(body ?? '').replace(/^\uFEFF?\s*<!--\s*zdiary-(?:persona|policy):\s*v\d+\s*-->\s*\r?\n?/, '');
}
export const PERSONA_TEMPLATE = `<!-- zdiary-persona: v${PERSONA_TEMPLATE_VERSION} -->
---
name: {{name}}
role: {{role}}
updated: {{updated}}
---

# 角色契约

> zdiary 生成；人类所有。永远注入、不参与截断。git diff 可审。

## 语气与边界

- 语气：{{tone}}
- 边界：{{boundaries}}

## 禁用表达

- 待填
`;
export const POLICY_TEMPLATE = `<!-- zdiary-policy: v${POLICY_TEMPLATE_VERSION} -->
---
version: 2
updated: {{updated}}
audit: DREAMS.md
---

# 自主权契约

| action | level | approval | reversible |
|---|---|---|---|
| zk.read | auto | none | yes |
| zk.note.write | auto | none | yes |
| zk.notebook.use | auto | none | yes |
`;
