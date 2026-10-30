/**
 * Composition health: what part of DSH itself failed to come up.
 *
 * The process guard covers faults that reach `uncaughtException`. It does not
 * cover the quieter half of "DSH is broken": a fiber that threw during
 * activation is caught by cordis, marked FAILED, and reported over RPC. The
 * process lives, the page loads, and something the user needs simply is not
 * there:
 *
 *   prompt section "deployment:persona-prefix" is already registered
 *   active Service "directoryPickerController" is unavailable
 *
 * Neither kills the process. Both can make a new conversation or a picker fail.
 *
 * This module reads the loader's own state — the same facts `auditStartupEntries`
 * uses — so the answer is about what DSH believes, not about guessing from error
 * text. It never disables anything: it produces a list a human or a model can act
 * on.
 */

/** Cordis fiber states, mirrored because the const enum has no runtime object. */
export const FIBER_PENDING = 0
export const FIBER_LOADING = 1
export const FIBER_ACTIVE = 2
export const FIBER_FAILED = 3
export const FIBER_DISPOSED = 4
export const FIBER_UNLOADING = 5

const STATE_NAMES = {
  [FIBER_PENDING]: 'pending',
  [FIBER_LOADING]: 'loading',
  [FIBER_ACTIVE]: 'active',
  [FIBER_FAILED]: 'failed',
  [FIBER_DISPOSED]: 'disposed',
  [FIBER_UNLOADING]: 'unloading',
}

/**
 * Rows that define a usable DSH application.
 *
 * Mirrors `requiredStartupEntryIds` in dsh-app-boot: when one of these is not
 * active, the process may be alive while the product is not usable — no agent
 * loop means no conversation, no webserver means no page.
 */
const REQUIRED_ROWS = new Set([
  'agent-loop',
  'webserver',
  'web-runtime',
  'modules',
  'connection',
  'headless-runner',
  'acp',
  'sdk-jsonrpc-server',
])

function readString(read) {
  try {
    const value = read()
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function describeError(error) {
  if (error === undefined || error === null) return undefined
  if (typeof error === 'string') return error
  const message = readString(() => error.message)
  const code = readString(() => error.code)
  if (message !== undefined) return code === undefined ? message : `${code}: ${message}`
  return readString(() => String(error))
}

/**
 * Inspect every enabled loader row and classify its activation.
 *
 * A row is `broken` when it is enabled but not active. `required` marks the rows
 * whose absence means DSH itself is unusable rather than merely incomplete.
 *
 * @param ctx - plugin context, for `loader`.
 * @returns {{ rows: object[], broken: object[], requiredBroken: object[], usable: boolean }}
 */
export function scanComposition(ctx) {
  let entries
  try {
    entries = [...(ctx.get?.('loader')?.entries?.() ?? [])]
  } catch {
    entries = []
  }

  const rows = []
  for (const entry of entries) {
    const id = readString(() => entry?.options?.id)
    const name = readString(() => entry?.options?.name)

    let disabled = false
    let disabledError
    try {
      disabled = Boolean(entry?.disabled)
    } catch (error) {
      // A `!!js` disabled expression that throws is itself a composition fault.
      disabledError = describeError(error)
      disabled = false
    }

    const fiber = entry?.fiber
    const state = typeof fiber?.state === 'number' ? fiber.state : undefined
    const stateName = state === undefined ? 'missing' : (STATE_NAMES[state] ?? `unknown(${String(state)})`)

    let error
    if (disabledError !== undefined) error = disabledError
    else error = describeError(fiber?._error ?? fiber?.error)

    const active = state === FIBER_ACTIVE
    const broken = !disabled && !active && state !== undefined
    const missing = !disabled && fiber === undefined

    rows.push({
      id: id ?? null,
      name: name ?? null,
      disabled,
      state: stateName,
      active,
      broken: broken || missing,
      required: id !== undefined && REQUIRED_ROWS.has(id),
      error,
    })
  }

  const broken = rows.filter((row) => row.broken)
  const requiredBroken = broken.filter((row) => row.required)

  return {
    rows,
    broken,
    requiredBroken,
    // DSH is "usable" only when nothing a core subsystem depends on is broken.
    usable: requiredBroken.length === 0,
    scannedAt: new Date().toISOString(),
  }
}

/** A compact summary for a log line. */
export function summarizeComposition(health) {
  if (health.requiredBroken.length === 0 && health.broken.length === 0) {
    return 'composition healthy'
  }
  const parts = []
  if (health.requiredBroken.length > 0) {
    parts.push(
      `required not running: ${health.requiredBroken.map((row) => `${row.id}(${row.state})`).join(', ')}`,
    )
  }
  const others = health.broken.filter((row) => !row.required)
  if (others.length > 0) {
    parts.push(`${others.length} other row(s) not active: ${others.map((row) => row.id).join(', ')}`)
  }
  return parts.join('; ')
}
