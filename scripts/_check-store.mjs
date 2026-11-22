import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStore } from '../lib/store.js'

const dir = mkdtempSync(join(tmpdir(), 'evo-store-'))
const file = join(dir, 'store.db')
let failures = 0
const check = (name, cond, extra) => {
  if (!cond) {
    failures++
    console.log(`FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra))
  } else {
    console.log(`ok   ${name}`)
  }
}

const store = openStore(file)
check('empty store has no active version', store.status().active === null)
check('lists no versions', store.status().versions.length === 0)

const evNode = {
  id: 'ev.pkgW',
  kind: 'evidence',
  label: 'pkgW value range',
  body: { source: 'sqlite:mon_4b#mon_4b.pkgW', probe: 'SELECT MIN(pkgW), MAX(pkgW) FROM mon_4b', result: 'min=23841 max=36604' }
}
const termNode = {
  id: 't.pkgW',
  kind: 'term',
  label: 'package power',
  body: { definition: 'package-level power reading', unit: 'mW', evidence: ['ev.pkgW'] }
}
const mapNode = {
  id: 'm.pkgW',
  kind: 'mapping',
  label: 'mon_4b.pkgW -> package power',
  body: { table: 'mon_4b', column: 'pkgW', term: 't.pkgW', transform: 'value/1000 -> W', evidence: ['ev.pkgW'] }
}
const basePatch = { summary: 'v0: mon_4b semantics', nodes: { upsert: [evNode, termNode, mapNode] } }

// --- ungrounded node is rejected
let rejected = null
try {
  store.applyPatch({ summary: 'bad', nodes: { upsert: [{ id: 't.unit', kind: 'term', body: { definition: 'no evidence' } }] } })
} catch (error) {
  rejected = error.message
}
check('ungrounded term rejected', /evidence/.test(String(rejected)) && /required|cites/.test(String(rejected)), rejected)

// --- grounded patch lands as a draft
const r1 = store.applyPatch(basePatch)
check('first patch created v0', r1.id === 'v0' && r1.created, r1)
const same = store.applyPatch(basePatch)
check('replaying the same patch is idempotent', same.id === 'v0' && same.created === false, same)

// --- publish
const pub = store.publish('v0')
check('v0 becomes active', pub.status === 'active' && pub.changed)
const s1 = store.status()
check('status reports the active version', s1.active.id === 'v0')
check('counts term/mapping/evidence', s1.counts.term === 1 && s1.counts.evidence === 1 && s1.counts.mapping === 1, s1.counts)

// --- v1 inherits v0's nodes (copy-on-write) and adds a constraint
const r2 = store.applyPatch({
  summary: 'v1: integer mW assumption',
  nodes: {
    upsert: [{ id: 'c.pkgW.unit', kind: 'constraint', label: 'pkgW is integer mW', body: { kind: 'unit', subject: 't.pkgW', value: 'mW', evidence: ['ev.pkgW'] } }]
  },
  edges: { upsert: [{ src: 'c.pkgW.unit', dst: 't.pkgW', type: 'association' }] }
})
check('v1 is a new draft', r2.id === 'v1', r2)
check('v1 inherited all four nodes', store.nodes('v1').length === 4, store.nodes('v1').map((n) => n.id))
check('v1 has the edge', store.edges('v1').length === 1, store.edges('v1'))
check('v1 inherited evidence rows', store.evidence('v1').length === 1)

let baseErr = null
try {
  store.applyPatch({ base: 'v1', summary: 'stale', nodes: { upsert: [] } })
} catch (error) {
  baseErr = error.message
}
check('base must be the active version', /base version mismatch/.test(String(baseErr)), baseErr)

// --- publishing v1 retires v0; revert is O(1)
store.publish('v1')
const afterPublish = store.listVersions()
check('exactly one active', afterPublish.filter((v) => v.status === 'active').length === 1, afterPublish.map((v) => `${v.id}:${v.status}`))
check('v0 retired after publishing v1', afterPublish.find((v) => v.id === 'v0').status === 'retired')

const rev = store.revert('v0')
check('revert makes v0 active again', rev.changed && store.status().active.id === 'v0')
check('v1 retired by revert', store.getVersion('v1').status === 'retired')

let draftRevert = null
try {
  store.applyPatch({ summary: 'v2', nodes: { upsert: [] } })
  store.revert('v2')
} catch (error) {
  draftRevert = error.message
}
check('cannot revert to a never-published draft', /never published/.test(String(draftRevert)), draftRevert)

// --- edges pointing at missing nodes are refused before a transaction opens
let edgeErr = null
try {
  store.applyPatch({ nodes: { upsert: [] }, edges: { upsert: [{ src: 't.pkgW', dst: 't.ghost', type: 'association' }] } })
} catch (error) {
  edgeErr = error.message
}
check('dangling edge refused', /edge target is not a node/.test(String(edgeErr)), edgeErr)

// --- relation kind is refused with guidance
let relationErr = null
try {
  store.applyPatch({ nodes: { upsert: [{ id: 'r1', kind: 'relation', body: {} }] } })
} catch (error) {
  relationErr = error.message
}
check('relation node kind refused', /not a node kind/.test(String(relationErr)) && /edge/.test(String(relationErr)), relationErr)

// --- search + discard
check('search finds the column', store.search('v1', 'pkgW').length >= 2, store.search('v1', 'pkgW').map((n) => n.id))
const draftId = store.listVersions().find((v) => v.status === 'draft')?.id
check('a draft is pending (v2)', draftId === 'v2', draftId)
store.discard(draftId)
check('discard removes the draft and its evidence rows', store.getVersion('v2') === null)

store.close()
rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? 'ALL STORE CHECKS PASSED' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
