/**
 * dsh-phoenix (不死鸟) — keep DSH alive through plugin faults.
 *
 * The premise: a crash is an injury, unavailability is death. DSH ships
 * `installFailLoud`, which turns any unhandled rejection or uncaught exception
 * into `process.exit(1)`. The desktop shell answers that exit with exactly one
 * recovery — disable every third-party bundle and rewrite the profile manifest
 * from the shipped template — which archives `cordis.patch.yml` and takes every
 * provider definition with it. One plugin's bad timer therefore costs the user
 * their whole configuration.
 *
 * This plugin replaces that outcome with: attribute the fault, disable only the
 * failing row, write a detailed record, and keep running.
 *
 * Boundaries, stated plainly:
 *   - A native fault (node-pty / koffi), a V8 OOM abort, SIGKILL, or power loss
 *     still kills the process. Nothing in-process survives those.
 *   - A failure before any plugin activates (`!!js` evaluation, patch parsing,
 *     broken import) cannot be caught here; use the CLI (`bin.js`).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { attribute, causeChain, describe, packageRoot } from './src/attribution.js'
import { readQuarantined, writeQuarantine } from './src/quarantine.js'
import { localDay, logPath, writeRecord } from './src/log.js'
import { beginRecovery, crashPageUrl } from './src/recovery.js'
import { describePackage } from './src/meta.js'
import { restartCommand } from './src/self-restart.js'

/** The web carrier, when this composition has one. The service key is `webServer`. */
function safeWebserver(ctx) {
  try {
    return ctx.get?.('webServer')
  } catch {
    return undefined
  }
}

export const name = 'dsh-phoenix'

const SELF_PACKAGE = 'dsh-phoenix'
const OFFICIAL_SCOPE = '@deepseek-ai/'

/** Rows this plugin must never quarantine on its own initiative. */
const PROTECTED_ROWS = new Set([
  SELF_PACKAGE,
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-session',
])

export function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function normalizeConfig(raw) {
  const config = raw ?? {}
  return {
    enabled: config.enabled !== false,
    quarantine: config.quarantine !== false,
    maxQuarantinePerRun:
      Number.isInteger(config.maxQuarantinePerRun) && config.maxQuarantinePerRun >= 0
        ? config.maxQuarantinePerRun
        : 2,
    protectOfficial: config.protectOfficial !== false,
    onUnattributable: config.onUnattributable === 'exit' ? 'exit' : 'log',
  }
}

