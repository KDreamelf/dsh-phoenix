/**
 * The crash page: a self-contained document served by the host while it is
 * still holding the process open after a fatal fault.
 *
 * Why a separate page and not the app: the failure this answers may have
 * already unmounted the React tree, so nothing inside that tree can be trusted
 * to render. A plain HTML document served over HTTP renders regardless, and
 * `location.reload()` rebuilds the renderer from scratch — which is the only
 * "hard reset" a page can perform on itself.
 *
 * The page never decides anything on its own. It posts the operator's choice to
 * the host, and the host applies the quarantine before the page reloads;
 * reloading first would just repeat the crash.
 */

export const CRASH_ROUTE = '/phoenix/crash'
export const DECIDE_ROUTE = '/phoenix/decide'
export const STATUS_ROUTE = '/phoenix/status'

/** Answers the page can submit. */
export const CHOICE_RETRY = 'retry'
export const CHOICE_DISABLE = 'disable'
export const CHOICE_REMOVE = 'remove'
export const CHOICE_RESCUE = 'rescue'

const CHOICES = new Set([CHOICE_RETRY, CHOICE_DISABLE, CHOICE_REMOVE, CHOICE_RESCUE])

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function initials(title, pkg) {
  const source = String(title ?? pkg ?? '?').trim()
  const first = [...source][0]
  return first === undefined ? '?' : first.toUpperCase()
}

/**
 * Render the crash page.
 * @param report - what the host recorded about this fault.
 * @returns a complete HTML document.
 */
