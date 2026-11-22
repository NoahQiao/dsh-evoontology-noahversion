/**
 * Skill provider. Skills describe *when* to reach for the semantic layer and
 * what counts as a good answer; they never restate the tool list, because the
 * tool catalog already exposes that and a rewrite of the tools would otherwise
 * invalidate every document.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER = 'evoontology'
const SKILL_DIRS = ['build-ontology', 'use-ontology', 'evolve-ontology']

export const skillsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

/** Split a `---` delimited front matter block; only scalar pairs are read. */
export function splitFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { data: {}, body: text }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key !== '') data[key] = value
  }
  return { data, body: text.slice(match[0].length) }
}

function skillFile(directory) {
  return join(skillsRoot, directory, 'SKILL.md')
}

function candidateOf(directory) {
  const file = skillFile(directory)
  const { data } = splitFrontMatter(readFileSync(file, 'utf8'))
  const summary = {
    name: data.name !== undefined && data.name !== '' ? data.name : directory,
    description: data.description !== undefined ? data.description : '',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: PROVIDER,
    path: file,
    resourceBase: { kind: 'directory', path: join(skillsRoot, directory) }
  }
  if (data.whenToUse !== undefined && data.whenToUse !== '') summary.whenToUse = data.whenToUse
  return summary
}

/** One provider over the shipped skill directories. Bodies load on demand. */
export function createSkillProvider(log) {
  return {
    name: PROVIDER,
    async list() {
      const candidates = []
      for (const directory of SKILL_DIRS) {
        try {
          if (!statSync(join(skillsRoot, directory)).isDirectory()) continue
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
    }
  }
}
