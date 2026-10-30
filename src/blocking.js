/**
 * Blocking-failure handling.
 *
 * Two rules shape this file.
 *
 * **Never classify by message text.** These errors are localized, reworded
 * between releases, and wrapped by RPC layers. A pattern list is always one
 * version behind, and a miss means the operator stays blocked forever. The
 * signal here is behavioural: consecutive session errors with nothing surviving
 * them.
 *
 * **Never switch the operator into rescue mode on its own.** The fault may be
 * transient, and a rescue session spends the operator's tokens. This prepares
 * the rescue and reports it; the operator decides from the dialog.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { liveRows, prepareResurrection } from './recovery-session.js'

/** Consecutive session errors that mean "DSH cannot talk", not "one call failed". */
export const BLOCKING_THRESHOLD = 2

/** Set inside a rescue session so it never tries to rescue itself. */
export const RESURRECTED_ENV = 'DSH_PHOENIX_RESURRECTED'

export function rescueStatePath(home) {
  return join(home, 'logs', 'crash-guard', 'rescue-state.json')
}

export function readRescueState(home) {
  const path = rescueStatePath(home)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function writeRescueState(home, state) {
  try {
    writeFileSync(rescueStatePath(home), `${JSON.stringify(state, null, 2)}\n`)
  } catch {
    /* advisory file */
  }
}

/**
 * Track session outcomes and prepare a rescue overlay once DSH is clearly stuck.
 *
 * @param options.ctx - plugin context, for the live loader rows.
 * @param options.home - DSH home.
 * @param options.profile - profile the rescue session should boot.
 * @param options.record - crash-log recorder.
 * @param options.notify - stderr reporter.
 */
export function createBlockingMonitor(options) {
  const { home, record, notify } = options
  const profile = options.profile ?? process.env.DSH_PROFILE
  const isRescueSession = process.env[RESURRECTED_ENV] === '1'

  let consecutive = 0
  let preparing = false
  let last

  const prepare = (cause) => {
    if (isRescueSession || preparing) return last
    preparing = true
    try {
      const overlay = prepareResurrection({ home, rows: liveRows(options.ctx) })
      if (!overlay.ok) {
        record({
          kind: 'rescue-unavailable',
          decision: 'failed',
          reason: overlay.reason,
          error: { message: overlay.reason, code: 'RESCUE_UNAVAILABLE' },
        })
        return undefined
      }
      last = {
        preparedAt: new Date().toISOString(),
        profile,
        overlayPath: overlay.overlayPath,
        disabled: overlay.disabled,
        cause: typeof cause === 'string' ? cause.slice(0, 2000) : undefined,
      }
      writeRescueState(home, last)
      record({
        kind: 'rescue-prepared',
        decision: 'prepared',
        reason: `disabled:${overlay.disabled.join(',') || 'none'}`,
        rows: overlay.disabled.map((id) => ({ id })),
      })
      notify(
        'DSH cannot start new conversations. A rescue is ready: official rows only, ' +
          'your providers kept. Use the dialog to enter it.',
      )
      return last
    } finally {
      preparing = false
    }
  }

  return {
    /** A session worked, so the streak was not a block. */
    onSessionWorking() {
      consecutive = 0
    },

    /** One session failed. */
    onSessionError(sessionId, message) {
      const text = typeof message === 'string' ? message : String(message ?? '')
      consecutive += 1
      const blocking = consecutive >= BLOCKING_THRESHOLD
      record({
        kind: 'session-error',
        decision: blocking ? 'blocking' : 'observed',
        reason: `session:${String(sessionId)}`,
        error: { message: text, code: 'SESSION_ERROR' },
        occurrences: consecutive,
      })
      if (blocking) prepare(text)
    },

    /** Whether a rescue overlay exists, for the modal and the CLI. */
    prepared() {
      return last ?? readRescueState(home)
    },

    /**
     * Prepare now because the operator asked for it.
     *
     * The dialog appears on the FIRST session error, but preparation waits for
     * the second — so a fast click would otherwise reach an endpoint that has
     * nothing ready and answer "not prepared", which is a dead button on the one
     * screen that must not have one. The operator's click is the consent, so
     * preparing here is not the automatic switch this module refuses to make.
     */
    prepareNow(cause) {
      return prepare(cause ?? 'operator-requested')
    },

    /** Clear the streak (rescue was declined or a session recovered). */
    reset() {
      consecutive = 0
    },
  }
}
