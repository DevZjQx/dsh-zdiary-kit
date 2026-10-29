/**
 * 安装内置 zk：下载官方 release → 解包到 ~/.dsh/zdiary/bin → 真跑一次 --version。
 *
 * 只信「跑得起来」这一条：下载完不验证能执行，就等于没装。
 * 镜像：设 ZK_DOWNLOAD_BASE（例如 https://ghproxy.example.com/https://github.com）可换源。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BIN_DIR, CACHE_DIR, expandHome } from '../config/paths.js';
import { run } from './exec.js';
import { zkAsset } from './platform.js';
import { managedBin, versionOf, ZkError } from './zk.js';
export async function installZk(version, signal) {
    const target = zkAsset(version);
    if (!target) {
        throw new ZkError(`暂不支持自动安装（${process.platform}/${process.arch}）`, '请自己装一份 zk 并把路径填进设置 →「zk 路径」：https://github.com/zk-org/zk#installation');
    }
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tarFile = path.join(CACHE_DIR, target.asset);
    let res;
    try {
        res = await fetch(target.url, { signal, redirect: 'follow' });
    }
    catch (err) {
        throw new ZkError('下载 zk 失败：' + String(err instanceof Error ? err.message : err), '检查网络，或用 ZK_DOWNLOAD_BASE 指定镜像；也可以自己装 zk 后填「zk 路径」');
    }
    if (!res.ok || !res.body) {
        throw new ZkError(`下载 zk 失败：HTTP ${res.status}`, target.url);
    }
    fs.writeFileSync(tarFile, Buffer.from(await res.arrayBuffer()));
    try {
        await run('tar', ['-xzf', tarFile, '-C', BIN_DIR, target.bin], { signal, timeoutMs: 120_000 });
    }
    catch (err) {
        throw new ZkError('解包失败（需要系统 tar）', String(err instanceof Error ? err.message : err) + ' —— 也可以手动解包后把 zk 放到 ' + BIN_DIR);
    }
    finally {
        try {
            fs.unlinkSync(tarFile);
        }
        catch { /* 缓存目录里残留也无所谓 */ }
    }
    const bin = managedBin();
    if (!fs.existsSync(bin))
        throw new ZkError('解包后没找到 zk 可执行文件', bin);
    try {
        fs.chmodSync(bin, 0o755);
    }
    catch { /* Windows 不需要 */ }
    const actual = await versionOf(bin);
    if (!actual)
        throw new ZkError('装好的 zk 跑不起来', bin);
    return { path: bin, version: actual, asset: target.asset };
}
/** 用户手动指的那个路径是不是真的 zk */
export async function verifyZkPath(p) {
    const abs = path.resolve(expandHome(p));
    if (!fs.existsSync(abs))
        return { ok: false, error: '文件不存在：' + abs };
    const version = await versionOf(abs);
    return version ? { ok: true, version } : { ok: false, error: '跑不起来或不是 zk：' + abs };
}
