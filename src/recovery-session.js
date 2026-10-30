/**
 * Resurrection mode: one boot with the suspects left out — Windows safe mode.
 *
 * Two properties define it, and both are load-bearing:
 *
 *   1. It is TEMPORARY. The overlay lives in one file under the log directory
 *      and reaches DSH only through `--patch`, which applies to this one
 *      process. Nothing is written to the profile or to the home patch layer,
 *      so closing this session and starting DSH again boots normally. A rescue
 *      that left the profile altered would not be a safe mode; it would be a
 *      second, slower way to lose the setup.
 *
 *   2. It never touches the provider configuration. That config is the `config`
 *      of official rows (`llm-pi-ai`, `llm-deepseek`, `agent-default-model`),
 *      and those rows are kept unconditionally. A provider created by a plugin
 *      does disappear — but that is the plugin's own removal, not something
 *      this guard deleted, and it can only happen after the plugin is stopped.
 *
 * The guard itself is always kept: a rescue session that lost its own watchdog
 * could not be rescued a second time.
 *
 * What goes is everything else the operator installed. If one of those was the
 * cause, the session is clean by construction. If attribution was impossible,
 * this still gets a working conversation, which is the actual goal.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** Ask the OS for a port nothing is listening on. */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(() => {
        if (port === undefined) reject(new Error('could not determine a free port'))
        else resolve(port)
      })
    })
  })
}

/** Rows the resurrection overlay must never disable. */
const ALWAYS_KEEP = new Set(['phoenix'])

/**
 * Reasons a rescue cannot start, in words an operator can act on.
 *
 * These are returned as machine codes and were being shown verbatim — an
 * English identifier is not an explanation, and the operator is already having
 * a bad day.
 */
const FAILURE_TEXT = {
  'unknown-profile': '不知道当前是哪个 profile，所以无法原样复用它。请在命令行重开 DSH。',
  'desktop-profile-is-app-managed':
    '桌面版的 profile 由应用自己管理，不死鸟没法替它另开一个安全模式窗口。请先关掉 DSH，用命令行方式启动一次 web 界面再进复活模式；或者直接在设置里停用可疑插件。',
  'electron-main-process': '当前进程是桌面应用的主进程，不能从这里重启。请手动关闭并重新打开 DSH。',
  'rescue-unavailable': '没能准备好复活所需的排查信息。请手动关掉 DSH 再重新打开。',
  'not-prepared': '还没准备好复活所需的排查信息，请先让故障复现一次。',
  'no-script': '无法确定启动参数，请手动重开 DSH。',
}

/**
 * Turn a rescue failure code into operator-facing text.
 * Unknown codes fall through unchanged rather than being hidden.
 */
export function describeRescueFailure(reason) {
  if (typeof reason !== 'string' || reason.length === 0) return '无法进入复活模式。请手动重开 DSH。'
  if (Object.hasOwn(FAILURE_TEXT, reason)) return FAILURE_TEXT[reason]
  if (reason.startsWith('could not find a free port')) {
    return '找不到可用端口，无法另开会话。请手动重开 DSH 后重试。'
  }
  if (reason.startsWith('could not write the overlay') || reason.startsWith('could not start')) {
    return `启动复活会话失败：${reason}`
  }
  return reason
}

function isOfficial(name) {
  return typeof name === 'string' && name.startsWith('@deepseek-ai/')
}

function isBuiltin(name) {
  return typeof name === 'string' && name.startsWith('cordis:')
}

/**
 * Rows to keep enabled in a resurrection session.
 * Everything official, every builtin, and the guard itself.
 */
export function keepRow(row) {
  if (typeof row?.id !== 'string') return false
  if (ALWAYS_KEEP.has(row.id)) return true
  return isOfficial(row.name) || isBuiltin(row.name)
}

/**
 * Build the overlay that disables every row worth suspecting.
 * @param rows - `{ id, name }` entries from the live loader.
 * @returns YAML text, or undefined when nothing needs disabling.
 */
export function buildResurrectionOverlay(rows) {
  const suspects = []
  for (const row of rows ?? []) {
    if (!keepRow(row)) suspects.push(row)
  }
  if (suspects.length === 0) return undefined

  const lines = [
    '# dsh-phoenix resurrection mode — this file is temporary',
    '# It is passed to one process as --patch and is never installed into the',
    '# profile or the home patch layer, so the next normal start ignores it.',
    '# Keeps every official row (and therefore every provider) and disables the',
    '# rows the operator installed.',
  ]
  for (const row of suspects) {
    lines.push(`- id: ${JSON.stringify(row.id)}`)
    lines.push('  disabled: true')
  }
  return `${lines.join('\n')}\n`
}

/**
 * Read the live loader's rows.
 * @returns {Array<{id: string, name?: string}>}
 */
