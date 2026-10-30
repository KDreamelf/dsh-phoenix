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
import { createServer, connect } from 'node:net'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

/**
 * Set inside a rescue session.
 *
 * Declared here rather than in the blocking monitor because the launcher is what
 * must refuse: a rescue session that can launch another rescue session is an
 * unbounded chain of processes, each one spending the operator's tokens and each
 * one a fresh chance to break. The guard is re-armed inside a rescue on purpose
 * (so a second fault is still contained) — but containment never escalates.
 */
export const RESURRECTED_ENV = 'DSH_PHOENIX_RESURRECTED'

/** Whether this process is itself a rescue session. */
export function isRescueSession(env = process.env) {
  return env?.[RESURRECTED_ENV] === '1'
}

/**
 * The profile this process actually booted.
 *
 * Not `process.env.DSH_PROFILE`. That variable is inherited by every shell and
 * child process, so a host started with `--profile phoenix-dev` from a terminal
 * whose environment says `desktop` reports `desktop` and then refuses to rescue
 * itself. The booted profile is `profileContext.name`, which the launcher
 * provides for exactly this purpose.
 *
 * Reading the environment as a fallback is still right for hosts that do not
 * provide the service, but it must never win.
 */
export function profileName(ctx) {
  try {
    const name = ctx?.get?.('profileContext')?.name
    if (typeof name === 'string' && name.length > 0) return name
  } catch {
    /* fall through to the environment */
  }
  const fromEnv = process.env.DSH_PROFILE
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined
}

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
  'already-rescue-session':
    '你现在就在复活模式里。再开一层只会套娃，不会更好——请把问题交给这里的 AI 处理。',
  'desktop-profile-is-app-managed':
    '桌面版的 profile 由应用自己管理，不死鸟没法替它另开一个安全模式窗口。请先关掉 DSH，用命令行方式启动一次 web 界面再进复活模式；或者直接在设置里停用可疑插件。',
  'electron-main-process': '当前进程是桌面应用的主进程，不能从这里重启。请手动关闭并重新打开 DSH。',
  'rescue-unavailable': '没能准备好复活所需的排查信息。请手动关掉 DSH 再重新打开。',
  'not-prepared': '还没准备好复活所需的排查信息，请先让故障复现一次。',
  'no-script': '无法确定启动参数，请手动重开 DSH。',
  'rescue-session-did-not-start': '安全模式进程没能起来（可能刚好又被同一个问题拖垮）。请手动重开 DSH；如果重开也起不来，就在设置里停用最近装的那个插件。',
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

/** How long a rescue process gets to accept a connection. */
export const RESCUE_READY_TIMEOUT_MS = 20000

/**
 * Wait until something accepts a connection on the port.
 *
 * Polling a listening socket is the only signal available here: the child is
 * detached with its stdio discarded, so there is no exit code, no stderr, and no
 * callback to subscribe to. A rescue that fails to boot is otherwise reported as
 * a success with a URL that never loads.
 */
export function waitForPort(port, timeoutMs = RESCUE_READY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const attempt = () => {
      const socket = connect({ port, host: '127.0.0.1' })
      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        socket.destroy()
        if (ok) resolve(true)
        else if (Date.now() > deadline) resolve(false)
        else setTimeout(attempt, 150)
      }
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
      socket.setTimeout(1000, () => finish(false))
    }
    attempt()
  })
}

/**
 * Build the argv for a rescue process.
 *
 * Appending launcher flags to the current argv does not work, and the failure is
 * silent: the launcher stops parsing its own options once the app's arguments
 * begin, so a second `--profile` further right is rejected as unknown and the
 * child exits immediately — with `stdio: 'ignore'`, which means nothing to read
 * and a URL that never answers. The rescue then looks "started" while nothing is
 * listening on the port it advertised.
 *
 * So this REPLACES the launcher flags instead of adding to them: drop `--profile`,
 * `--patch`, `--port`, and `--no-open` wherever they appear, then put ours back in
 * front of whatever app arguments remain. Any app-specific flag the operator had
 * (a `--trusted-host`, say) survives in its original order.
 *
 * The return value EXCLUDES argv[0]: it is what `spawn(execPath, args)` expects.
 * Returning the full argv and slicing at each call site is how the child ended up
 * being told to run `node.exe` as a script.
 */
export function buildRescueArgv(options) {
  const argv = options.argv ?? process.argv
  if (!Array.isArray(argv) || argv.length < 2) return undefined

  const launcherValueFlags = new Set(['--profile', '--patch', '--port'])
  const launcherBareFlags = new Set(['--no-open'])
  // index 1 is the script (the launcher itself); it must stay adjacent to argv[0]
  // or the child runs nothing at all.
  const script = argv[1]
  const appArgs = []

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index]
    if (launcherValueFlags.has(value)) {
      // Skip the flag and the value it consumes.
      index += 1
      continue
    }
    if (launcherBareFlags.has(value)) continue
    appArgs.push(value)
  }

  const args = [script]
  if (typeof options.profile === 'string' && options.profile.length > 0) {
    args.push('--profile', options.profile)
  }
  if (typeof options.overlayPath === 'string' && options.overlayPath.length > 0) {
    args.push('--patch', options.overlayPath)
  }
  args.push('--no-open')
  if (options.port !== undefined) args.push('--port', String(options.port))
  args.push(...appArgs)
  return args
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
  // Never from inside a rescue. The guard stays armed there so a second fault is
  // contained, but a rescue that launched rescue would be a chain with no end.
  if (isRescueSession(options.env)) return { ok: false, reason: 'already-rescue-session' }

  const profile = options.profile ?? profileName(options.ctx)
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

  const args = buildRescueArgv({
    argv,
    profile,
    overlayPath: prepared.overlayPath,
    port,
  })
  if (args === undefined) return { ok: false, reason: 'no-script' }

  // The child cannot report a startup failure: it is detached with stdio
  // ignored, so its stderr is gone. Verify the port answers before telling the
  // operator to go there — an advertised URL that never loads is worse than an
  // honest failure.
  try {
    const child = spawn(options.execPath ?? process.execPath, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, DSH_PHOENIX_RESURRECTED: '1' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    const ready = await waitForPort(port, options.readyTimeoutMs ?? RESCUE_READY_TIMEOUT_MS)
    if (!ready) {
      // Stop the corpse: leaving it running would hold the port and the overlay
      // long after the operator was told the rescue failed.
      try {
        child.kill()
      } catch {
        /* best effort */
      }
      return { ok: false, reason: 'rescue-session-did-not-start' }
    }
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

  const childArgs = buildRescueArgv({ argv, profile, overlayPath, port })
  if (childArgs === undefined) return { ok: false, reason: 'no-script' }

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
