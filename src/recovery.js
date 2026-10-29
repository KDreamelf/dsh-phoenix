/**
 * Recovery: hold the process open after a fatal fault and let the operator
 * decide what happens to the culprit.
 *
 * The flow, and why it is ordered this way:
 *
 *   1. A fatal fault is recorded synchronously (never lose the reason).
 *   2. Instead of exiting, the host keeps the HTTP server it already has and
 *      registers a crash page on it.
 *   3. The browser loads that page — a standalone document, so it renders even
 *      though the React tree may already be unmounted.
 *   4. The operator picks: retry / disable / remove.
 *   5. The host applies the decision, spawns a replacement process, and exits.
 *
 * Step 5 is what makes this a real reset. Reloading the page against a process
 * that already threw is not recovery; DSH's own fail-loud comment states that
 * resuming after a throw can leave silently wrong state behind.
 *
 * Every step degrades rather than throws: a missing webserver means the crash
 * page cannot be served, and the host falls back to exiting with the record on
 * disk for the next start's CLI to read.
 */

import { hostname } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CRASH_ROUTE, DECIDE_ROUTE, STATUS_ROUTE, CHOICE_DISABLE, CHOICE_REMOVE, CHOICE_RETRY, readChoice, renderCrashPage } from './crash-page.js'
import { readQuarantined, writeQuarantine } from './quarantine.js'
import { spawnReplacement } from './self-restart.js'

/** How long the process waits for an operator before giving up. */
export const RECOVERY_HOLD_MS = 10 * 60 * 1000

export function pendingRemovePath(home) {
  return join(home, 'logs', 'crash-guard', 'pending-remove.json')
}

/** Record an uninstall request for the next start, when the row is disabled. */
export function markPendingRemove(home, entry) {
  const path = pendingRemovePath(home)
  mkdirSync(join(home, 'logs', 'crash-guard'), { recursive: true })
  let existing = []
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(parsed)) existing = parsed
    } catch {
      existing = []
    }
  }
  const next = existing.filter((item) => item.package !== entry.package)
  next.push({ ...entry, requestedAt: new Date().toISOString() })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  return path
}

export function readPendingRemovals(home) {
  const path = pendingRemovePath(home)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  })
  res.end(html)
}

async function readBody(req, limit = 8 * 1024) {
  return await new Promise((resolve) => {
    let total = 0
    const chunks = []
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        resolve(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(Buffer.concat(chunks).toString('utf8'))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/**
 * Install the recovery surface and hold the process.
 *
 * @param options.ctx - the plugin context (needs `webserver` for the routes).
 * @param options.home - DSH home, where quarantine and records live.
 * @param options.report - the fault being recovered from.
 * @param options.exit - process exit function, injectable for tests.
 * @param options.restart - replacement spawner, injectable for tests.
 * @returns a controller with `settle()` for tests and `release()` for cleanup.
 */
export function beginRecovery(options) {
  const { ctx, home, report } = options
  const exit = options.exit ?? ((code) => process.exit(code))
  const restart = options.restart ?? spawnReplacement
  const holdMs = options.holdMs ?? RECOVERY_HOLD_MS

  const state = {
    decided: false,
    released: false,
    timer: undefined,
    disposers: [],
  }

  const release = () => {
    if (state.released) return
    state.released = true
    if (state.timer !== undefined) clearTimeout(state.timer)
    for (const dispose of state.disposers) {
      try {
        dispose()
      } catch {
        /* route disposal is best-effort during teardown */
      }
    }
    state.disposers = []
  }

  /** Apply the operator's choice, then replace the process and exit. */
  const apply = (choice) => {
    let message = ''
    if (choice === CHOICE_DISABLE || choice === CHOICE_REMOVE) {
      const ids = Array.isArray(report.rowIds) ? report.rowIds : []
      if (ids.length > 0) {
        const current = new Set(readQuarantined(home))
        for (const id of ids) current.add(id)
        try {
          writeQuarantine(home, [...current])
          message =
            choice === CHOICE_REMOVE
              ? `已禁用并在下次启动后卸载：${ids.join(', ')}`
              : `已禁用：${ids.join(', ')}`
        } catch (error) {
          return { ok: false, error: `写入隔离失败：${String(error)}` }
        }
      }
      if (choice === CHOICE_REMOVE && typeof report.package === 'string') {
        try {
          markPendingRemove(home, {
            package: report.package,
            rowIds: ids,
            profile: process.env.DSH_PROFILE ?? null,
          })
          message += '（卸载排队中，重启后由 CLI 或下次启动完成）'
        } catch (error) {
          message += `（排队失败：${String(error)}）`
        }
      }
    } else {
      message = '未做改动，正在重启'
    }

    const spawned = restart()
    setTimeout(() => exit(1), 250)
    return {
      ok: true,
      message: spawned.ok ? message : `${message}（无法自动重启：${spawned.reason}，请手动重开）`,
    }
  }

  /**
   * Settle a decision. Exposed on every controller, including one with no
   * carrier: applying a quarantine is independent of being able to show a page,
   * and the caller may have its own way to ask.
   */
  const settle = (choice) => {
    if (state.decided) return { ok: false, error: 'already decided' }
    state.decided = true
    return apply(choice)
  }

  const webserver = (() => {
    try {
      // `dsh-host-webserver` registers itself as `webServer`.
      return ctx.get?.('webServer')
    } catch {
      return undefined
    }
  })()

  if (webserver === undefined || typeof webserver.register !== 'function') {
    // No carrier to serve a page on: leave the record on disk and let the
    // caller's original behaviour finish the job. The decision surface stays
    // available so a caller with its own channel can still use it.
    return {
      available: false,
      release,
      settle,
      get decided() {
        return state.decided
      },
    }
  }

  try {
    state.disposers.push(
      webserver.register({
        kind: 'exact',
        path: CRASH_ROUTE,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          sendHtml(res, renderCrashPage(report))
        },
      }),
    )
    state.disposers.push(
      webserver.register({
        kind: 'exact',
        path: STATUS_ROUTE,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          sendJson(res, 200, { ok: true, recovering: true, decided: state.decided, report })
        },
      }),
    )
    state.disposers.push(
      webserver.register({
        kind: 'exact',
        path: DECIDE_ROUTE,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (state.decided) {
            sendJson(res, 200, { ok: true, message: '已经处理过了' })
            return
          }
          const body = await readBody(req)
          const choice = readChoice(body)
          if (choice === undefined) {
            sendJson(res, 400, { ok: false, error: '无效的选择' })
            return
          }
          state.decided = true
          const result = apply(choice)
          sendJson(res, result.ok ? 200 : 500, result)
        },
      }),
    )
  } catch (error) {
    release()
    return {
      available: false,
      release,
      settle,
      error: String(error),
      get decided() {
        return state.decided
      },
    }
  }

  // Stay alive long enough for a human to answer, then fall back to exiting so
  // a forgotten crash window cannot pin the process forever.
  state.timer = setTimeout(() => {
    release()
    exit(1)
  }, holdMs)
  state.timer.unref?.()

  return {
    available: true,
    release,
    /** Test hook: apply a choice without going through HTTP. */
    settle,
    get decided() {
      return state.decided
    },
  }
}

/** Absolute crash page URL for a running server. */
export function crashPageUrl(webserver) {
  try {
    const origin = typeof webserver?.getOrigin === 'function' ? webserver.getOrigin() : undefined
    if (typeof origin === 'string' && origin.length > 0) return `${origin}${CRASH_ROUTE}`
  } catch {
    /* fall through */
  }
  return CRASH_ROUTE
}

export { hostname }
