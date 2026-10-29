/**
 * Plugin metadata for the crash page: what is this plugin, where does it live,
 * what does it claim to do.
 *
 * Resolution goes through the stack, not through DSH's internal packages. A
 * profile-installed plugin cannot rely on resolving `@deepseek-ai/dsh-app-boot`
 * from its own node_modules, and reaching into another package's internals is
 * exactly the kind of coupling that breaks on upgrade. The stack already names
 * the file that threw; walking up to the nearest `package.json` is both simpler
 * and more accurate, because it identifies the package that actually faulted
 * rather than the one the row claims to be.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_WALK = 12

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Extract filesystem paths from stack frames, deepest first. */
export function pathsFromStack(stack) {
  if (typeof stack !== 'string' || stack.length === 0) return []
  const found = []
  for (const line of stack.split('\n')) {
    const match = /\(?((?:file:\/\/)?[A-Za-z]:[\\/][^:()]+|[\\/][^:()\s]+\.(?:js|mjs|cjs|ts|tsx|jsx))(?::\d+){0,2}\)?\s*$/u.exec(
      line.trim(),
    )
    if (match === null) continue
    let candidate = match[1]
    try {
      if (candidate.startsWith('file://')) candidate = fileURLToPath(candidate)
    } catch {
      continue
    }
    found.push(candidate)
  }
  return found
}

/** Nearest directory at or above `start` holding a package.json. */
export function findPackageDir(start) {
  let current = resolve(start)
  for (let depth = 0; depth < MAX_WALK; depth += 1) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (statSync(manifest).isFile()) return current
      } catch {
        /* unreadable: keep walking */
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

function localizedTitle(packageDir, manifest) {
  const english = readJson(join(packageDir, 'locale', 'en.json'))
  const meta = english?.meta
  const title = typeof meta?.title === 'string' && meta.title.length > 0 ? meta.title : undefined
  const description =
    typeof meta?.description === 'string' && meta.description.length > 0 ? meta.description : undefined
  return {
    title: title ?? (typeof manifest?.name === 'string' ? manifest.name : undefined),
    description: description ?? (typeof manifest?.description === 'string' ? manifest.description : undefined),
  }
}

/**
 * Resolve the icon to something an <img> can load.
 * Only file-backed/icons inside the package are accepted; the crash page is
 * served from a plain HTTP route, so a filesystem path has to become a data URL.
 */
function resolveIcon(packageDir, manifest) {
  const declared = typeof manifest?.icon === 'string' ? manifest.icon : undefined
  const candidates = [declared, join('locale', '..', 'icon.svg'), 'icon.svg', 'icon.png'].filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
  for (const candidate of candidates) {
    const path = join(packageDir, candidate)
    if (!existsSync(path)) continue
    try {
      const bytes = readFileSync(path)
      if (bytes.length > 256 * 1024) continue
      const lower = candidate.toLowerCase()
      const mime = lower.endsWith('.svg')
        ? 'image/svg+xml'
        : lower.endsWith('.png')
          ? 'image/png'
          : lower.endsWith('.jpg') || lower.endsWith('.jpeg')
            ? 'image/jpeg'
            : lower.endsWith('.webp')
              ? 'image/webp'
              : undefined
      if (mime === undefined) continue
      return `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Describe the package that owns a fault.
 * @param stack - the recorded stack of the deepest error.
 * @returns metadata for the crash page; every field may be undefined.
 */
export function describePackage(stack) {
  const paths = pathsFromStack(stack)
  let packageDir
  for (const path of paths) {
    const dir = existsSync(path) ? dirname(path) : findPackageDir(dirname(path))
    if (dir === undefined) continue
    const found = findPackageDir(dir)
    if (found !== undefined) {
      packageDir = found
      break
    }
  }
  if (packageDir === undefined) return {}

  const manifest = readJson(join(packageDir, 'package.json'))
  const { title, description } = localizedTitle(packageDir, manifest)
  return {
    packageDir,
    packageName: typeof manifest?.name === 'string' ? manifest.name : undefined,
    title,
    description,
    version: typeof manifest?.version === 'string' ? manifest.version : undefined,
    icon: resolveIcon(packageDir, manifest),
  }
}
