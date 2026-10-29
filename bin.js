#!/usr/bin/env node
/**
 * dsh-phoenix CLI — the part that works when no plugin could load.
 *
 * The in-process guard cannot help a failure that happens before any plugin
 * activates: a malformed patch layer, a `!!js` expression that throws, a broken
 * import. For those DSH only offers the desktop shell's nuclear recovery. This
 * CLI is the narrow alternative: read the records, name the culprit, and print a
 * minimal overlay that disables exactly that row.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { composePatchText, homePatchPath, readQuarantined } from './src/quarantine.js'
import { logDirectory, logPath, pruneRecords, readRecords } from './src/log.js'
import { readPendingRemovals } from './src/recovery.js'
import { resolveHome } from './index.js'

function out(line = '') {
  process.stdout.write(`${line}\n`)
}

function err(line) {
  process.stderr.write(`${line}\n`)
}

function commandStatus(home) {
  const ids = readQuarantined(home)
  const records = readRecords(home)
  const contained = records.filter((entry) => entry.decision === 'quarantined')
  const pending = readPendingRemovals(home)
  const activation = [...records].reverse().find((entry) => entry.kind === 'guard-activated')
  out(`home:        ${home}`)
  out(`records:     ${logDirectory(home)}`)
  out(`count:       ${records.length}`)
  out(`quarantined: ${ids.length === 0 ? '(none)' : ids.join(', ')}`)
  out(`pending:     ${pending.length === 0 ? '(none)' : pending.map((item) => item.package).join(', ')}`)
  if (activation?.restart !== undefined) {
    out(
      `auto-restart:${activation.restart.ok === true ? ' available' : ` unavailable (${activation.restart.reason})`}`,
    )
  }
  if (contained.length > 0) {
    out()
    out('recent containments:')
    for (const entry of contained.slice(-10)) {
      out(`  ${entry.at}  ${entry.package ?? '?'}  ->  ${(entry.quarantinedIds ?? []).join(', ')}`)
    }
  }
  return 0
}

function commandDoctor(home) {
  const records = readRecords(home)
  if (records.length === 0) {
    out('No dsh-phoenix records found.')
    out(`Looked in: ${logDirectory(home)}`)
    out('If DSH never started, the failure came before any plugin loaded.')
    out('Next: check the desktop crash report (crash-*.log), or run `dsh --dump-config`.')
    return 0
  }

  const failures = records.filter((entry) => entry.kind !== 'guard-activated')
  out(`records: ${records.length} (failures: ${failures.length})`)

  const latest = failures[failures.length - 1]
  if (latest === undefined) {
    out('Only activation records; nothing was ever contained.')
    return 0
  }

  out()
  out(`last failure: ${latest.at}`)
  out(`  kind:     ${latest.kind}`)
  out(`  package:  ${latest.package ?? '(unattributed)'}`)
  out(`  decision: ${latest.decision} (${latest.reason})`)
  if (latest.error?.message) out(`  message:  ${latest.error.message}`)

  if (Array.isArray(latest.rows) && latest.rows.length > 0) {
    out()
    out('  candidate rows:')
    for (const row of latest.rows) out(`    ${row.id}  <-  ${row.name}`)
  }

  const byPackage = new Map()
  for (const entry of failures) {
    if (typeof entry.package !== 'string') continue
    byPackage.set(entry.package, (byPackage.get(entry.package) ?? 0) + 1)
  }
  if (byPackage.size > 0) {
    out()
    out('  failures by package:')
    for (const [pkg, count] of [...byPackage].sort((a, b) => b[1] - a[1])) {
      out(`    ${String(count).padStart(3)}  ${pkg}`)
    }
  }

  if (typeof latest.package === 'string' && Array.isArray(latest.rows) && latest.rows.length > 0) {
    out()
    out('  minimal overlay to boot without it (your profile is untouched):')
    out('    dsh --profile <name> --patch <overlay.yml>')
    out('    where <overlay.yml> contains:')
    for (const row of latest.rows) {
      out(`      - id: ${JSON.stringify(row.id)}`)
      out('        disabled: true')
    }
  }
  return 0
}

function commandRestore(home, args) {
  const target = args[0]
  const ids = readQuarantined(home)
  if (ids.length === 0) {
    out('Nothing is quarantined.')
    return 0
  }
  if (target === undefined) {
    out(`quarantined: ${ids.join(', ')}`)
    out('Usage: dsh-phoenix restore <rowId>|--all')
    return 1
  }
  const keep = target === '--all' ? [] : ids.filter((id) => id !== target)
  if (target !== '--all' && keep.length === ids.length) {
    err(`"${target}" is not quarantined.`)
    return 1
  }
  const path = homePatchPath(home)
  const text = readFileSync(path, 'utf8')
  const content = composePatchText(text, keep)
  const temp = `${path}.phoenix-restore-${process.pid}.tmp`
  writeFileSync(temp, content)
  renameSync(temp, path)
  out(`restored: ${target === '--all' ? ids.join(', ') : target}`)
  out('Restart DSH for the change to take effect.')
  return 0
}

function commandLogs(home, args) {
  const limit = Number(args[0] ?? 20)
  const records = readRecords(home).filter((entry) => entry.kind !== 'guard-activated')
  if (records.length === 0) {
    out('No failures recorded.')
    return 0
  }
  for (const entry of records.slice(-limit)) {
    out(`${entry.at}  ${entry.kind}  ${entry.package ?? '?'}  ${entry.decision}`)
    const message = entry.error?.message
    if (typeof message === 'string' && message.length > 0) {
      out(`    ${message.split('\n')[0]}`)
    }
  }
  return 0
}

function commandPrune(home) {
  const removed = pruneRecords(home, 30)
  out(`pruned ${removed} file(s) older than 30 days`)
  return 0
}

/**
 * Execute queued uninstalls through DSH's own plugin manager path.
 *
 * Deliberately a separate, explicit command: the crash handler only records an
 * intent, because removing a package while the process that runs it is
 * unhealthy is how a profile ends up half-broken. This runs in a clean process,
 * against a profile whose culprit row is already disabled.
 */
