/**
 * Attribution: turn a thrown value into the plugin row that owns it.
 *
 * Two shapes have to work:
 *   1. A registry install — frames carry `.../node_modules/<pkg>/lib/x.js`.
 *   2. A `link:` install — the checkout lives outside `node_modules`, so the
 *      only usable signal is a path segment matching a mounted row's package
 *      root.
 *
 * Everything here is pure and defensive: attribution runs on the crash path,
 * where throwing would be worse than failing to attribute.
 */

/** Describe a thrown value without trusting its own getters. */
export function describe(value) {
  if (value instanceof Error) {
    return {
      name: readString(() => value.name) ?? 'Error',
      message: readString(() => value.message) ?? '',
      stack: readString(() => value.stack) ?? '',
      code: readString(() => value.code),
    }
  }
  return {
    name: typeof value,
    message: readString(() => String(value)) ?? '<unstringifiable>',
    stack: '',
    code: undefined,
  }
}

function readString(read) {
  try {
    const value = read()
    if (typeof value === 'string') return value
    if (value === undefined || value === null) return undefined
    return String(value)
  } catch {
    return undefined
  }
}

/** Walk `cause` links without looping on a self-reference. */
export function causeChain(error, limit = 8) {
  const out = []
  const seen = new Set()
  let current = error
  while (current instanceof Error && !seen.has(current) && out.length < limit) {
    seen.add(current)
    out.push(current)
    current = current.cause
  }
  return out
}

/**
 * Extract the package from a `node_modules/<pkg>/` frame.
 * The last match wins: the deepest frame sits closest to the fault.
 */
export function packageFromStack(stack) {
  if (typeof stack !== 'string' || stack.length === 0) return undefined
  const pattern = /(?:node_modules|plugins)[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)[/\\]/
  let best
  for (const line of stack.split('\n')) {
    const hit = pattern.exec(line)
    if (hit) best = hit[1].replace(/\\/g, '/')
  }
  return best
}

/** Strip a subpath: `dsh-ops/shell` -> `dsh-ops`, `@scope/pkg/x` -> `@scope/pkg`. */
export function packageRoot(name) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (name.startsWith('@')) {
    const parts = name.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : name
  }
  return name.split('/')[0]
}

/**
 * The directory basename that identifies a package on disk.
 * `@scope/pkg` -> `pkg`; the scope directory is a container, not the package.
 */
export function packageSegment(name) {
  const root = packageRoot(name)
  if (root === undefined) return undefined
  const segment = root.startsWith('@') ? root.split('/')[1] : root
  return typeof segment === 'string' && segment.length > 0 ? segment : undefined
}

/** Loader rows whose mounted name resolves to `pkg`. */
export function rowsForPackage(loader, pkg) {
  const rows = []
  for (const entry of safeEntries(loader)) {
    const id = entry?.options?.id
    const name = entry?.options?.name
    if (typeof id !== 'string') continue
    if (packageRoot(name) === pkg) rows.push({ id, name })
  }
  return rows
}

function safeEntries(loader) {
  try {
    return [...(loader?.entries?.() ?? [])]
  } catch {
    return []
  }
}

/**
 * Attribute a stack to a mounted row by matching a path segment.
 * Used for `link:` installs, where no `node_modules` frame exists.
 */
export function rowFromStack(loader, stack) {
  if (typeof stack !== 'string' || stack.length === 0) return undefined
  const wanted = new Map()
  for (const entry of safeEntries(loader)) {
    const id = entry?.options?.id
    const name = entry?.options?.name
    if (typeof id !== 'string' || typeof name !== 'string') continue
    const segment = packageSegment(name)
    if (segment === undefined) continue
    wanted.set(segment.toLowerCase(), { id, name })
  }
  if (wanted.size === 0) return undefined

  let best
  for (const line of stack.split('\n')) {
    const lowered = line.toLowerCase()
    for (const [segment, row] of wanted) {
      if (lowered.includes(`/${segment}/`) || lowered.includes(`\\${segment}\\`)) best = row
    }
  }
  return best
}

/**
 * Combine both attribution paths for one failure.
 * @returns the package name (when a `node_modules` frame existed), the
 *   candidate rows, and the deepest described error.
 */
export function attribute(loader, described, deepestDescribed) {
  const pkg = packageFromStack(described.stack) ?? packageFromStack(deepestDescribed.stack)

  let rows = pkg === undefined ? [] : rowsForPackage(loader, pkg)
  if (rows.length === 0) {
    const row =
      rowFromStack(loader, described.stack) ?? rowFromStack(loader, deepestDescribed.stack)
    if (row !== undefined) rows = [row]
  }

  const attributedPkg = pkg ?? (rows.length > 0 ? packageRoot(rows[0].name) : undefined)
  return { pkg: attributedPkg, rows }
}
