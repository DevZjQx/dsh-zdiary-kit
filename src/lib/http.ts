/** 路由小工具与访问来源判定（和宿主无关，纯 node:http）。 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 本插件所有服务端路由的前缀（设置页与只读视图共用同一个真相）。
 * client.ts 因「单文件零 import」的宿主约束另存了一份字面量 —— 改这里记得同步那边。
 */
export const ROUTE_BASE = '/dsh-zdiary-kit'

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

/**
 * Host 头是不是回环。只证明「地址栏里写的是 127.0.0.1」——
 * 单独用它会被 DNS rebinding 骗（恶意域名解析到 127.0.0.1，Host 还是域名，这里挡得住，
 * 但反过来把 Host 伪造成 127.0.0.1 的请求挡不住）。要收紧就跟 isLoopbackPeer 一起判。
 */
export function isLoopbackHost(req: IncomingMessage): boolean {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

/** 对端 socket 地址是不是回环；没有对端地址（unix socket / 测试替身）不算反证 */
export function isLoopbackPeer(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress
  if (!addr) return true
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** 两边都在回环才算「本机打开」—— 只读视图用它，比只看 Host 严格 */
export function isLoopback(req: IncomingMessage): boolean {
  return isLoopbackHost(req) && isLoopbackPeer(req)
}
