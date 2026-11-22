/**
 * DSH host plugin for the EvoOntology semantic layer.
 *
 * Three seats, nothing else: the tool table (`ctx.tools`), the manual command
 * (`ctx.commands`), and the skills (`ctx.skills`). The store is one SQLite file
 * opened in-process — no subprocess, no MCP bridge, no vendored interpreter.
 */
import { createTools, StoreHolder } from './lib/tools.js'
import { createCommand } from './lib/command.js'
import { createSkillProvider } from './lib/skills.js'

export const name = 'dsh-evoontology'
export const inject = ['tools', 'commands', 'skills']

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
}
