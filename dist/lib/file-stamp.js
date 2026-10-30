/**
 * 文件指纹：给「读盘结果」缓存做失效判断。
 *
 * 为什么不用 mtimeMs：毫秒粒度挡不住「同一毫秒里连写两次」—— 测试与 agent 批量改写
 * 都是这种节奏；bigint stat 的 mtimeNs 在主流文件系统上是纳秒级，size / ino 再兜一层。
 * 读不到（不存在 / 无权限）统一记成 absent：文件出现或消失，指纹自然会变。
 */
import fs from 'node:fs';
export function fileStamp(file) {
    try {
        const st = fs.statSync(file, { bigint: true });
        return `${st.mtimeNs}:${st.size}:${st.ino}`;
    }
    catch {
        return 'absent';
    }
}
