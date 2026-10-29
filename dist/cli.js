#!/usr/bin/env node
/**
 * 人也能用的命令行（和 agent 的 zk_* 工具走同一套 lib，不重复实现）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config/store.js';
import { ensureNotebook } from './lib/notebook.js';
import { installZk } from './lib/install.js';
import { resolveZk, searchNotes, createNote, readNote, findNote, appendToNote, ensureDailyNote, appendDaily, linkNotes, notebookStats, indexNotebook, withTags, hasNotebook, localDate, ZkError, } from './lib/zk.js';
const HELP = `zk-kit —— dsh-zdiary-kit 的命令行

  zk-kit doctor                       自检：zk / 笔记本 / 模板 / group / 索引
  zk-kit install [版本]                安装内置 zk（默认取配置里的版本）
  zk-kit init                         建好（或补齐）笔记本
  zk-kit new --title T [--body B] [--tags a,b] [--dir notes]
  zk-kit search [词] [--tags a,b] [--since 日期] [--limit 5] [--json]
  zk-kit read <路径> | --query 词 [--max-chars n] [--json]
  zk-kit daily [--entry 一段] [--date yesterday]
  zk-kit append <路径> --text 一段 [--heading 标题]
  zk-kit link <来源路径> <目标路径或标题>
  zk-kit index                        重建索引

任何时候加 --json 输出结构化结果。`;
function parse(argv) {
    const out = { pos: [], flags: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) {
            out.pos.push(a);
            continue;
        }
        const eq = a.indexOf('=');
        if (eq > 0) {
            out.flags[a.slice(2, eq)] = a.slice(eq + 1);
            continue;
        }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            out.flags[key] = next;
            i++;
        }
        else {
            out.flags[key] = true;
        }
    }
    return out;
}
const str = (v) => (v === true || v === undefined ? '' : String(v));
const list = (v) => str(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
const print = (value, asJson) => {
    console.log(asJson || typeof value !== 'string' ? JSON.stringify(value, null, 2) : value);
};
async function doctor() {
    const cfg = config();
    const zk = await resolveZk(cfg);
    const rows = [];
    rows.push(`${zk ? '✓' : '✗'} zk：${zk ? `${zk.version}（${zk.source}）${zk.bin}` : '没找到 —— 跑 zk-kit install'}`);
    const exists = hasNotebook(cfg);
    rows.push(`${exists ? '✓' : '✗'} 笔记本：${cfg.notebook}${exists ? '' : '（不是 zk 笔记本 —— 跑 zk-kit init）'}`);
    const template = path.join(cfg.notebook, '.zk', 'templates', 'daily.md');
    rows.push(`${fs.existsSync(template) ? '✓' : '✗'} 日记模板：${template}`);
    let group = false;
    try {
        group = new RegExp(`^\\[group\\."?${cfg.dailyGroup}"?\\]`, 'm').test(fs.readFileSync(path.join(cfg.notebook, '.zk', 'config.toml'), 'utf8'));
    }
    catch {
        group = false;
    }
    rows.push(`${group ? '✓' : '✗'} 日记 group：${cfg.dailyGroup} → ${cfg.dailyDir}/`);
    if (zk && exists) {
        try {
            const s = await notebookStats(cfg);
            rows.push(`✓ 索引：${s.notes} 篇笔记 / ${s.tags} 个标签 / 断链 ${s.brokenLinks} / 孤立 ${s.orphans}`);
        }
        catch (err) {
            rows.push('✗ 索引：' + (err instanceof Error ? err.message : String(err)));
        }
    }
    console.log(rows.join('\n'));
    return rows.every((r) => r.startsWith('✓'));
}
async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0] ?? 'doctor';
    const { pos, flags } = parse(argv.slice(1));
    const json = flags.json === true;
    const cfg = config();
    switch (cmd) {
        case 'doctor':
        case 'status':
            if (!(await doctor()))
                process.exitCode = 1;
            return;
        case 'install': {
            const version = str(flags.version) || pos[0] || cfg.zkVersion;
            const result = await installZk(version);
            print(json ? result : `已安装 zk ${result.version} → ${result.path}`, json);
            return;
        }
        case 'init': {
            const r = await ensureNotebook(cfg);
            print(json ? r : `笔记本 ${r.notebook}\n初始化：${r.initialized ? '是' : '已是笔记本'} · 日记 group：${r.configPatched ? '已补齐' : '已存在'} · 日记模板：${r.templateWritten ? '已写入' : '已存在'}`, json);
            return;
        }
        case 'new': {
            const title = str(flags.title) || pos[0] || '';
            if (!title)
                throw new ZkError('用法：zk-kit new --title 标题 [--body 正文] [--tags a,b]');
            const tags = [...new Set([...cfg.defaultTags, ...list(flags.tags)])];
            const created = await createNote(cfg, {
                title,
                content: withTags(str(flags.body), tags),
                dir: str(flags.dir) || cfg.notesDir,
            });
            print(json ? { ...created, tags } : `已创建 ${created.path}${tags.length ? ' · ' + tags.map((t) => '#' + t).join(' ') : ''}`, json);
            return;
        }
        case 'search': {
            const notes = await searchNotes(cfg, {
                query: pos[0] || str(flags.query) || undefined,
                tags: list(flags.tags),
                since: str(flags.since) || undefined,
                limit: Number(str(flags.limit)) || 10,
                sort: str(flags.sort) || 'created-desc',
            });
            if (json) {
                print(notes, true);
                return;
            }
            if (!notes.length) {
                console.log('没有匹配的笔记');
                return;
            }
            console.log(`${notes.length} 条：`);
            for (const [i, n] of notes.entries()) {
                console.log(`${i + 1}. ${n.title || n.path}\n   ${n.path} · ${localDate(n.created)}${n.tags.length ? ' · ' + n.tags.map((t) => '#' + t).join(' ') : ''}${n.lead ? '\n   ' + n.lead : ''}`);
            }
            return;
        }
        case 'read': {
            const target = str(flags.query) ? '' : (pos[0] ?? '');
            if (!target && !flags.query)
                throw new ZkError('用法：zk-kit read <路径> 或 zk-kit read --query 搜索词');
            const doc = target ? await readNote(cfg, target) : await findNote(cfg, str(flags.query));
            if (!doc)
                throw new ZkError('没找到这篇笔记');
            const limit = Number(str(flags.maxChars)) || cfg.maxReadChars;
            const content = doc.content.length > limit ? doc.content.slice(0, limit) + '\n\n…（已截断）' : doc.content;
            print(json ? { ...doc, content } : `# ${doc.title}\n${doc.path}\n\n${content}`, json);
            return;
        }
        case 'daily': {
            const daily = await ensureDailyNote(cfg, { date: str(flags.date) || undefined });
            if (str(flags.entry))
                appendDaily(cfg, daily.path, str(flags.entry));
            print(json ? daily : `日记 ${daily.created ? '已新建' : '已存在'}：${daily.path}${str(flags.entry) ? '（已追加一段）' : ''}`, json);
            return;
        }
        case 'append': {
            const p = pos[0];
            if (!p || !str(flags.text))
                throw new ZkError('用法：zk-kit append <路径> --text 一段');
            const r = appendToNote(cfg, p, str(flags.text), { heading: str(flags.heading) || undefined });
            print(json ? r : `已追加 → ${r.path}（${r.bytes} 字节）`, json);
            return;
        }
        case 'link': {
            const [from, to] = [pos[0], pos[1]];
            if (!from || !to)
                throw new ZkError('用法：zk-kit link <来源路径> <目标路径或标题>');
            const r = await linkNotes(cfg, from, to);
            print(json ? r : `${r.from} → ${r.link}${r.added ? '（已添加）' : '（已存在）'}`, json);
            return;
        }
        case 'index': {
            await indexNotebook(cfg);
            print(json ? { ok: true } : '✓ 索引已重建', json);
            return;
        }
        case 'help':
        case '--help':
        case '-h':
            console.log(HELP);
            return;
        default:
            throw new ZkError(`不认识的命令：${cmd}（zk-kit help 看用法）`);
    }
}
main().catch((err) => {
    const msg = err instanceof ZkError && err.hint ? `${err.message}\n提示：${err.hint}` : err instanceof Error ? err.message : String(err);
    console.error('✗ ' + msg);
    process.exitCode = 1;
});
