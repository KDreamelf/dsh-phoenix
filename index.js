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
import { beginRecovery, crashPageUrl, installRescueRoutes } from './src/recovery.js'
import { describePackage } from './src/meta.js'
import { restartCommand } from './src/self-restart.js'
import { finalizeRemovals } from './src/finalize.js'
import { scanComposition, summarizeComposition } from './src/health.js'
import { spawnResurrectionSession, liveRows, profileName } from './src/recovery-session.js'
import { createBlockingMonitor } from './src/blocking.js'

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
      // What attribution already disabled for the next start. The page needs it:
      // "retry" must undo exactly these, or the button that says "no change"
      // would keep the plugin off and the operator would see the same fault again.
      quarantinedIds: fault.quarantinedIds ?? [],
      alreadyQuarantined: quarantined.size > 0,
    }

    let opened
    try {
      opened = beginRecovery({
        ctx,
        home,
        report,
        // The crash page offers rescue only when attribution failed, because
        // disabling a known culprit is the better fix. Launching is the same
        // path the error dialog uses.
        launchRescue: async () =>
          await spawnResurrectionSession({
            ctx,
            home,
            rows: liveRows(ctx),
          }),
      })
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

  // Composition health: a fiber that threw during activation never reaches the
  // process handlers. Cordis catches it, marks it FAILED, and reports over RPC,
  // so the page loads while something the user needs is simply absent. Record
  // what the loader itself believes, at activation.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      let health
      try {
        health = scanComposition(ctx)
      } catch (error) {
        notify(`composition scan failed: ${describe(error).message}`)
        return
      }
      record({
        kind: 'composition-scan',
        package: null,
        rows: health.broken.map((row) => ({ id: row.id, name: row.name })),
        decision: health.usable ? 'healthy' : 'degraded',
        reason: summarizeComposition(health),
        quarantinedIds: [],
        error: null,
        causes: [],
        requiredBroken: health.requiredBroken.map((row) => row.id),
      })
      if (!health.usable) {
        notify(
          `DSH is running but ${health.requiredBroken.length} core row(s) are not active: ` +
            `${health.requiredBroken.map((row) => `${row.id}(${row.state})`).join(', ')}. ` +
            'Some capabilities will not work.',
        )
      }
    }, 0)
    return () => clearTimeout(timer)
  })

  // Session-level failures: the "page loads, but nothing works" case.
  //
  // No pattern matching. These messages are localized, reworded between
  // releases, wrapped by RPC layers, and impossible to enumerate — a regex list
  // is always one version behind, and a miss means the operator stays blocked.
  //
  // The signal is behavioural: consecutive session errors with no session
  // surviving them. When that holds, the guard PREPARES a rescue session — an
  // overlay that keeps every official row (and therefore every provider) while
  // disabling everything the operator installed — and reports where it is.
  //
  // It does not switch the operator into it. The fault may be transient, and a
  // rescue session spends their tokens. The error dialog offers the choice.
  ctx.effect(() => {
    const monitor = createBlockingMonitor({
      ctx,
      home,
      record: (entry) => record(entry),
      notify,
    })

    const disposers = []
    const push = (dispose) => {
      if (typeof dispose === 'function') disposers.push(dispose)
    }

    push(ctx.on('api-session/error', (sessionId, message) => monitor.onSessionError(sessionId, message)))
    // A session that appears or runs is evidence DSH can still talk.
    push(ctx.on('api-session/added', () => monitor.onSessionWorking()))
    push(ctx.on('api-session/activity', () => monitor.onSessionWorking()))

    push(
      installRescueRoutes({
        ctx,
        prepared: () => monitor.prepared(),
        launch: async () => {
          // The dialog shows on the first error; preparation waits for the
          // second. A fast click must still work, so prepare on demand — the
          // click is the consent this plugin always waits for.
          //
          // A prepared state read back from disk may belong to a different
          // profile (it is one file under the home directory, shared by every
          // profile). Rescuing the wrong profile is not a rescue, so a
          // mismatch re-prepares against the one that is actually running.
          const current = profileName(ctx)
          const prior = monitor.prepared()
          const state =
            prior !== undefined && (current === undefined || prior.profile === current)
              ? prior
              : monitor.prepareNow('operator-requested')
          if (state === undefined) return { ok: false, reason: 'rescue-unavailable' }
          return await spawnResurrectionSession({
            ctx,
            home,
            // The running profile is authoritative, never a file.
            profile: current ?? state.profile,
            rows: liveRows(ctx),
          })
        },
      }),
    )

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* listener teardown is best-effort */
        }
      }
    }
  })

  // Deliberately no tool deadline. A tool that runs for hours is doing its job:
  // a cargo build, a poller that watches for days. DSH leaves the wall-clock
  // decision to the tool on purpose, and long work already has a proper home in
  // the background-job system. Bounding it here would kill legitimate work to
  // rescue a case that a restart already fixes. A wedged session is an injury,
  // not death.

  // Deferred removals: "remove" on the crash page only queues an uninstall,
  // because removing a bundle whose process just threw is exactly what the
  // plugin manager's `stop-profile` and `bundle-in-use` guards exist to prevent.
  // This is the clean start it was waiting for: the culprit row is disabled by
  // the home patch, the process is healthy, and HMR is available. Run it after
  // activation settles so it cannot disturb this plugin's own wiring.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      finalizeRemovals({
        ctx,
        home,
        record: (entry) => record(entry),
      })
        .then((outcomes) => {
          for (const outcome of outcomes) {
            if (outcome.skipped === true) continue
            notify(
              outcome.ok
                ? `removed queued plugin ${outcome.package}`
                : `could not remove ${outcome.package} (${outcome.reason}); kept in the queue`,
            )
          }
        })
        .catch((error) => notify(`removal queue failed: ${describe(error).message}`))
    }, 0)
    return () => clearTimeout(timer)
  })
}

/** Exposed for tests and the CLI; the module is otherwise a Cordis plugin. */
export const internals = { describe, attribute, packageRoot }
