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
  readdirSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-evoontology'

/**
 * The skill loader is a hard dependency: without it this bundle contributes
 * nothing. `commands` backs the read-only `/evo` status command the sidebar
 * panel reads from.
 */
export const inject = ['skills', 'commands']

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

// ---- read-only workspace view ------------------------------------------------
//
// The sidebar panel cannot call MCP tools (they live on the Host tool table,
// not in the browser), so it reads through this small command instead of the
// Python process: the panel is a read-only view, and parsing the store's JSON
// is far cheaper than starting another interpreter.

/** Record families serialized under `<workspace>/versions/<version>/`. */
const RECORD_FAMILIES = ['terms', 'mappings', 'relations', 'constraints', 'evidence']

/** Where `--store` points; the panel reads the very same tree. */
function workspaceDir() {
  const configured = process.env.DSH_EVOONTOLOGY_WORKSPACE
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(dshHome(), 'evoontology', 'workspace')
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function entriesOf(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function activeVersionOf(workspace) {
  const active = readJsonSafe(join(workspace, 'active.json'))
  if (active === undefined || active === null || typeof active !== 'object') return null
  // `version` is the legacy field the upstream store still accepts.
  const version = String(active.active_version ?? active.version ?? '').trim()
  return version === '' ? null : version
}

function countsOfVersion(workspace, version) {
  const dir = join(workspace, 'versions', version)
  const counts = {}
  let total = 0
  for (const family of RECORD_FAMILIES) {
    const records = readJsonSafe(join(dir, `${family}.json`))
    const count = Array.isArray(records) ? records.length : 0
    counts[family] = count
    total += count
  }
  return { version, counts, total }
}

function collectVersions(workspace, activeVersion) {
  const versionsDir = join(workspace, 'versions')
  return entriesOf(versionsDir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((version) => ({ ...countsOfVersion(workspace, version), active: version === activeVersion }))
}

/** `run_<n>/run.json` records, newest first. Budget and round stay as upstream wrote them. */
function collectRuns(workspace, limit) {
  const runsDir = join(workspace, 'evolution')
  const rows = []
  for (const entry of entriesOf(runsDir)) {
    if (!entry.isDirectory() || !/^run_\d+$/.test(entry.name)) continue
    const file = join(runsDir, entry.name, 'run.json')
    if (!existsSync(file)) continue
    const run = readJsonSafe(file)
    if (run === undefined || run === null || typeof run !== 'object') continue
    let updatedAt
    try {
      updatedAt = statSync(file).mtime.toISOString()
    } catch {
      updatedAt = undefined
    }
    rows.push({
      dir: entry.name,
      runId: run.run_id ?? entry.name,
      status: run.status ?? null,
      parentVersion: run.parent_version ?? null,
      currentCandidate: run.current_candidate ?? null,
      acceptedVersion: run.accepted_version ?? null,
      endReason: run.end_reason ?? null,
      round: run.round ?? null,
      budget: run.budget ?? null,
      updatedAt,
    })
  }
  rows.sort((left, right) => {
    const leftIndex = Number(left.dir.split('_').pop())
    const rightIndex = Number(right.dir.split('_').pop())
    return rightIndex - leftIndex
  })
  return limit === undefined ? rows : rows.slice(0, limit)
}

function workspaceStatus(workspace) {
  const exists = existsSync(workspace)
  const activeVersion = exists ? activeVersionOf(workspace) : null
  const versions = exists ? collectVersions(workspace, activeVersion) : []
  const runs = exists ? collectRuns(workspace, 5) : []
  const trajectories = exists
    ? entriesOf(join(workspace, 'trajectories')).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length
    : 0
  const visualizationDir = join(workspace, 'visualizations')
  const visualizations = exists
    ? entriesOf(visualizationDir)
        .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
        .map((entry) => ({ file: entry.name, path: join(visualizationDir, entry.name) }))
    : []
  const runTargets = exists && versions.length > 0 ? versions.filter((row) => row.active) : []
  return {
    ok: true,
    workspace,
    exists,
    activeVersion,
    versions,
    runs,
    latestRun: runs.length > 0 ? runs[0] : null,
    trajectories,
    visualizations,
    activeVersionTotals: runTargets,
    generatedAt: new Date().toISOString(),
  }
}

/** `status | versions | runs`; every reply is JSON so the panel parses one shape. */
function evoCommand() {
  return {
    name: 'evo',
    description: 'EvoOntology 语义层只读状态：status / versions / runs（不修改工作区）。',
    input: { hint: 'status | versions | runs' },
    async handler(invocation) {
      try {
        const raw = String(invocation?.rawInput ?? '').trim().replace(/^\/?evo\b\s*/i, '')
        const action = (raw.split(/\s+/)[0] || 'status').toLowerCase()
        const workspace = workspaceDir()
        if (action === 'runs') {
          return { kind: 'success', text: JSON.stringify({ ok: true, workspace, runs: collectRuns(workspace, 20) }) }
        }
        if (action === 'versions') {
          const exists = existsSync(workspace)
          const activeVersion = exists ? activeVersionOf(workspace) : null
          return {
            kind: 'success',
            text: JSON.stringify({
              ok: true,
              workspace,
              exists,
              activeVersion,
              versions: exists ? collectVersions(workspace, activeVersion) : [],
            }),
          }
        }
        if (action === 'status') {
          return { kind: 'success', text: JSON.stringify(workspaceStatus(workspace)) }
        }
        return { kind: 'error', text: `unknown action: ${action}` }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
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

  // Read-only status for the sidebar panel. A failure here must not take the
  // skills down with it, so the registration is guarded independently.
  try {
    ctx.effect(() => ctx.commands.register(evoCommand()))
  } catch (error) {
    log(`could not register the /evo command: ${String(error)}`)
  }
}
