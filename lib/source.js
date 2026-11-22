/**
 * Turning a data source into something read-only SQL can run against.
 *
 * SQLite files are opened with `readOnly: true`, so a mistake cannot write.
 * CSV and JSON are materialised into an in-memory database instead of being
 * queried in place: the file stays untouched, and every column is loaded as
 * evidence of what the file actually contains.
 *
 * This module runs inside the query worker as well as in the host, which is why
 * it has no dependency on the store or on any DSH service.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

/** Refuse to slurp anything larger than this into memory. */
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024
/** Rows kept per materialised file; the rest is dropped and reported. */
export const MAX_ROWS = 50000

const KINDS_BY_EXT = {
  '.db': 'sqlite',
  '.sqlite': 'sqlite',
  '.sqlite3': 'sqlite',
  '.db3': 'sqlite',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.txt': 'csv',
  '.json': 'json',
  '.jsonl': 'json'
}

export function detectKind(path) {
  return KINDS_BY_EXT[extname(String(path)).toLowerCase()] ?? null
}

/** `mon_4b.csv` → `mon_4b`; anything unusable becomes `data`. */
export function tableNameFor(path) {
  const stem = basename(String(path), extname(String(path)))
  const cleaned = stem
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!cleaned) return 'data'
  return /^[0-9]/.test(cleaned) ? `t_${cleaned}` : cleaned
}

function assertSize(path) {
  const info = statSync(path)
  if (!info.isFile()) throw new Error(`${path} 不是文件`)
  if (info.size > MAX_SOURCE_BYTES) {
    throw new Error(`${path} 有 ${info.size} 字节，超过上限 ${MAX_SOURCE_BYTES}；先用 SQLite 预处理成大文件可承载的形式`)
  }
  return info
}

// ------------------------------------------------------------------ CSV

/**
 * RFC 4180 without the ceremony: quotes, doubled escapes, CRLF, and a
 * delimiter guessed from the header when the extension does not say.
 */
export function parseCsv(text, delimiter) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const records = []
  let field = ''
  let record = []
  let quoted = false
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      index += 1
      continue
    }
    if (char === delimiter) {
      record.push(field)
      field = ''
      index += 1
      continue
    }
    if (char === '\n' || char === '\r') {
      record.push(field)
      field = ''
      records.push(record)
      record = []
      index += char === '\r' && source[index + 1] === '\n' ? 2 : 1
      continue
    }
    field += char
    index += 1
  }
  if (field !== '' || record.length) {
    record.push(field)
    records.push(record)
  }
  const rows = records.filter((row) => row.length > 1 || (row.length === 1 && row[0].trim() !== ''))
  if (!rows.length) throw new Error('CSV 是空的')
  const header = rows[0].map((name, i) => {
    const cleaned = String(name).trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
    return cleaned || `col_${i + 1}`
  })
  return { columns: header, rows: rows.slice(1) }
}

function guessDelimiter(text) {
  const line = text.slice(0, 4096).split('\n', 1)[0] ?? ''
  const commas = (line.match(/,/g) ?? []).length
  const semicolons = (line.match(/;/g) ?? []).length
  const tabs = (line.match(/\t/g) ?? []).length
  if (tabs > commas && tabs > semicolons) return '\t'
  return semicolons > commas ? ';' : ','
}

const INT_RE = /^-?\d+$/
const REAL_RE = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

function inferColumnType(values) {
  let sawValue = false
  let integral = true
  let real = true
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    sawValue = true
    const text = String(value).trim()
    if (!INT_RE.test(text)) integral = false
    if (!REAL_RE.test(text)) real = false
    if (!integral && !real) return 'TEXT'
  }
  if (!sawValue) return 'TEXT'
  if (integral) return 'INTEGER'
  if (real) return 'REAL'
  return 'TEXT'
}

function coerce(value, type) {
  if (value === null || value === undefined) return null
  if (type === 'TEXT') return String(value)
  const text = String(value).trim()
  if (text === '') return null
  return type === 'INTEGER' ? Number.parseInt(text, 10) : Number.parseFloat(text)
}

