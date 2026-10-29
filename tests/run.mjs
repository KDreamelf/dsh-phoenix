/**
 * dsh-phoenix test suite.
 *
 * Covers the four things that can silently regress:
 *   1. attribution  — wrong package means quarantining an innocent plugin
 *   2. quarantine   — a malformed patch layer bricks the NEXT boot
 *   3. deadline     — a missing bound means a wedged session
 *   4. client rescue — a rescue that throws is worse than none
 *
 * Run: node tests/run.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) })
  }
}

function freshHome(label) {
  return mkdtempSync(join(tmpdir(), `phoenix-${label}-`))
}

// ── 1. attribution ────────────────────────────────────────────────────────────
const attribution = await import('../src/attribution.js')

const fakeLoader = {
  entries: () => [
    { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } },
    { options: { id: 'broken-plugin', name: 'some-broken-plugin' } },
    { options: { id: 'linked-row', name: 'linked-pkg' } },
    { options: { id: 'todo', name: '@deepseek-ai/dsh-tool-todo' } },
  ],
}

function frameError(path, message = 'boom') {
  const error = new Error(message)
  error.stack = [`Error: ${message}`, `    at run (${path}:10:5)`, '    at main (app.js:3:1)'].join('\n')
  return error
}

await test('attribution: node_modules frame yields the package', () => {
  const error = frameError('file:///C:/x/node_modules/some-broken-plugin/lib/index.js')
  const described = attribution.describe(error)
  const { pkg, rows } = attribution.attribute(fakeLoader, described, described)
  assert.equal(pkg, 'some-broken-plugin')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'broken-plugin')
})

await test('attribution: scoped package keeps its scope', () => {
  const error = frameError('file:///C:/x/node_modules/@deepseek-ai/dsh-tool-todo/lib/index.js')
  const described = attribution.describe(error)
  const { pkg } = attribution.attribute(fakeLoader, described, described)
  assert.equal(pkg, '@deepseek-ai/dsh-tool-todo')
})

await test('attribution: link install recognized by path segment', () => {
  // No node_modules in the path: this is a `link:` checkout.
  const error = frameError('file:///E:/work/linked-pkg/index.js')
  const described = attribution.describe(error)
  const { pkg, rows } = attribution.attribute(fakeLoader, described, described)
  assert.equal(pkg, 'linked-pkg')
  assert.equal(rows[0].id, 'linked-row')
})

await test('attribution: segment matching is exact, not prefix', () => {
  const error = frameError('file:///E:/work/linked-pkg-extra/index.js')
  const described = attribution.describe(error)
  const { rows } = attribution.attribute(fakeLoader, described, described)
  assert.equal(rows.length, 0, 'must not match linked-pkg-extra')
})

await test('attribution: unknown code yields no candidates', () => {
  const described = attribution.describe(new Error('mystery'))
  const { pkg, rows } = attribution.attribute(fakeLoader, described, described)
  assert.equal(pkg, undefined)
  assert.equal(rows.length, 0)
})

await test('attribution: unstringifiable throw does not itself throw', () => {
  const hostile = {
    toString() {
      throw new Error('nope')
    },
  }
  const described = attribution.describe(hostile)
  assert.equal(typeof described.message, 'string')
})

await test('attribution: cause chain terminates on a cycle', () => {
  const a = new Error('a')
  const b = new Error('b', { cause: a })
  a.cause = b
  const chain = attribution.causeChain(b)
  assert.ok(chain.length <= 8)
})

// ── 2. quarantine ─────────────────────────────────────────────────────────────
const quarantine = await import('../src/quarantine.js')

await test('quarantine: first write produces a managed block', () => {
  const text = quarantine.composePatchText('', ['broken-plugin'])
  assert.ok(text.includes(quarantine.MARK_BEGIN))
  assert.ok(text.includes('"broken-plugin"'))
  assert.ok(text.includes('disabled: true'))
})

await test('quarantine: releasing the last row leaves [] not an empty file', () => {
  // The bug this locks in: a zero-byte patch parses to `undefined`, and the
  // loader requires an array, so "undo" used to brick the next boot.
  const withRow = quarantine.composePatchText('', ['broken-plugin'])
  const released = quarantine.composePatchText(withRow, [])
  assert.equal(released, '[]\n')
})

await test('quarantine: user provider layer survives unchanged', () => {
  const provider = [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      opencode-go:',
    '        apiKeyEnv: OPENCODE_GO_API_KEY',
    '',
  ].join('\n')
  const text = quarantine.composePatchText(provider, ['broken-plugin'])
  assert.ok(text.includes('OPENCODE_GO_API_KEY'), 'provider config lost')
  assert.ok(text.includes('"broken-plugin"'))
})

await test('quarantine: rewriting replaces the block instead of appending', () => {
  const first = quarantine.composePatchText('', ['a'])
  const second = quarantine.composePatchText(first, ['b'])
  const blocks = second.split(quarantine.MARK_BEGIN).length - 1
  assert.equal(blocks, 1, 'exactly one managed block')
  assert.ok(second.includes('"b"'))
  assert.ok(!second.includes('"a"'))
})

await test('quarantine: strip is the identity when no block exists', () => {
  const provider = '- id: x\n  name: y\n'
  assert.equal(quarantine.stripManagedBlock(provider), provider)
})

await test('quarantine: round-trips through disk', () => {
  const home = freshHome('disk')
  try {
    quarantine.writeQuarantine(home, ['row-a', 'row-b'])
    assert.deepEqual(quarantine.readQuarantined(home), ['row-a', 'row-b'])
    quarantine.writeQuarantine(home, [])
    assert.deepEqual(quarantine.readQuarantined(home), [])
    const text = readFileSync(quarantine.homePatchPath(home), 'utf8')
    assert.equal(text, '[]\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 3. tool deadline ──────────────────────────────────────────────────────────
const deadline = await import('../src/tool-deadline.js')

await test('deadline: per-tool override wins over the global default', () => {
  const config = { toolTimeoutMs: 1000, toolTimeouts: { bash: 50 } }
  assert.equal(deadline.resolveDeadline({ name: 'bash' }, config), 50)
  assert.equal(deadline.resolveDeadline({ name: 'read' }, config), 1000)
})

await test('deadline: zero and null disable the bound', () => {
  assert.equal(deadline.resolveDeadline({ name: 'read' }, { toolTimeoutMs: 0 }), undefined)
  assert.equal(deadline.resolveDeadline({ name: 'read' }, { toolTimeoutMs: null }), undefined)
  assert.equal(
    deadline.resolveDeadline({ name: 'bash' }, { toolTimeoutMs: 1000, toolTimeouts: { bash: 0 } }),
    undefined,
  )
})

await test('deadline: a fast body resolves untouched', async () => {
  const value = await deadline.withDeadline(async () => 'ok', 1000, 'read')
  assert.equal(value, 'ok')
})

await test('deadline: a body error propagates as itself', async () => {
  const boom = new Error('body failed')
  await assert.rejects(
    deadline.withDeadline(async () => {
      throw boom
    }, 1000, 'read'),
    (error) => error === boom,
  )
})

await test('deadline: a hung body is abandoned with TOOL_DEADLINE_EXCEEDED', async () => {
  let aborted = false
  const startedAt = Date.now()
  await assert.rejects(
    deadline.withDeadline(() => new Promise(() => {}), 40, 'stuck', () => {
      aborted = true
    }),
    (error) => error instanceof deadline.ToolDeadlineError && error.code === 'TOOL_DEADLINE_EXCEEDED',
  )
  assert.ok(aborted, 'onTimeout must run')
  assert.ok(Date.now() - startedAt < 1000, 'must not wait for the body')
})

await test('deadline: a late body result cannot override the timeout', async () => {
  const guarded = deadline.withDeadline(
    () => new Promise((resolve) => setTimeout(() => resolve('late'), 80)),
    25,
    'slow',
  )
  await assert.rejects(guarded, /deadline/)
  // If the late resolution leaked through, this would resolve instead.
  await new Promise((resolve) => setTimeout(resolve, 100))
})

// ── 4. plugin behaviour against a fake host ───────────────────────────────────
await test('deadline seam: installs on tools/execute with prepend', async () => {
  let captured
  const ctx = {
    on: (name, handler, options) => {
      captured = { name, handler, options }
      return () => {}
    },
  }
  const reports = []
  deadline.installToolDeadline(ctx, { toolTimeoutMs: 30 }, (entry) => reports.push(entry))
  assert.equal(captured.name, 'tools/execute')
  assert.equal(captured.options?.prepend, true, 'must run before the cooperative policy')

  // A hung next(): the seam must reject with the deadline error and report it.
  const exec = { name: 'fake-hung-tool', signal: { abort() {} } }
  await assert.rejects(captured.handler(exec, () => new Promise(() => {})), /deadline/)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].tool, 'fake-hung-tool')
  assert.equal(reports[0].timeoutMs, 30)
})

await test('deadline seam: a fast tool call passes straight through', async () => {
  let captured
  const ctx = { on: (name, handler, options) => ((captured = { handler }), () => {}) }
  deadline.installToolDeadline(ctx, { toolTimeoutMs: 5000 }, () => {})
  const result = await captured.handler({ name: 'read', signal: { abort() {} } }, async () => 'tool-result')
  assert.equal(result, 'tool-result')
})

await test('deadline seam: toolDeadline:false installs nothing', () => {
  let called = false
  const ctx = { on: () => ((called = true), () => {}) }
  const dispose = deadline.installToolDeadline(ctx, { toolDeadline: false }, () => {})
  assert.equal(called, false)
  assert.equal(typeof dispose, 'function')
})

await test('plugin: contains a fault, quarantines only the culprit, keeps providers', async () => {
  const home = freshHome('plugin')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // A user layer that must survive: this is where providers live.
    writeFileSync(
      quarantine.homePatchPath(home),
      '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    apiKeyEnv: KEEP_ME\n',
    )

    const rows = [
      { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } },
      { options: { id: 'broken-plugin', name: 'some-broken-plugin' } },
      { options: { id: 'official', name: '@deepseek-ai/dsh-tool-todo' } },
    ]
    let cleanup
    const ctx = {
      get: (service) => (service === 'loader' ? { entries: () => rows } : undefined),
      effect: (fn) => {
        cleanup = fn()
        return () => cleanup?.()
      },
      on: () => () => {},
    }

    const plugin = await import('../index.js')
    plugin.apply(ctx, { quarantine: true, maxQuarantinePerRun: 2 })

    process.emit('unhandledRejection', frameError('file:///C:/x/node_modules/some-broken-plugin/lib/index.js'))
    const text = readFileSync(quarantine.homePatchPath(home), 'utf8')
    assert.ok(text.includes('"broken-plugin"'), 'culprit not quarantined')
    assert.ok(text.includes('KEEP_ME'), 'provider config was damaged')

    // An official package must be protected, not silently disabled.
    process.emit('uncaughtException', frameError('file:///C:/x/node_modules/@deepseek-ai/dsh-tool-todo/lib/index.js'))
    const after = readFileSync(quarantine.homePatchPath(home), 'utf8')
    assert.ok(!after.includes('"official"'), 'official row was quarantined')

    // Unattributable faults are logged and survived, never fatal.
    process.emit('unhandledRejection', new Error('mystery'))

    const log = await import('../src/log.js')
    const records = log.readRecords(home)
    assert.ok(records.some((record) => record.kind === 'guard-activated'))
    assert.ok(records.some((record) => record.decision === 'quarantined'))
    assert.ok(records.some((record) => record.reason === 'no-package-in-stack'))
    assert.ok(
      records.some((record) => typeof record.reason === 'string' && record.reason.startsWith('protected')),
      'official protection not recorded',
    )

    cleanup?.()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

await test('plugin: dispose restores the host handlers it replaced', async () => {
  const home = freshHome('restore-handlers')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const original = () => {}
  process.on('unhandledRejection', original)
  try {
    let cleanups = []
    const ctx = {
      get: () => undefined,
      effect: (fn) => {
        // The plugin registers more than one effect (process guard, tool
        // deadline); dispose must run all of them, so collect every cleanup.
        const dispose = fn()
        if (typeof dispose === 'function') cleanups.push(dispose)
        return () => dispose?.()
      },
      on: () => () => {},
    }
    const plugin = await import('../index.js')
    plugin.apply(ctx, {})
    assert.ok(!process.listeners('unhandledRejection').includes(original), 'guard did not take ownership')
    for (const dispose of cleanups) dispose()
    assert.ok(process.listeners('unhandledRejection').includes(original), 'host handler not restored')
  } finally {
    process.removeListener('unhandledRejection', original)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 5. client rescue, driven through a fake DOM ───────────────────────────────
await test('client: fatal signature draws one overlay, non-fatal draws none', async () => {
  const appended = []
  const makeElement = (tag) => {
    const element = {
      tagName: tag,
      style: { cssText: '' },
      children: [],
      id: '',
      textContent: '',
      type: '',
      setAttribute() {},
      append(...items) {
        this.children.push(...items)
      },
      appendChild(item) {
        this.children.push(item)
        appended.push(item)
        return item
      },
      remove() {},
      addEventListener() {},
      getElementById: undefined,
    }
    return element
  }
  const body = makeElement('body')
  const documentStub = {
    body,
    createElement: makeElement,
    getElementById: (id) => appended.find((element) => element.id === id) ?? null,
    execCommand: () => true,
  }
  const listeners = new Map()
  const windowStub = {
    __ModuleLoader__: { load: (entry) => (captured = entry) },
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
  }
  let captured
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousLocation = globalThis.location
  globalThis.window = windowStub
  globalThis.document = documentStub
  globalThis.location = { search: '', reload() {} }

  try {
    await import('../client.js')
    assert.ok(captured, 'client factory was not registered')
    assert.equal(captured.id, 'dsh-phoenix')

    const mod = captured.factory()
    let cleanup
    mod.apply({
      effect: (fn) => {
        cleanup = fn()
        return () => cleanup?.()
      },
    })

    // Non-fatal: no overlay.
    listeners.get('error')?.({ error: new Error('a widget broke') })
    assert.equal(documentStub.getElementById('dsh-phoenix-rescue'), null, 'overlay shown for a benign error')

    // Fatal: overlay appears.
    const fatal = new Error("renderSlot('root') before any 'root' registration")
    fatal.name = 'SlotAssemblyError'
    listeners.get('error')?.({ error: fatal })
    const overlay = documentStub.getElementById('dsh-phoenix-rescue')
    assert.ok(overlay, 'overlay missing for a fatal error')

    // Idempotent: a second fatal must not stack a second card.
    listeners.get('unhandledrejection')?.({ reason: fatal })
    assert.equal(appended.filter((element) => element.id === 'dsh-phoenix-rescue').length, 1)

    assert.ok(windowStub.__DSH_PHOENIX__, 'diagnostics handle missing')
    cleanup?.()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
    if (previousLocation === undefined) delete globalThis.location
    else globalThis.location = previousLocation
  }
})

// ── report ───────────────────────────────────────────────────────────────────
let failed = 0
for (const result of results) {
  process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}\n`)
  if (!result.ok) {
    process.stdout.write(`      ${result.detail}\n`)
    failed += 1
  }
}
process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`)
process.exitCode = failed === 0 ? 0 : 1
