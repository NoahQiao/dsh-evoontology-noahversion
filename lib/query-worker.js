/**
 * The only place user SQL is compiled.
 *
 * It runs in a worker thread for one reason: a synchronous SQLite query cannot
 * be interrupted, and the host is the process that serves every other tool. If
 * a query runs long, the host terminates the worker instead of freezing.
 *
 * Three independent limits apply here:
 *   1. the statement must be a single SELECT / WITH (checked on both sides),
 *   2. the authorizer refuses everything that is not SELECT / READ / FUNCTION /
 *      RECURSIVE, so a smuggled write dies inside SQLite itself,
 *   3. rows stop at `limit` and any single value longer than the cell budget is
 *      cut, so a `SELECT *` cannot flood the transcript.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { openSource } from './source.js'

const SQLITE_SELECT = 21
const SQLITE_READ = 20
const SQLITE_FUNCTION = 31
const SQLITE_RECURSIVE = 33
const ALLOWED_ACTIONS = new Set([SQLITE_SELECT, SQLITE_READ, SQLITE_FUNCTION, SQLITE_RECURSIVE])

const CELL_LIMIT = 2000

const message = (error) => String(error && error.message ? error.message : error)

function clip(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`
  const text = String(value)
  return text.length > CELL_LIMIT ? `${text.slice(0, CELL_LIMIT)}…（截断，原长 ${text.length}）` : text
}

function run({ spec, sql, limit }) {
  let source
  try {
    source = openSource(spec)
  } catch (error) {
    return { ok: false, error: message(error) }
  }

  try {
    source.db.setAuthorizer((action) => (ALLOWED_ACTIONS.has(action) ? 0 : 1))
    const statement = source.db.prepare(sql)
    const columns = statement.columns().map((column) => column.name)
    const iterator = typeof statement.iterate === 'function' ? statement.iterate() : statement.all()[Symbol.iterator]()
    const rows = []
    let truncated = false
    for (const row of iterator) {
      if (rows.length >= limit) {
        truncated = true
        break
      }
      rows.push(
        Array.isArray(row)
          ? row.map(clip)
          : Object.fromEntries(Object.entries(row).map(([key, value]) => [key, clip(value)]))
      )
    }
    return {
      ok: true,
      kind: source.kind,
      path: source.path,
      table: source.table ?? null,
      tables: source.tables ?? [],
      loaded: source.loaded ?? null,
      dropped: source.dropped ?? null,
      columns,
      rows,
      truncated
    }
  } catch (error) {
    return {
      ok: false,
      error: message(error),
      kind: source.kind,
      path: source.path,
      table: source.table ?? null,
      tables: source.tables ?? []
    }
  } finally {
    source.close()
  }
}

parentPort.postMessage(run(workerData))
