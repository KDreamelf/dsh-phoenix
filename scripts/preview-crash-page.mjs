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
import { readFileSync } from 'node:fs'
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

/**
 * Serve a harness that loads the REAL client.js and fires a fatal error, so the
 * modal is rendered by the actual code rather than a reimplementation of it.
 */
function modalHarness(clientSource) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>不死鸟 · 模态框预览</title>
<style>
  body { margin: 0; min-height: 100vh; background: #0f1116; color: #6b7891;
         font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         display: flex; align-items: center; justify-content: center; }
  .behind { text-align: center; max-width: 420px; }
  .behind h1 { font-size: 16px; color: #8b99b3; font-weight: 500; margin: 0 0 8px; }
  .behind p { margin: 0; font-size: 13px; }
  code { background: #1a1f2b; padding: 1px 6px; border-radius: 4px; }
</style>
</head>
<body>
  <div class="behind">
    <h1>模拟的应用界面</h1>
    <p>下面是真实 <code>client.js</code> 渲染出来的模态框。<br>
       刷新页面可重现；点「进入复活模式」在预览里只会报错，这是预期。</p>
  </div>
<script>
// Minimal stand-ins for the two globals client.js expects.
window.__ModuleLoader__ = { load: function (entry) { window.__phoenixEntry = entry; } };
</script>
<script>${clientSource}</script>
<script>
(function () {
  var entry = window.__phoenixEntry;
  if (!entry) { document.title = '加载失败'; return; }
  var mod = entry.factory();
  var cleanups = [];
  mod.apply({
    effect: function (fn) {
      var d = fn();
      if (typeof d === 'function') cleanups.push(d);
      return function () { if (typeof d === 'function') d(); };
    },
    remote: { $on: function () { return function () {}; } },
  });

  // Fire the exact shape the renderer produces for a whole-tree unmount.
  var fatal = new Error("renderSlot('root') before any 'root' registration (boot order)");
  fatal.name = 'SlotAssemblyError';
  setTimeout(function () {
    window.dispatchEvent(new ErrorEvent('error', { error: fatal, message: fatal.message }));
  }, 200);
})();
</script>
</body>
</html>`
}

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
    // `?variant=unattributable` shows the branch where no plugin could be
    // named: nothing to disable, so the page offers retry or a rescue session.
    const variant = url.searchParams.get('variant')
    const shown =
      variant === 'unattributable'
        ? {
            kind: 'uncaughtException',
            package: null,
            title: undefined,
            description: undefined,
            packageDir: undefined,
            icon: null,
            rowIds: [],
            message: "TypeError: undefined is not an object (evaluating 'win.ctx.foo')",
            stack: [
              "TypeError: undefined is not an object (evaluating 'win.ctx.foo')",
              '    at init (app://dsh/main.js:1:1)',
              '    (no package frame in this stack)',
            ].join('\n'),
            decision: 'logged',
            reason: 'no-package-in-stack',
            alreadyQuarantined: false,
          }
        : report
    sendHtml(res, renderCrashPage(shown))
    return
  }

  if (url.pathname === '/phoenix/modal' && req.method === 'GET') {
    let source
    try {
      source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`could not read client.js: ${String(error)}`)
      return
    }
    sendHtml(res, modalHarness(source))
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
