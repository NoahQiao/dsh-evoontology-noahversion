import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'evo-plugin-'))
process.env.DSH_EVOONTOLOGY_HOME = join(dir, 'evo')
process.env.DSH_EVOONTOLOGY_STORE = join(dir, 'evo', 'store.db')

const { apply } = await import('../index.js')
const { createSkillProvider } = await import('../lib/skills.js')

let failures = 0
const check = (name, cond, extra) => {
  if (!cond) {
    failures++
    console.log(`FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra))
  } else {
    console.log(`ok   ${name}`)
  }
}

const tools = new Map()
let command = null
let providerFactory = null
const warnings = []
const disposers = []

const ctx = {
  logger: { warn: (message) => warnings.push(message) },
  effect: (factory) => {
    const dispose = factory()
    disposers.push(() => {
      if (typeof dispose === 'function') dispose()
    })
    return dispose
  },
  tools: {
    register: (definition) => {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    }
  },
  commands: {
    register: (definition) => {
      command = definition
      return () => {
        command = null
      }
    }
  },
  skills: {
    registerProvider: (create) => {
      providerFactory = create
      return () => {
        providerFactory = null
      }
    }
  }
}

apply(ctx)

check('registers 11 tools', tools.size === 11, [...tools.keys()])
check('tool names match the design', ['evo_status', 'evo_browse', 'evo_resolve', 'evo_history', 'evo_commit', 'evo_publish', 'evo_revert', 'evo_export', 'evo_query', 'evo_task_start', 'evo_task_finish'].every((n) => tools.has(n)))
check('registers the /evo command', command !== null && command.name === 'evo')
check('registers a skill provider', typeof providerFactory === 'function')

const call = async (name, args) => tools.get(name).execute(args ?? {})
const text = (value) => value.summary

// A patch reused verbatim to prove commit idempotency.
const patchA = {
  summary: 'mon_4b: 功耗与 GPU 口径',
  limitations: ['只覆盖 20 行样本'],
  nodes: {
    upsert: [
      { id: 'ev.pkgW', kind: 'evidence', label: 'pkgW 取值区间', body: { source: 'sqlite:mon_4b#mon_4b', probe: 'SELECT MIN(pkgW),MAX(pkgW) FROM mon_4b', result: 'min=23841 max=36604，量级符合 mW' } },
      { id: 't.package_power', kind: 'term', label: '封装功耗', body: { definition: '整卡封装功率读数', unit: 'mW', evidence: ['ev.pkgW'] } },
      { id: 'm.mon_4b.pkgW', kind: 'mapping', label: 'mon_4b.pkgW → 封装功耗', body: { table: 'mon_4b', column: 'pkgW', term: 't.package_power', transform: 'value/1000 → W', evidence: ['ev.pkgW'] } },
      { id: 'ev.gpuPct', kind: 'evidence', label: 'gpuPct 超过 100', body: { source: 'sqlite:mon_4b#mon_4b', probe: 'SELECT MAX(gpuPct) FROM mon_4b', result: 'max=177.5，说明是相对基线倍数而非占比' } },
      { id: 'c.gpuPct.ratio', kind: 'constraint', label: 'gpuPct 是倍数不是百分比', body: { kind: 'ratio', subject: 'm.mon_4b.gpuPct', value: 'baseline multiple', evidence: ['ev.gpuPct'] } }
    ]
  },
  edges: { upsert: [{ src: 'c.gpuPct.ratio', dst: 't.package_power', type: 'association' }] }
}

// --- empty store
const s0 = await call('evo_status')
check('status ok on an empty store', s0.ok === true && /激活版本：无/.test(text(s0)), text(s0))

const b0 = await call('evo_browse', { query: 'pkgW' })
check('browse explains the missing version', b0.ok === false && /还没有激活版本/.test(text(b0)), text(b0))

// --- commit + idempotency
const commit = await call('evo_commit', patchA)
check('commit created a draft', commit.ok === true && /已创建草稿 v0/.test(text(commit)), text(commit))

const again = await call('evo_commit', patchA)
check('re-commit is idempotent', again.ok === true && /已经包含相同的 patch/.test(text(again)), text(again))

const ungrounded = await call('evo_commit', { summary: 'x', nodes: { upsert: [{ id: 't.bad', kind: 'term', label: 'x', body: { definition: 'x', evidence: ['ev.missing'] } }] } })
check('commit refuses an evidence reference that does not exist', ungrounded.ok === false && /does not validate|not an evidence node/.test(text(ungrounded)), text(ungrounded))

// --- publish (single draft, no argument needed)
const published = await call('evo_publish')
check('publish activates the only draft', published.ok === true && /v0 已激活/.test(text(published)), text(published))

const status = await call('evo_status')
check('status shows the active version and counts', /激活版本：v0/.test(text(status)) && /term 1/.test(text(status)) && /合计 5/.test(text(status)), text(status))

const browsed = await call('evo_browse', { query: 'pkgW' })
check('browse finds the mapping and its evidence', browsed.ok === true && /m\.mon_4b\.pkgW/.test(text(browsed)) && /ev\.pkgW/.test(text(browsed)), text(browsed))

const resolved = await call('evo_resolve', { intent: 'mon_4b 里 pkgW 换算成瓦后的均值' })
check('resolve returns mappings and a skeleton', resolved.ok === true && /字段映射/.test(text(resolved)) && /SELECT pkgW AS/.test(text(resolved)), text(resolved))
check('resolve calls out the unit transform', /package_power/.test(text(resolved)))

const unresolved = await call('evo_resolve', { intent: '完全无关的天气数据' })
check('resolve admits no match instead of inventing', unresolved.ok === true && /未命中/.test(text(unresolved)), text(unresolved))

// --- second version on top of the first
const patchB = {
  summary: '补 vramMB 映射',
  nodes: {
    upsert: [
      { id: 'ev.vram', kind: 'evidence', label: 'vramMB 区间', body: { source: 'sqlite:mon_4b#mon_4b', probe: 'SELECT MAX(vramMB) FROM mon_4b', result: 'max 约 8000MB' } },
      { id: 'm.mon_4b.vramMB', kind: 'mapping', label: 'mon_4b.vramMB → 显存占用', body: { table: 'mon_4b', column: 'vramMB', term: 't.vram', evidence: ['ev.vram'] } }
    ]
  }
}
const v1 = await call('evo_commit', patchB)
check('second commit is v1', v1.ok === true && /已创建草稿 v1/.test(text(v1)), text(v1))

const patchC = await call('evo_commit', {
  summary: '补 freqMHz 映射',
  nodes: {
    upsert: [
      { id: 'ev.freq', kind: 'evidence', label: 'freqMHz 区间', body: { source: 'sqlite:mon_4b#mon_4b', probe: 'SELECT MAX(freqMHz) FROM mon_4b', result: 'max 约 2000MHz' } },
      { id: 'm.mon_4b.freqMHz', kind: 'mapping', label: 'mon_4b.freqMHz → 核心频率', body: { table: 'mon_4b', column: 'freqMHz', term: 't.freq', evidence: ['ev.freq'] } }
    ]
  }
})
check('a second concurrent draft is v2', patchC.ok === true && /已创建草稿 v2/.test(text(patchC)), text(patchC))

const twoDrafts = await call('evo_publish')
check('publish refuses to guess between drafts', twoDrafts.ok === false && /必须指定/.test(text(twoDrafts)), text(twoDrafts))

const history = await call('evo_history', { from: 'v0', to: 'v1' })
check('history shows the diff', history.ok === true && /\+2 节点/.test(text(history)), text(history))

const exported = await call('evo_export', { format: 'markdown' })
check('export writes a markdown file', exported.ok === true && existsSync(exported.data.path), text(exported))
check('exported markdown lists the terms', existsSync(exported.data.path) && /封装功耗/.test(readFileSync(exported.data.path, 'utf8')))

const exportedJson = await call('evo_export', { version: 'v1', format: 'json' })
check('export can target a specific version as json', exportedJson.ok === true && existsSync(exportedJson.data.path) && Array.isArray(JSON.parse(readFileSync(exportedJson.data.path, 'utf8')).nodes))

// --- publish v1, revert to v0, refuse reverting to a draft
await call('evo_publish', { version: 'v1' })
const afterPublish = await call('evo_status')
check('v1 is now active', /激活版本：v1/.test(text(afterPublish)), text(afterPublish))

const reverted = await call('evo_revert', { version: 'v0' })
check('revert points back at v0', reverted.ok === true && /指回 v0/.test(text(reverted)), text(reverted))

const patchD = await call('evo_commit', { summary: '补 t 列映射', nodes: { upsert: [{ id: 'm.mon_4b.t', kind: 'mapping', label: 'mon_4b.t → 时间步', body: { table: 'mon_4b', column: 't', term: 't.time', evidence: ['ev.pkgW'] } }] } })
check('a draft can be added on top of the reverted version', patchD.ok === true && /已创建草稿 v3/.test(text(patchD)), text(patchD))

const badRevert = await call('evo_revert', { version: 'v2' })
check('reverting to a never-published draft is refused', badRevert.ok === false && /never published/.test(text(badRevert)), text(badRevert))

// --- command seat
const runCmd = async (rawInput) => command.handler({ rawInput, commandId: 'c', agent: {}, attachments: [], signal: undefined })
const cmdStatus = await runCmd('/evo status')
check('command status works', cmdStatus.kind === 'success' && /激活：v0/.test(cmdStatus.text), cmdStatus.text)
const cmdVersions = await runCmd('/evo versions')
check('command versions lists every version', cmdVersions.kind === 'success' && /v0/.test(cmdVersions.text) && /v2/.test(cmdVersions.text), cmdVersions.text)
const cmdPath = await runCmd('/evo path')
check('command path prints the store file', cmdPath.kind === 'success' && cmdPath.text.endsWith('store.db'), cmdPath.text)
const cmdDiff = await runCmd('/evo diff v0 v1')
check('command diff counts the additions', cmdDiff.kind === 'success' && /\+2/.test(cmdDiff.text), cmdDiff.text)
const cmdUnknown = await runCmd('/evo nope')
check('command rejects unknown subcommands', cmdUnknown.kind === 'error' && /未知子命令/.test(cmdUnknown.text))
const cmdMultiPublish = await runCmd('/evo publish')
check('command publish refuses to guess between drafts', cmdMultiPublish.kind === 'error' && /请指定/.test(cmdMultiPublish.text), cmdMultiPublish.text)
const cmdDiscard = await runCmd('/evo discard v3')
check('command discards a draft', cmdDiscard.kind === 'success' && /v3 已删除/.test(cmdDiscard.text), cmdDiscard.text)
const cmdDiscardActive = await runCmd('/evo discard v0')
check('command refuses to discard the active version', cmdDiscardActive.kind === 'error' && /only a draft/.test(cmdDiscardActive.text), cmdDiscardActive.text)

// --- skills
const provider = createSkillProvider((m) => warnings.push(m))
const listed = await provider.list()
check('lists 3 skills', listed.candidates.length === 3, listed.candidates.map((c) => c.name))
check('skill names match the design', JSON.stringify(listed.candidates.map((c) => c.name).sort()) === JSON.stringify(['build-ontology', 'evolve-ontology', 'use-ontology']))
const one = await provider.get(listed.candidates[0])
check('loads a skill body', typeof one.content === 'string' && one.content.length > 500, one.content.length)
check('every skill declares a description', listed.candidates.every((c) => typeof c.description === 'string' && c.description.length > 10))

// --- schema sanity
for (const [name, tool] of tools) {
  const rendered = tool.output.render({}, { summary: 'x' })
  check(`${name} renders text`, Array.isArray(rendered) && rendered[0].type === 'text')
  check(`${name} declares object parameters`, tool.parameters && tool.parameters.type === 'object')
  check(`${name} has a description`, typeof tool.description === 'string' && tool.description.length > 20)
}

check('no warnings logged', warnings.length === 0, warnings)

for (const dispose of disposers.reverse()) {
  try {
    await dispose()
  } catch (error) {
    check(`disposer threw: ${String(error)}`, false)
  }
}
check('disposing clears every seat', tools.size === 0 && command === null)
rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? 'ALL PLUGIN CHECKS PASSED' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
