import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'

function runtimeFor(file) {
  return createRoutingRuntime({ routingConfigPath: file })
}

test('loadRoutingConfig fails when routing.json is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-runtime-missing-'))
  try {
    assert.throws(() => runtimeFor(path.join(root, 'routing.json')).loadRoutingConfig(), /Routing config .*not found/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('loadRoutingConfig fails when routing.json is invalid', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-runtime-invalid-'))
  const file = path.join(root, 'routing.json')
  try {
    fs.writeFileSync(file, '{invalid')
    assert.throws(() => runtimeFor(file).loadRoutingConfig(), /Routing config .*invalid JSON/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('applyVmSessionSlots updates only native admission policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-session-slots-'))
  const vms = path.join(root, 'vms')
  const file = path.join(vms, 'vm-01.json')
  fs.mkdirSync(vms, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ id: 'vm-01', policy: { maxConcurrency: 8, maxRpm: 60 } }))
  try {
    const runtime = createRoutingRuntime({ cfg: { paths: { project: root } } })
    runtime.applyVmSessionSlots('vm-01', 4, { override: true })
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.policy.sessionSlots, 4)
    assert.equal(saved.policy.sessionSlotsOverride, true)
    assert.equal(saved.policy.maxConcurrency, 8)
    assert.equal(saved.policy.maxRpm, 60)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('persistRoutingPatch reconciles inherited Claude session slots and preserves overrides', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-session-default-'))
  const vms = path.join(root, 'vms')
  const routingFile = path.join(root, 'routing.json')
  fs.mkdirSync(vms, { recursive: true })
  fs.writeFileSync(
    path.join(vms, 'vm-inherited.json'),
    JSON.stringify({
      id: 'vm-inherited',
      claude: { account_uuid: 'account-inherited' },
      policy: { sessionSlots: 20, sessionSlotsOverride: false },
    }),
  )
  fs.writeFileSync(
    path.join(vms, 'vm-override.json'),
    JSON.stringify({
      id: 'vm-override',
      claude: { account_uuid: 'account-override' },
      policy: { sessionSlots: 8, sessionSlotsOverride: true },
    }),
  )
  fs.writeFileSync(
    path.join(vms, 'vm-codex.json'),
    JSON.stringify({
      id: 'vm-codex',
      platform: 'openai',
      family: 'codex',
      codex: {},
      policy: { sessionSlots: 20, sessionSlotsOverride: false },
    }),
  )
  const routingConfig = {
    inference: { session_slots: 4 },
    concurrency: {},
    tiers: {},
  }
  fs.writeFileSync(routingFile, JSON.stringify(routingConfig))
  try {
    const runtime = createRoutingRuntime({
      cfg: { paths: { project: root } },
      routingConfigPath: routingFile,
      routingConfig,
      stickyRouter: { reloadConfig() {} },
      accountQuota: {
        setMaxConcurrency() {},
        setMaxRpm() {},
        reloadConfig() {},
        applyTierConcurrency() {},
        applyTierRpm() {},
        repo: { get: () => null },
      },
      requestLog: { setConfig() {} },
    })

    const applied = runtime.persistRoutingPatch({ inference: { session_slots: 4 } })

    const inherited = JSON.parse(fs.readFileSync(path.join(vms, 'vm-inherited.json'), 'utf8'))
    const overridden = JSON.parse(fs.readFileSync(path.join(vms, 'vm-override.json'), 'utf8'))
    const codex = JSON.parse(fs.readFileSync(path.join(vms, 'vm-codex.json'), 'utf8'))
    assert.deepEqual(applied.session_slots, { updated: 1, skipped: 1 })
    assert.equal(inherited.policy.sessionSlots, 4)
    assert.equal(inherited.policy.sessionSlotsOverride, false)
    assert.equal(overridden.policy.sessionSlots, 8)
    assert.equal(overridden.policy.sessionSlotsOverride, true)
    assert.equal(codex.policy.sessionSlots, 20)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('persistRoutingPatch writes compatibility cache_ttl into Claude kernel configs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-cache-ttl-'))
  const vms = path.join(root, 'vms')
  const routingFile = path.join(root, 'routing.json')
  fs.mkdirSync(vms, { recursive: true })
  fs.writeFileSync(path.join(vms, 'vm-claude.json'), JSON.stringify({ id: 'vm-claude', claude: {} }))
  fs.writeFileSync(
    path.join(vms, 'vm-codex.json'),
    JSON.stringify({ id: 'vm-codex', platform: 'openai', family: 'codex', codex: {} }),
  )
  const routingConfig = { compatibility: { cache_ttl: '1h' }, concurrency: {}, tiers: {} }
  fs.writeFileSync(routingFile, JSON.stringify(routingConfig))
  try {
    const runtime = createRoutingRuntime({
      cfg: { paths: { project: root } },
      routingConfigPath: routingFile,
      routingConfig,
      stickyRouter: { reloadConfig() {} },
      accountQuota: {
        reloadConfig() {},
        applyTierConcurrency() {},
        applyTierRpm() {},
        repo: { get: () => null },
      },
      requestLog: { setConfig() {} },
    })

    runtime.persistRoutingPatch({ compatibility: { cache_ttl: '5m' } })

    const kernel = JSON.parse(fs.readFileSync(path.join(vms, 'vm-claude', 'run', 'kernel.json'), 'utf8'))
    assert.equal(kernel.default_cache_ttl, '5m')
    assert.equal(fs.existsSync(path.join(vms, 'vm-codex', 'run', 'kernel.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
