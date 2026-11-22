/**
 * `/evo` — the manual seat. Everything here is also reachable through a tool,
 * so this command exists for the cases where the user wants to act without
 * spending a turn on the model: check state, publish, revert, or find the file.
 *
 * `--json` exists for one reason: the right-sidebar panel is a browser module.
 * It cannot hold a store handle, so it reads through this command and parses
 * the payload. Keeping the projection here means the panel and the CLI can
 * never disagree about what "the current state" is.
 */
import { KINDS } from './schema.js'

const USAGE = `用法：/evo <子命令>
  status            当前激活版本、计数、草稿、任务、最近运行
  versions          版本列表（带每版计数）
  diff <from> <to>  两个版本的差异
  publish [vN]      激活草稿（省略则只有唯一草稿时生效）
  revert <vN>       指回历史版本
  discard <vN>      删除一个草稿（只对 draft 有效）
  export [vN]       导出到 exports/ 并打印路径
  path              打印 store.db 的路径

任一子命令后加 --json 输出结构化结果（面板与脚本用）。`

const countsLine = (counts) =>
  counts ? KINDS.map((kind) => `${kind} ${counts[kind] ?? 0}`).join(' · ') + ` · 合计 ${counts.total ?? 0}` : '（无激活版本）'

const nodeBrief = (node) => ({ id: node.id, kind: node.kind, label: node.label ?? null })

/** Everything the panel needs in one payload. */
function snapshot(store) {
  const status = store.status()
  const versions = store.listVersions().map((version) => ({
    id: version.id,
    status: version.status,
    parent: version.parent ?? null,
    summary: version.summary ?? null,
    createdAt: version.createdAt ?? null,
    counts: store.counts(version.id)
  }))
  return {
    ok: true,
    storePath: status.storePath,
    active: status.active ? { id: status.active.id, summary: status.active.summary ?? null, createdAt: status.active.createdAt ?? null } : null,
    counts: status.counts ?? null,
    versions,
    drafts: status.drafts ?? [],
    staleDrafts: status.staleDrafts ?? [],
    tasks: status.tasks,
    latestRun: status.latestRun ?? null,
    generatedAt: new Date().toISOString()
  }
}

export function createCommand(holder) {
  return {
    name: 'evo',
    description: '本体层：查看状态、发布、回退、导出。',
    input: { hint: 'status | versions | diff | publish | revert | discard | export | path' },
    handler: async (invocation) => {
      const raw = String(invocation.rawInput ?? '').trim().replace(/^\/?evo\b\s*/i, '')
      const parts = raw.split(/\s+/).filter((part) => part !== '')
      const json = parts.includes('--json')
      const [sub = 'status', ...rest] = parts.filter((part) => part !== '--json')
      const asJson = (value) => ({ kind: 'success', text: JSON.stringify(value) })
      try {
        const store = holder.get()
        switch (sub.toLowerCase()) {
          case 'status': {
            const data = snapshot(store)
            if (json) return asJson(data)
            const status = store.status()
            const lines = [
              `存储：${status.storePath}`,
              status.active ? `激活：${status.active.id}「${status.active.summary || '无摘要'}」` : '激活：无',
              `节点：${countsLine(status.counts)}`,
              status.drafts.length ? `草稿：${status.drafts.join(', ')}` : '草稿：无',
              `任务：进行中 ${status.tasks.running} · 完成 ${status.tasks.completed} · 失败 ${status.tasks.failed}`,
              status.latestRun ? `最近运行：${status.latestRun.run_id} ${status.latestRun.status}` : '最近运行：无'
            ]
            return { kind: 'success', text: lines.join('\n') }
          }
          case 'versions': {
            if (json) return asJson(snapshot(store))
            const versions = store.listVersions()
            if (!versions.length) return { kind: 'success', text: '还没有任何版本。' }
            const rows = versions.map((v) => {
              const counts = store.counts(v.id)
              return `${v.id}\t${v.status}\t${v.parent ?? '-'}\t${counts.total}\t${v.summary || '(无摘要)'}`
            })
            return { kind: 'success', text: ['版本\t状态\t父版本\t节点\t摘要', ...rows].join('\n') }
          }
          case 'diff': {
            const [from, to] = rest
            if (!from || !to) return { kind: 'error', text: '需要两个版本 id：/evo diff v0 v1' }
            const diff = store.diffVersions(from, to)
            if (json) {
              return asJson({
                ok: true,
                from,
                to,
                added: diff.added.map(nodeBrief),
                removed: diff.removed.map(nodeBrief),
                changed: diff.changed.map(nodeBrief),
                addedEdges: diff.addedEdges,
                removedEdges: diff.removedEdges
              })
            }
            const added = diff.added.map((n) => n.id)
            const removed = diff.removed.map((n) => n.id)
            const changed = diff.changed.map((n) => n.id)
            return {
              kind: 'success',
              text: `${from} → ${to}: +${added.length} -${removed.length} ~${changed.length} 节点 · +${diff.addedEdges.length} -${diff.removedEdges.length} 边${added.length ? `\n新增：${added.join(', ')}` : ''}${removed.length ? `\n删除：${removed.join(', ')}` : ''}${changed.length ? `\n修改：${changed.join(', ')}` : ''}`
            }
          }
          case 'publish': {
            let id = rest[0]
            if (!id) {
              const drafts = store.listVersions().filter((v) => v.status === 'draft')
              if (!drafts.length) return { kind: 'error', text: '没有待发布的草稿。' }
              if (drafts.length > 1) return { kind: 'error', text: `有 ${drafts.length} 个草稿（${drafts.map((d) => d.id).join(', ')}），请指定：/evo publish vN` }
              id = drafts[0].id
            }
            const result = store.publish(id, { publishedBy: 'user' })
            return { kind: 'success', text: result.changed ? `${id} 已激活。` : `${id} 本来就是激活版本。` }
          }
          case 'revert': {
            const id = rest[0]
            if (!id) return { kind: 'error', text: '需要一个历史版本 id：/evo revert v0' }
            const result = store.revert(id)
            return { kind: 'success', text: result.changed ? `激活指针已指回 ${id}。` : `${id} 本来就是激活版本。` }
          }
          case 'path':
            return { kind: 'success', text: store.status().storePath }
          case 'discard': {
            const id = rest[0]
            if (!id) return { kind: 'error', text: '需要一个草稿版本 id：/evo discard v1' }
            store.discard(id)
            return { kind: 'success', text: `${id} 已删除。` }
          }
          case 'export': {
            const id = rest[0] ?? store.activeVersion()?.id
            if (!id) return { kind: 'error', text: '还没有激活版本。' }
            return { kind: 'error', text: '导出请用 evo_export 工具（需要写文件），或在会话里说「导出 vN」。' }
          }
          default:
            return { kind: 'error', text: `未知子命令：${sub}\n\n${USAGE}` }
        }
      } catch (error) {
        return { kind: 'error', text: String(error && error.message ? error.message : error) }
      }
    }
  }
}
