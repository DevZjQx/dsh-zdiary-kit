/**
 * 根目录 PERSONA.md 模板：opt-in 写入（`zk-kit init --with-persona`、
 * 设置页「写入角色人格模板」、ensureNotebook(..., { withPersona: true })），已存在绝不覆盖。
 *
 * 与 AGENTS.md 模板同一条规矩：首行版本标记独立（`zdiary-persona`，
 * 不复用 zdiary-template —— AGENTS 改版不该让人格文件误报旧版）。
 * 版本标记后**紧跟** frontmatter：解析 PERSONA 前先 `stripPersonaMarker()`，
 * 再复用 `lib/frontmatter` —— 不要让「机器可读字段」依赖一个只在本模块才认的自定义语法。
 * 缺文件 = 未启用，不报错；doctor / zk_lint 只给只读提示。
 *
 * 长度是设计约束：默认上限 240 词（personaBudgetWords，中文 2 字 = 1 词），
 * 人格不参与截断，超了只告警 —— 所以模板只留骨架，占位符 `{{...}}` 由人填，
 * lint 据此报告「未填」。
 */
/** PERSONA.md 模板版本：改模板就 +1（独立于 TEMPLATE_VERSION） */
export const PERSONA_TEMPLATE_VERSION = 4;
/**
 * 只列当前版本的哨兵，用来发现「只改了首行数字」：
 * - PERSONA v3 删掉了「## 口头禅」；v4 统一标题为「# 角色人格」。
 * 升版本时同步补；命中也只报告，不覆盖（人格允许人改）。
 */
export const PERSONA_TEMPLATE_SENTINELS = {
    'PERSONA.md': { 4: { required: ['# 角色人格'], forbidden: ['## 口头禅'] } },
};
/**
 * 去掉首行人格版本标记，剩下的可以直接交给 `parseFrontmatter()`。
 * PERSONA 解析必须走这里，别自己再写一套「跳过第几行」的规则。
 */
export function stripPersonaMarker(body) {
    return String(body ?? '').replace(/^\uFEFF?\s*<!--\s*zdiary-persona:\s*v\d+\s*-->\s*\r?\n?/, '');
}
export const PERSONA_TEMPLATE = `<!-- zdiary-persona: v${PERSONA_TEMPLATE_VERSION} -->
---
name: {{name}}
role: {{role}}
updated: {{updated}}
---

# 角色人格

> zdiary 生成；人类所有。永远注入、不参与截断。git diff 可审。

## 语气与边界

- 语气：{{tone}}
- 边界：{{boundaries}}

## 禁用表达

- 待填
`;
