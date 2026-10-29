/**
 * Crash records: one JSONL line per decision, written synchronously.
 *
 * Synchronous on purpose. A record is often written while the process is
 * unhealthy, and the one thing that must never happen is losing the reason.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const LOG_DIRNAME = 'crash-guard'

export function logDirectory(home) {
  return join(home, 'logs', LOG_DIRNAME)
}

/** Local calendar day, so a user reading the directory sees their own date. */
export function localDay(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function logPath(home, now = new Date()) {
  return join(logDirectory(home), `${localDay(now)}.jsonl`)
}

/** Append one record. Failures go to stderr and never throw. */
export function writeRecord(home, record, file = logPath(home)) {
  try {
    mkdirSync(logDirectory(home), { recursive: true })
    appendFileSync(file, `${JSON.stringify(record)}\n`)
    return true
  } catch (error) {
    try {
      process.stderr.write(`dsh-phoenix: could not write crash log: ${String(error)}\n`)
    } catch {
      /* stderr itself is gone */
    }
    return false
  }
}

/** Read every record, oldest file first. A torn final line is ignored. */
export function readRecords(home) {
  const dir = logDirectory(home)
  let names
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  const records = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        records.push({ ...JSON.parse(line), file: path })
      } catch {
        /* torn tail */
      }
    }
  }
  return records
}

/** Drop record files older than `days`. */
export function pruneRecords(home, days = 30, now = Date.now()) {
  const dir = logDirectory(home)
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  const cutoff = now - days * 24 * 60 * 60 * 1000
  let removed = 0
  for (const name of names) {
    const path = join(dir, name)
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path)
        removed += 1
      }
    } catch {
      /* skip */
    }
  }
  return removed
}
