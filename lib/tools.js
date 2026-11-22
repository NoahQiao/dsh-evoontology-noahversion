/**
 * The P0 tool surface.
 *
 * Eight tools, each with exactly one job. Read paths first (status / browse /
 * resolve / history / export), then the three write paths (commit / publish /
 * revert). Nothing here reaches outside `store.db`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { derivedDirs, storePath } from './paths.js'
import { openStore } from './store.js'
import { KINDS } from './schema.js'
import { DEFAULT_LIMIT, assertReadOnlyStatement, formatTable, runReadOnlyQuery } from './query.js'

const OUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    tool: { type: 'string' },
    summary: { type: 'string' },
    data: { type: 'object' }
  },
  required: ['ok', 'tool', 'summary']
}

/** One store handle shared by every tool, opened on first use. */
export class StoreHolder {
  #store = null

  get() {
    if (!this.#store) this.#store = openStore(storePath())
    return this.#store
  }

  path() {
    return storePath()
  }

  close() {
    if (!this.#store) return
    this.#store.close()
    this.#store = null
  }
}

const countsLine = (counts) =>
  counts
    ? KINDS.map((kind) => `${kind} ${counts[kind] ?? 0}`).join(' · ') + ` · 合计 ${counts.total ?? 0}`
    : '（无激活版本）'

function describeNode(node) {
  const body = node.body ?? {}
  const bits = []
  if (body.definition) bits.push(body.definition)
  if (body.unit) bits.push(`单位 ${body.unit}`)
  if (body.table) bits.push(`字段 ${body.table}.${body.column}`)
  if (body.term) bits.push(`→ ${body.term}`)
  if (body.kind && node.kind === 'constraint') bits.push(`${body.kind} ${body.subject ?? ''} = ${body.value ?? ''}`)
  if (body.source) bits.push(`来源 ${body.source}`)
  if (body.result) bits.push(`结果 ${String(body.result).slice(0, 120)}`)
  const evidence = Array.isArray(body.evidence) ? ` [证据 ${body.evidence.join(',')}]` : ''
  return `${node.id} (${node.kind}) ${node.label}: ${bits.join(' · ') || '(空)'}${evidence}`
}

function tokens(text) {
  return [...new Set(String(text).toLowerCase().split(/[^a-z0-9_.]+/).filter((t) => t.length >= 2))]
}

function score(node, parts) {
  const haystack = `${node.id} ${node.label} ${JSON.stringify(node.body ?? {})}`.toLowerCase()
  let hit = 0
  for (const part of parts) if (haystack.includes(part)) hit++
  return hit
}

function tool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: OUT,
      render: (_args, value) => [{ type: 'text', text: value.summary }]
    },
    execute: async (args, exec) => {
      try {
        const result = await run(args ?? {}, exec ?? {})
        return { ok: true, tool: name, ...result }
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        return { ok: false, tool: name, summary: `${name} 失败：${message}` }
      }
    }
  }
}

/** Which task a tool call belongs to: explicit arg, else this session's. */
function taskFor(store, exec, explicit) {
  if (explicit) return explicit
  const sessionId = exec && exec.agent ? exec.agent.id : null
  const running = sessionId ? store.runningTask(sessionId) : store.runningTask(null)
  return running ? running.id : null
}

