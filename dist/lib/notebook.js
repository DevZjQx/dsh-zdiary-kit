/**
 * 笔记本自举：目录 → zk init → 模板 → group 配置 → 建索引。
 *
 * 幂等：每一步都是「缺了才补」，第二次调用什么都不改。
 * 不覆盖用户已有配置：只在缺少 `[group."<name>"]` 时追加，其它内容一字不动。
 *
 * 两种结构（Config.structure）：
 *   · flat（默认，0.1.0 行为逐字节一致）：notes/ + 日记 + 一个 daily group；
 *   · layered：raw / inbox / notes/{sources,concepts,entities,patterns} / archive + 三套模板（daily / source / entry）+ 五个 group。
 * 切到 layered **只建目录与模板，不搬已有笔记**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { zk } from './zk.js';
export const DAILY_TEMPLATE = `# {{format-date now "%Y-%m-%d"}}

{{content}}
`;
/** layered 的日记模板：多三节，`{{content}}` 必须在，否则 stdin 的正文被丢（Z9） */
export const DAILY_TEMPLATE_LAYERED = `# {{format-date now "%Y-%m-%d"}}

## Events

{{content}}

## Observations

## Loose ends
`;
/** 原始材料：保留 Key claims / Quotes，跟概念笔记分开模板 */
export const SOURCE_TEMPLATE = `---
type: {{extra.type}}
title: {{title}}
date: {{format-date now "%Y-%m-%d"}}
status: active
authority: {{extra.authority}}
tags: []
---

# {{title}}

## Summary

## Key claims

## Quotes

{{content}}

## Links
`;
/** concept / entity / pattern 共用（type 由 group extra 注入） */
export const ENTRY_TEMPLATE = `---
type: {{extra.type}}
title: {{title}}
date: {{format-date now "%Y-%m-%d"}}
status: active
authority: {{extra.authority}}
tags: []
---

# {{title}}

## Summary

## Content

{{content}}

## Links
`;
function groupSection(spec) {
    const dots = `group."${spec.name}"`;
    const paths = spec.paths.map((p) => JSON.stringify(p)).join(', ');
    let out = `\n# ${spec.comment}\n[${dots}]\npaths = [${paths}]\n\n[${dots}.note]\n`;
    if (spec.filename)
        out += `filename = '${spec.filename}'\n`;
    out += `template = "${spec.template}"\n`;
    if (spec.extra) {
        out += `\n[${dots}.extra]\n`;
        for (const [key, value] of Object.entries(spec.extra))
            out += `${key} = "${value}"\n`;
    }
    return out;
}
function dailyGroup(cfg) {
    return {
        name: cfg.dailyGroup,
        paths: [cfg.dailyDir],
        template: 'daily.md',
        filename: '{{format-date now "%Y-%m-%d"}}',
        comment: 'dsh-zdiary-kit：日记笔记组（一天一篇，文件名就是日期）',
    };
}
function layeredGroups(cfg) {
    const base = cfg.notesDir;
    const named = (kind, template, authority) => ({
        name: kind,
        paths: [`${base}/${kind}s`],
        template,
        filename: '{{slug title}}',
        extra: { type: kind, authority },
        comment: `dsh-zdiary-kit：${kind} 笔记组`,
    });
    return [
        dailyGroup(cfg),
        named('source', 'source.md', 'official'),
        named('concept', 'entry.md', 'expert'),
        named('entity', 'entry.md', 'official'),
        named('pattern', 'entry.md', 'expert'),
    ];
}
function hasGroup(configToml, group) {
    const escaped = group.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\[group\\."?${escaped}"?\\]`, 'm').test(configToml);
}
/** 建目录，返回真正新建的那些（相对笔记本） */
function ensureDirs(cfg, rels) {
    const created = [];
    for (const rel of rels) {
        const abs = path.join(cfg.notebook, rel);
        if (!fs.existsSync(abs))
            created.push(rel);
        fs.mkdirSync(abs, { recursive: true });
    }
    return created;
}
/** 写模板，返回真正写入的那些；已存在的一律不覆盖（用户可能改过） */
function ensureTemplates(cfg, files) {
    const written = [];
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(cfg.notebook, '.zk', 'templates', name);
        if (fs.existsSync(file))
            continue;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
        written.push(name);
    }
    return written;
}
/** 建好（或补好）笔记本；返回每一步各自做了没有，设置页直接展示 */
export async function ensureNotebook(cfg, signal) {
    const layered = cfg.structure === 'layered';
    const rels = [cfg.notesDir, cfg.dailyDir];
    if (layered) {
        rels.push('raw', 'inbox', `${cfg.notesDir}/sources`, `${cfg.notesDir}/concepts`, `${cfg.notesDir}/entities`, `${cfg.notesDir}/patterns`, cfg.archiveDir);
    }
    fs.mkdirSync(cfg.notebook, { recursive: true });
    const dirsCreated = ensureDirs(cfg, rels);
    const configFile = path.join(cfg.notebook, '.zk', 'config.toml');
    let initialized = false;
    if (!fs.existsSync(configFile)) {
        await zk(cfg, ['init', cfg.notebook], { signal, timeoutMs: 120_000 });
        initialized = true;
    }
    const templatesWritten = layered
        ? ensureTemplates(cfg, {
            'daily.md': DAILY_TEMPLATE_LAYERED,
            'source.md': SOURCE_TEMPLATE,
            'entry.md': ENTRY_TEMPLATE,
        })
        : ensureTemplates(cfg, { 'daily.md': DAILY_TEMPLATE });
    const groups = layered ? layeredGroups(cfg) : [dailyGroup(cfg)];
    let configText = fs.readFileSync(configFile, 'utf8');
    const groupsAdded = [];
    for (const group of groups) {
        if (hasGroup(configText, group.name))
            continue;
        const prefix = configText.endsWith('\n') ? '' : '\n';
        configText += prefix + groupSection(group);
        fs.writeFileSync(configFile, configText, 'utf8');
        groupsAdded.push(group.name);
    }
    return {
        notebook: cfg.notebook,
        initialized,
        configPatched: groupsAdded.length > 0,
        templateWritten: templatesWritten.length > 0,
        dirsCreated,
        templatesWritten,
        groupsAdded,
    };
}
