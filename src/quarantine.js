/**
 * Quarantine: disable exactly one loader row in the HOME patch layer.
 *
 * Why the home layer and not the profile: the layer order is
 *   bundle patches -> profile cordis.patch.yml -> $DSH_HOME/cordis.patch.yml -> --patch
 * so a home-layer row wins over the profile while leaving the user's own
 * `cordis.patch.yml` — which normally holds every provider definition —
 * byte-identical. The desktop shell's recovery rewrites that profile file, which
 * is why "disable the bad plugin" currently costs the user all their providers.
 *
 * YAML constraint, learned the hard way: the loader requires the file to parse
 * to a top-level array, and an EMPTY document parses to `undefined`. Releasing
 * the last row must therefore leave `[]`, never a zero-byte file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const HOME_PATCH_FILENAME = 'cordis.patch.yml'
export const MARK_BEGIN = '# >>> dsh-phoenix quarantine — managed, do not edit between these markers'
export const MARK_END = '# <<< dsh-phoenix quarantine'

export function homePatchPath(home) {
  return join(home, HOME_PATCH_FILENAME)
}

/** Remove this plugin's managed block, preserving everything around it. */
export function stripManagedBlock(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const start = text.indexOf(MARK_BEGIN)
  if (start < 0) return text
  const end = text.indexOf(MARK_END, start)
  if (end < 0) return text.slice(0, start)
  return text.slice(0, start) + text.slice(end + MARK_END.length)
}

/** Read the row ids this plugin currently quarantines. */
export function readQuarantined(home) {
  const path = homePatchPath(home)
  if (!existsSync(path)) return []
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const start = text.indexOf(MARK_BEGIN)
  const end = text.indexOf(MARK_END, start)
  if (start < 0 || end < 0) return []
  const body = text.slice(start + MARK_BEGIN.length, end)
  const ids = []
  for (const line of body.split('\n')) {
    const hit = /^-\s*id:\s*(.+)$/u.exec(line.trim())
    if (!hit) continue
    try {
      ids.push(JSON.parse(hit[1]))
    } catch {
      ids.push(hit[1].replace(/^["']|["']$/g, ''))
    }
  }
  return ids
}

function renderBlock(ids) {
  if (ids.length === 0) return ''
  const rows = ids.map((id) => `- id: ${JSON.stringify(id)}\n  disabled: true`).join('\n')
  return `${MARK_BEGIN}\n${rows}\n${MARK_END}\n`
}

/**
 * Compose the next patch-file text.
 * Exported for tests: this is where the empty-document bug lived.
 */
export function composePatchText(existing, ids) {
  const base = stripManagedBlock(existing).trim()
  const block = renderBlock(ids)
  if (base.length === 0 || base === '[]') return block.length === 0 ? '[]\n' : block
  return `${base}\n${block}`
}

/** Rewrite the managed block atomically. Returns the written path. */
export function writeQuarantine(home, ids) {
  const path = homePatchPath(home)
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const content = composePatchText(existing, ids)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.phoenix-${process.pid}.tmp`
  writeFileSync(temp, content)
  renameSync(temp, path)
  return path
}