function makeMemoryDb(table, columns, types, rows, dropped) {
  const db = new DatabaseSync(':memory:')
  const quoted = table.replace(/"/g, '""')
  const defs = columns.map((name, i) => `"${name.replace(/"/g, '""')}" ${types[i] ?? 'TEXT'}`).join(', ')
  db.exec(`CREATE TABLE "${quoted}" (${defs})`)
  const placeholders = columns.map(() => '?').join(', ')
  const insert = db.prepare(`INSERT INTO "${quoted}" VALUES (${placeholders})`)
  db.exec('BEGIN')
  try {
    for (const row of rows) insert.run(...columns.map((_name, i) => coerce(row[i], types[i])))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { db, table, columns, types, loaded: rows.length, dropped }
}

function materializeCsv(path, table, explicitDelimiter) {
  const info = assertSize(path)
  const text = readFileSync(path, 'utf8')
  const delimiter = explicitDelimiter ?? guessDelimiter(text)
  const parsed = parseCsv(text, delimiter)
  const rows = parsed.rows.slice(0, MAX_ROWS)
  const dropped = Math.max(parsed.rows.length - rows.length, 0)
  const types = parsed.columns.map((_name, i) =>
    inferColumnType(rows.slice(0, 500).map((row) => row[i]))
  )
  return { ...makeMemoryDb(table, parsed.columns, types, rows, dropped), kind: 'csv', bytes: info.size, delimiter }
}

function materializeJson(path, table) {
  const info = assertSize(path)
  const raw = readFileSync(path, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`JSON 解析失败：${error.message}`)
  }
  let records = parsed
  if (!Array.isArray(records) && parsed && typeof parsed === 'object') {
    const arrays = Object.values(parsed).filter((value) => Array.isArray(value))
    if (arrays.length === 1) records = arrays[0]
  }
  if (!Array.isArray(records)) throw new Error('JSON 必须是对象数组（或只有一个数组字段的对象）')
  const objects = records.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
  if (!objects.length) throw new Error('JSON 里没有对象行')
  const columns = []
  const seen = new Set()
  for (const row of objects.slice(0, 500)) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue
      seen.add(key)
      columns.push(String(key).replace(/[^A-Za-z0-9_]+/g, '_') || `col_${columns.length + 1}`)
    }
  }
  const rows = objects.slice(0, MAX_ROWS).map((row) =>
    columns.map((column) => {
      const value = row[column] ?? row[Object.keys(row).find((k) => String(k).replace(/[^A-Za-z0-9_]+/g, '_') === column)]
      if (value === null || value === undefined) return null
      return typeof value === 'object' ? JSON.stringify(value) : value
    })
  )
  const dropped = Math.max(objects.length - rows.length, 0)
  const types = columns.map((_name, i) =>
    inferColumnType(rows.slice(0, 500).map((row) => row[i]))
  )
  return { ...makeMemoryDb(table, columns, types, rows, dropped), kind: 'json', bytes: info.size }
}

function sqliteTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name)
}

/**
 * Open `path` as a read-only query source.
 * Returns `{ kind, path, table, db, tables, close() }`.
 */
export function openSource({ path, kind, table, delimiter } = {}) {
  if (!path) throw new Error('必须给出数据源路径（绝对路径）')
  const resolved = String(path)
  const info = statSync(resolved)
  const detected = kind ?? detectKind(resolved)
  if (!detected) throw new Error(`无法从扩展名判断数据源类型：${resolved}；请显式指定 sqlite / csv / json`)

  if (detected === 'sqlite') {
    if (!info.isFile()) throw new Error(`${resolved} 不是文件`)
    const db = new DatabaseSync(resolved, { readOnly: true })
    const tables = sqliteTables(db)
    const chosen = table ?? tables[0] ?? null
    return {
      kind: 'sqlite',
      path: resolved,
      table: chosen,
      tables,
      db,
      close: () => db.close()
    }
  }

  if (detected === 'csv') {
    const name = table ?? tableNameFor(resolved)
    const loaded = materializeCsv(resolved, name, delimiter)
    return { kind: 'csv', path: resolved, tables: [loaded.table], close: () => loaded.db.close(), ...loaded }
  }

  if (detected === 'json') {
    const name = table ?? tableNameFor(resolved)
    const loaded = materializeJson(resolved, name)
    return { kind: 'json', path: resolved, tables: [loaded.table], close: () => loaded.db.close(), ...loaded }
  }

  throw new Error(`未知的数据源类型：${detected}`)
}