function commandFinalize(home, args) {
  const pending = readPendingRemovals(home)
  if (pending.length === 0) {
    out('Nothing queued for removal.')
    return 0
  }
  const profile = args[0] ?? process.env.DSH_PROFILE
  const doIt = args.includes('--yes')
  out(`queued: ${pending.map((item) => item.package).join(', ')}`)
  if (profile === undefined) {
    err('No profile given. Pass one explicitly: dsh-phoenix finalize <profile> [--yes]')
    err('(The crash handler records the profile it saw, but never assumes.)')
    return 1
  }
  out(`profile: ${profile}`)
  if (!doIt) {
    out()
    out('This will run, for each package:')
    out(`  dsh plugin --profile ${profile} remove <package>`)
    out()
    out('Re-run with --yes to execute.')
    return 0
  }
  let failures = 0
  for (const item of pending) {
    if (typeof item.package !== 'string' || item.package.length === 0) continue
    out(`removing ${item.package} …`)
    const result = spawnSync('dsh', ['plugin', '--profile', profile, 'remove', item.package], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (result.status !== 0) {
      err(`remove failed for ${item.package} (exit ${String(result.status ?? 'signal')})`)
      failures += 1
    } else {
      out(`removed ${item.package}`)
    }
  }
  if (failures === 0) {
    out()
    out('All queued removals finished. The queue file is left in place for audit;')
    out('delete it manually once you are satisfied.')
  }
  return failures === 0 ? 0 : 1
}

function commandPath(home) {
  out(homePatchPath(home))
  out(logPath(home))
  return 0
}

async function main(argv) {
  const home = resolveHome()
  const [command, ...args] = argv
  switch (command) {
    case undefined:
    case 'status':
      return commandStatus(home)
    case 'doctor':
      return commandDoctor(home)
    case 'restore':
      return commandRestore(home, args)
    case 'logs':
      return commandLogs(home, args)
    case 'prune':
      return commandPrune(home)
    case 'finalize':
      return commandFinalize(home, args)
    case 'path':
      return commandPath(home)
    case '--version':
    case '-v':
      out('dsh-phoenix 0.1.0')
      return 0
    case '--help':
    case '-h':
    case 'help':
      out(
        [
          'dsh-phoenix — inspect and undo crash containment',
          '',
          '  status              quarantined rows and record count',
          '  doctor              attribute the last failure, print a minimal overlay',
          '  restore <rowId>     un-quarantine one row',
          '  restore --all       un-quarantine everything',
          '  logs [n]            recent contained failures',
          '  prune               drop records older than 30 days',
          '  finalize <profile>  run queued removals (add --yes to execute)',
          '  path                print the patch and log locations',
          '',
          `home: ${home}`,
          '',
        ].join('\n'),
      )
      return 0
    default:
      err(`dsh-phoenix: unknown command "${command}" (try --help)`)
      return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
