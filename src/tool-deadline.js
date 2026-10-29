/**
 * Tool deadline: bound every tool call so a hung tool cannot wedge a session.
 *
 * Why this is needed at all: `dsh-tools` awaits the tool body with no deadline
 * (`const returned = await tool.execute(...)`), and the shipped
 * `dsh-tool-call-timeout-policy` is cooperative — it substitutes a result only
 * AFTER the body settles, so it cannot unblock a body that never settles. A
 * caller's Cancel aborts a signal but does not force the turn to close, so the
 * phase stays `running` and that session refuses new work until a restart.
 *
 * The guard is deliberately non-cooperative: it races the body and abandons it.
 * The abandoned promise keeps running in the background; that is a leak we
 * accept, because a leaked promise costs less than an unrecoverable session.
 * `exec.signal` is aborted on timeout so well-behaved tools stop cooperatively.
 */

export class ToolDeadlineError extends Error {
  constructor(toolName, timeoutMs) {
    super(`tool "${toolName}" exceeded its ${timeoutMs} ms deadline and was abandoned`)
    this.name = 'ToolDeadlineError'
    this.code = 'TOOL_DEADLINE_EXCEEDED'
    this.toolName = toolName
    this.timeoutMs = timeoutMs
  }
}

/**
 * Resolve the deadline for one call.
 * Order: per-tool override, then the global default, then none.
 * `0` or `null` disables the deadline for that scope.
 */
export function resolveDeadline(exec, config) {
  const global = config?.toolTimeoutMs
  const perTool = config?.toolTimeouts?.[exec?.name]
  const chosen = perTool !== undefined ? perTool : global
  if (chosen === null || chosen === 0) return undefined
  if (typeof chosen !== 'number' || !Number.isFinite(chosen) || chosen <= 0) return undefined
  return chosen
}

/**
 * Race `body` against a deadline.
 * Resolves/rejects with the body's outcome when it settles in time; rejects with
 * {@link ToolDeadlineError} otherwise.
 *
 * The timer is referenced on purpose. An `unref`'d timer lets Node consider the
 * loop idle and exit while the deadline is still pending — which is exactly the
 * case this guard exists for (a tool that never settles and holds nothing else
 * open). A pending deadline must keep the loop alive.
 */
export function withDeadline(body, timeoutMs, toolName, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        onTimeout?.()
      } catch {
        /* the abort callback is not allowed to break the rejection */
      }
      reject(new ToolDeadlineError(toolName, timeoutMs))
    }, timeoutMs)

    Promise.resolve()
      .then(body)
      .then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
  })
}

/**
 * Install the guard.
 *
 * `prepend: true` matters: it must run before the cooperative timeout policy,
 * otherwise that policy would arm a deadline that cannot fire.
 *
 * @returns a disposer removing the listener.
 */
export function installToolDeadline(ctx, config, report) {
  if (config?.toolDeadline === false) return () => {}

  const handler = async (exec, next) => {
    const timeoutMs = resolveDeadline(exec, config)
    if (timeoutMs === undefined) return next()

    const startedAt = Date.now()
    try {
      return await withDeadline(
        () => next(),
        timeoutMs,
        String(exec?.name),
        () => {
          // Ask well-behaved tools to stop; the race already gave up on them.
          try {
            exec?.signal?.abort?.(new ToolDeadlineError(String(exec?.name), timeoutMs))
          } catch {
            /* an abort that throws must not mask the deadline */
          }
        },
      )
    } catch (error) {
      if (error instanceof ToolDeadlineError) {
        report({
          kind: 'tool-deadline',
          tool: String(exec?.name ?? 'unknown'),
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
        })
      }
      throw error
    }
  }

  const dispose = ctx.on('tools/execute', handler, { prepend: true })
  return typeof dispose === 'function' ? dispose : () => {}
}
