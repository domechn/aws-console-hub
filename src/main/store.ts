import fs from 'node:fs'
import path from 'node:path'

export function readJson<T>(file: string, fallback: T): T {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    // Unreadable is not empty: carrying on would overwrite it on the next save.
    throw err
  }
  try {
    return JSON.parse(text) as T
  } catch {
    // Set the corrupt file aside rather than let the next save destroy it.
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    return fallback
  }
}

/** Write-then-rename, so a crash mid-write never leaves a truncated file. */
export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}
