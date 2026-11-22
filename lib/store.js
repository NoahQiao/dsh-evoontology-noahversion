import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { BODY_SCHEMA, EDGE_TYPES, KINDS, describeErrors, validate } from './schema.js'

const SCHEMA_VERSION = '2'

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS version (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES version(id),
  status      TEXT NOT NULL CHECK (status IN ('draft','active','retired')),
  summary     TEXT NOT NULL DEFAULT '',
  limitations TEXT NOT NULL DEFAULT '[]',
  metrics     TEXT NOT NULL DEFAULT '{}',
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  patch_hash  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS version_single_active ON version(status) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS version_patch_hash ON version(patch_hash) WHERE patch_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS node (
  version_id TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
  node_id    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('term','mapping','relation','constraint','evidence')),
  label      TEXT NOT NULL,
  body       TEXT NOT NULL,
  PRIMARY KEY (version_id, node_id)
);

CREATE TABLE IF NOT EXISTS edge (
  version_id TEXT NOT NULL,
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('association','hierarchy','composition','equivalence','derivation')),
  note       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (version_id, src, dst, type),
  FOREIGN KEY (version_id, src) REFERENCES node(version_id, node_id) ON DELETE CASCADE,
  FOREIGN KEY (version_id, dst) REFERENCES node(version_id, node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evidence (
  version_id  TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  source      TEXT NOT NULL,
  probe       TEXT NOT NULL,
  result      TEXT NOT NULL,
  digest      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (version_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS question (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('user','history','generated')),
  provenance  TEXT NOT NULL DEFAULT '[]',
  split       TEXT NOT NULL DEFAULT 'construction' CHECK (split IN ('construction','validation','heldout')),
  data_source TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
  id           TEXT PRIMARY KEY,
  question_id  TEXT NOT NULL,
  version_id   TEXT NOT NULL,
  session_id   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('running','completed','failed','interrupted')),
  final_answer TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT
);

CREATE TABLE IF NOT EXISTS event (
  task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  tool     TEXT NOT NULL,
  args     TEXT NOT NULL,
  result   TEXT NOT NULL,
  error    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, event_id)
);

