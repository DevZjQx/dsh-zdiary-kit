/** 两个路由小工具（和宿主无关，纯 node:http）。 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

/** 读请求体（上限 1 MiB，超出直接截断 —— 设置页不会传这么大的东西） */
export async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > limit) break
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}
