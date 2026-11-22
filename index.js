/**
 * DSH host plugin for the EvoOntology semantic layer.
 *
 * Four seats, nothing else: the tool table (`ctx.tools`), the manual command
 * (`ctx.commands`), the skills (`ctx.skills`), and one line of prompt state
 * (`ctx.systemPrompt`). The store is one SQLite file opened in-process — no
 * subprocess, no MCP bridge, no vendored interpreter.
 */
import { createTools, StoreHolder } from './lib/tools.js'
import { createCommand } from './lib/command.js'
import { createSkillProvider } from './lib/skills.js'

export const name = 'dsh-evoontology'
export const inject = ['tools', 'commands', 'skills']

const STATUS_TTL_MS = 1500
const DAY_MS = 24 * 3600 * 1000

function makeLogger(ctx) {
  return (message) => {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`[evoontology] ${message}`)
        return
      }
    } catch {
      // fall through to console
    }
    console.warn(`[evoontology] ${message}`)
  }
}

function publishedAgo(createdAt) {
  const parsed = Date.parse(String(createdAt ?? ''))
  if (!Number.isFinite(parsed)) return '发布时间未知'
  const days = Math.floor((Date.now() - parsed) / DAY_MS)
  if (days <= 0) return '今天发布'
  return `${days} 天前发布`
}

/**
 * One line of prompt state, rebuilt at most every STATUS_TTL_MS.
 *
 * It stays silent until a version is published: an ontology that does not exist
 * yet must not take up space in sessions that will never use it.
 */
function createStatusLine(holder, log) {
  let cached = { at: 0, text: '' }
  let warned = false
  return () => {
    const now = Date.now()
    if (now - cached.at < STATUS_TTL_MS) return cached.text
    let text = ''
    try {
      const status = holder.get().status()
      if (status.active) {
        const counts = status.counts ?? {}
        const parts = [`本体 ${status.active.id}`]
        for (const kind of ['term', 'mapping', 'constraint', 'evidence']) {
          const n = counts[kind] ?? 0
          if (n) parts.push(`${n} ${kind}`)
        }
        if (counts.edges) parts.push(`${counts.edges} 边`)
        parts.push(publishedAgo(status.active.createdAt))
        text = `${parts.join(' · ')}。碰这批数据前先 evo_resolve 查语义，别按列名字面意思猜。`
      }
    } catch (error) {
      if (!warned) {
        warned = true
        log(`could not read the store for prompt state: ${String(error && error.message ? error.message : error)}`)
      }
    }
    cached = { at: now, text }
    return text
  }
}

export function apply(ctx) {
  const log = makeLogger(ctx)
  const holder = new StoreHolder()

  ctx.effect(() => {
    const disposers = []
    for (const definition of createTools(holder)) {
      try {
        disposers.push(ctx.tools.register(definition))
      } catch (error) {
        log(`could not register tool ${definition.name}: ${String(error)}`)
      }
    }
    try {
      disposers.push(ctx.commands.register(createCommand(holder)))
    } catch (error) {
      log(`could not register command /evo: ${String(error)}`)
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // a seat that already went away needs no cleanup
        }
      }
      holder.close()
    }
  })

  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(log)))

  // Optional seat: a profile without `systemPrompt` still gets the tools.
  const systemPrompt = ctx.get ? ctx.get('systemPrompt') : undefined
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    const statusLine = createStatusLine(holder, log)
    ctx.effect(() => {
      try {
        return systemPrompt.section({ name: 'evoontology-status', order: 62, text: () => statusLine() })
      } catch (error) {
        log(`could not register the prompt section: ${String(error)}`)
        return () => {}
      }
    })
  }
}
