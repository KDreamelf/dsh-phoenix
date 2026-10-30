/**
 * dsh-phoenix test suite.
 *
 * Covers the three things that can silently regress:
 *   1. attribution  — wrong package means quarantining an innocent plugin
 *   2. quarantine   — a malformed patch layer bricks the NEXT boot
 *   3. client rescue — a rescue that throws is worse than none
 *
 * There is deliberately no tool-deadline suite: the plugin does not bound tool
 * runtime. Long work is legitimate; a wedged session is an injury, not death.
 *
 * Run: node tests/run.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// ── 3. plugin behaviour against a fake host ───────────────────────────────────
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
        // The plugin may register more than one effect; dispose must run all of
        // them, so collect every cleanup rather than keeping only the last.
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

// ── 4. crash page and recovery surface ────────────────────────────────────────
const crashPage = await import('../src/crash-page.js')
const recovery = await import('../src/recovery.js')
const meta = await import('../src/meta.js')
const selfRestart = await import('../src/self-restart.js')

const sampleReport = {
  kind: 'uncaughtException',
  package: 'some-broken-plugin',
  title: 'Broken Plugin',
  description: 'A plugin that throws from a timer.',
  packageDir: 'C:/plugins/some-broken-plugin',
  icon: undefined,
  rowIds: ['broken-plugin'],
  message: 'boom',
  stack: 'Error: boom\n    at run (C:/plugins/node_modules/some-broken-plugin/lib/index.js:1:1)',
}

await test('crash page: renders identity, path, stack and three choices', () => {
  const html = crashPage.renderCrashPage(sampleReport)
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'must be a standalone document')
  assert.ok(html.includes('Broken Plugin'), 'title missing')
  assert.ok(html.includes('some-broken-plugin'), 'package missing')
  assert.ok(html.includes('C:/plugins/some-broken-plugin'), 'path missing')
  assert.ok(html.includes('boom'), 'message missing')
  assert.ok(html.includes('data-choice="retry"'), 'retry button missing')
  assert.ok(html.includes('data-choice="disable"'), 'disable button missing')
  assert.ok(html.includes('data-choice="remove"'), 'remove button missing')
  assert.ok(html.includes('给个机会') && html.includes('停职') && html.includes('开除'))
})

await test('crash page: escapes hostile field values', () => {
  const html = crashPage.renderCrashPage({
    ...sampleReport,
    title: '<img src=x onerror=alert(1)>',
    description: '</style><script>alert(1)</script>',
    message: '"><script>alert(2)</script>',
  })
  assert.ok(!html.includes('<script>alert(1)</script>'), 'description not escaped')
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'title not escaped')
  assert.ok(html.includes('&lt;script&gt;'), 'escaped form missing')
})

await test('crash page: unattributable faults disable the acting buttons', () => {
  const html = crashPage.renderCrashPage({ ...sampleReport, package: null, rowIds: [] })
  // Unattributable: no culprit to disable, so the page offers the two options
  // that still make sense — retry, or a clean rescue session.
  assert.ok(!html.includes('data-choice="disable"'), 'disable must not be offered')
  assert.ok(!html.includes('data-choice="remove"'), 'remove must not be offered')
  assert.ok(html.includes('data-choice="retry"'), 'retry must be offered')
  assert.ok(html.includes('data-choice="rescue"'), 'rescue must be offered')
  assert.ok(html.includes('复活模式'), 'rescue button must be labeled in Chinese')
})

await test('crash page: readChoice accepts only the known answers', () => {
  assert.equal(crashPage.readChoice('{"choice":"retry"}'), 'retry')
  assert.equal(crashPage.readChoice('{"choice":"disable"}'), 'disable')
  assert.equal(crashPage.readChoice('{"choice":"remove"}'), 'remove')
  assert.equal(crashPage.readChoice('{"choice":"rescue"}'), 'rescue')
  assert.equal(crashPage.readChoice('{"choice":"nuke"}'), undefined)
  assert.equal(crashPage.readChoice('not json'), undefined)
  assert.equal(crashPage.readChoice(''), undefined)
})

await test('recovery: unavailable without a webserver', () => {
  const home = freshHome('no-web')
  try {
    const controller = recovery.beginRecovery({
      ctx: { get: () => undefined },
      home,
      report: sampleReport,
      exit: () => {},
      restart: () => ({ ok: true, pid: 1 }),
    })
    assert.equal(controller.available, false)
    controller.release()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('recovery: registers the three routes and serves the page', async () => {
  const home = freshHome('routes')
  const routes = new Map()
  try {
    const controller = recovery.beginRecovery({
      ctx: {
        get: (service) =>
          service === 'webServer'
            ? {
                register: (route) => {
                  routes.set(route.path, route)
                  return () => routes.delete(route.path)
                },
              }
            : undefined,
      },
      home,
      report: sampleReport,
      exit: () => {},
      restart: () => ({ ok: true, pid: 1 }),
    })
    assert.equal(controller.available, true)
    assert.ok(routes.has(crashPage.CRASH_ROUTE))
    assert.ok(routes.has(crashPage.DECIDE_ROUTE))
    assert.ok(routes.has(crashPage.STATUS_ROUTE))

    // GET the page.
    let body = ''
    const res = {
      writeHead() {},
      end(chunk) {
        body += chunk ?? ''
      },
    }
    routes.get(crashPage.CRASH_ROUTE).handler({ method: 'GET' }, res)
    assert.ok(body.includes('Broken Plugin'))

    controller.release()
    assert.equal(routes.size, 0, 'release must remove every route')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('recovery: disable writes quarantine before restarting', async () => {
  const home = freshHome('decide')
  let restarted = 0
  let exited
  try {
    const controller = recovery.beginRecovery({
      ctx: { get: () => undefined },
      home,
      report: sampleReport,
      exit: (code) => {
        exited = code
      },
      restart: () => {
        restarted += 1
        return { ok: true, pid: 4242 }
      },
    })
    // No webserver: settle is still the code path under test for apply().
    const result = await controller.settle('disable')
    assert.equal(result.ok, true, JSON.stringify(result))
    const quarantine = await import('../src/quarantine.js')
    assert.deepEqual(quarantine.readQuarantined(home), ['broken-plugin'], 'quarantine not written')
    assert.equal(restarted, 1, 'process was not replaced')
    await new Promise((resolve) => setTimeout(resolve, 320))
    assert.equal(exited, 1, 'old process did not exit')
    controller.release()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('recovery: remove queues an uninstall for the next clean start', async () => {
  const home = freshHome('remove')
  try {
    const controller = recovery.beginRecovery({
      ctx: { get: () => undefined },
      home,
      report: sampleReport,
      exit: () => {},
      restart: () => ({ ok: true, pid: 1 }),
    })
    const result = await controller.settle('remove')
    assert.equal(result.ok, true)
    const pending = recovery.readPendingRemovals(home)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].package, 'some-broken-plugin')
    controller.release()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('meta: finds the package directory from a stack frame', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-meta-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo-plugin', description: 'from manifest' }))
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), '// demo\n')
    mkdirSync(join(dir, 'locale'), { recursive: true })
    writeFileSync(join(dir, 'locale', 'en.json'), JSON.stringify({ meta: { title: 'Demo', description: 'from locale' } }))
    writeFileSync(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')

    const described = meta.describePackage(
      `Error: boom\n    at run (${join(dir, 'lib', 'index.js')}:1:1)`,
    )
    assert.equal(described.packageName, 'demo-plugin')
    assert.equal(described.title, 'Demo')
    assert.equal(described.description, 'from locale')
    assert.ok(String(described.icon).startsWith('data:image/svg+xml;base64,'), 'icon not inlined')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('meta: survives a stack with no resolvable package', () => {
  const described = meta.describePackage('Error: x\n    at <anonymous>')
  assert.deepEqual(described, {})
})

await test('self-restart: refuses only a real Electron main process', () => {
  const electronMain = selfRestart.restartCommand({}, { electron: '38.0.0' })
  assert.equal(electronMain.ok, false)
  assert.equal(electronMain.reason, 'electron-main-process')

  // A host launched BY Electron with ELECTRON_RUN_AS_NODE=1 is an ordinary Node
  // process: argv[1] is a script, so replacing it is legitimate.
  const asNode = selfRestart.restartCommand({ ELECTRON_RUN_AS_NODE: '1' }, { electron: '38.0.0' })
  assert.notEqual(asNode.reason, 'electron-main-process')
})

// ── 5. removal finalization (the plugin manager contract) ─────────────────────
const finalize = await import('../src/finalize.js')

await test('removal: a folded failure result is NOT success', () => {
  // PluginManager.change() never throws for an expected refusal; it folds the
  // failure into the returned value. Treating "no throw" as success would clear
  // the queue and report a removal that never happened.
  const stopProfile = finalize.classifyRemoval({ application: 'failed', error: { code: 'stop-profile' } })
  assert.equal(stopProfile.ok, false)
  assert.equal(stopProfile.reason, 'stop-profile')
  assert.equal(finalize.classifyRemoval({ application: 'failed', error: { code: 'bundle-in-use' } }).ok, false)
  assert.equal(finalize.classifyRemoval({ application: 'failed' }).ok, false)
})

await test('removal: applied and restart-required both count as success', () => {
  assert.equal(finalize.classifyRemoval({ application: 'applied' }).ok, true)
  assert.equal(finalize.classifyRemoval({ application: 'restart-required' }).ok, true)
})

await test('removal: cancelled and missing results are failures', () => {
  assert.equal(finalize.classifyRemoval({ application: 'cancelled' }).ok, false)
  assert.equal(finalize.classifyRemoval(undefined).reason, 'no-result')
})

await test('removal: drops successes, keeps failures for the next start', async () => {
  const home = freshHome('finalize')
  try {
    recovery.markPendingRemove(home, { package: 'good-plugin', rowIds: ['good'], profile: 'dev' })
    recovery.markPendingRemove(home, { package: 'stubborn-plugin', rowIds: ['stub'], profile: 'dev' })

    const recorded = []
    const ctx = {
      get: (service) =>
        service === 'pluginManager'
          ? {
              removeBundle: async (name) =>
                name === 'good-plugin'
                  ? { application: 'applied' }
                  : { application: 'failed', error: { code: 'bundle-in-use' } },
            }
          : undefined,
    }

    const outcomes = await finalize.finalizeRemovals({ ctx, home, record: (entry) => recorded.push(entry) })
    assert.equal(outcomes.length, 2)
    assert.equal(outcomes.find((item) => item.package === 'good-plugin').ok, true)
    assert.equal(outcomes.find((item) => item.package === 'stubborn-plugin').ok, false)

    const left = recovery.readPendingRemovals(home)
    assert.equal(left.length, 1, 'failed entry must stay queued')
    assert.equal(left[0].package, 'stubborn-plugin')
    assert.ok(recorded.some((entry) => entry.kind === 'removal-failed' && entry.reason === 'bundle-in-use'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('removal: refuses to uninstall itself', async () => {
  const home = freshHome('self-remove')
  try {
    recovery.markPendingRemove(home, { package: 'dsh-phoenix', rowIds: ['phoenix'], profile: 'dev' })
    const ctx = { get: () => ({ removeBundle: async () => ({ application: 'applied' }) }) }
    const outcomes = await finalize.finalizeRemovals({ ctx, home })
    assert.equal(outcomes[0].ok, false)
    assert.equal(outcomes[0].reason, 'refuses-to-remove-itself')
    assert.equal(recovery.readPendingRemovals(home).length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('removal: without a plugin manager nothing is deleted', async () => {
  const home = freshHome('no-manager')
  try {
    recovery.markPendingRemove(home, { package: 'some-plugin', rowIds: ['some'], profile: 'dev' })
    const outcomes = await finalize.finalizeRemovals({ ctx: { get: () => undefined }, home })
    assert.equal(outcomes[0].skipped, true)
    assert.equal(recovery.readPendingRemovals(home).length, 1, 'queue must be untouched')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 5. composition health ─────────────────────────────────────────────────────
const health = await import('../src/health.js')

await test('health: a required row that failed makes DSH unusable', () => {
  const ctx = {
    get: () => ({
      entries: () => [
        { options: { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop' }, fiber: { state: 3, _error: new Error('boom') } },
        { options: { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' }, fiber: { state: 2 } },
      ],
    }),
  }
  const result = health.scanComposition(ctx)
  assert.equal(result.usable, false)
  assert.equal(result.requiredBroken.length, 1)
  assert.equal(result.requiredBroken[0].id, 'agent-loop')
  assert.equal(result.requiredBroken[0].state, 'failed')
  assert.ok(String(result.requiredBroken[0].error).includes('boom'))
})

await test('health: a broken optional row degrades but stays usable', () => {
  const ctx = {
    get: () => ({
      entries: () => [
        { options: { id: 'agent-loop', name: 'x' }, fiber: { state: 2 } },
        { options: { id: 'optional-thing', name: 'y' }, fiber: { state: 0 } },
      ],
    }),
  }
  const result = health.scanComposition(ctx)
  assert.equal(result.usable, true)
  assert.equal(result.broken.length, 1)
  assert.equal(result.broken[0].state, 'pending')
})

await test('health: disabled rows are not reported as broken', () => {
  const ctx = {
    get: () => ({
      entries: () => [
        { options: { id: 'agent-loop', name: 'x' }, fiber: { state: 2 } },
        { options: { id: 'off', name: 'y' }, disabled: true, fiber: { state: 0 } },
      ],
    }),
  }
  assert.equal(health.scanComposition(ctx).broken.length, 0)
})

await test('health: a throwing disabled expression is itself a fault', () => {
  const ctx = {
    get: () => ({
      entries: () => [
        {
          options: { id: 'weird', name: 'z' },
          get disabled() {
            throw new Error('!!js blew up')
          },
          fiber: { state: 2 },
        },
      ],
    }),
  }
  const result = health.scanComposition(ctx)
  assert.equal(result.rows[0].disabled, false)
  assert.ok(String(result.rows[0].error).includes('!!js blew up'))
})

await test('health: summarize names the required rows by state', () => {
  const summary = health.summarizeComposition({
    requiredBroken: [{ id: 'webserver', state: 'failed' }],
    broken: [{ id: 'webserver', state: 'failed' }],
  })
  assert.ok(summary.includes('webserver(failed)'))
})

// ── 6. blocking detection and rescue preparation ──────────────────────────────
const blocking = await import('../src/blocking.js')
const recoverySession = await import('../src/recovery-session.js')

await test('rescue: overlay keeps official rows and disables the rest', () => {
  const rows = [
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop' },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
    { id: 'include', name: 'cordis:include' },
    { id: 'phoenix', name: 'dsh-phoenix' },
    { id: 'community-thing', name: 'dsh-community-thing' },
    { id: 'linked-thing', name: '@someone/linked-thing' },
  ]
  const yaml = recoverySession.buildResurrectionOverlay(rows)
  assert.ok(yaml.includes('"community-thing"'), 'third-party row must be disabled')
  assert.ok(yaml.includes('"linked-thing"'), 'scoped third-party row must be disabled')
  assert.ok(!yaml.includes('"llm-pi-ai"'), 'provider row must survive')
  assert.ok(!yaml.includes('"include"'), 'builtin must survive')
  assert.ok(!yaml.includes('"phoenix"'), 'the guard must survive')
})

await test('rescue: an all-official composition needs no overlay', () => {
  const yaml = recoverySession.buildResurrectionOverlay([{ id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop' }])
  assert.equal(yaml, undefined)
})

await test('rescue: the overlay is temporary — it never touches the profile or the home patch', () => {
  const home = freshHome('rescue-temp')
  try {
    const prepared = recoverySession.prepareResurrection({
      home,
      rows: [
        { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop' },
        { id: 'community-thing', name: 'dsh-community-thing' },
      ],
    })
    assert.equal(prepared.ok, true)
    // It lives beside the crash logs, which is not a layer any normal boot reads.
    assert.ok(prepared.overlayPath.startsWith(join(home, 'logs', 'crash-guard')))
    // The two ways a rescue could become permanent, both unused.
    assert.equal(existsSync(join(home, 'cordis.patch.yml')), false, 'home patch must stay untouched')
    assert.ok(prepared.disabled.includes('community-thing'))
    assert.ok(!prepared.disabled.includes('agent-loop'), 'official rows are not suspects')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('rescue: a machine code is never shown to the operator verbatim', () => {
  const desktop = recoverySession.describeRescueFailure('desktop-profile-is-app-managed')
  assert.ok(!desktop.includes('desktop-profile-is-app-managed'), 'the raw code must be translated')
  assert.ok(desktop.includes('点击') === false && desktop.length > 20, 'and it must say what to do')
  // Unknown codes survive rather than being swallowed: silence would hide a real bug.
  assert.equal(recoverySession.describeRescueFailure('something-new'), 'something-new')
  assert.ok(recoverySession.describeRescueFailure(undefined).length > 0)
})

await test('crash page: the unattributable note is a safe mode, not a threat', () => {
  const html = crashPage.renderCrashPage({ ...sampleReport, package: null, rowIds: [] })
  // Facts the operator needs, and the words that carry them.
  assert.ok(html.includes('安全模式'), 'must name the analogy')
  assert.ok(html.includes('关掉重开'), 'must say it ends by itself')
  assert.ok(html.includes('供应商'), 'must say providers are untouched')
  // It must not read as "we could not find the culprit, so we will disable things".
  assert.ok(!html.includes('所以不会自动禁用任何东西'))
})

await test('rescue: a refused launch answers in words, never in a machine code', async () => {
  const routes = new Map()
  const dispose = recovery.installRescueRoutes({
    ctx: {
      get: (service) =>
        service === 'webServer'
          ? {
              register: (route) => {
                routes.set(route.path, route)
                return () => routes.delete(route.path)
              },
            }
          : undefined,
    },
    prepared: () => ({ profile: 'desktop' }),
    launch: async () => ({ ok: false, reason: 'desktop-profile-is-app-managed' }),
  })
  try {
    const route = routes.get(recovery.RESCUE_ROUTE)
    assert.ok(route !== undefined, 'the rescue route must be registered')

    let status
    let payload
    const res = {
      writeHead(code) {
        status = code
      },
      end(chunk) {
        payload = JSON.parse(String(chunk))
      },
    }
    await route.handler(
      {
        method: 'POST',
        // readBody waits for 'end'; a stub that never emits it would hang the
        // handler (and the whole suite) rather than fail.
        on(event, handler) {
          if (event === 'end') queueMicrotask(() => handler())
          return this
        },
        destroy() {},
      },
      res,
    )
    assert.equal(status, 500)
    assert.equal(payload.ok, false)
    assert.ok(typeof payload.message === 'string' && payload.message.length > 0)
    assert.ok(!payload.message.includes('desktop-profile-is-app-managed'), 'the code must be translated')
  } finally {
    dispose()
  }
})

await test('blocking: an operator click prepares the rescue before the threshold', () => {
  const home = freshHome('blocking-on-demand')
  try {
    const monitor = blocking.createBlockingMonitor({
      ctx: { get: () => ({ entries: () => [] }) },
      home,
      profile: 'demo',
      record: () => {},
      notify: () => {},
    })
    // The dialog appears on the first error; a click at that instant must still
    // find something to launch.
    assert.equal(monitor.prepared(), undefined)
    const state = monitor.prepareNow('operator-requested')
    assert.ok(state !== undefined, 'the click itself is the consent')
    assert.equal(monitor.prepared()?.profile, 'demo')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('blocking: threshold is reached by consecutive errors only', () => {
  const home = freshHome('blocking')
  try {
    const records = []
    const monitor = blocking.createBlockingMonitor({
      ctx: { get: () => ({ entries: () => [{ options: { id: 'x', name: 'third-party-x' }, fiber: { state: 2 } }] }) },
      home,
      profile: 'demo',
      record: (entry) => records.push(entry),
      notify: () => {},
    })

    monitor.onSessionError('s1', 'boom')
    assert.equal(records.filter((entry) => entry.decision === 'blocking').length, 0, 'one error is not a block')
    assert.equal(monitor.prepared(), undefined)

    monitor.onSessionError('s2', 'boom')
    const state = monitor.prepared()
    assert.ok(state !== undefined, 'second consecutive error must prepare a rescue')
    assert.equal(state.disabled.includes('x'), true)
    assert.ok(records.some((entry) => entry.kind === 'rescue-prepared'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('blocking: a working session resets the streak', () => {
  const home = freshHome('blocking-reset')
  try {
    const records = []
    const monitor = blocking.createBlockingMonitor({
      ctx: { get: () => ({ entries: () => [] }) },
      home,
      profile: 'demo',
      record: (entry) => records.push(entry),
      notify: () => {},
    })
    monitor.onSessionError('s1', 'boom')
    monitor.onSessionWorking()
    monitor.onSessionError('s2', 'boom')
    assert.equal(records.filter((entry) => entry.decision === 'blocking').length, 0)
    assert.equal(monitor.prepared(), undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 7. client rescue, driven through a fake DOM ───────────────────────────────
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
    assert.deepEqual(mod.inject, ['remote'], 'must inject remote to observe session failures')

    // Fake ctx: effect runs the body, remote exposes a subscriber.
    const sessionHandlers = []
    let cleanup
    mod.apply({
      effect: (fn) => {
        const dispose = fn()
        cleanup = () => {
          if (typeof dispose === 'function') dispose()
        }
        return cleanup
      },
      remote: {
        $on: (name, handler) => {
          if (name === 'api-session/error') sessionHandlers.push(handler)
          return () => {}
        },
      },
    })

    // Non-fatal: no modal.
    listeners.get('error')?.({ error: new Error('a widget broke') })
    assert.equal(documentStub.getElementById('dsh-phoenix-modal'), null, 'modal shown for a benign error')

    // Fatal: modal appears.
    const fatal = new Error("renderSlot('root') before any 'root' registration")
    fatal.name = 'SlotAssemblyError'
    listeners.get('error')?.({ error: fatal })
    const overlay = documentStub.getElementById('dsh-phoenix-modal')
    assert.ok(overlay, 'modal missing for a fatal error')

    // The original error must survive into the dialog: the operator decides
    // based on what actually broke, and a rewritten message would be a lie.
    assert.ok(overlay.children.length > 0, 'modal has no content')
    const text = JSON.stringify(overlay.children, (key, value) => (key === 'children' ? value : value))
    assert.ok(text.includes('SlotAssemblyError'), 'original error text missing from the modal')

    // Idempotent: a second fatal must not stack a second card.
    listeners.get('unhandledrejection')?.({ reason: fatal })
    assert.equal(appended.filter((element) => element.id === 'dsh-phoenix-modal').length, 1)

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
