/**
 * Offline check for the P1 surface: the read-only executor, the task loop, and
 * the one line of prompt state. Everything runs headless against temporary
 * stores and fixture files; nothing here needs DSH.
 *
 *   node scripts/_check-query.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dir = mkdtempSync(join(tmpdir(), 'evo-p1-'))
process.env.DSH_EVOONTOLOGY_HOME = join(dir, 'home')
process.env.DSH_EVOONTOLOGY_STORE = join(dir, 'home', 'store.db')

const { assertReadOnlyStatement, runReadOnlyQuery, formatTable } = await import('../lib/query.js')
const { openSource, tableNameFor, parseCsv } = await import('../lib/source.js')
const { createTools, StoreHolder } = await import('../lib/tools.js')
const { createCommand } = await import('../lib/command.js')
const plugin = await import('../index.js')

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
function expectError(name, fn, fragment) {
  try {
    fn()
    failures.push(`${name} — 应当报错但没有`)
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    check(name, message.includes(fragment), message)
  }
}

// ------------------------------------------------------------ statement gate

check('accepts SELECT', assertReadOnlyStatement('SELECT 1') === 'SELECT 1')
check('accepts WITH', assertReadOnlyStatement('WITH c AS (SELECT 1) SELECT * FROM c').startsWith('WITH'))
check('accepts trailing semicolon', assertReadOnlyStatement('SELECT 1;') === 'SELECT 1;')
check('accepts leading comment', assertReadOnlyStatement('-- why\nSELECT 1').startsWith('-- why'))
check('accepts semicolon in literal', assertReadOnlyStatement("SELECT ';' AS a").includes("';'"))
check('accepts semicolon in comment', assertReadOnlyStatement('SELECT 1 -- ;\n').startsWith('SELECT'))
expectError('rejects INSERT', () => assertReadOnlyStatement('INSERT INTO t VALUES (1)'), '只允许 SELECT')
expectError('rejects PRAGMA', () => assertReadOnlyStatement('PRAGMA user_version'), '只允许 SELECT')
expectError('rejects ATTACH', () => assertReadOnlyStatement("ATTACH 'x.db' AS x"), '只允许 SELECT')
expectError('rejects two statements', () => assertReadOnlyStatement('SELECT 1; DROP TABLE t'), '一次只能执行一条')
expectError('rejects empty', () => assertReadOnlyStatement('   '), 'sql 不能为空')

// ------------------------------------------------------------ fixtures

const csv = join(dir, 'mon_4b.csv')
const rows = ['model,t,pkgW,gpuPct,vramMB']
for (let i = 0; i < 150; i += 1) rows.push(`"m${i % 3}","t${i}",${23841 + i * 100},${(100 + i / 10).toFixed(1)},${4000 + i}`)
writeFileSync(csv, rows.join('\n'), 'utf8')

const quoted = join(dir, 'quoted.csv')
writeFileSync(quoted, 'name,note\n"a, b","he said ""hi"""\n"c;d",plain\n', 'utf8')

const jsonFile = join(dir, 'metrics.json')
writeFileSync(jsonFile, JSON.stringify([{ model: 'm0', pkgW: 23841, note: null }, { model: 'm1', pkgW: 27927 }]), 'utf8')

const dbFile = join(dir, 'sample.db')
{
  const db = new DatabaseSync(dbFile)
  db.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, model TEXT, pkgW INTEGER); INSERT INTO runs VALUES (1,'m0',23841),(2,'m1',27927);")
  db.close()
}

// ------------------------------------------------------------ sources

check('csv table name', tableNameFor(csv) === 'mon_4b')
const parsed = parseCsv('a,b\n1,"x,y"\n', ',')
check('csv quoted field', parsed.rows[0][1] === 'x,y', JSON.stringify(parsed.rows))
const quotedParsed = parseCsv('name,note\n"a, b","he said ""hi"""\n"c;d",plain\n', ',')
check('csv escaped quotes', quotedParsed.rows[0][1] === 'he said "hi"', JSON.stringify(quotedParsed.rows))
check('csv semicolon in field', quotedParsed.rows[1][0] === 'c;d', JSON.stringify(quotedParsed.rows[1]))

const src = openSource({ path: csv })
check('csv columns', src.columns.join(',') === 'model,t,pkgW,gpuPct,vramMB', src.columns.join(','))
check('csv types inferred', src.types[2] === 'INTEGER' && src.types[3] === 'REAL', JSON.stringify(src.types))
check('csv loaded 150 rows', src.loaded === 150, String(src.loaded))
src.close()

const jsonSrc = openSource({ path: jsonFile })
check('json columns union', jsonSrc.columns.join(',') === 'model,pkgW,note', jsonSrc.columns.join(','))
check('json rows', jsonSrc.loaded === 2, String(jsonSrc.loaded))
jsonSrc.close()

// ------------------------------------------------------------ queries

const sqliteWrite = await runReadOnlyQuery({ spec: { path: dbFile }, sql: "INSERT INTO runs VALUES (3,'m2',1)", limit: 10 })
check('sqlite write refused', sqliteWrite.ok === false && /authoriz|readonly|read-only/i.test(sqliteWrite.error), JSON.stringify(sqliteWrite))

const sqliteOk = await runReadOnlyQuery({ spec: { path: dbFile }, sql: 'SELECT model, pkgW FROM runs ORDER BY pkgW', limit: 10 })
check('sqlite read works', sqliteOk.ok === true && sqliteOk.rows.length === 2, JSON.stringify(sqliteOk).slice(0, 200))
check('sqlite table reported', sqliteOk.table === 'runs', String(sqliteOk.table))

const capped = await runReadOnlyQuery({ spec: { path: csv }, sql: 'SELECT * FROM mon_4b', limit: 100 })
check('row cap enforced', capped.ok === true && capped.rows.length === 100 && capped.truncated === true, `${capped.rows?.length}/${capped.truncated}`)

const aggregate = await runReadOnlyQuery({ spec: { path: csv }, sql: 'SELECT model, AVG(pkgW) AS avg_mw, COUNT(*) AS n FROM mon_4b GROUP BY model ORDER BY avg_mw DESC', limit: 10 })
check('csv aggregate', aggregate.ok === true && aggregate.rows.length === 3, JSON.stringify(aggregate).slice(0, 200))

const missing = await runReadOnlyQuery({ spec: { path: csv }, sql: 'SELECT * FROM nope', limit: 10 })
check('missing table lists tables', missing.ok === false && Array.isArray(missing.tables) && missing.tables.includes('mon_4b'), JSON.stringify(missing).slice(0, 200))

const slow = await runReadOnlyQuery({
  spec: { path: dbFile },
  sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 500000000) SELECT count(*) FROM c',
  limit: 10,
  timeoutMs: 800
})
check('timeout kills the query', slow.ok === false && slow.timeout === true, JSON.stringify(slow).slice(0, 200))

const clipFile = join(dir, 'wide.db')
{
  const db = new DatabaseSync(clipFile)
  db.exec("CREATE TABLE t (v TEXT);")
  db.prepare('INSERT INTO t VALUES (?)').run('x'.repeat(9000))
  db.close()
}
const clipped = await runReadOnlyQuery({ spec: { path: clipFile }, sql: 'SELECT v FROM t', limit: 5 })
check('long cell clipped', clipped.ok === true && String(clipped.rows[0].v).length < 2200, String(clipped.rows?.[0]?.v?.length))

const table = formatTable(['a', 'b'], [{ a: 1, b: null }])
check('formatTable marks null', table.includes('NULL'), table)

// ------------------------------------------------------------ the tool surface

const holder = new StoreHolder()
const tools = new Map(createTools(holder).map((definition) => [definition.name, definition]))
const call = (name, args, exec = {}) => tools.get(name).execute(args ?? {}, exec)

check('P1 adds three tools', ['evo_query', 'evo_task_start', 'evo_task_finish'].every((n) => tools.has(n)))
check('tool count is 11', tools.size === 11, String(tools.size))

const exec = { agent: { id: 'session-a' } }

const noVersion = await call('evo_task_start', { question: '还没发布就开任务' }, exec)
check('task needs an active version', noVersion.ok === false && noVersion.summary.includes('激活版本'), noVersion.summary)

await call('evo_commit', {
  summary: 'p1 fixture',
  nodes: {
    upsert: [
      { id: 'ev.pkgW', kind: 'evidence', label: 'pkgW 范围', body: { source: csv, probe: 'SELECT MIN(pkgW), MAX(pkgW) FROM mon_4b', result: 'min=23841 max=38741' } },
      { id: 't.power', kind: 'term', label: '封装功耗', body: { definition: '芯片封装级功耗', unit: 'mW', evidence: ['ev.pkgW'] } },
      { id: 'm.pkgW', kind: 'mapping', label: 'pkgW → power', body: { table: 'mon_4b', column: 'pkgW', term: 't.power', transform: 'value/1000 → W', evidence: ['ev.pkgW'] } }
    ]
  }
})
await call('evo_publish', {})

const started = await call('evo_task_start', { question: 'mon_4b 里 pkgW 的单位和范围是什么', data_source: csv }, exec)
check('task starts', started.ok === true && started.data.task.id === 'task.0001', JSON.stringify(started).slice(0, 200))

const secondStart = await call('evo_task_start', { question: '第二个问题' }, exec)
check('one running task per session', secondStart.ok === false && secondStart.summary.includes('进行中'), secondStart.summary)

const queried = await call('evo_query', { source: csv, sql: 'SELECT MIN(pkgW) AS lo, MAX(pkgW) AS hi, COUNT(*) AS n FROM mon_4b' }, exec)
check('evo_query works', queried.ok === true && queried.data.rowCount === 1, queried.summary)
check('evo_query records the task', queried.data.task === 'task.0001', String(queried.data.task))

const events = holder.get().events('task.0001')
check('event landed', events.length === 1 && events[0].tool === 'evo_query' && events[0].error === 0, JSON.stringify(events).slice(0, 200))

const badQuery = await call('evo_query', { source: csv, sql: 'DELETE FROM mon_4b' }, exec)
check('evo_query refuses non-select', badQuery.ok === false && badQuery.summary.includes('只允许 SELECT'), badQuery.summary)
check('failed query recorded with error flag', holder.get().events('task.0001').length === 2 && holder.get().events('task.0001')[1].error === 1)

const finished = await call('evo_task_finish', { answer: 'pkgW 单位 mW，范围 23841–38741' }, exec)
check('task finishes', finished.ok === true && finished.data.status === 'completed' && finished.data.events === 2, JSON.stringify(finished).slice(0, 200))

const again = await call('evo_task_finish', { task: 'task.0001' }, exec)
check('finish is idempotent', again.ok === true && again.summary.includes('无需重复'), again.summary)

const statusAfter = await call('evo_status', {})
check('status counts tasks', statusAfter.data.tasks.completed === 1, JSON.stringify(statusAfter.data.tasks))

const otherSession = { agent: { id: 'session-b' } }
const otherTask = await call('evo_task_start', { question: '另一会话的问题' }, otherSession)
check('sessions are isolated', otherTask.ok === true && otherTask.data.task.id === 'task.0002', JSON.stringify(otherTask.data?.task?.id))

const scope = await call('evo_query', { source: dbFile, sql: 'SELECT COUNT(*) AS n FROM runs' }, otherSession)
check('session b records its own task', scope.data.task === 'task.0002', String(scope.data.task))

// ------------------------------------------------------------ command

const command = createCommand(holder)
const runCommand = async (rawInput) => command.handler({ rawInput })
const statusText = await runCommand('/evo status')
check('command shows tasks', statusText.kind === 'success' && statusText.text.includes('任务：'), statusText.text)
const diffText = await runCommand('/evo diff v0 v1')
check('command diff uses the shared diff', diffText.kind === 'success' && diffText.text.includes('~'), diffText.text)

// ------------------------------------------------------------ prompt state

const registered = new Map()
const sections = []
const disposers = []
const fakeCtx = {
  logger: { warn: (m) => failures.push(`unexpected warning: ${m}`) },
  effect: (fn) => {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
  tools: { register: (definition) => (registered.set(definition.name, definition), () => registered.delete(definition.name)) },
  commands: {
    register: (definition) => (registered.set(`/${definition.name}`, definition), () => registered.delete(`/${definition.name}`))
  },
  skills: { registerProvider: () => () => {} },
  get: (name) => (name === 'systemPrompt' ? { section: (section) => (sections.push(section), () => sections.pop()) } : undefined)
}

plugin.apply(fakeCtx)
check('plugin registers 11 tools + command', registered.size === 12, String(registered.size))
check('one prompt section registered', sections.length === 1, String(sections.length))
const section = sections[0]
check('section name and order', section.name === 'evoontology-status' && section.order === 62, JSON.stringify(section.name))

const line = section.text({})
check('prompt line is one line', typeof line === 'string' && !line.includes('\n'), line)
check('prompt line names the version', line.includes('本体 v0'), line)
check('prompt line counts nodes', line.includes('1 term') && line.includes('1 mapping'), line)
check('prompt line points at evo_resolve', line.includes('evo_resolve'), line)

// Stale-after-publish behaviour: the line is cached briefly, then refreshes.
await registered.get('evo_publish').execute({}, {})
const cachedLine = section.text({})
check('prompt line is cached', cachedLine === line, cachedLine)

for (const dispose of disposers) dispose()
check('dispose clears the seats', registered.size === 0 && sections.length === 0, `${registered.size}/${sections.length}`)

// ------------------------------------------------------------ report

holder.close()
// Worker threads close their SQLite handles asynchronously, and Windows keeps
// the temp directory locked for a moment after terminate(). Retry, and never
// let cleanup turn a green run into a red one.
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    rmSync(dir, { recursive: true, force: true })
    break
  } catch (error) {
    if (attempt === 19) {
      console.log(`(清理临时目录失败，忽略：${error.code} → ${dir})`)
      const left = []
      const walk = (path) => {
        for (const entry of readdirSync(path)) {
          const full = join(path, entry)
          if (statSync(full).isDirectory()) walk(full)
          else {
            try {
              unlinkSync(full)
            } catch (inner) {
              left.push(`${entry}:${inner.code}`)
            }
          }
        }
      }
      walk(dir)
      if (left.length) console.log(`  仍被占用：${left.join(', ')}`)
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

if (failures.length) {
  console.log(`FAILURES (${failures.length})`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`ALL P1 CHECKS PASSED (${passed})`)
