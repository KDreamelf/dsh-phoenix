/**
 * dsh-phoenix — the dialog the operator actually sees.
 *
 * Why native DOM and not a React component: the failures this covers include
 * `SlotAssemblyError`, which the renderer deliberately re-throws, after which
 * React unmounts the whole tree — taking any React-based rescue UI with it. A
 * listener on `window` is outside that tree, so it survives and can still draw.
 *
 * Why a modal and not a toast: a toast is a line of text that disappears on its
 * own. It cannot ask a question and it cannot be acted on. This failure needs the
 * operator's decision — retry, or enter a rescue session — so it blocks, shows
 * the original error, and offers both.
 *
 * Two triggers:
 *   - the page is gone (fatal render error, white screen)
 *   - DSH itself cannot work (the host reports repeated session failures)
 *
 * The plugin never decides on its own. A transient fault should retry, and a
 * rescue session spends the operator's tokens.
 */

const PKG = 'dsh-phoenix'
const OVERLAY_ID = 'dsh-phoenix-modal'
const RESCUE_ENDPOINT = '/phoenix/rescue'

/** Render errors that mean the page itself is gone, not one widget. */
const FATAL = [
  'SlotAssemblyError',
  "before any 'root' registration",
  'has contextual injected Hooks but no hookContext',
  'no locale face is installed',
  "without an installed 'session' scope adapter",
  'Maximum update depth exceeded',
]

function isFatal(error) {
  if (error === undefined || error === null) return false
  const name = typeof error.name === 'string' ? error.name : ''
  const message = typeof error.message === 'string' ? error.message : String(error)
  const stack = typeof error.stack === 'string' ? error.stack : ''
  const haystack = `${name}\n${message}\n${stack}`
  return FATAL.some((signature) => haystack.includes(signature))
}

function summarize(error) {
  if (error === undefined || error === null) return '未知错误'
  const name = typeof error.name === 'string' ? error.name : 'Error'
  const message = typeof error.message === 'string' ? error.message : String(error)
  return `${name}: ${message}`
}

function el(tag, style, text) {
  const node = document.createElement(tag)
  if (style !== undefined) node.style.cssText = style
  if (text !== undefined) node.textContent = text
  return node
}

function removeModal() {
  const existing = document.getElementById(OVERLAY_ID)
  if (existing !== null) existing.remove()
}

/**
 * Draw the modal.
 *
 * @param options.title - headline.
 * @param options.detail - the original error, unedited.
 * @param options.hint - one line about what the buttons do.
 * @param options.onRescue - async; returns a URL to open or a reason it failed.
 * @returns the overlay element.
 */
function drawModal(options) {
  if (typeof document === 'undefined' || document.body === null) return undefined
  removeModal()

  const host = el(
    'div',
    [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:24px',
      'background:rgba(8,10,16,.74)',
      'backdrop-filter:blur(6px)',
      'font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'color:#e8ecf4',
    ].join(';'),
  )
  host.id = OVERLAY_ID
  host.setAttribute('role', 'alertdialog')
  host.setAttribute('aria-modal', 'true')
  host.setAttribute('aria-live', 'assertive')

  const card = el(
    'div',
    [
      'width:100%',
      'max-width:680px',
      'background:#171b26',
      'border:1px solid #2b3245',
      'border-radius:14px',
      'padding:22px',
      'box-shadow:0 18px 60px rgba(0,0,0,.55)',
    ].join(';'),
  )

  const title = el('div', 'font-size:17px;font-weight:650;margin-bottom:6px', options.title)
  const hint = el('div', 'color:#9aa4bb;margin-bottom:14px', options.hint)

  const detail = el(
    'pre',
    [
      'margin:0 0 16px',
      'padding:11px 13px',
      'max-height:220px',
      'overflow:auto',
      'background:#0f131c',
      'border:1px solid #262d3d',
      'border-radius:9px',
      'font:12px/1.55 ui-monospace,Consolas,monospace',
      'color:#c8d2e6',
      'white-space:pre-wrap',
      'word-break:break-word',
    ].join(';'),
    options.detail,
  )

  const status = el('div', 'margin-right:auto;align-self:center;color:#8b99b3;font-size:12px', '')

  const actions = el('div', 'display:flex;gap:10px;align-items:center;flex-wrap:wrap')

  const retry = el(
    'button',
    [
      'padding:9px 16px',
      'border-radius:9px',
      'border:1px solid #2f3748',
      'background:transparent',
      'color:#cdd8ea',
      'cursor:pointer',
      'font:inherit',
    ].join(';'),
    '再试一次（刷新页面）',
  )
  retry.type = 'button'
  retry.addEventListener('click', () => {
    try {
      location.reload()
    } catch {
      /* nothing else to try */
    }
  })

  const rescue = el(
    'button',
    [
      'padding:9px 16px',
      'border-radius:9px',
      'border:1px solid #3b6fe0',
      'background:#2f5fd0',
      'color:#fff',
      'cursor:pointer',
      'font:inherit',
      'font-weight:600',
    ].join(';'),
    '进入复活模式',
  )
  rescue.type = 'button'
  rescue.addEventListener('click', async () => {
    rescue.disabled = true
    status.textContent = '正在准备复活会话…'
    try {
      const result = await options.onRescue()
      if (result?.ok === true && typeof result.url === 'string') {
        status.textContent = '已就绪，正在打开…'
        try {
          location.assign(result.url)
        } catch {
          status.textContent = `复活会话已就绪，请手动打开：${result.url}`
        }
        return
      }
      rescue.disabled = false
      status.textContent = result?.message ?? result?.reason ?? '无法自动进入复活模式'
    } catch (error) {
      rescue.disabled = false
      status.textContent = `无法自动进入复活模式：${summarize(error)}`
    }
  })

  actions.append(status, retry, rescue)
  card.append(title, hint, detail, actions)
  host.append(card)
  document.body.appendChild(host)
  return host
}

