/**
 * 记忆注入（M1）：读 vault 根目录的 AGENTS.md / USER.md / MEMORY.md，
 * 按 `memoryBudgetWords` 截断，渲染成一段可注入系统提示的文本。
 * 另读 DREAMS.md 的「上次做梦」一行（不进正文、不计预算），给周节奏一句机械提醒。
 *
 * 硬约定（与 docs/plan-memory-layers.md §3 D6 一致）：
 *   · 预算按**总载荷**算，不是只卡 MEMORY.md；
 *   · 截断顺序纯机械：先丢 MEMORY 的尾部 `##` 整段，再丢 USER 的尾部整段，
 *     最后各自只留首段；AGENTS.md 是硬规则，永不截断（单独超预算时只告警）；
 *   · 丢掉的段落留一份**目录**（段落标题，计入预算），agent 用 zk_read 取回正文 ——
 *     选哪段是 agent 按当前任务判断，插件只搬运目录，不猜相关性；
 *   · 中文按「1 词 / 2 字」计 —— 空白切分在中文上严重低估，300 词会变成装饰。
 *
 * 另有一条可观测性约定（D6 的补完）：截断不只回显「截了多少」，还要能解释「谁吃掉的」——
 * 否则用户只看到 MEMORY 常年不生效，排查会跑去怀疑注入没挂载（见 notice 里的 AGENTS 归因）。
 *
 * 读文件失败一律当作「没有这份文件」：老 vault 没有这些文件也能照常工作。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DREAM_INTERVAL_DAYS, daysSinceDream, lastDreamDate } from './dream.js';
import { fileStamp } from './file-stamp.js';
import { MEMORY_META_FILES } from './meta.js';
/** vault 根目录下、按优先级排列的三份 meta 文件（定义在 lib/meta.ts，这里只挂个本地名） */
export const META_FILES = MEMORY_META_FILES;
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
/** 给 doctor / 设置页共用：`AGENTS 193 · USER 30 · MEMORY 22（原 82）` */
export function formatFileShares(files, tocWords = 0) {
    const parts = files
        .filter((f) => f.present)
        .map((f) => {
        const label = f.name.replace(/\.md$/i, '');
        return f.originalWords > f.words
            ? `${label} ${f.words}（原 ${f.originalWords}）`
            : `${label} ${f.words}`;
    });
    if (tocWords > 0)
        parts.push(`目录 ${tocWords}`);
    return parts.join(' · ');
}
/** 词数：CJK 按 2 字 1 词，其余按空白切分 */
export function countWords(text) {
    if (!text)
        return 0;
    const cjk = (text.match(CJK) ?? []).length;
    const latin = text.replace(CJK, ' ').split(/\s+/).filter(Boolean).length;
    return Math.ceil(cjk / 2) + latin;
}
/** 目录最多列几段：再多就只给「还有 N 段」，免得目录自己把预算吃掉 */
const TOC_MAX = 5;
function splitSections(body) {
    const head = [];
    const sections = [];
    for (const line of body.split('\n')) {
        if (/^##\s+/.test(line))
            sections.push([line]);
        else if (sections.length > 0)
            sections[sections.length - 1].push(line);
        else
            head.push(line);
    }
    return {
        head: head.join('\n').trim(),
        sections: sections.map((s) => s.join('\n').trim()).filter(Boolean),
    };
}
function joinSections(split) {
    return [split.head, ...split.sections].filter(Boolean).join('\n\n');
}
/** 只留首段（preamble + 第一个 `##` 段） */
function firstSection(body) {
    const split = splitSections(body);
    return joinSections({ head: split.head, sections: split.sections.slice(0, 1) });
}
function sectionTitle(section) {
    const first = section.split('\n', 1)[0] ?? '';
    return first.replace(/^##\s+/, '').trim() || '（无标题）';
}
/**
 * 被截掉段落的目录：代替「按位置丢尾段」的不可见性。
 * 只列标题、不搬运正文，也不列词数 —— 目录自己占预算，紧凑比「信息全」更重要；
 * 选哪段读是 agent 按当前任务判断，插件不猜相关性。
 */
function renderToc(dropped, limit) {
    const byFile = new Map();
    for (const item of dropped.slice(0, limit)) {
        const titles = byFile.get(item.name) ?? [];
        titles.push(`§${item.title}`);
        byFile.set(item.name, titles);
    }
    const lines = ['## 未注入的段落（用 zk_read 取回）'];
    for (const [name, titles] of byFile)
        lines.push(`- ${name}：${titles.join('、')}`);
    if (dropped.length > limit)
        lines.push(`（另有 ${dropped.length - limit} 段）`);
    // 标题也来自文件内容：不转义的话，一个恶意 `## </system-reminder>` 就能提前闭合注入框
    return escapeFrame(lines.join('\n'));
}
/** 目录最多占预算的这个比例：宁可少列几段，也别让索引把正文挤没 */
function tocCapOf(budget) {
    return Math.min(40, Math.max(0, Math.floor(budget * 0.2)));
}
/**
 * 目录按「能放下多少列多少」生成；一段都放不下时返回空串，
 * 由 notice 里的「用 zk_read 读 …」兜底，不让内容彻底静默。
 */
function tocText(dropped, cap = Number.POSITIVE_INFINITY) {
    if (!dropped.length || cap <= 0)
        return '';
    for (let n = Math.min(TOC_MAX, dropped.length); n >= 1; n--) {
        const text = renderToc(dropped, n);
        if (countWords(text) <= cap)
            return text;
    }
    return '';
}
function readMeta(cfg) {
    const out = [];
    for (const name of META_FILES) {
        let body = '';
        try {
            body = fs.readFileSync(path.join(cfg.notebook, name), 'utf8').trim();
        }
        catch { /* 缺文件 = 空 */ }
        out.push({ name, body });
    }
    return out;
}
function escapeFrame(text) {
    // 文件内容不许提前闭合我们自己的 <system-reminder> 框
    return text.replaceAll('</system-reminder>', '<\\/system-reminder>');
}
/**
 * 「上次做梦」提醒：DREAMS.md 不在注入清单里，但它头部那一行决定周节奏。
 * 只做日期算术（机械活）；整理本身仍然由 agent 按 AGENTS.md 执行 —— 插件没有定时器。
 * 冷启动：没有 DREAMS.md 就说「从未整理过」，否则这套节奏对从没跑过 zk_dream 的库永远不生效。
 * 是否提醒由调用方按「有没有 AGENTS.md」决定：没采用这套工作约定的库不该每步被催。
 */
function dreamNote(cfg) {
    let body = '';
    try {
        body = fs.readFileSync(path.join(cfg.notebook, 'DREAMS.md'), 'utf8');
    }
    catch {
        body = '';
    }
    if (!body.trim())
        return '做梦：从未整理过 —— 先跑一次 zk_dream，再把「上次做梦：YYYY-MM-DD」写进 DREAMS.md';
    const last = lastDreamDate(body);
    if (!last)
        return '做梦：DREAMS.md 里没有「上次做梦：YYYY-MM-DD」，无法判断该不该整理';
    const days = daysSinceDream(last);
    if (days === null)
        return '做梦：DREAMS.md 的「上次做梦」不是有效日期';
    const gap = Math.max(0, days);
    const ago = gap === 0 ? '今天' : `${gap} 天前`;
    if (gap < DREAM_INTERVAL_DAYS)
        return `做梦：上次 ${last}（${ago}），未到 ${DREAM_INTERVAL_DAYS} 天`;
    return `做梦：上次 ${last}（${ago}），已到 ${DREAM_INTERVAL_DAYS} 天 —— zk_lint → zk_dream → 写 DREAMS.md 并更新这一行`;
}
/** 缓存里只放最近几个库：同一进程可能开着多个工作区（各自一个笔记本） */
const PAYLOAD_CACHE_MAX = 8;
const payloadCache = new Map();
/** DREAMS.md 不进正文，但「上次做梦 N 天前」也算载荷的一部分 —— 它变了同样要重算 */
const STAMPED_FILES = [...META_FILES, 'DREAMS.md'];
function payloadKeyOf(cfg) {
    const stamps = STAMPED_FILES.map((name) => `${name}=${fileStamp(path.join(cfg.notebook, name))}`).join('|');
    // 做梦提醒按本地日历天变化（「3 天前」→「4 天前」）：文件没动也得跟着日期失效
    const now = new Date();
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    return `${cfg.notebook}|${cfg.memoryBudgetWords}|${day}|${stamps}`;
}
/**
 * 生成注入载荷。纯读文件，不调 zk、不建目录：笔记本不存在时返回空载荷。
 *
 * 宿主把它挂在系统提示的 text 函数上 —— **每个 step 都会重新求值**。所以这里带一层
 * 按文件指纹失效的缓存：文件没变（最常见的连续 step）就整个载荷复用，不再重复读盘
 * 与重算词数；改动 MEMORY.md 后下一次求值立刻看得见新内容。
 *
 * @param cfg - 当前配置（只用到 notebook 与 memoryBudgetWords）
 * @returns 载荷；`text === ''` 表示没有可注入的内容
 */
export function buildMemoryPayload(cfg) {
    const key = payloadKeyOf(cfg);
    const hit = payloadCache.get(key);
    if (hit)
        return hit;
    const value = computePayload(cfg);
    if (payloadCache.size >= PAYLOAD_CACHE_MAX) {
        const oldest = payloadCache.keys().next().value;
        if (oldest !== undefined)
            payloadCache.delete(oldest);
    }
    payloadCache.set(key, value);
    return value;
}
/** 真正的计算（无缓存）。词数只算一次：截断只改`original`副本，原文词数始终来自这里。 */
function computePayload(cfg) {
    const budget = cfg.memoryBudgetWords;
    const files = readMeta(cfg);
    const original = new Map(files.map((f) => [f.name, f.body]));
    const pristineWords = new Map(files.map((f) => [f.name, countWords(f.body)]));
    // 截断会改写这份计数；pristineWords 保留原值，给「原多少词」和 truncatedWords 用
    const words = new Map(pristineWords);
    const total = () => [...words.values()].reduce((a, b) => a + b, 0);
    // ── 机械截断：MEMORY 尾段 → USER 尾段 → 各留首段 ──────────────────
    // 丢掉的段落留一份目录（段落标题），让 agent 能按当前任务用 zk_read 取回。
    // 目录自己也要占预算，所以每丢一段都把它算进去；目录有上限，循环一定收敛。
    const dropped = [];
    const tocCap = tocCapOf(budget);
    for (const name of ['MEMORY.md', 'USER.md']) {
        if (total() + countWords(tocText(dropped, tocCap)) <= budget)
            break;
        const split = splitSections(original.get(name) ?? '');
        const mine = [];
        const over = () => total() + countWords(tocText([...dropped, ...mine], tocCap)) > budget;
        while (over() && split.sections.length > 1) {
            const section = split.sections.pop();
            mine.unshift({ name, title: sectionTitle(section) });
            const body = joinSections(split);
            original.set(name, body);
            words.set(name, countWords(body));
        }
        dropped.push(...mine);
    }
    if (total() + countWords(tocText(dropped, tocCap)) > budget) {
        for (const name of ['USER.md', 'MEMORY.md']) {
            const body = firstSection(original.get(name) ?? '');
            original.set(name, body);
            words.set(name, countWords(body));
        }
    }
    // 目录本身也放不下时宁可不给：否则「截断」会变成另一处超预算的来源
    const tocDraft = tocText(dropped, tocCap);
    const toc = dropped.length > 0 && total() + countWords(tocDraft) <= budget ? tocDraft : '';
    const present = files.filter((f) => (original.get(f.name) ?? '').length > 0);
    const bodies = present.map((f) => `## ${f.name}\n\n${escapeFrame(original.get(f.name) ?? '')}`);
    const keptWords = total();
    const finalWords = keptWords + countWords(toc);
    const originalWords = files.reduce((sum, f) => sum + (pristineWords.get(f.name) ?? 0), 0);
    // 报「正文被截掉多少」，不是净减少：目录也会占词，混在一起会让人以为没丢多少
    const truncatedWords = Math.max(0, originalWords - keptWords);
    let text = '';
    if (bodies.length > 0) {
        const notes = [];
        if (truncatedWords > 0)
            notes.push(`已截断 ${truncatedWords} 词`);
        // 目录放不下时至少留一句指路；否则被丢掉的段落对模型完全不可见
        if (!toc && dropped.length > 0) {
            const names = [...new Set(dropped.map((d) => d.name))];
            notes.push(`其余 ${dropped.length} 段用 zk_read 读 ${names.join(' / ')}`);
        }
        // 归因：AGENTS 不参与截断，占掉大半预算时得点名 —— 否则「记忆为什么总是不生效」无从查起。
        // 只在「确实截断了、且总载荷没超」时说：总载荷都超了的话，下面的「预算不足」已经点了 AGENTS 的名。
        const agentsWords = words.get('AGENTS.md') ?? 0;
        if (truncatedWords > 0 && finalWords <= budget && agentsWords * 2 > budget) {
            notes.push(`AGENTS.md 占 ${agentsWords}/${budget} 词且不参与截断，留给 USER / MEMORY 的只有 ${Math.max(0, budget - agentsWords)} 词`);
        }
        if (finalWords > budget) {
            notes.push(`预算不足：内容 ${finalWords} 词，超出 ${budget} 词；AGENTS.md 为硬规则，不截断`);
        }
        const notice = notes.length > 0 ? `\n\n（注入预算 ${budget} 词：${notes.join('；')}）` : '';
        // 只有用了这套约定的库（根目录有 AGENTS.md）才提醒周节奏
        const dream = files.some((f) => f.name === 'AGENTS.md' && f.body.length > 0) ? dreamNote(cfg) : '';
        text =
            '<system-reminder>\n' +
                '以下内容由 zdiary 从知识库根目录读出，是长期约定与记忆；与系统、开发者或用户的直接指令冲突时，以更直接的那条为准。\n\n' +
                bodies.join('\n\n') +
                (toc ? `\n\n${toc}` : '') +
                (dream ? `\n\n（${dream}）` : '') +
                notice +
                '\n</system-reminder>';
    }
    return {
        text,
        words: finalWords,
        budget,
        truncatedWords,
        tocWords: countWords(toc),
        files: files.map((f) => ({
            name: f.name,
            present: f.body.length > 0,
            words: words.get(f.name) ?? 0,
            // files[].body 始终是原文件内容（截断只改 original 副本）
            originalWords: pristineWords.get(f.name) ?? 0,
        })),
    };
}
