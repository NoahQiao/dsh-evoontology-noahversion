/**
 * Host side of the read-only executor.
 *
 * `assertReadOnlyStatement` is the cheap gate that runs before a worker is
 * spawned (a bad statement should cost nothing). The worker repeats the
 * guarantees that actually matter: read-only connection, authorizer whitelist,
 * row cap, and a hard timeout enforced by terminating the thread.
 */
import { Worker } from 'node:worker_threads'

const WORKER_URL = new URL('./query-worker.js', import.meta.url)

export const DEFAULT_LIMIT = 100
export const DEFAULT_TIMEOUT_MS = 5000

/**
 * Blank out string literals, quoted identifiers and comments, keeping the
 * character positions, so the keyword and semicolon checks cannot be fooled by
 * a semicolon that lives inside a string literal or inside a comment.
 */
function blankLiterals(sql) {
  const out = sql.split('')
  let i = 0
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < sql.length) {
    const char = sql[i]
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      blank(i, stop)
      i = stop
      continue
    }
    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      let k = i + 1
      while (k < sql.length) {
        if (sql[k] === char) {
          if (sql[k + 1] === char) {
            k += 2
            continue
          }
          break
        }
        k += 1
      }
      blank(i, Math.min(k + 1, sql.length))
      i = k + 1
      continue
    }
    if (char === '[') {
      const end = sql.indexOf(']', i + 1)
      const stop = end === -1 ? sql.length : end + 1
      blank(i, stop)
      i = stop
      continue
    }
    i += 1
  }
  return out.join('')
}

/** Throw unless `sql` is exactly one SELECT / WITH statement. */
export function assertReadOnlyStatement(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('sql 不能为空')
  const cleaned = blankLiterals(sql)
  const keyword = (cleaned.trimStart().match(/^([A-Za-z_]+)/) ?? [])[1]?.toUpperCase() ?? ''
  if (keyword !== 'SELECT' && keyword !== 'WITH') {
    throw new Error(`只允许 SELECT / WITH 查询，收到的是 ${keyword || '（没有关键字）'}`)
  }
  const semicolon = cleaned.indexOf(';')
  if (semicolon !== -1 && cleaned.slice(semicolon + 1).trim() !== '') {
    throw new Error('一次只能执行一条语句')
  }
  return sql.trim()
}

/** Run one read-only statement in a worker. Never throws; always resolves. */
export function runReadOnlyQuery({ spec, sql, limit = DEFAULT_LIMIT, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let settled = false
    let worker
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        worker.terminate()
      } catch {
        /* already gone */
      }
      resolve(value)
    }
    const timer = setTimeout(
      () => finish({ ok: false, timeout: true, error: `查询超过 ${timeoutMs} ms，已被中止（只读、100 行上限；试试加 WHERE 或 LIMIT）` }),
      timeoutMs
    )
    try {
      worker = new Worker(WORKER_URL, { workerData: { spec, sql, limit } })
    } catch (error) {
      clearTimeout(timer)
      resolve({ ok: false, error: `无法启动查询线程：${error.message}` })
      return
    }
    worker.on('message', (message) => finish(message))
    worker.on('error', (error) => finish({ ok: false, error: String(error && error.message ? error.message : error) }))
    worker.on('exit', (code) => {
      if (!settled) finish({ ok: false, error: `查询线程退出（code ${code}）` })
    })
  })
}

/** Compact fixed-width table for the tool summary. */
export function formatTable(columns, rows, maxRows = 20) {
  if (!rows.length) return `（0 行）列：${columns.join(', ') || '（无）'}`
  const shown = rows.slice(0, maxRows)
  const cells = shown.map((row) =>
    Array.isArray(row) ? row.map((v) => (v === null ? 'NULL' : String(v))) : columns.map((c) => (row[c] === null ? 'NULL' : String(row[c])))
  )
  const widths = columns.map((name, i) =>
    Math.min(28, Math.max(String(name).length, ...cells.map((row) => String(row[i] ?? '').length)))
  )
  const line = (values) => values.map((value, i) => String(value ?? '').slice(0, widths[i]).padEnd(widths[i])).join('  ')
  const out = [line(columns), widths.map((w) => '-'.repeat(w)).join('  ')]
  for (const row of cells) out.push(line(row))
  if (rows.length > shown.length) out.push(`… 还有 ${rows.length - shown.length} 行未显示`)
  return out.join('\n')
}
