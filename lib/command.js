/**
 * `/evo` — the manual seat. Everything here is also reachable through a tool,
 * so this command exists for the cases where the user wants to act without
 * spending a turn on the model: check state, publish, revert, or find the file.
 */
import { KINDS } from './schema.js'

const USAGE = `用法：/evo <子命令>
  status            当前激活版本、计数、草稿、最近运行
  versions          版本列表
  diff <from> <to>  两个版本的差异
  publish [vN]      激活草稿（省略则激活最新的草稿）
  revert <vN>       指回历史版本
  discard <vN>      删除一个草稿（只对 draft 有效）
  export [vN]       导出到 exports/ 并打印路径
  path              打印 store.db 的路径`

const countsLine = (counts) =>
  counts ? KINDS.map((kind) => `${kind} ${counts[kind] ?? 0}`).join(' · ') + ` · 合计 ${counts.total ?? 0}` : '（无激活版本）'

export function createCommand(holder) {
  return {
    name: 'evo',
    description: '本体层：查看状态、发布、回退、导出。',
    input: { hint: 'status | versions | diff | publish | revert | discard | export | path' },
    handler: async (invocation) => {
      const raw = String(invocation.rawInput ?? '').trim().replace(/^\/?evo\b\s*/i, '')
      const [sub = 'status', ...rest] = raw.split(/\s+/).filter((part) => part !== '')
      try {
        const store = holder.get()
        switch (sub.toLowerCase()) {
          case 'status': {
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
            const versions = store.listVersions()
            if (!versions.length) return { kind: 'success', text: '还没有任何版本。' }
            const text = versions.map((v) => `${v.id}\t${v.status}\t${v.parent ?? '-'}\t${v.summary || '(无摘要)'}`).join('\n')
            return { kind: 'success', text }
          }
          case 'diff': {
            const [from, to] = rest
            if (!from || !to) return { kind: 'error', text: '需要两个版本 id：/evo diff v0 v1' }
            const diff = store.diffVersions(from, to)
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
