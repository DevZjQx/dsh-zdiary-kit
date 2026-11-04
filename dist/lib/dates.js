/**
 * 日期口径（3.1）：`YYYY-MM-DD` 的严格校验只写一份。
 *
 * 为什么单独一层：`zk_lint` 的 90 天窗口、`zk_dream` 的 noteDate 判的其实是同一件事 ——
 * 「这串是不是一天」。各写一份就会在边界上漂移（`2026-02-30` 一边认、一边不认）。
 * 这里只有纯函数、不 import 任何东西：被 lint / dream / timeline 共用，不能反向依赖它们。
 */
/** 严格的 YYYY-MM-DD（2 月 30 日、13 月都不算） */
export function isDayString(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const [year, month, day] = value.split('-').map(Number);
    const at = new Date(year, month - 1, day);
    return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day;
}
