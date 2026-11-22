import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH home: honour DSH_HOME, else ~/.dsh. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv
  return join(homedir(), '.dsh')
}

/** Root of everything this plugin owns on disk. */
export function evoRoot() {
  const fromEnv = process.env.DSH_EVOONTOLOGY_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv
  return join(dshHome(), 'evoontology')
}

/** The one and only truth file (see docs/native-redesign.md §8). */
export function storePath() {
  const fromEnv = process.env.DSH_EVOONTOLOGY_STORE
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv
  return join(evoRoot(), 'store.db')
}

export function runsDir() {
  return join(evoRoot(), 'runs')
}

/** Derived, safe to delete. */
export function derivedDirs() {
  return {
    exports: join(evoRoot(), 'exports'),
    cache: join(evoRoot(), 'cache'),
    viz: join(evoRoot(), 'viz')
  }
}
