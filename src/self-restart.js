/**
 * Self-restart: replace this process with a fresh one.
 *
 * Why not just `location.reload()`: after an uncaught exception the in-process
 * state is untrustworthy — DSH's own comment on the fail-loud handler says a
 * listener that threw mid-update leaves silently wrong results behind if it is
 * resumed. Reloading the page against the same damaged process would show the
 * same fault again. A real reset has to replace the process.
 *
 * A detached child is spawned from the same executable and argv, then this
 * process exits. The child is detached so it survives this process's teardown;
 * it inherits the environment so the profile and home resolve identically.
 *
 * This cannot work everywhere, and says so instead of pretending: Electron's
 * main process launches the host differently, and a packaged app may not have a
 * usable argv. Every failure returns a reason for the caller to report.
 */

import { spawn } from 'node:child_process'

/** Arguments that describe "run the same thing again". */
export function restartCommand(env = process.env, versions = process.versions) {
  const execPath = process.execPath
  if (typeof execPath !== 'string' || execPath.length === 0) {
    return { ok: false, reason: 'no-exec-path' }
  }

  // Running as Electron's main process is the one case where `execPath` is the
  // Electron binary and respawning it would open an app, not this host. Note
  // the discriminator: a host launched BY Electron with ELECTRON_RUN_AS_NODE=1
  // is an ordinary Node process (argv[1] is a script) and restarts fine.
  const isElectronBinary = typeof versions?.electron === 'string' && env.ELECTRON_RUN_AS_NODE !== '1'
  if (isElectronBinary) {
    return { ok: false, reason: 'electron-main-process' }
  }

  const argv = Array.isArray(process.argv) ? [...process.argv] : []
  if (argv.length === 0) return { ok: false, reason: 'empty-argv' }

  // `process.argv[0]` is the executable and `argv[1]` the script (or -e etc.).
  const script = argv[1]
  if (script === undefined) return { ok: false, reason: 'no-script' }

  const execArgv = Array.isArray(process.execArgv)
    ? process.execArgv.filter((flag) => !String(flag).startsWith('--inspect'))
    : []

  return { ok: true, command: execPath, args: [...execArgv, ...argv.slice(1)], cwd: process.cwd() }
}

/**
 * Spawn the replacement and return without touching this process.
 * @returns {{ ok: boolean, reason?: string, pid?: number }}
 */
export function spawnReplacement() {
  const spec = restartCommand()
  if (!spec.ok) return { ok: false, reason: spec.reason }

  try {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return { ok: true, pid: child.pid }
  } catch (error) {
    return { ok: false, reason: `spawn-failed:${String(error)}` }
  }
}