function protectionReason(pkg, rowName, config) {
  if (pkg === SELF_PACKAGE || rowName === SELF_PACKAGE) return 'self'
  if (PROTECTED_ROWS.has(pkg) || PROTECTED_ROWS.has(rowName)) return 'protected'
  if (config.protectOfficial !== false && typeof pkg === 'string' && pkg.startsWith(OFFICIAL_SCOPE)) {
    return 'official'
  }
  if (typeof rowName === 'string' && rowName.startsWith('cordis:')) return 'structural'
  return undefined
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return

  const home = resolveHome()
  const quarantined = new Set(readQuarantined(home))
  let budget = config.maxQuarantinePerRun
  let handled = 0
  let active = true
  let recovery
  let recovering = false

  const record = (entry) => {
    writeRecord(home, {
      at: new Date().toISOString(),
      day: localDay(),
      handledCount: handled,
      ...entry,
    })
  }

  const notify = (message) => {
    try {
      process.stderr.write(`dsh-phoenix: ${message}\n`)
    } catch {
      /* nothing left to write to */
    }
  }

  /**
   * Open the crash page and hold the process so an operator can decide.
   * @returns true when the hold is active and the caller must not exit.
   */
  const openRecovery = (fault) => {
    recovering = true
    const meta = describePackage(fault.described.stack)
    const report = {
      kind: fault.kind,
      package: fault.pkg ?? meta.packageName ?? null,
      title: meta.title,
      description: meta.description,
      version: meta.version,
      packageDir: meta.packageDir,
      icon: meta.icon,
      rowIds: fault.rows.map((row) => row.id),
      message: fault.described.message,
      stack: fault.described.stack,
      decision: fault.decision,
      reason: fault.reason,
      alreadyQuarantined: quarantined.size > 0,
    }

    let opened
    try {
      opened = beginRecovery({ ctx, home, report })
    } catch (error) {
      recovering = false
      notify(`could not open the recovery page (${describe(error).message}); falling back to exit`)
      return false
    }

    if (!opened.available) {
      recovering = false
      return false
    }

    recovery = opened
    notify(
      `fatal ${fault.kind} from ${report.package ?? 'unknown'}; holding the process and serving the crash page. ` +
        `Open ${crashPageUrl(safeWebserver(ctx))} to decide.`,
    )
    return true
  }

  /** Contain one process-level fault. Never exits unless configured to. */
  const contain = (kind, value) => {
    if (!active) return
    handled += 1

    const described = describe(value)
    const chain = value instanceof Error ? causeChain(value) : []
    const deepest = chain.length > 0 ? chain[chain.length - 1] : value
    const deepestDescribed = chain.length > 0 ? describe(deepest) : described

    let loader
    try {
      loader = ctx.get?.('loader')
    } catch {
      loader = undefined
    }

    const { pkg, rows } = attribute(loader, described, deepestDescribed)

    let decision = 'logged'
    let reason
    let quarantinedIds = []

    if (rows.length === 0) {
      reason = pkg === undefined ? 'no-package-in-stack' : 'package-not-a-loader-row'
    } else {
      const blocked = rows
        .map((row) => protectionReason(pkg ?? packageRoot(row.name), row.name, config))
        .find((value) => value !== undefined)
      if (blocked !== undefined) reason = `protected:${blocked}`
      else if (quarantined.has(rows[0].id)) reason = 'already-quarantined'
      else if (!config.quarantine) reason = 'quarantine-disabled'
      else if (budget <= 0) reason = 'quarantine-budget-exhausted'
      else {
        const target = rows[0]
        try {
          quarantined.add(target.id)
          writeQuarantine(home, [...quarantined])
          budget -= 1
          decision = 'quarantined'
          quarantinedIds = [target.id]
          reason = `row:${target.id}`
        } catch (error) {
          reason = `quarantine-write-failed:${describe(error).message}`
        }
      }
    }

    record({
      kind,
      package: pkg ?? null,
      rows: rows.map((row) => ({ id: row.id, name: row.name })),
      decision,
      reason,
      quarantinedIds,
      error: {
        name: described.name,
        message: described.message,
        code: described.code,
        stack: described.stack,
      },
      causes: chain.slice(1).map((cause) => {
        const item = describe(cause)
        return { name: item.name, message: item.message, stack: item.stack }
      }),
    })

    // Hand the fault to the recovery surface. It keeps the process alive so the
    // crash page can be served, then replaces the process once the operator
    // chooses. Only the first fault opens a hold; a second one during recovery
    // is recorded and nothing else, so a broken listener cannot stack windows.
    if (active && !recovering) {
      const opened = openRecovery({
        kind,
        pkg,
        rows,
        described,
        decision,
        reason,
        quarantinedIds,
      })
      if (opened) return
    }

    if (decision === 'quarantined') {
      notify(
        `contained ${kind} from ${pkg ?? 'unknown'}; quarantined row ${quarantinedIds.join(', ')} for the next start. ` +
          `Record: ${logPath(home)}`,
      )
      return
    }

    if (config.onUnattributable === 'exit') {
      notify(`unattributable ${kind} (${reason}); exiting because onUnattributable=exit`)
      process.exit(1)
    }
    notify(`contained ${kind} (${reason}); continuing`)
  }

  const onRejection = (reason) => contain('unhandledRejection', reason)
  const onException = (error) => contain('uncaughtException', error)

  ctx.effect(() => {
    // Snapshot whatever the host installed, then take ownership. Restoring the
    // snapshot on dispose keeps this reversible and leaves other observers intact.
    const previousRejection = process.listeners('unhandledRejection')
    const previousException = process.listeners('uncaughtException')
    process.removeAllListeners('unhandledRejection')
    process.removeAllListeners('uncaughtException')
    process.on('unhandledRejection', onRejection)
    process.on('uncaughtException', onException)

    record({
      kind: 'guard-activated',
      package: null,
      rows: [],
      decision: 'activated',
      reason: `home:${home}`,
      quarantinedIds: [...quarantined],
      error: null,
      causes: [],
      // Probe the reset capability once, so `dsh-phoenix status` can tell the
      // operator up front whether "disable and restart" will really restart.
      restart: (() => {
        const spec = restartCommand()
        return spec.ok ? { ok: true } : { ok: false, reason: spec.reason }
      })(),
    })

    return () => {
      active = false
      try {
        recovery?.release?.()
      } catch {
        /* route teardown is best-effort */
      }
      recovering = false
      process.removeListener('unhandledRejection', onRejection)
      process.removeListener('uncaughtException', onException)
      for (const listener of previousRejection) process.on('unhandledRejection', listener)
      for (const listener of previousException) process.on('uncaughtException', listener)
    }
  })

  // Deliberately no tool deadline. A tool that runs for hours is doing its job:
  // a cargo build, a poller that watches for days. DSH leaves the wall-clock
  // decision to the tool on purpose, and long work already has a proper home in
  // the background-job system. Bounding it here would kill legitimate work to
  // rescue a case that a restart already fixes. A wedged session is an injury,
  // not death.
}

/** Exposed for tests and the CLI; the module is otherwise a Cordis plugin. */
export const internals = { describe, attribute, packageRoot }
