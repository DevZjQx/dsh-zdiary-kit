/**
 * 记忆写路径：把一条结论追加进 MEMORY.md / USER.md。
 *
 * 边界（§15.1 / §16.1）：插件只做机械门，语义判断全归调用方 ——
 *   · 不改 entry 一个字、不自动补日期、不自动合并 / 去重、不提议退役哪条；
 *   · 不做 replace / 合并：只往文件末尾追加，现有条目一律不动；
 *   · 超预算返回结构化错误 + dropCandidates，绝不静默截断；
 *   · 写前用 fileStamp 挡并发（与设置页 409 同语义）。
 *
 * `retire` 追加的是 `- [superseded …]` 标记（调用方给全文）；退役条目在注入里被 strip，
 * 所以不占预算、不做容量门。要让某条现行结论退役，调用方仍需用原生 edit 改写那一行 ——
 * 这一步是语义判断，不在本工具里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileStamp } from './file-stamp.js';
import { countWords, memoryCapacity } from './memory.js';
import { entryDate, isRetiredEntry, splitMemoryEntries } from './memory-format.js';
import { resolveWikiTarget, WIKI_LINK } from './wikilink.js';
const TARGET_FILE = { MEMORY: 'MEMORY.md', USER: 'USER.md' };
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+/;
const PRE_IMAGE_LINES = 40;
const PRE_IMAGE_CHARS = 4000;
function reject(base, rejection, detail) {
    return { ...base, accepted: false, rejection, detail };
}
/** 往文件末尾追加一条顶层列表项；不碰已有内容 */
function appendEntry(body, entry) {
    const head = String(body ?? '').replace(/\s+$/, '');
    return (head ? head + '\n\n' : '') + entry + '\n';
}
/** tmp + rename：写一半被杀不会留下半截 MEMORY.md */
function atomicWrite(file, text) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, text, 'utf8');
    try {
        fs.renameSync(tmp, file);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { /* 已经不在了 */ }
        throw err;
    }
}
/** 周审复核材料：pre-image 摘要 + 一行 diff，只追加、不回改结论 */
function appendDreams(cfg, r, preImage) {
    const at = new Date().toISOString();
    const capped = preImage.length > PRE_IMAGE_CHARS ? preImage.slice(0, PRE_IMAGE_CHARS) + '\n…（pre-image 已截断）' : preImage;
    const quoted = capped.split('\n').slice(0, PRE_IMAGE_LINES).map((line) => `> ${line}`).join('\n');
    const block = [
        '',
        `## 记忆写入 ${at}（zk_memory_write）`,
        '',
        `- target: ${r.target} · action: ${r.action} · source: [[${r.sourceTarget}]] → ${r.source || '（未解析）'}`,
        `- pre-image stamp: ${r.stamp} · 词数 ${r.beforeWords} → ${r.afterWords}`,
        `- diff: ${r.diff}`,
        '',
        '改前（pre-image 摘要）：',
        '',
        quoted || '> （空文件）',
        '',
    ].join('\n');
    fs.appendFileSync(path.join(cfg.notebook, 'DREAMS.md'), block, 'utf8');
}
export function writeMemory(cfg, input) {
    const file = path.join(cfg.notebook, TARGET_FILE[input.target]);
    const entry = String(input.entry ?? '').trim();
    let body = '';
    try {
        body = fs.readFileSync(file, 'utf8');
    }
    catch { /* 缺文件 = 空 */ }
    const stamp = fileStamp(file);
    const beforeWords = countWords(body);
    const base = {
        accepted: true,
        rejection: '',
        detail: '',
        target: TARGET_FILE[input.target],
        action: input.action,
        dryRun: input.dryRun,
        performed: false,
        source: '',
        sourceTarget: '',
        stamp,
        words: 0,
        budget: 0,
        headroom: 0,
        extraWords: 0,
        wouldTruncate: false,
        needToFree: 0,
        dropCandidates: [],
        beforeWords,
        afterWords: beforeWords,
        diff: '',
        indexComplete: input.indexComplete,
    };
    // 1. 形状：只能是单独一条顶层列表项，不带额外段落
    const pieces = splitMemoryEntries(entry);
    const firstLine = entry.split('\n', 1)[0] ?? '';
    if (!entry || pieces.length !== 1 || !LIST_ITEM.test(firstLine) || pieces[0] !== entry) {
        return reject(base, 'invalid-entry', 'entry 必须是一条顶层列表项（`- …`），不带额外段落；插件不改字');
    }
    // 2. 日期：首行带合法的 YYYY-MM-DD（与 memoryFormatDebt 同口径）
    if (!entryDate(entry)) {
        return reject(base, 'missing-date', '首行要带 YYYY-MM-DD 真实日期；插件不自动补');
    }
    // 3. 来源：带 [[…]] 且解析到活笔记
    const links = [...entry.matchAll(WIKI_LINK)];
    if (!links.length) {
        return reject(base, 'missing-source', '要带 [[来源]]；插件不自动补');
    }
    const sourceTarget = String(links[0][1] ?? '').trim();
    const emptyIndex = { byTitle: new Map(), byId: new Map() };
    const pathOnly = resolveWikiTarget(cfg, sourceTarget, emptyIndex);
    // 索引没扫全 / 没起来时，标题式来源不能核实（可能只是前 10k 里碰巧有）—— 只放路径式过
    if (!input.indexComplete && pathOnly.status !== 'live') {
        base.sourceTarget = sourceTarget;
        return reject(base, 'index-incomplete', '活笔记索引没扫全，标题式 [[来源]] 无法核实；改用笔记本根相对路径，或等索引可用后重试');
    }
    const resolved = resolveWikiTarget(cfg, sourceTarget, input.index);
    base.sourceTarget = sourceTarget;
    if (resolved.status !== 'live') {
        const why = resolved.status === 'archived'
            ? '指向归档 / superseded 笔记'
            : '没找到（标题式来源在索引不可用时也解析不到）';
        return reject(base, 'source-not-live', `[[${sourceTarget}]] ${why}，没有晋升资格`);
    }
    base.source = resolved.path;
    // 4. action 与条目形态要对得上（机械判断，不猜语义）
    if (input.action === 'retire' && !isRetiredEntry(entry)) {
        return reject(base, 'invalid-retire', 'action: retire 的 entry 必须是 `- [superseded …]` 形式');
    }
    if (input.action === 'add' && isRetiredEntry(entry)) {
        return reject(base, 'invalid-add', '退役标记要用 action: retire；add 只收现行结论');
    }
    // 5. 容量门：只管 add（退役条目在注入里被 strip，不占预算）
    const cap = memoryCapacity(cfg, { proposedEntry: input.action === 'add' ? entry : undefined });
    base.words = cap.words;
    base.budget = cap.budget;
    base.headroom = cap.headroom;
    base.extraWords = cap.extraWords;
    base.wouldTruncate = cap.wouldTruncate;
    base.needToFree = Math.max(0, cap.extraWords - cap.headroom);
    base.dropCandidates = cap.dropCandidates;
    if (input.action === 'add' && cap.wouldTruncate) {
        return reject(base, 'over-budget', `再加 ${cap.extraWords} 词会触发截断（余 ${cap.headroom} 词），需先腾出 ${base.needToFree} 词；` +
            'dropCandidates 里是会让位给它的条目，插件不静默截断、也不替你退役');
    }
    // 6. 并发：预演时给的 stamp 必须与当前一致
    if (input.expectStamp && input.expectStamp !== stamp) {
        return reject(base, 'stale-stamp', '文件在预演之后被改过（stamp 不符），本次放弃；重新预演再写');
    }
    const diff = `+ ${firstLine.trim()}`;
    base.diff = diff;
    // 7. 预演到此为止：不改盘（索引 db 的刷新不算改记忆文件）
    if (input.dryRun) {
        base.detail = '预演通过：机械门都过了，没有动任何文件；确认后带 dry_run: false（可带 expect_stamp）执行';
        return base;
    }
    // 8. 真写：落盘前再核一次指纹，期间有人改过就放弃
    if (fileStamp(file) !== stamp) {
        return reject(base, 'concurrent-change', '落盘前发现文件被改过（stamp 变了），本次放弃');
    }
    const next = appendEntry(body, entry);
    atomicWrite(file, next);
    base.afterWords = countWords(next);
    base.performed = true;
    base.detail = `已追加到 ${base.target}；pre-image 与 diff 已写进 DREAMS.md`;
    appendDreams(cfg, base, body);
    return base;
}
