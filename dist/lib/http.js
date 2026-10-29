export function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(payload);
}
/** 读请求体（上限 1 MiB，超出直接截断 —— 设置页不会传这么大的东西） */
export async function readBody(req, limit = 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > limit)
            break;
        chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
}