export function renderCrashPage(report) {
  const pkg = report.package ?? null
  const rowIds = Array.isArray(report.rowIds) ? report.rowIds : []
  const title = report.title ?? (pkg ?? '未知插件')
  const description = report.description ?? '没有可用的插件描述。'
  const path = report.packageDir ?? report.path ?? '(未解析到安装路径)'
  const icon = report.icon ?? null
  const message = report.message ?? '(无错误信息)'
  const stack = report.stack ?? ''
  const canAct = pkg !== null && rowIds.length > 0
  const alreadyQuarantined = report.alreadyQuarantined === true
  const justQuarantined = Array.isArray(report.quarantinedIds) ? report.quarantinedIds : []

  const iconMarkup =
    icon === null
      ? `<div class="glyph">${escapeHtml(initials(title, pkg))}</div>`
      : `<img class="glyph" src="${escapeHtml(icon)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'glyph',textContent:${JSON.stringify(initials(title, pkg))}}))">`

  // Be exact about what has already happened. Attribution disables the row before
  // this page exists, so "给个机会" is not a no-op — it is the button that undoes
  // that. Saying "nothing has been touched yet" would be a lie the operator can
  // catch by looking at their next start.
  const decideNote = canAct
    ? `检测到故障时，这一行已经被停用（${justQuarantined.length > 0 ? justQuarantined.join('、') : rowIds.join('、')}），这样无论你选哪个，下一次都起得来。` +
      '选择后先改写隔离，再重启进程——直接刷新会重复同样的崩溃。'
    : '第一步「查出是谁崩的」这次没成功：崩溃发生在栈里没有插件信息的地方。不死鸟不会乱猜，也不会顺手动任何一个插件。先点「再试一次」排除偶发；仍然崩就进复活模式——它相当于系统的安全模式：只这一次启动不加载第三方插件，你配的模型供应商一个字节都不碰，不死鸟自己也不停，所以新会话里 AI 是活的。它是临时的，关掉重开就回到正常启动。进去以后，把上面这段错误原样丢给 AI，让它把凶手反查出来。'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${canAct ? `DSH 崩溃恢复 — ${escapeHtml(title)}` : 'DSH 已停止运行 — 不死鸟'}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 28px; background: #0f1116; color: #e7ecf5;
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .card { width: 100%; max-width: 760px; background: #171b24; border: 1px solid #2a3143; border-radius: 16px; overflow: hidden; }
  .head { display: flex; gap: 16px; padding: 22px 24px 18px; border-bottom: 1px solid #232a39; }
  .glyph {
    width: 56px; height: 56px; flex: 0 0 56px; border-radius: 12px; object-fit: contain;
    background: #0e1219; border: 1px solid #2a3143;
    display: flex; align-items: center; justify-content: center;
    font-size: 24px; font-weight: 600; color: #8fa6cc;
  }
  .titles { min-width: 0; }
  h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  .pkg { margin: 0 0 6px; color: #93a2bd; font: 12px/1.5 ui-monospace, Consolas, monospace; word-break: break-all; }
  .desc { margin: 0; color: #b3c0d6; }
  .body { padding: 18px 24px; }
  .label { color: #7d8ba5; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
  .path { margin: 0 0 16px; font: 12px/1.5 ui-monospace, Consolas, monospace; color: #9db0cd; word-break: break-all; }
  pre {
    margin: 0; padding: 12px 14px; max-height: 260px; overflow: auto;
    background: #0d1118; border: 1px solid #242b3a; border-radius: 10px;
    font: 12px/1.5 ui-monospace, Consolas, monospace; color: #c4d0e4; white-space: pre-wrap; word-break: break-word;
  }
  .note { margin: 14px 0 0; color: #7d8ba5; font-size: 12px; }
  .foot { display: flex; gap: 10px; justify-content: flex-end; padding: 16px 24px 22px; border-top: 1px solid #232a39; flex-wrap: wrap; }
  button {
    font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 9px; cursor: pointer;
    border: 1px solid #2f3748; background: transparent; color: #cdd8ea;
  }
  button:hover { background: #1e2532; }
  button.primary { border-color: #3b6fe0; background: #2f5fd0; color: #fff; }
  button.danger { border-color: #7a2f2f; color: #f0a9a9; }
  button.danger:hover { background: #2a1a1a; }
  button:disabled { opacity: .5; cursor: default; }
  #status { margin-right: auto; color: #7d8ba5; font-size: 12px; align-self: center; }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      ${iconMarkup}
      <div class="titles">
        <h1>${canAct ? `${escapeHtml(title)} 让 DSH 无法继续` : 'DSH 已停止运行（不死鸟接管）'}</h1>
        <p class="pkg">${canAct ? escapeHtml(pkg ?? '') : '没能定位到是哪个插件出的问题'}</p>
        <p class="desc">${
          canAct
            ? escapeHtml(description)
            : '它本来是去查这个的：从崩溃现场反查是哪一行插件。这次栈里没有插件信息，所以它把这件事交给 AI——下面是原始错误，一个字没改。'
        }</p>
      </div>
    </div>
    <div class="body">
      <div class="label">安装路径</div>
      <p class="path">${escapeHtml(path)}</p>
      <div class="label">错误</div>
      <pre>${escapeHtml(message)}${stack.length > 0 ? `\n\n${escapeHtml(stack)}` : ''}</pre>
      <p class="note">${escapeHtml(decideNote)}${
        alreadyQuarantined && justQuarantined.length === 0 ? '（这个插件此前已被隔离。）' : ''
      }</p>
    </div>
    <div class="foot">
      <span id="status"></span>
      ${
        canAct
          ? `<button type="button" class="primary" data-choice="retry">给个机会（恢复它再启动）</button>
      <button type="button" data-choice="disable">停职（保持禁用）</button>
      <button type="button" class="danger" data-choice="remove">开除（禁用并卸载）</button>`
          : `<button type="button" data-choice="retry">再试一次</button>
      <button type="button" class="primary" data-choice="rescue">进入复活模式（让 AI 查）</button>`
      }
    </div>
  </div>
<script>
(function () {
  var status = document.getElementById('status');
  var buttons = document.querySelectorAll('button[data-choice]');
  var busy = false;

  function setBusy(on, text) {
    busy = on;
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = on || buttons[i].hasAttribute('data-original-disabled');
    status.textContent = text || '';
  }

  for (var i = 0; i < buttons.length; i++) {
    if (buttons[i].disabled) buttons[i].setAttribute('data-original-disabled', '1');
  }

  async function decide(choice) {
    if (busy) return;
    setBusy(true, '正在执行…');
    try {
      var response = await fetch('${DECIDE_ROUTE}', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ choice: choice }),
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok || !payload.ok) {
        setBusy(false, payload.error || payload.message || ('请求失败：' + response.status));
        return;
      }
      // A rescue session lives at a different URL; the others restart in place.
      if (typeof payload.url === 'string' && payload.url.length > 0) {
        status.textContent = payload.message || '复活会话已就绪，正在打开…';
        setTimeout(function () { location.assign(payload.url); }, 400);
        return;
      }
      status.textContent = payload.message || '已完成，正在重载…';
      setTimeout(function () { location.reload(); }, 600);
    } catch (error) {
      setBusy(false, '无法联系宿主：' + error.message + '（可以手动重启 DSH）');
    }
  }

  for (var j = 0; j < buttons.length; j++) {
    buttons[j].addEventListener('click', function () {
      decide(this.getAttribute('data-choice'));
    });
  }
})();
</script>
</body>
</html>`
}

/** Validate one submitted choice. */
export function readChoice(body) {
  if (typeof body !== 'string' || body.length === 0) return undefined
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const choice = parsed?.choice
  return typeof choice === 'string' && CHOICES.has(choice) ? choice : undefined
}
