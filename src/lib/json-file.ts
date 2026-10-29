/** 小工具：读 JSON（坏文件不炸宿主）、原子写 JSON。 */
import fs from 'node:fs'
import path from 'node:path'

export function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 写临时文件再 rename：中途崩了也不会留下半个 JSON */
export function writeJson(file: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode ? { mode } : undefined)
  fs.renameSync(tmp, file)
}
