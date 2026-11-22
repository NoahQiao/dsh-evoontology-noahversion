/**
 * DSH bundle for the EvoOntology semantic layer.
 *
 * This plugin contributes two things a configuration-only bundle cannot:
 *
 * 1. It stages the vendored, zero-dependency Python core from `python/` into
 *    `$DSH_HOME/evoontology/python` so the `evo` MCP row can start
 *    `python -m evoontology.runtime.mcp_server` from a stable directory.
 * 2. It registers the upstream Claude Code skills (`build-ontology`,
 *    `evolve-ontology`, `explore-ontology`) with the DSH skill loader, which
 *    is how an agent discovers the capability at all.
 *
 * The 29 `mcp__evo__*` tools themselves come from the `@deepseek-ai/dsh-mcp-client`
 * row in `cordis.patch.yml`; see `README.md` for the full picture.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-evoontology'

/** The skill loader is a hard dependency: without it this bundle contributes nothing. */
export const inject = ['skills']

const packageDir = dirname(fileURLToPath(import.meta.url))
const sourcePython = join(packageDir, 'python')
const skillsRoot = join(packageDir, 'skills')

/** Provider name shown on each skill summary. */
const PROVIDER = 'evoontology'

/** Skills shipped by this bundle, in catalog order. */
const SKILL_DIRS = ['build-ontology', 'evolve-ontology', 'explore-ontology']

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/**
 * Copy the vendored core to `$DSH_HOME/evoontology/python` when it is missing
 * or comes from a different upstream revision. The bundle is installed as a
 * link to this checkout, so the source tree can change under a running profile.
 */
function stagePython(log) {
  const staged = join(dshHome(), 'evoontology', 'python')
  try {
    const provenance = join(sourcePython, 'UPSTREAM.txt')
    const stagedProvenance = join(staged, 'UPSTREAM.txt')
    const wanted = existsSync(provenance) ? readFileSync(provenance, 'utf8') : ''
    const present = existsSync(stagedProvenance) ? readFileSync(stagedProvenance, 'utf8') : ''
    if (wanted !== '' && wanted === present && existsSync(join(staged, 'evoontology', 'runtime', 'mcp_server.py'))) {
      return staged
    }
    mkdirSync(dirname(staged), { recursive: true })
    cpSync(sourcePython, staged, { recursive: true, force: true })
    log(`staged EvoOntology core into ${staged}`)
    return staged
  } catch (error) {
    log(`could not stage the EvoOntology core into ${staged}: ${String(error)}`)
    return staged
  }
}

/**
 * Split a `---` delimited front matter block. Only the scalar `key: value`
 * pairs the DSH skill loader needs are read.
 */
function splitFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { data: {}, body: text }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key !== '') data[key] = value
  }
  return { data, body: text.slice(match[0].length) }
}

function skillDirOf(directory) {
  return join(skillsRoot, directory)
}

function readSkillMeta(directory) {
  const dir = skillDirOf(directory)
  const file = join(dir, 'SKILL.md')
  const { data, body } = splitFrontMatter(readFileSync(file, 'utf8'))
  return { dir, file, data, body }
}

function candidateOf(directory) {
  const { dir, file, data } = readSkillMeta(directory)
  const summary = {
    name: data.name !== undefined && data.name !== '' ? data.name : directory,
    description: data.description !== undefined ? data.description : '',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: PROVIDER,
    path: file,
    resourceBase: { kind: 'directory', path: dir },
  }
  if (data.whenToUse !== undefined && data.whenToUse !== '') summary.whenToUse = data.whenToUse
  return summary
}

/** One provider serving the vendored skill directories. Bodies load on demand. */
function createProvider(log) {
  return {
    name: PROVIDER,
    async list() {
      const candidates = []
      for (const directory of SKILL_DIRS) {
        try {
          if (!statSync(skillDirOf(directory)).isDirectory()) continue
          const candidate = candidateOf(directory)
          candidates.push({ ...candidate, rank: candidates.length, locator: candidate.path })
        } catch (error) {
          log(`skipping skill ${directory}: ${String(error)}`)
        }
      }
      return { candidates, complete: true }
    },
    async get(candidate) {
      const file = typeof candidate?.locator === 'string' ? candidate.locator : candidate?.path
      if (typeof file !== 'string') return undefined
      const { data, body } = splitFrontMatter(readFileSync(file, 'utf8'))
      const { rank, locator, ...summary } = candidate
      const definition = { ...summary, content: body }
      if (data.whenToUse !== undefined && data.whenToUse !== '') definition.whenToUse = data.whenToUse
      return definition
    },
  }
}

export function apply(ctx) {
  // Logging must never be the reason a skill fails to register, and the Logger
  // shape varies between host builds, so probe it and fall back to the console.
  const log = (message) => {
    try {
      if (typeof ctx.logger === 'function') {
        const logger = ctx.logger('evoontology')
        if (logger !== undefined && logger !== null && typeof logger.warn === 'function') {
          logger.warn(message)
          return
        }
      }
    } catch {
      // fall through to the console
    }
    console.warn(`[evoontology] ${message}`)
  }

  // Stage before the MCP row activates so `cwd` already points at real files.
  stagePython(log)

  ctx.effect(() => ctx.skills.registerProvider(() => createProvider(log)))
}