CREATE TABLE IF NOT EXISTS evaluation (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('parent','candidate','judge')),
  question_id TEXT,
  metrics     TEXT NOT NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('pass','fail','uncertain')),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run (
  id                TEXT PRIMARY KEY,
  parent_version    TEXT NOT NULL,
  candidate_version TEXT,
  status            TEXT NOT NULL CHECK (status IN ('running','accepted','rejected','incomplete')),
  round             INTEGER NOT NULL DEFAULT 0,
  budget            INTEGER NOT NULL,
  end_reason        TEXT,
  started_at        TEXT NOT NULL,
  ended_at          TEXT
);
`

/** Commit-time grounding rule: these kinds must cite at least one evidence node. */
const GROUNDED_KINDS = new Set(['term', 'mapping', 'constraint'])

export function nowIso() {
  return new Date().toISOString()
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Stable JSON: sorted keys, so the same patch always hashes the same. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}

class Transaction {
  constructor(db) {
    this.db = db
  }

  run(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* the original error is the useful one */
      }
      throw error
    }
  }
}

export class OntologyStore {
  constructor(db, file) {
    this.db = db
    this.file = file
    this.tx = new Transaction(db)
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }

  // ---------------------------------------------------------------- reading

  activeVersion() {
    return this.db.prepare("SELECT * FROM version WHERE status='active'").get() ?? null
  }

  getVersion(id) {
    return this.db.prepare('SELECT * FROM version WHERE id = ?').get(id) ?? null
  }

  listVersions() {
    const rows = this.db.prepare('SELECT * FROM version ORDER BY id').all()
    return rows.map((row) => ({ ...row, limitations: parseJson(row.limitations, []), metrics: parseJson(row.metrics, {}) }))
  }

  counts(versionId) {
    const out = {}
    for (const kind of [...KINDS, 'relation']) out[kind] = 0
    const rows = this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM node WHERE version_id = ? GROUP BY kind')
      .all(versionId)
    for (const row of rows) out[row.kind] = Number(row.n)
    out.edges = Number(this.db.prepare('SELECT COUNT(*) AS n FROM edge WHERE version_id = ?').get(versionId).n)
    out.total = KINDS.reduce((sum, kind) => sum + (out[kind] ?? 0), 0)
    return out
  }

  nodes(versionId, kind) {
    const rows = kind
      ? this.db.prepare('SELECT * FROM node WHERE version_id = ? AND kind = ? ORDER BY node_id').all(versionId, kind)
      : this.db.prepare('SELECT * FROM node WHERE version_id = ? ORDER BY kind, node_id').all(versionId)
    return rows.map(shapeNode)
  }

  node(versionId, nodeId) {
    const row = this.db.prepare('SELECT * FROM node WHERE version_id = ? AND node_id = ?').get(versionId, nodeId)
    return row ? shapeNode(row) : null
  }

  edges(versionId) {
    return this.db
      .prepare('SELECT * FROM edge WHERE version_id = ? ORDER BY src, dst, type')
      .all(versionId)
      .map((row) => ({ ...row }))
  }

  evidence(versionId) {
    return this.db.prepare('SELECT * FROM evidence WHERE version_id = ? ORDER BY evidence_id').all(versionId)
  }

  search(versionId, text, kind, limit = 20) {
    const like = `%${text}%`
    const rows = kind
      ? this.db
          .prepare('SELECT * FROM node WHERE version_id = ? AND kind = ? AND (label LIKE ? OR body LIKE ?) ORDER BY kind, node_id LIMIT ?')
          .all(versionId, kind, like, like, limit)
      : this.db
          .prepare('SELECT * FROM node WHERE version_id = ? AND (label LIKE ? OR body LIKE ?) ORDER BY kind, node_id LIMIT ?')
          .all(versionId, like, like, limit)
    return rows.map(shapeNode)
  }

  status() {
    const active = this.activeVersion()
    const drafts = this.db.prepare("SELECT id, created_at FROM version WHERE status='draft' ORDER BY created_at").all()
    const staleDrafts = drafts.filter((d) => Date.now() - Date.parse(d.created_at) > 7 * 24 * 3600 * 1000)
    const latestRun = this.db.prepare('SELECT * FROM run ORDER BY started_at DESC LIMIT 1').get() ?? null
    const evaluations = Number(this.db.prepare('SELECT COUNT(*) AS n FROM evaluation').get().n)
    return {
      storePath: this.file,
      schemaVersion: SCHEMA_VERSION,
      active: active ? shapeVersion(active) : null,
      counts: active ? this.counts(active.id) : null,
      drafts: drafts.map((d) => d.id),
      staleDrafts: staleDrafts.map((d) => d.id),
      latestRun: latestRun ? { ...latestRun } : null,
      evaluations,
      versions: this.listVersions().map((v) => ({ id: v.id, status: v.status, parent: v.parent_id, summary: v.summary }))
    }
  }

  // ---------------------------------------------------------------- writing

  /**
   * Apply a patch and land it as a new draft version.
   * Idempotent: the same patch body returns the version that already carries it.
   */
  applyPatch(patch, options = {}) {
    if (!patch || typeof patch !== 'object') throw userError('patch must be an object')
    const nodes = normalizeCollection(patch.nodes, 'nodes')
    const edges = normalizeCollection(patch.edges, 'edges')

    const active = this.activeVersion()
    if (patch.base !== undefined && patch.base !== null && patch.base !== (active ? active.id : null)) {
      throw userError(`base version mismatch: patch expects ${patch.base}, active is ${active ? active.id : 'none'}`)
    }

    const parentId = patch.base === null ? null : active ? active.id : null
    const working = this.workingSet(parentId, nodes, edges)

    const problems = validateWorkingSet(working)
    if (problems.length) throw userError(`patch does not validate: ${describeErrors(problems)}`)

    const hash = sha256(
      canonicalJson({
        parent: parentId,
        summary: patch.summary ?? '',
        limitations: patch.limitations ?? [],
        nodes: { upsert: nodes.upsert, remove: [...nodes.remove].sort() },
        edges: { upsert: edges.upsert, remove: edges.remove }
      })
    )
    const seen = this.db.prepare('SELECT id FROM version WHERE patch_hash = ?').get(hash)
    if (seen) return { id: seen.id, created: false, hash }

    const createdAt = nowIso()
    const id = this.tx.run(() => {
      const nextId = this.nextVersionId()
      this.db
        .prepare(
          'INSERT INTO version (id, parent_id, status, summary, limitations, metrics, created_by, created_at, patch_hash) VALUES (?,?,?,?,?,?,?,?,?)'
        )
        .run(
          nextId,
          parentId,
          'draft',
          String(patch.summary ?? ''),
          JSON.stringify(patch.limitations ?? []),
          '{}',
          String(options.createdBy ?? patch.createdBy ?? 'user'),
          createdAt,
          hash
        )

      // Versions are immutable snapshots: carry the parent's node/edge/evidence
      // set forward, then apply the delta. Copy-on-write keeps reads flat and
      // makes the foreign keys on `edge` honest.
      if (parentId) {
        this.db
          .prepare('INSERT INTO node (version_id, node_id, kind, label, body) SELECT ?, node_id, kind, label, body FROM node WHERE version_id = ?')
          .run(nextId, parentId)
        this.db
          .prepare('INSERT INTO edge (version_id, src, dst, type, note) SELECT ?, src, dst, type, note FROM edge WHERE version_id = ?')
          .run(nextId, parentId)
        this.db
          .prepare(
            'INSERT INTO evidence (version_id, evidence_id, source, probe, result, digest, created_at) SELECT ?, evidence_id, source, probe, result, digest, created_at FROM evidence WHERE version_id = ?'
          )
          .run(nextId, parentId)
      }

      for (const nodeId of nodes.remove) {
        this.db.prepare('DELETE FROM node WHERE version_id = ? AND node_id = ?').run(nextId, nodeId)
      }
      for (const node of nodes.upsert) {
        const body = { ...node.body }
        if (node.kind === 'evidence' && !body.digest) body.digest = sha256(String(body.result ?? ''))
        this.db
          .prepare('INSERT OR REPLACE INTO node (version_id, node_id, kind, label, body) VALUES (?,?,?,?,?)')
          .run(nextId, node.id, node.kind, node.label, JSON.stringify(body))
        if (node.kind === 'evidence') {
          this.db
            .prepare('INSERT OR REPLACE INTO evidence (version_id, evidence_id, source, probe, result, digest, created_at) VALUES (?,?,?,?,?,?,?)')
            .run(nextId, node.id, String(body.source ?? ''), String(body.probe ?? ''), String(body.result ?? ''), String(body.digest), createdAt)
        }
      }
      for (const edge of edges.remove) {
        this.db.prepare('DELETE FROM edge WHERE version_id = ? AND src = ? AND dst = ? AND type = ?').run(nextId, edge.src, edge.dst, edge.type)
      }
      for (const edge of edges.upsert) {
        this.db
          .prepare('INSERT OR REPLACE INTO edge (version_id, src, dst, type, note) VALUES (?,?,?,?,?)')
          .run(nextId, edge.src, edge.dst, edge.type, String(edge.note ?? ''))
      }
      return nextId
    })

    return { id, created: true, hash }
  }

  publish(versionId, options = {}) {
    const version = this.getVersion(versionId)
    if (!version) throw userError(`no such version: ${versionId}`)
    if (version.status === 'active') return { id: versionId, changed: false, status: 'active' }
    if (version.status !== 'draft') throw userError(`only a draft can be published; ${versionId} is ${version.status}`)

    const problems = this.groundingProblems(versionId)
    if (problems.length) throw userError(`cannot publish ${versionId}: ${problems.join('; ')}`)

    this.tx.run(() => {
      const current = this.activeVersion()
      if (current) this.db.prepare("UPDATE version SET status='retired' WHERE id = ?").run(current.id)
      this.db.prepare("UPDATE version SET status='active' WHERE id = ?").run(versionId)
    })
    return { id: versionId, changed: true, status: 'active', publishedBy: options.publishedBy ?? 'user' }
  }

  revert(versionId) {
    const target = this.getVersion(versionId)
    if (!target) throw userError(`no such version: ${versionId}`)
    if (target.status === 'active') return { id: versionId, changed: false, status: 'active' }
    if (target.status === 'draft') throw userError(`${versionId} was never published; publish it instead of reverting to it`)
    if (target.status !== 'retired') throw userError(`cannot revert to a ${target.status} version`)
    this.tx.run(() => {
      const current = this.activeVersion()
      if (current) this.db.prepare("UPDATE version SET status='retired' WHERE id = ?").run(current.id)
      this.db.prepare("UPDATE version SET status='active' WHERE id = ?").run(versionId)
    })
    return { id: versionId, changed: true, status: 'active' }
  }

  discard(versionId) {
    const version = this.getVersion(versionId)
    if (!version) throw userError(`no such version: ${versionId}`)
    if (version.status !== 'draft') throw userError(`only a draft can be discarded; ${versionId} is ${version.status}`)
    this.tx.run(() => {
      this.db.prepare('DELETE FROM evidence WHERE version_id = ?').run(versionId)
      this.db.prepare('DELETE FROM version WHERE id = ?').run(versionId)
    })
    return { id: versionId, discarded: true }
  }

  // ---------------------------------------------------------------- internals

  nextVersionId() {
    const rows = this.db.prepare("SELECT id FROM version WHERE id GLOB 'v[0-9]*'").all()
    let max = -1
    for (const row of rows) {
      const n = Number(String(row.id).slice(1))
      if (Number.isInteger(n) && n > max) max = n
    }
    return `v${max + 1}`
  }

  /**
   * Materialise the node/edge set a draft would have, without writing it.
   * Everything is validated against this set, so a patch that cites a node it
   * does not carry is rejected before a transaction opens.
   */
  workingSet(parentId, nodes, edges) {
    const byId = new Map()
    if (parentId) {
      for (const node of this.nodes(parentId)) byId.set(node.id, node)
    }
    for (const nodeId of nodes.remove) byId.delete(nodeId)
    for (const node of nodes.upsert) byId.set(node.id, node)

    const edgeMap = new Map()
    if (parentId) {
      for (const edge of this.edges(parentId)) edgeMap.set(edgeKey(edge), edge)
    }
    for (const edge of edges.remove) edgeMap.delete(edgeKey(edge))
    for (const edge of edges.upsert) edgeMap.set(edgeKey(edge), edge)

    return { byId, edgeMap }
  }

  groundingProblems(versionId) {
    const problems = []
    const nodes = this.nodes(versionId)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    for (const node of nodes) {
      if (!GROUNDED_KINDS.has(node.kind)) continue
      const cited = Array.isArray(node.body.evidence) ? node.body.evidence : []
      if (!cited.length) {
        problems.push(`${node.id} (${node.kind}) cites no evidence`)
        continue
      }
      for (const ref of cited) {
        const target = byId.get(ref)
        if (!target || target.kind !== 'evidence') problems.push(`${node.id} cites ${ref}, which is not an evidence node in ${versionId}`)
      }
    }
    const edges = this.edges(versionId)
    for (const edge of edges) {
      if (!byId.has(edge.src)) problems.push(`edge ${edge.src} → ${edge.dst} has a missing source node`)
      if (!byId.has(edge.dst)) problems.push(`edge ${edge.src} → ${edge.dst} has a missing target node`)
    }
    return problems
  }
}

function shapeNode(row) {
  return { id: row.node_id, kind: row.kind, label: row.label, body: parseJson(row.body, {}) }
}

function shapeVersion(row) {
  return {
    id: row.id,
    parent: row.parent_id,
    status: row.status,
    summary: row.summary,
    limitations: parseJson(row.limitations, []),
    metrics: parseJson(row.metrics, {}),
    createdBy: row.created_by,
    createdAt: row.created_at
  }
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function edgeKey(edge) {
  return `${edge.src}\u0000${edge.dst}\u0000${edge.type}`
}

function userError(message) {
  const error = new Error(message)
  error.code = 'EVO_BAD_REQUEST'
  return error
}

export { userError }

function normalizeCollection(input, name) {
  if (input === undefined || input === null) return { upsert: [], remove: [] }
  if (Array.isArray(input)) {
    if (name === 'edges') return { upsert: input.map(normalizeEdge), remove: [] }
    return { upsert: input.map(normalizeNode), remove: [] }
  }
  if (typeof input !== 'object') throw userError(`${name} must be an object or an array`)
  if (name === 'edges') {
    return {
      upsert: (input.upsert ?? []).map(normalizeEdge),
      remove: (input.remove ?? []).map(normalizeEdge)
    }
  }
  return {
    upsert: (input.upsert ?? []).map(normalizeNode),
    remove: (input.remove ?? []).map((entry) => (typeof entry === 'string' ? entry : entry?.id))
  }
}

function normalizeNode(entry) {
  if (!entry || typeof entry !== 'object') throw userError('each node must be an object')
  if (!entry.id || typeof entry.id !== 'string') throw userError('each node needs a string id')
  if (!entry.kind || typeof entry.kind !== 'string') throw userError(`node ${entry.id} needs a kind`)
  if (entry.kind === 'relation') {
    throw userError(
      `node ${entry.id}: 'relation' is not a node kind in the native design — model it as an edge with one of: ${EDGE_TYPES.join(', ')} (docs/native-redesign.md §4 note 2)`
    )
  }
  if (!KINDS.includes(entry.kind)) throw userError(`node ${entry.id}: kind must be one of ${KINDS.join(', ')}`)
  const body = entry.body ?? {}
  const errors = validate(body, BODY_SCHEMA[entry.kind], `node ${entry.id}.body`)
  if (errors.length) throw userError(`node ${entry.id}: ${describeErrors(errors)}`)
  const label = String(entry.label ?? body.definition ?? body.column ?? body.subject ?? entry.id)
  return { id: entry.id, kind: entry.kind, label, body }
}

function normalizeEdge(entry) {
  if (!entry || typeof entry !== 'object') throw userError('each edge must be an object')
  const { src, dst, type } = entry
  if (!src || !dst) throw userError('each edge needs src and dst')
  if (!EDGE_TYPES.includes(type)) throw userError(`edge ${src} → ${dst}: type must be one of ${EDGE_TYPES.join(', ')}`)
  return { src, dst, type, note: String(entry.note ?? '') }
}

function validateWorkingSet(working) {
  const problems = []
  const byId = working.byId

  for (const node of byId.values()) {
    if (!KINDS.includes(node.kind)) problems.push({ path: node.id, message: `unsupported kind ${node.kind}` })
  }

  for (const node of byId.values()) {
    if (!GROUNDED_KINDS.has(node.kind)) continue
    const cited = Array.isArray(node.body.evidence) ? node.body.evidence : []
    if (!cited.length) {
      problems.push({ path: `${node.id}.evidence`, message: 'must cite at least one evidence node (P2: semantics must be grounded)' })
      continue
    }
    for (const ref of cited) {
      const target = byId.get(ref)
      if (!target) problems.push({ path: `${node.id}.evidence`, message: `cites ${ref}, which is not in this version` })
      else if (target.kind !== 'evidence') problems.push({ path: `${node.id}.evidence`, message: `cites ${ref}, which is a ${target.kind}, not evidence` })
    }
  }

  for (const edge of working.edgeMap.values()) {
    if (!byId.has(edge.src)) problems.push({ path: `${edge.src} → ${edge.dst}`, message: 'edge source is not a node in this version' })
    if (!byId.has(edge.dst)) problems.push({ path: `${edge.src} → ${edge.dst}`, message: 'edge target is not a node in this version' })
  }

  return problems
}

export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(DDL)
  const existing = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  if (!existing) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION)
    db.prepare("INSERT INTO meta (key, value) VALUES ('created_at', ?)").run(nowIso())
  }
  return new OntologyStore(db, file)
}