export function liveRows(ctx) {
  const rows = []
  try {
    for (const entry of ctx.get?.('loader')?.entries?.() ?? []) {
      const id = entry?.options?.id
      if (typeof id !== 'string') continue
      let disabled = false
      try {
        disabled = Boolean(entry.disabled)
      } catch {
        disabled = false
      }
      if (disabled) continue
      rows.push({ id, name: entry?.options?.name })
    }
  } catch {
    /* an unreadable loader means an empty suspect list, not a crash */
  }
  return rows
}

/**
 * Write the resurrection overlay to disk.
 * @returns {{ ok: true, overlayPath: string, disabled: string[] } | { ok: false, reason: string }}
 */
export function prepareResurrection(options) {
  const rows = options.rows ?? liveRows(options.ctx)
  const overlay = buildResurrectionOverlay(rows)
  const dir = join(options.home, 'logs', 'crash-guard')
  const overlayPath = join(dir, 'resurrection.patch.yml')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(overlayPath, overlay ?? '[]\n')
  } catch (error) {
    return { ok: false, reason: `could not write the overlay: ${String(error)}` }
  }
  return {
    ok: true,
    overlayPath,
    disabled: rows.filter((row) => !keepRow(row)).map((row) => row.id),
  }
}

/**
 * Start a rescue session on the operator's own profile, on its own port.
 *
 * This is the version the rescue endpoint needs: it returns a URL the operator
 * can open, and it leaves the broken process alone. (Replacing this process in
 * place is `scheduleResurrection`, a different job.)
 *
 * @returns {{ ok: boolean, url?: string, pid?: number, reason?: string }}
 */
export async function spawnResurrectionSession(options) {
  const profile = options.profile ?? process.env.DSH_PROFILE
  if (typeof profile !== 'string' || profile.length === 0) return { ok: false, reason: 'unknown-profile' }
  if (profile === 'desktop') return { ok: false, reason: 'desktop-profile-is-app-managed' }

  const prepared = prepareResurrection({ ctx: options.ctx, home: options.home, rows: options.rows })
  if (!prepared.ok) return { ok: false, reason: prepared.reason }

  if (process.versions?.electron !== undefined && process.env.ELECTRON_RUN_AS_NODE !== '1') {
    return { ok: false, reason: 'electron-main-process' }
  }
  const argv = options.argv ?? process.argv
  if (!Array.isArray(argv) || argv.length < 2) return { ok: false, reason: 'no-script' }

  let port
  try {
    port = await findFreePort()
  } catch (error) {
    return { ok: false, reason: `could not find a free port: ${String(error)}` }
  }

  const args = [...argv.slice(1), '--profile', profile, '--patch', prepared.overlayPath, '--no-open', '--port', String(port)]

  try {
    const child = spawn(options.execPath ?? process.execPath, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, DSH_PHOENIX_RESURRECTED: '1' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return {
      ok: true,
      url: `http://127.0.0.1:${String(port)}/`,
      pid: child.pid,
      overlayPath: prepared.overlayPath,
      disabled: prepared.disabled,
    }
  } catch (error) {
    return { ok: false, reason: `could not start the rescue session: ${String(error)}` }
  }
}

/**
 * Replace this process with one booted through the resurrection overlay.
 *
 * The port is the tricky part: the caller is still listening on it, so a
 * replacement started immediately would lose the race and die with EADDRINUSE,
 * leaving the operator with nothing. Instead a tiny detached launcher waits for
 * the port to go quiet and only then starts DSH on it — which also means the
 * operator's browser reconnects to the same URL with no action at all.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
export function scheduleResurrection(options) {
  const { execPath = process.execPath, argv = process.argv, port, profile, overlayPath, cwd = process.cwd() } = options
  if (!Array.isArray(argv) || argv.length < 2) return { ok: false, reason: 'no-script' }
  if (typeof port !== 'number' || port <= 0) return { ok: false, reason: 'no-port' }
  if (process.versions?.electron !== undefined && process.env.ELECTRON_RUN_AS_NODE !== '1') {
    return { ok: false, reason: 'electron-main-process' }
  }

  const childArgs = [...argv.slice(1), '--profile', profile, '--patch', overlayPath, '--no-open', '--port', String(port)]

  // The launcher polls the port, then hands off. It must not inherit stdio:
  // this process is about to exit.
  const launcher = String.raw`
const { execFile } = require('node:child_process');
const net = require('node:net');
const [port, exec, ...args] = process.argv.slice(1);
const deadline = Date.now() + 30000;
function tryOnce() {
  const server = net.createServer();
  server.once('error', () => {
    if (Date.now() > deadline) process.exit(0);
    setTimeout(tryOnce, 150);
  });
  server.listen(Number(port), '127.0.0.1', () => {
    server.close(() => {
      const child = execFile(exec, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: process.env.DSH_PHOENIX_CWD });
      child.unref();
      process.exit(0);
    });
  });
}
tryOnce();
`

  try {
    const child = spawn(execPath, ['-e', launcher, String(port), execPath, ...childArgs], {
      cwd,
      env: { ...process.env, DSH_PHOENIX_CWD: cwd },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `could not schedule the replacement: ${String(error)}` }
  }
}