export function createTools(holder) {
  return [
    tool(
      'evo_status',
      '查看本体层的当前状态：激活版本、五类节点的计数、待发布的草稿（含超过 7 天的悬挂草稿）、最近一次进化运行、版本列表。只读，不改变任何数据。开始任何语义工作前先调用它。',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        const store = holder.get()
        const status = store.status()
        const lines = [
          `存储：${status.storePath}（schema ${status.schemaVersion}）`,
          status.active
            ? `激活版本：${status.active.id}「${status.active.summary || '无摘要'}」（${status.active.created_at}）`
            : '激活版本：无（还没有 publish 过任何版本）',
          `节点：${countsLine(status.counts)}`
        ]
        lines.push(status.drafts.length ? `草稿：${status.drafts.join(', ')}${status.staleDrafts.length ? `（其中 ${status.staleDrafts.join(', ')} 已悬挂超过 7 天，建议 discard）` : ''}` : '草稿：无')
        if (status.latestRun) lines.push(`最近运行：${status.latestRun.run_id} ${status.latestRun.status}（轮次 ${status.latestRun.round ?? 0}/${status.latestRun.budget ?? 0}）`)
        lines.push(`评测记录：${status.evaluations} 条`)
        if (status.versions.length) lines.push(`版本：${status.versions.map((v) => `${v.id}/${v.status}`).join(' · ')}`)
        return { summary: lines.join('\n'), data: status }
      }
    ),

    tool(
      'evo_browse',
      '按关键词在激活版本里检索语义对象（term / mapping / constraint / evidence），返回对象与其接地证据。只读。要看某个对象周边的关系用 kind 过滤或换关键词；文本不强时先用它摸清有哪些说法。',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，匹配 id / 标签 / 正文' },
          kind: { type: 'string', enum: KINDS, description: '只看某一类对象' },
          limit: { type: 'number', description: '返回条数，默认 20，最大 100' }
        },
        required: ['query'],
        additionalProperties: false
      },
      async (args) => {
        const store = holder.get()
        const active = store.activeVersion()
        if (!active) throw new Error('还没有激活版本；先用 evo_commit 建草稿并 evo_publish 激活')
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
        const hits = store.search(active.id, String(args.query), args.kind, limit)
        const summary = hits.length
          ? `在 ${active.id} 命中 ${hits.length} 条：\n` + hits.map(describeNode).join('\n')
          : `在 ${active.id} 没有命中「${args.query}」。可换关键词，或该概念尚未记录。`
        return { summary, data: { version: active.id, hits } }
      }
    ),

    tool(
      'evo_resolve',
      '把一个分析意图落成可执行的载体：哪些字段映射到哪些术语、有哪些约束（单位/取值范围/口径）、可用的查询骨架。只读。凡是准备写 SQL 前先用它，避免按列名字面意思猜。',
      {
        type: 'object',
        properties: {
          intent: { type: 'string', description: '要做的分析，例如「mon_4b 里不同模型的封装功耗均值」' },
          limit: { type: 'number', description: '每类返回条数，默认 8' }
        },
        required: ['intent'],
        additionalProperties: false
      },
      async (args) => {
        const store = holder.get()
        const active = store.activeVersion()
        if (!active) throw new Error('还没有激活版本；先用 evo_commit 建草稿并 evo_publish 激活')
        const parts = tokens(args.intent)
        const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 50)
        const all = store.nodes(active.id)
        const ranked = all
          .map((node) => ({ node, hit: score(node, parts) }))
          .filter((entry) => entry.hit > 0)
          .sort((a, b) => b.hit - a.hit)

        const pick = (kind) => ranked.filter((e) => e.node.kind === kind).slice(0, limit).map((e) => e.node)
        const terms = pick('term')
        const mappings = pick('mapping')
        const constraints = pick('constraint')
        const evidence = pick('evidence')

        const lines = [`意图：${args.intent}`, `基于版本：${active.id}`]
        if (!ranked.length) {
          lines.push('未命中任何已记录语义。要点：先查清这些列到底是什么（单位、口径、与业务对象的对应关系），再用 evo_commit 记录下来。')
        } else {
          if (terms.length) lines.push('术语：\n' + terms.map(describeNode).join('\n'))
          if (mappings.length) lines.push('字段映射：\n' + mappings.map(describeNode).join('\n'))
          if (constraints.length) lines.push('约束：\n' + constraints.map(describeNode).join('\n'))
          if (evidence.length) lines.push('证据：\n' + evidence.map(describeNode).join('\n'))
          const tables = [...new Set(mappings.map((m) => m.body.table).filter(Boolean))]
          if (tables.length) {
            lines.push('查询骨架（只读）：')
            for (const table of tables) {
              const cols = mappings.filter((m) => m.body.table === table).map((m) => `${m.body.column} AS ${String(m.body.term ?? m.body.column).replace(/^t\./, '')}`)
              lines.push(`  SELECT ${cols.length ? cols.join(', ') : '*'} FROM ${table} LIMIT 100`)
            }
          }
          const ungrounded = [...terms, ...mappings, ...constraints].filter((n) => !(Array.isArray(n.body.evidence) && n.body.evidence.length))
          if (ungrounded.length) lines.push(`注意：${ungrounded.map((n) => n.id).join(', ')} 没有引用证据，结论不可复验。`)
        }
        return { summary: lines.join('\n'), data: { version: active.id, terms, mappings, constraints, evidence } }
      }
    ),

    tool(
      'evo_history',
      '查看版本时间线；给出 from/to 则返回两个版本之间的差异（新增/删除的节点与边）。只读。回答「为什么现在这么算」或做发布前评审时用。',
      {
        type: 'object',
        properties: {
          from: { type: 'string', description: '旧版本 id，例如 v0' },
          to: { type: 'string', description: '新版本 id，例如 v3' }
        },
        additionalProperties: false
      },
      async (args) => {
        const store = holder.get()
        const versions = store.listVersions()
        if (!versions.length) return { summary: '还没有任何版本。', data: { versions: [] } }
        const timeline = versions
          .map((v) => `${v.id} ${v.status.padEnd(7)} parent=${v.parent ?? '-'} ${v.summary || '(无摘要)'}`)
          .join('\n')
        if (!args.from || !args.to) {
          return { summary: `版本时间线：\n${timeline}`, data: { versions } }
        }
        const diff = store.diffVersions(args.from, args.to)
        const { added, removed, changed } = diff
        const addedEdges = diff.addedEdges.map((e) => `${e.src} → ${e.dst} (${e.type})`)
        const removedEdges = diff.removedEdges.map((e) => `${e.src} → ${e.dst} (${e.type})`)
        const lines = [
          `版本时间线：\n${timeline}`,
          `\n${args.from} → ${args.to}：+${added.length} 节点 / -${removed.length} 节点 / ~${changed.length} 节点 / +${addedEdges.length} 边 / -${removedEdges.length} 边`
        ]
        if (added.length) lines.push('新增：\n' + added.map(describeNode).join('\n'))
        if (removed.length) lines.push('删除：\n' + removed.map(describeNode).join('\n'))
        if (changed.length) lines.push('修改：\n' + changed.map(describeNode).join('\n'))
        if (addedEdges.length) lines.push(`新增边：${addedEdges.join(', ')}`)
        if (removedEdges.length) lines.push(`删除边：${removedEdges.join(', ')}`)
        return { summary: lines.join('\n'), data: { versions, added, removed, changed, addedEdges, removedEdges } }
      }
    ),

    tool(
      'evo_commit',
      '把一批语义修改提交成一个草稿版本（不改动线上语义）。patch 里只放增量：nodes.upsert / nodes.remove / edges.upsert / edges.remove。term、mapping、constraint 必须在 body.evidence 里引用同版本的 evidence 节点，否则会被拒绝。同一个 patch 重复提交是幂等的。提交后用 evo_publish 激活。',
      {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '这一版做了什么，一句话' },
          limitations: { type: 'array', items: { type: 'string' }, description: '已知局限，会随版本一起记录' },
          base: { type: 'string', description: '可选：期望的父版本 id；与当前激活版本不一致时拒绝，用于避免基于过期状态提交' },
          nodes: {
            type: 'object',
            properties: {
              upsert: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: '稳定 id，建议 t./m./c./ev. 前缀' },
                    kind: { type: 'string', enum: KINDS },
                    label: { type: 'string' },
                    body: { type: 'object', description: '按 kind 的 body schema；evidence 类要有 source/probe/result' }
                  },
                  required: ['id', 'kind', 'label', 'body']
                }
              },
              remove: { type: 'array', items: { type: 'string' }, description: '要删除的节点 id' }
            }
          },
          edges: {
            type: 'object',
            properties: {
              upsert: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    src: { type: 'string' },
                    dst: { type: 'string' },
                    type: { type: 'string', enum: ['association', 'hierarchy', 'composition', 'equivalence', 'derivation'] },
                    note: { type: 'string' }
                  },
                  required: ['src', 'dst', 'type']
                }
              },
              remove: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    src: { type: 'string' },
                    dst: { type: 'string' },
                    type: { type: 'string' }
                  },
                  required: ['src', 'dst', 'type']
                }
              }
            }
          }
        },
        required: ['summary'],
        additionalProperties: false
      },
      async (args) => {
        const store = holder.get()
        const result = store.applyPatch(args, { createdBy: 'agent' })
        const counts = store.counts(result.id)
        const summary = result.created
          ? `已创建草稿 ${result.id}（父版本 ${store.getVersion(result.id).parent ?? '无'}）：${countsLine(counts)}\n下一步：用 evo_publish 激活（或继续 evo_commit 追加修改）。`
          : `${result.id} 已经包含相同的 patch，未重复创建（幂等）。当前内容：${countsLine(counts)}`
        return { summary, data: { ...result, counts } }
      }
    ),

    tool(
      'evo_publish',
      '校验并激活一个草稿版本：校验接地（term/mapping/constraint 的 evidence 必须存在、边必须指向存在的节点）通过才切换。旧的激活版本转为 retired。这是会改变线上语义的写操作。',
      {
        type: 'object',
        properties: {
          version: { type: 'string', description: '草稿版本 id；省略则激活最新的草稿' }
        },
        additionalProperties: false
      },
      async (args) => {
        const store = holder.get()
        let id = args.version
        if (!id) {
          const drafts = store.listVersions().filter((v) => v.status === 'draft')
          if (!drafts.length) throw new Error('没有待发布的草稿')
          if (drafts.length > 1) {
            throw new Error(`有 ${drafts.length} 个草稿（${drafts.map((d) => d.id).join(', ')}），必须指定要激活哪一个：evo_publish({version:'vN'})`)
          }
          id = drafts[0].id
        }
        const previous = store.activeVersion()
        const result = store.publish(id, { publishedBy: 'agent' })
        const summary = result.changed
          ? `${id} 已激活，旧激活版本 ${previous ? previous.id : '（无）'} 转为 retired。当前内容：${countsLine(store.counts(id))}`
          : `${id} 已经是激活版本，无需操作。`
        return { summary, data: result }
      }
    ),

    tool(
      'evo_revert',
      '把激活指针指回一个历史版本（该版本必须是发布过的 retired 版本）。不改数据，只改指针，所以是安全的回退。改变线上语义。',
      {
        type: 'object',
        properties: { version: { type: 'string', description: '要回退到的历史版本 id' } },
        required: ['version'],
        additionalProperties: false
      },
      async (args) => {
        const store = holder.get()
        const previous = store.activeVersion()
        const result = store.revert(String(args.version))
        const summary = result.changed
          ? `激活指针已从 ${previous ? previous.id : '（无）'} 指回 ${args.version}。数据未改动。`
          : `${args.version} 已经是激活版本，无需操作。`
        return { summary, data: result }
      }
    ),

    tool(
      'evo_export',
      '把一个版本导出成 Markdown 或 JSON，写到插件数据目录的 exports/ 下，返回绝对路径。派生物可随时删。用于人工评审、贴进文档、或带出本机前先看清楚有什么。',
      {
        type: 'object',
        properties: {
          version: { type: 'string', description: '版本 id；省略则用激活版本' },
          format: { type: 'string', enum: ['markdown', 'json'], description: '默认 markdown' }
        },
        additionalProperties: false
      },
      async (args) => {
        const store = holder.get()
        const active = store.activeVersion()
        const id = args.version ?? (active ? active.id : null)
        if (!id) throw new Error('还没有激活版本')
        const version = store.getVersion(id)
        if (!version) throw new Error(`没有版本 ${id}`)
        const nodes = store.nodes(id)
        const edges = store.edges(id)
        const dir = join(derivedDirs().exports)
        mkdirSync(dir, { recursive: true })
        const format = args.format === 'json' ? 'json' : 'markdown'
        const target = join(dir, `${id}.${format === 'json' ? 'json' : 'md'}`)
        if (format === 'json') {
          writeFileSync(target, JSON.stringify({ version, nodes, edges }, null, 2), 'utf8')
        } else {
          const byKind = new Map()
          for (const node of nodes) {
            if (!byKind.has(node.kind)) byKind.set(node.kind, [])
            byKind.get(node.kind).push(node)
          }
          const lines = [`# 本体版本 ${id}`, '', `- 状态：${version.status}`, `- 父版本：${version.parent ?? '无'}`, `- 摘要：${version.summary || '（无）'}`, '']
          for (const kind of KINDS) {
            const list = byKind.get(kind)
            if (!list) continue
            lines.push(`## ${kind}（${list.length}）`, '')
            for (const node of list) lines.push(`- ${describeNode(node)}`)
            lines.push('')
          }
          if (edges.length) {
            lines.push(`## 边（${edges.length}）`, '')
            for (const edge of edges) lines.push(`- ${edge.src} → ${edge.dst} (${edge.type})${edge.note ? ` — ${edge.note}` : ''}`)
            lines.push('')
          }
          writeFileSync(target, lines.join('\n'), 'utf8')
        }
        return { summary: `已导出 ${id}（${format}）：${target}\n节点 ${nodes.length} · 边 ${edges.length}`, data: { path: target, version: id, format } }
      }
    ),

    tool(
      'evo_query',
      '唯一的数据源执行器：只跑一条 SELECT / WITH，只读，最多 100 行、单值 2 KB、5 秒超时（超时直接掐掉线程）。sqlite 文件按只读打开；csv / json 会被装载成内存表，表名是文件名主干转小写（mon_4b.csv → mon_4b）。写查询前先用 evo_resolve 查语义，别按列名字面意思猜。',
      {
        type: 'object',
        properties: {
          source: { type: 'string', description: '数据源绝对路径：.db / .sqlite / .csv / .tsv / .json' },
          sql: { type: 'string', description: '一条 SELECT 或 WITH 语句' },
          table: { type: 'string', description: '可选：csv/json 的装载表名，或 sqlite 的默认表（不给则用第一个表）' },
          kind: { type: 'string', enum: ['sqlite', 'csv', 'json'], description: '可选：显式指定数据源类型，默认按扩展名判断' },
          limit: { type: 'number', description: `返回行数上限，默认 ${DEFAULT_LIMIT}，最大 500` },
          task: { type: 'string', description: '可选：把这次调用记进哪个任务；默认记进当前会话进行中的任务' }
        },
        required: ['source', 'sql'],
        additionalProperties: false
      },
      async (args, exec) => {
        let sql
        try {
          sql = assertReadOnlyStatement(args.sql)
        } catch (error) {
          // A refused statement is still something the session tried; record it
          // so the task's event log tells the truth about what was attempted.
          const refusedStore = holder.get()
          const refusedTask = taskFor(refusedStore, exec, args.task)
          const summary = `拒绝执行：${error.message}。要改数据请走 evo_commit，不要尝试写库。`
          if (refusedTask) refusedStore.recordEvent(refusedTask, { tool: 'evo_query', args: { sql: args.sql, source: args.source }, result: summary, error: true })
          return { ok: false, summary, data: { task: refusedTask } }
        }
        const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), 500)
        const spec = { path: args.source, kind: args.kind, table: args.table }
        const result = await runReadOnlyQuery({ spec, sql, limit })

        const store = holder.get()
        const taskId = taskFor(store, exec, args.task)

        if (!result.ok) {
          const hint = Array.isArray(result.tables) && result.tables.length ? `\n${result.kind} 里的表：${result.tables.join(', ')}` : ''
          const summary = `${result.timeout ? '超时' : '查询失败'}：${result.error}${hint}`
          if (taskId) store.recordEvent(taskId, { tool: 'evo_query', args: { sql, source: args.source }, result: summary, error: true })
          return { ok: false, summary, data: { task: taskId, ...result } }
        }

        const loaded = result.kind === 'sqlite' ? '' : `（装载 ${result.loaded} 行${result.dropped ? `，超过上限丢弃 ${result.dropped} 行` : ''}）`
        const header = [
          `源：${args.source} [${result.kind}${result.table ? ` · ${result.table}` : ''}]${loaded}`,
          `返回 ${result.rows.length} 行${result.truncated ? `（已达上限 ${limit}，结果被截断）` : ''}`
        ].join(' · ')
        const summary = `${header}\n${formatTable(result.columns, result.rows)}`
        if (taskId) store.recordEvent(taskId, { tool: 'evo_query', args: { sql, source: args.source }, result: summary.slice(0, 2000), error: false })
        return {
          summary,
          data: {
            task: taskId,
            source: args.source,
            kind: result.kind,
            table: result.table,
            columns: result.columns,
            rowCount: result.rows.length,
            truncated: result.truncated,
            rows: result.rows
          }
        }
      }
    ),

    tool(
      'evo_task_start',
      '开始一个任务：把「这次要回答什么问题」钉在一个已发布版本上，后续 evo_query 会自动记进这个任务。需要已有激活版本——答案要能说清依据哪个版本。同一会话同时只允许一个进行中的任务。',
      {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要用数据回答的问题，一句话' },
          data_source: { type: 'string', description: '可选：这次分析的数据源（路径或名字）' },
          version: { type: 'string', description: '可选：钉住的版本，默认当前激活版本' }
        },
        required: ['question'],
        additionalProperties: false
      },
      async (args, exec) => {
        const store = holder.get()
        const sessionId = exec && exec.agent ? exec.agent.id : null
        const task = store.startTask({
          question: args.question,
          dataSource: args.data_source,
          sessionId,
          versionId: args.version
        })
        const summary = [
          `任务 ${task.id} 已开始（版本 ${task.version_id}）`,
          `问题：${args.question}`,
          '接下来每次 evo_query 都会记进这个任务；答完用 evo_task_finish 收尾。'
        ].join('\n')
        return { summary, data: { task } }
      }
    ),

    tool(
      'evo_task_finish',
      '结束当前任务：写下状态与最终答案，事件链就此封口。答案里应写明依据哪条约束/术语与哪个版本。不指定 task 时结束本会话进行中的那个。',
      {
        type: 'object',
        properties: {
          task: { type: 'string', description: '可选：任务 id，默认本会话进行中的任务' },
          status: { type: 'string', enum: ['completed', 'failed', 'interrupted'], description: '默认 completed' },
          answer: { type: 'string', description: '最终答案' }
        },
        additionalProperties: false
      },
      async (args, exec) => {
        const store = holder.get()
        const taskId = taskFor(store, exec, args.task)
        if (!taskId) throw new Error('没有进行中的任务；先用 evo_task_start 开一个')
        const result = store.finishTask(taskId, { status: args.status ?? 'completed', answer: args.answer ?? null })
        if (!result.changed) return { summary: `${result.id} 已经是 ${result.status}，无需重复收尾。`, data: result }
        const summary = [
          `任务 ${result.id} 结束：${result.status}（事件 ${result.events} 条）`,
          args.answer ? `答案：${args.answer}` : '（没有记录答案）'
        ].join('\n')
        return { summary, data: result }
      }
    )
  ]
}