window.__ModuleLoader__.load({
  id: PKG,
  factory() {
    return {
      inject: ['remote'],

      apply(ctx) {
        // A rescue must never become a second source of breakage.
        const safe = (work) => {
          try {
            work()
          } catch {
            /* swallowing is correct here: the rescue cannot be the next fault */
          }
        }

        let shown = false
        let lastDetail = ''

        const present = (title, detail, hint) => {
          if (shown) return
          shown = true
          lastDetail = detail
          drawModal({
            title,
            detail,
            hint,
            onRescue: async () => {
              const response = await fetch(RESCUE_ENDPOINT, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ choice: 'rescue' }),
              })
              if (!response.ok) {
                return {
                  ok: false,
                  message: `宿主拒绝了请求（HTTP ${String(response.status)}）。桌面端无法直接调用此接口，请在命令行运行：dsh-phoenix rescue`,
                }
              }
              return await response.json()
            },
          })
        }

        const onError = (event) => {
          safe(() => {
            const error = event?.error ?? new Error(String(event?.message ?? 'error'))
            if (!isFatal(error)) return
            present(
              '界面已崩溃（不死鸟接管）',
              `${summarize(error)}\n\n${error?.stack ?? ''}`.trim(),
              '页面渲染出错，DSH 进程仍然存活。你可以先刷新重试，或者进入复活模式——它会保留你的模型配置，只停用你装的第三方插件。',
            )
          })
        }

        const onRejection = (event) => {
          safe(() => {
            const reason = event?.reason
            if (!isFatal(reason)) return
            present(
              '界面已崩溃（不死鸟接管）',
              `${summarize(reason)}\n\n${reason?.stack ?? ''}`.trim(),
              '页面渲染出错，DSH 进程仍然存活。你可以先刷新重试，或者进入复活模式——它会保留你的模型配置，只停用你装的第三方插件。',
            )
          })
        }

        ctx.effect(() => {
          window.addEventListener('error', onError)
          window.addEventListener('unhandledrejection', onRejection)

          // The host counts session failures and prepares a rescue when the
          // streak proves DSH cannot talk. This only surfaces the native error
          // text it recorded; nothing here classifies messages.
          safe(() => {
            const dispose = ctx.remote?.$on?.('api-session/error', (_sessionId, message) => {
              present(
                'DSH 无法开始对话（不死鸟接管）',
                String(message ?? '(空错误)'),
                '新建会话反复失败。你可以先重试，或者进入复活模式——保留你的模型配置，只停用第三方插件。',
              )
            })
            if (typeof dispose === 'function') ctx.effect(() => dispose)
          })

          // Escape hatch when a failure never reached a handler.
          safe(() => {
            const params = new URLSearchParams(location.search)
            if (params.get('phoenix') === 'rescue') {
              shown = true
              present('手动进入复活检查', '（由 ?phoenix=rescue 触发）', '如果你只是想看看这里有什么。')
            }
          })

          window.__DSH_PHOENIX__ = {
            version: '0.1.0',
            dismiss: () => {
              removeModal()
              shown = false
            },
            reload: () => location.reload(),
            lastError: () => lastDetail,
          }

          return () => {
            window.removeEventListener('error', onError)
            window.removeEventListener('unhandledrejection', onRejection)
            removeModal()
            delete window.__DSH_PHOENIX__
            shown = false
          }
        })
      },
    }
  },
})
