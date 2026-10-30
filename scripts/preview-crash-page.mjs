/**
 * Preview the crash page without crashing anything.
 *
 * This serves the REAL renderer from src/crash-page.js, so what you see is the
 * actual product, not a hand-copied mock. Only two things are stubbed: the
 * fault report (obviously) and the decision handler, which records the choice
 * in the preview process instead of quarantining anything or restarting a
 * process that does not exist.
 *
 * Usage: node scripts/preview-crash-page.mjs [--port 7788] [--no-open]
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

import { CRASH_ROUTE, DECIDE_ROUTE, STATUS_ROUTE, readChoice, renderCrashPage } from '../src/crash-page.js'

const argv = process.argv.slice(2)
function flag(name) {
  return argv.includes(name)
}
function value(name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const port = Number(value('--port', '7788'))
const shouldOpen = !flag('--no-open')

/** A believable fault: a real package shape, a real stack. */
const report = {
  kind: 'uncaughtException',
  package: 'dsh-plugin-iot-thinking',
  title: 'IoT 思维插件',
  description: '把 IoT 设备状态接进对话上下文，供模型读取温湿度与开关状态。',
  version: '0.4.2',
  packageDir: 'C:\\Users\\dream\\dsh-plugins\\IoT-items-of-thoughts\\dsh-plugin-iot-thinking',
  icon: null,
  rowIds: ['iot-thinking'],
  message: "TypeError: Cannot read properties of undefined (reading 'temperature')",
  stack: [
    "TypeError: Cannot read properties of undefined (reading 'temperature')",
    '    at poll (/C:/Users/dream/dsh-plugins/IoT-items-of-thoughts/dsh-plugin-iot-thinking/lib/poller.js:42:31)',
    '    at Timeout._onTimeout (node:internal/timers:588:17)',
    '    at listOnTimeout (node:internal/timers:523:7)',
    '    at process.processTimers (node:internal/timers:523:7)',
  ].join('\n'),
  decision: 'logged',
  reason: 'no-package-in-stack',
  alreadyQuarantined: false,
}

const chosen = []

function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(html)
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

async function readBody(req) {
  return await new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

  if (url.pathname === CRASH_ROUTE && req.method === 'GET') {
    sendHtml(res, renderCrashPage(report))
    return
  }

  if (url.pathname === STATUS_ROUTE && req.method === 'GET') {
    sendJson(res, 200, { ok: true, preview: true, recovering: true, decided: false, report })
    return
  }

  if (url.pathname === DECIDE_ROUTE && req.method === 'POST') {
    const body = await readBody(req)
    const choice = readChoice(body)
    if (choice === undefined) {
      sendJson(res, 400, { ok: false, error: '无效的选择' })
      return
    }
    chosen.push(choice)
    process.stdout.write(`\n[preview] 你点了：${choice}\n`)
    // Report success without reloading, so the page stays put for inspection.
    sendJson(res, 200, {
      ok: true,
      message: `预览模式：记录到「${choice}」，真实环境里这里会隔离并重启`,
    })
    return
  }

  if (url.pathname === '/') {
    res.writeHead(302, { location: CRASH_ROUTE })
    res.end()
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}${CRASH_ROUTE}`
  process.stdout.write(`crash page preview: ${url}\n`)
  process.stdout.write('（这是本地预览，进程里没有任何真实插件，也不会改动 ~/.dsh）\n')
  process.stdout.write('按 Ctrl-C 结束。\n')

  if (!shouldOpen) return
  // Same approach the web app uses: hand the URL to the OS.
  try {
    if (process.platform === 'win32') {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
    }
  } catch {
    /* the operator can open the printed URL */
  }
})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
