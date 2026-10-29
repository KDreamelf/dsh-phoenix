/**
 * dsh-phoenix — Web rescue half.
 *
 * Why native DOM and not a React component: the failure this covers is a
 * `SlotAssemblyError` thrown during render. The renderer's error boundaries
 * deliberately re-throw that family, and React then unmounts the whole tree —
 * every component, including any rescue UI built as one. A listener on `window`
 * is outside that tree, so it survives the unmount and can still draw.
 *
 * Scope: fatal signatures only. This is not a general error reporter; a normal
 * per-entry crash already degrades to a single empty slot and needs no rescue.
 */

const PKG = 'dsh-phoenix'
const OVERLAY_ID = 'dsh-phoenix-rescue'

/** Signatures that mean "the page is gone", not "one widget broke". */
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
  if (error === undefined || error === null) return 'Unknown failure'
  const name = typeof error.name === 'string' ? error.name : 'Error'
  const message = typeof error.message === 'string' ? error.message : String(error)
  return `${name}: ${message}`
}

function removeOverlay() {
  const existing = document.getElementById(OVERLAY_ID)
  if (existing !== null) existing.remove()
}

function drawOverlay(detail) {
  if (typeof document === 'undefined' || document.body === null) return
  removeOverlay()

  const host = document.createElement('div')
  host.id = OVERLAY_ID
  host.setAttribute('role', 'alertdialog')
  host.setAttribute('aria-live', 'assertive')
  host.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:24px',
    'background:rgba(12,14,20,.72)',
    'backdrop-filter:blur(6px)',
    'font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
    'color:#e8ecf4',
  ].join(';')

  const card = document.createElement('div')
  card.style.cssText = [
    'max-width:640px',
    'width:100%',
    'background:#171b26',
    'border:1px solid #2b3245',
    'border-radius:14px',
    'padding:22px 22px 18px',
    'box-shadow:0 18px 60px rgba(0,0,0,.5)',
  ].join(';')

  const title = document.createElement('div')
  title.textContent = '界面渲染崩溃（不死鸟兜底）'
  title.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:6px'

  const hint = document.createElement('div')
  hint.textContent = '页面结构已被框架卸载，但进程仍然存活，会话数据没有丢失。刷新即可恢复。'
  hint.style.cssText = 'color:#9aa4bb;margin-bottom:14px'

  const detailBox = document.createElement('pre')
  detailBox.textContent = detail
  detailBox.style.cssText = [
    'margin:0 0 16px',
    'padding:10px 12px',
    'max-height:180px',
    'overflow:auto',
    'background:#0f131c',
    'border:1px solid #262d3d',
    'border-radius:8px',
    'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#c8d2e6',
    'white-space:pre-wrap',
    'word-break:break-word',
  ].join(';')

  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end'

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = '复制详情'
  copy.style.cssText = [
    'padding:8px 14px',
    'border-radius:8px',
    'border:1px solid #2b3245',
    'background:transparent',
    'color:#c8d2e6',
    'cursor:pointer',
    'font:inherit',
  ].join(';')
  copy.addEventListener('click', () => {
    const text = detail
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        void navigator.clipboard.writeText(text)
        copy.textContent = '已复制'
        return
      }
    } catch {
      /* fall through to the legacy path */
    }
    try {
      const area = document.createElement('textarea')
      area.value = text
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
      copy.textContent = '已复制'
    } catch {
      copy.textContent = '复制失败'
    }
  })

  const reload = document.createElement('button')
  reload.type = 'button'
  reload.textContent = '刷新页面'
  reload.style.cssText = [
    'padding:8px 14px',
    'border-radius:8px',
    'border:1px solid #3b6fe0',
    'background:#2f5fd0',
    'color:#fff',
    'cursor:pointer',
    'font:inherit',
    'font-weight:600',
  ].join(';')
  reload.addEventListener('click', () => {
    try {
      location.reload()
    } catch {
      /* nothing else to try */
    }
  })

  actions.append(copy, reload)
  card.append(title, hint, detailBox, actions)
  host.append(card)
  document.body.appendChild(host)
}

window.__ModuleLoader__.load({
  id: PKG,
  factory() {
    // The rescue must never become a second source of breakage: every entry
    // point below swallows its own failure.
    function safe(work) {
      try {
        work()
      } catch {
        /* a rescue that throws is worse than no rescue */
      }
    }

    return {
      apply(ctx) {
        const state = { shown: false, last: '' }

        function handle(error, origin) {
          safe(() => {
            if (!isFatal(error)) return
            const detail = summarize(error)
            state.last = detail
            if (state.shown) return
            state.shown = true
            drawOverlay(`${detail}\n\n[${origin}]\n${error?.stack ?? ''}`.trim())
          })
        }

        const onError = (event) => handle(event?.error ?? new Error(String(event?.message ?? 'error')), 'window.error')
        const onRejection = (event) => handle(event?.reason, 'unhandledrejection')

        ctx.effect(() => {
          window.addEventListener('error', onError)
          window.addEventListener('unhandledrejection', onRejection)

          // Escape hatch for a blank page produced by something that never
          // reached an error handler: ?phoenix=rescue forces the card.
          safe(() => {
            const params = new URLSearchParams(location.search)
            if (params.get('phoenix') === 'rescue') {
              state.shown = true
              drawOverlay('手动进入救援模式（?phoenix=rescue）')
            }
          })

          window.__DSH_PHOENIX__ = {
            version: '0.1.0',
            reload: () => location.reload(),
            force: () => {
              state.shown = true
              drawOverlay('手动触发')
            },
            dismiss: () => {
              removeOverlay()
              state.shown = false
            },
            lastError: () => state.last,
          }

          return () => {
            window.removeEventListener('error', onError)
            window.removeEventListener('unhandledrejection', onRejection)
            removeOverlay()
            delete window.__DSH_PHOENIX__
            state.shown = false
          }
        })
      },
    }
  },
})
