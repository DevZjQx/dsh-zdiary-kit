/**
 * POLICY.md 解析（M3a，只读）：把「自主权契约」从一张四列表读成动作行 + 结构问题。
 *
 * 边界（与 docs/plan-persona-autonomy.md §D6 一致）：
 *   · 只读，不写文件；缺文件返回 null（未启用）—— lint 的 contract 桶已经报 missing，
 *     这里不再重复报，否则同一个缺口会有两条告警，人很快就会都忽略。
 *   · 解析失败不猜：坏行进 issues，合法行照常返回；调用方决定怎么展示。
 *   · 不执行权限：插件只管自己的 zk_*；bili_* 等外部动作由各自的工具读同一份契约执行，
 *     「本插件不假装能管住别的插件」。
 *
 * 形状（契约模板 v4）：首行版本标记 + frontmatter（updated / audit）+ 一张表：
 *   | action | level | approval | reversible |
 *   | zk.read | auto | none | yes |
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { stripContractMarker } from './persona-template.js';
export const POLICY_LEVELS = ['auto', 'ask', 'forbidden'];
export const POLICY_APPROVALS = ['none', 'human', 'policy'];
export const POLICY_COLUMNS = ['action', 'level', 'approval', 'reversible'];
/** 结构问题种类（运行时也要用：工具输出 schema 的 enum 从这里取，别在 feature.ts 里再抄一份） */
export const POLICY_ISSUE_KINDS = [
    'table',
    'row',
    'empty-action',
    'unknown-level',
    'unknown-approval',
    'bad-reversible',
    'duplicate-action',
    'no-audit',
];
function cellsOf(line) {
    return line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((cell) => cell.trim());
}
function isSeparator(line) {
    const cells = cellsOf(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}
/**
 * 解析 POLICY.md 原文。导出成纯函数是为了单测能直接喂坏表，不用建临时库。
 * 行号不返回：坏行把原文片段带进 detail，人在编辑器里搜得到，比一个会漂的坐标可靠。
 */
export function parsePolicyText(content) {
    const text = String(content ?? '');
    const { fields, body } = parseFrontmatter(stripContractMarker(text));
    const issues = [];
    const rows = [];
    const seen = new Set();
    const audit = (fields.audit ?? '').trim();
    if (!audit)
        issues.push({ kind: 'no-audit', detail: 'frontmatter 里没有 audit（审计落点）' });
    const lines = body.split('\n');
    // 表头只认前四列；多出来的列会让下面的行报「列数不对」，不会静默忽略一个 trigger 列
    const headAt = lines.findIndex((line) => {
        if (!line.trim().startsWith('|'))
            return false;
        const cells = cellsOf(line).slice(0, POLICY_COLUMNS.length).map((cell) => cell.toLowerCase());
        return cells.length === POLICY_COLUMNS.length && POLICY_COLUMNS.every((column, i) => cells[i] === column);
    });
    if (headAt < 0) {
        issues.push({ kind: 'table', detail: `没有找到 | ${POLICY_COLUMNS.join(' | ')} | 表头` });
        return { updated: fields.updated ?? '', audit, rows, issues };
    }
    const header = cellsOf(lines[headAt] ?? '');
    if (header.length !== POLICY_COLUMNS.length) {
        issues.push({
            kind: 'table',
            detail: `表头有 ${header.length} 列，应为 ${POLICY_COLUMNS.length}：${POLICY_COLUMNS.join(' | ')}`,
        });
    }
    // 分隔行缺失时 headAt+1 就是第一条数据行：跳过它会静默丢一条动作
    const hasSeparator = isSeparator(lines[headAt + 1] ?? '');
    if (!hasSeparator) {
        issues.push({ kind: 'table', detail: '表头下缺分隔行（| --- | --- | --- | --- |）' });
    }
    const start = hasSeparator ? headAt + 2 : headAt + 1;
    for (let i = start; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!line.trim().startsWith('|'))
            break;
        if (isSeparator(line))
            continue;
        const cells = cellsOf(line);
        if (cells.length !== POLICY_COLUMNS.length) {
            issues.push({
                kind: 'row',
                detail: `列数是 ${cells.length}，应为 ${POLICY_COLUMNS.length}：${line.trim()}`,
            });
            continue;
        }
        const [action, rawLevel = '', rawApproval = '', rawReversible = ''] = cells;
        if (!action) {
            issues.push({ kind: 'empty-action', detail: `action 为空：${line.trim()}` });
            continue;
        }
        const level = rawLevel.toLowerCase();
        if (!POLICY_LEVELS.includes(level)) {
            issues.push({ kind: 'unknown-level', detail: `${action} 的 level 是「${rawLevel}」，只认 auto / ask / forbidden` });
            continue;
        }
        const approval = rawApproval.toLowerCase();
        if (!POLICY_APPROVALS.includes(approval)) {
            issues.push({ kind: 'unknown-approval', detail: `${action} 的 approval 是「${rawApproval}」，只认 none / human / policy` });
            continue;
        }
        const reversible = rawReversible.toLowerCase();
        if (reversible !== 'yes' && reversible !== 'no') {
            issues.push({ kind: 'bad-reversible', detail: `${action} 的 reversible 是「${rawReversible}」，只认 yes / no` });
            continue;
        }
        // level / approval 都按小写归一，动作名也照此办理：ZK.READ 与 zk.read 是同一个动作
        const key = action.toLowerCase();
        if (seen.has(key)) {
            issues.push({ kind: 'duplicate-action', detail: `${action} 重复出现，只保留第一行` });
            continue;
        }
        seen.add(key);
        rows.push({
            action,
            level: level,
            approval: approval,
            reversible: reversible === 'yes',
        });
    }
    // 表头在了、行却全是坏行：上面已经逐行报过，不再叠一条「表里没有合法动作行」的废话
    if (rows.length === 0 && issues.every((issue) => issue.kind !== 'table')) {
        issues.push({ kind: 'table', detail: '表里没有合法的动作行' });
    }
    return { updated: fields.updated ?? '', audit, rows, issues };
}
/** 读 <notebook>/POLICY.md；缺文件 / 空文件 = null（未启用） */
export function parsePolicy(cfg) {
    let text = '';
    try {
        text = fs.readFileSync(path.join(cfg.notebook, 'POLICY.md'), 'utf8');
    }
    catch {
        return null;
    }
    if (!text.trim())
        return null;
    return parsePolicyText(text);
}
/** lint 的只读投影：缺文件不在这里报（contract 桶负责），这里只报「已启用但表坏了」 */
export function policyStatus(cfg) {
    const doc = parsePolicy(cfg);
    if (!doc)
        return { present: false, rows: 0, total: 0, items: [] };
    return { present: true, rows: doc.rows.length, total: doc.issues.length, items: doc.issues };
}
