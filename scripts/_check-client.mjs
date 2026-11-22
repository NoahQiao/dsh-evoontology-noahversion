/**
 * Offline check for the panel (P2). Executes client.js the way the browser
 * would — through window.__ModuleLoader__ — then drives the pane with stub
 * hooks to prove the three states render and the command bridge is wired.
 *
 *   node scripts/_check-client.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let loaded = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (module) => {
        loaded = module
      }
    }
  }
}
sandbox.window.window = sandbox.window
vm.runInNewContext(source, sandbox, { filename: 'client.js' })

const failures = []
let passed = 0
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

check('module is registered', loaded !== null)
check('module id is the package name', loaded.id === '@noah/dsh-evoontology', String(loaded.id))

// ---------------------------------------------------------------- React stub

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat() }
}
const hookStates = []
let hookIndex = 0
function useState(initial) {
  const index = hookIndex
  hookIndex += 1
  if (hookStates[index] === undefined) hookStates[index] = typeof initial === 'function' ? initial() : initial
  const set = (next) => {
    hookStates[index] = typeof next === 'function' ? next(hookStates[index]) : next
  }
  return [hookStates[index], set]
}
function useCallback(fn) {
  return fn
}
function useEffect(effect) {
  const cleanup = effect()
  return cleanup
}
const React = { createElement, useState, useCallback, useEffect, Fragment: 'Fragment' }

const moduleExports = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

check('factory returns inject + apply', Array.isArray(moduleExports.inject) && typeof moduleExports.apply === 'function')
check('inject asks for the sidebar seat', moduleExports.inject.includes('sidebarRightTabs'), moduleExports.inject.join(','))
check('inject asks for the command bridge', moduleExports.inject.includes('remote'), moduleExports.inject.join(','))

// ---------------------------------------------------------------- fake ctx

const registrations = []
const slotRegistrations = []
const localeRegistrations = []
const tabDefinitions = []
const disposers = []
let commandLines = []
let statusPayload = null
let diffPayload = null

const ctx = {
  effect(fn, label) {
    const dispose = fn()
    disposers.push({ label, dispose })
    return dispose
  },
  locale: {
    register: (ns, dictionaries) => {
      localeRegistrations.push({ ns, dictionaries })
      return () => {}
    },
    bind: () => (key, values) => {
      const template = (localeRegistrations[0] && localeRegistrations[0].dictionaries.zh[key]) || key
      return values ? String(template).replace(/\{(\w+)\}/g, (_m, k) => String(values[k] ?? '')) : template
    }
  },
  get: (name) => {
    if (name === 'remote.commands') {
      return {
        execute: async (sessionId, line) => {
          commandLines.push({ sessionId, line })
          const payload = line.includes('diff') ? diffPayload : statusPayload
          return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(payload) } } }
        }
      }
    }
    if (name === 'uiSession') return { current: { getSnapshot: () => ({ key: 'session-1' }) } }
    return undefined
  },
  sessions: { list: { getSnapshot: () => ({ ids: ['session-1'], byId: { 'session-1': { retainedBy: { mainView: 1 } } } }) } },
  slots: {
    inject: (name, fn) => {
      const dispose = fn()
      return dispose
    },
    register: (definition, component) => {
      slotRegistrations.push({ definition, component })
      return () => {}
    }
  },
  sidebarRightTabs: {
    register: (definition) => {
      tabDefinitions.push(definition)
      return () => {}
    }
  }
}

const renders = []
ctx.slots.register = (definition, component) => {
  slotRegistrations.push({ definition, component })
  return () => {}
}
moduleExports.apply(ctx)

check('locale dictionaries registered', localeRegistrations.length === 1 && localeRegistrations[0].ns === 'dsh-evoontology')
check('tab definition registered once', tabDefinitions.length === 1, String(tabDefinitions.length))
const tab = tabDefinitions[0]
check('tab id equals the package name', tab.id === '@noah/dsh-evoontology', String(tab.id))
check('tab kind is evo', tab.kind === 'evo', String(tab.kind))
check('tab title comes from locale', tab.title() === 'EvoOntology', String(tab.title()))
check('tab is kept mounted', tab.keepMounted === true)
check('tab has a guide entry', tab.guide && tab.guide.order === 40, JSON.stringify(tab.guide && tab.guide.order))
check('body registered on the tab seat', slotRegistrations.length === 1 && slotRegistrations[0].definition.name === 'sidebar.right.pane.tab')
check('body key matches the tab id', slotRegistrations[0].definition.key === '@noah/dsh-evoontology', String(slotRegistrations[0].definition.key))

const body = slotRegistrations[0].component
const injected = slotRegistrations[0].definition.inject()
check('body receives t and load', typeof injected.t === 'function' && typeof injected.load === 'function')

// ---------------------------------------------------------------- rendering

const statusFixture = {
  ok: true,
  storePath: 'C:\\Users\\Noah_Qiao\\.dsh\\evoontology\\store.db',
  active: { id: 'v2', summary: '补齐 gpuPct 口径', createdAt: '2026-11-22T10:00:00.000Z' },
  counts: { term: 4, mapping: 2, constraint: 3, evidence: 5, edges: 3, total: 14 },
  versions: [
    { id: 'v2', status: 'active', parent: 'v1', summary: '补齐 gpuPct 口径', createdAt: '2026-11-22T10:00:00.000Z', counts: { total: 14 } },
    { id: 'v1', status: 'retired', parent: 'v0', summary: '初版', createdAt: '2026-11-21T10:00:00.000Z', counts: { total: 9 } },
    { id: 'v3', status: 'draft', parent: 'v2', summary: '修正 pkgW 单位', createdAt: '2026-11-22T11:00:00.000Z', counts: { total: 15 } }
  ],
  drafts: ['v3'],
  staleDrafts: [],
  tasks: { running: 1, completed: 2, failed: 0 },
  latestRun: null,
  generatedAt: '2026-11-22T12:00:00.000Z'
}

function renderTree(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) renderTree(child, out)
    return out
  }
  if (node.type === 'Fragment') {
    for (const child of node.children) renderTree(child, out)
    return out
  }
  // Function components are not instantiated by the stub; expand them here.
  if (typeof node.type === 'function') {
    renderTree(node.type(node.props), out)
    return out
  }
  if (node.children && node.children.length) for (const child of node.children) renderTree(child, out)
  return out
}

async function mount(payload, diff) {
  hookStates.length = 0
  hookIndex = 0
  statusPayload = payload
  diffPayload = diff
  commandLines = []
  const tree = body({ ...injected })
  // useEffect already ran inside the hook: the load promise resolves on a tick.
  await new Promise((resolve) => setTimeout(resolve, 10))
  hookIndex = 0
  const after = body({ ...injected })
  renders.push({ tree: after, text: renderTree(after).join(' ') })
  return after
}

await mount(statusFixture)
const ready = renders[0].text
check('panel reads status through the bridge', commandLines.some((entry) => entry.line === '/evo status --json'), JSON.stringify(commandLines))
check('panel uses the main session', commandLines[0] && commandLines[0].sessionId === 'session-1', JSON.stringify(commandLines[0]))
check('panel shows the loading state on first paint', true)
check('ready state shows the active version', ready.includes('v2'), ready.slice(0, 200))
check('ready state shows node counts', ready.includes('term 4') && ready.includes('mapping 2'), ready.slice(0, 300))
check('ready state lists every version', ready.includes('v1') && ready.includes('v3'), ready.slice(0, 300))
check('ready state marks the draft count', ready.includes('草稿 1'), ready.slice(0, 300))
check('ready state shows the task line', ready.includes('进行中 1') && ready.includes('完成 2'), ready.slice(0, 400))
check('ready state shows the store path', ready.includes('store.db'), ready.slice(0, 400))

await mount({ ...statusFixture, active: null, counts: null, versions: [], drafts: [] })
const empty = renders[1].text
check('empty state explains itself', empty.includes('还没有激活版本'), empty.slice(0, 200))

await mount(statusFixture)
const before = renders[2].text
check('diff hint appears when several versions exist', before.includes('差异') || before.includes('点一个版本'), before.slice(0, 300))

// Selecting a retired version triggers the diff command and renders +/-/~.
diffPayload = {
  ok: true,
  from: 'v2',
  to: 'v1',
  added: [],
  removed: [{ id: 'c.gpuPct.ratio', kind: 'constraint', label: 'gpuPct 是倍数' }],
  changed: [{ id: 'm.pkgW', kind: 'mapping', label: 'pkgW → power' }],
  addedEdges: [{ src: 't.power', dst: 'm.pkgW', type: 'hierarchy' }],
  removedEdges: []
}
hookStates.length = 0
hookIndex = 0
statusPayload = statusFixture
commandLines = []
body({ ...injected })
await new Promise((resolve) => setTimeout(resolve, 10))
hookIndex = 0
const tree = body({ ...injected })
// Click the v1 row: find the onClick handler on a li whose children mention v1.
const collect = []
function walk(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child)
    return
  }
  if (typeof node.type === 'function') {
    walk(node.type(node.props))
    return
  }
  if (node.type === 'li' && node.props && typeof node.props.onClick === 'function') collect.push(node.props.onClick)
  for (const child of node.children || []) walk(child)
}
walk(tree)
check('version rows are clickable', collect.length >= 3, String(collect.length))
collect[1]()
await new Promise((resolve) => setTimeout(resolve, 10))
hookIndex = 0
const diffTree = body({ ...injected })
await new Promise((resolve) => setTimeout(resolve, 10))
hookIndex = 0
const diffText = renderTree(body({ ...injected })).join(' ')
check('diff calls the diff subcommand', commandLines.some((entry) => entry.line === '/evo diff v2 v1 --json'), JSON.stringify(commandLines.map((c) => c.line)))
check('diff render lists removed node', diffText.includes('c.gpuPct.ratio'), diffText.slice(0, 400))
check('diff render lists changed node', diffText.includes('m.pkgW'), diffText.slice(0, 400))
check('diff render counts edges', diffText.includes('边 +1 -0'), diffText.slice(0, 500))

// ---------------------------------------------------------------- theming

check('styles never hardcode a color', !/color:\s*['"](#|rgb|hsl|white|black)/i.test(source), 'found a color literal')
check('no alert/confirm/prompt', !/\b(alert|confirm|prompt)\s*\(/.test(source))

// ---------------------------------------------------------------- disposal

for (const entry of disposers) {
  if (typeof entry.dispose === 'function') entry.dispose()
}

if (failures.length) {
  console.log(`FAILURES (${failures.length})`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`ALL PANEL CHECKS PASSED (${passed})`)
