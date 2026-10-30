/**
 * Finalize queued removals through DSH's own plugin manager.
 *
 * Why not `dsh plugin remove <pkg>`: that command forwards to pnpm directly
 * (see dsh/lib/plugin-BiveYA7h.js `runPlugin`). It deletes the package from
 * node_modules but leaves the entry in `dsh.profile.bundles`, producing a
 * profile that selects a bundle that no longer exists.
 *
 * The real API is `ctx.get('pluginManager').removeBundle(name)`. It performs the
 * whole operation in the right order — deselect the bundle, reload, verify no
 * live fiber still owns one of its rows, run pnpm remove, then publish and
 * reload — and it refuses with a named code instead of half-succeeding:
 *
 *   not-removable   the bundle cannot be removed from this profile
 *   stop-profile    no HMR, and the bundle is running: it must be stopped first
 *   bundle-in-use   a live fiber still owns a row the bundle contributes
 *   management-required / unknown-plugin / incompatible-version, and so on
 *
 * That is why removal is deferred to the NEXT start rather than performed in the
 * crash handler: `stop-profile` and `bundle-in-use` both exist precisely because
 * removing a running bundle is unsafe, and a process that just threw an uncaught
 * exception is the worst possible moment to run pnpm.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { pendingRemovePath } from './recovery.js'

const SELF_PACKAGE = 'dsh-phoenix'

/** Read the removal queue. */
export function readQueue(home) {
  const path = pendingRemovePath(home)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeQueue(home, entries) {
  const path = pendingRemovePath(home)
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`)
}

/** Localize a management failure code for the log. */
const FAILURE_TEXT = {
  'not-removable': '这个 bundle 不能从当前 profile 移除',
  'stop-profile': '需要先停止 profile（当前没有 HMR）',
  'bundle-in-use': '仍有活着的 fiber 占用它贡献的行',
  'management-required': '这个包由插件管理器自己托管，不能移除',
  'unknown-plugin': '插件管理器不认识这个包',
  'incompatible-version': '版本兼容性检查拒绝移除',
}

/**
 * Decide whether a `removeBundle` result means success.
 *
 * `PluginManager.change()` does NOT throw for an expected refusal. It catches
 * and folds the failure into its return value (`index.js:2389-2395`):
 *
 *   result.application = 'failed'
 *   result.error = managementError(error)   // { code, ... }
 *
 * so a caller that only wraps the call in try/catch treats every refusal as a
 * success — clearing the queue and reporting a removal that never happened.
 * Success is `application` of 'applied' (HMR unloaded it) or 'restart-required'
 * (the files are gone, the row goes off on the next start).
 */
export function classifyRemoval(result) {
  if (result === undefined || result === null) return { ok: false, reason: 'no-result' }
  const application = result.application
  if (application === 'applied' || application === 'restart-required') return { ok: true, application }
  if (application === 'cancelled') return { ok: false, reason: 'cancelled' }
  const code = result.error?.code
  return { ok: false, reason: typeof code === 'string' ? code : 'failed' }
}

/**
 * Run every queued removal through the plugin manager.
 *
 * Never throws. Each outcome is returned and, on success, dropped from the
 * queue. A failure keeps its entry so a later start can retry after the
 * operator addresses the cause.
 *
 * @param options.ctx - plugin context, for `pluginManager` and logging.
 * @param options.home - DSH home.
 * @param options.record - record writer (kind/entry) for the crash log.
 * @returns outcomes in the order attempted.
 */
export async function finalizeRemovals(options) {
  const queue = readQueue(options.home)
  if (queue.length === 0) return []

  let manager
  try {
    manager = options.ctx.get?.('pluginManager')
  } catch {
    manager = undefined
  }
  if (manager === undefined || typeof manager.removeBundle !== 'function') {
    return [{ skipped: true, reason: 'plugin-manager-unavailable', queue }]
  }

  const outcomes = []
  const remaining = []

  for (const entry of queue) {
    const name = entry?.package
    if (typeof name !== 'string' || name.length === 0) continue

    if (name === SELF_PACKAGE) {
      // Never remove the plugin doing the removing.
      remaining.push(entry)
      outcomes.push({ package: name, ok: false, reason: 'refuses-to-remove-itself' })
      continue
    }

    let verdict
    try {
      verdict = classifyRemoval(await manager.removeBundle(name))
    } catch (error) {
      // The lock or an abort can still reject; `change()` folds everything else.
      verdict = { ok: false, reason: typeof error?.code === 'string' ? error.code : 'threw' }
    }

    if (verdict.ok) {
      outcomes.push({ package: name, ok: true, application: verdict.application })
      options.record?.({
        kind: 'removal-finalized',
        package: name,
        decision: 'removed',
        reason: verdict.application,
      })
      continue
    }

    remaining.push(entry)
    outcomes.push({ package: name, ok: false, reason: verdict.reason })
    options.record?.({
      kind: 'removal-failed',
      package: name,
      decision: 'queued',
      reason: verdict.reason,
      error: {
        message: FAILURE_TEXT[verdict.reason] ?? verdict.reason,
        code: verdict.reason,
      },
    })
  }

  writeQueue(options.home, remaining)
  return outcomes
}
