import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

function loadFacade() {
  const saves = []
  const data = {
    characters: {
      Sprout: { name: 'Sprout' },
      Acorn: { name: 'Acorn' },
      Maple: { name: 'Maple' },
    },
    roster: ['Sprout', 'Acorn'],
    stage: {
      platforms: [
        { x: 0, y: 900, w: 500, h: 40, kind: 'ground', pass: false },
        {
          x: 100,
          y: 700,
          w: 200,
          h: 32,
          kind: 'drawn',
          pass: false,
          source: { kind: 'magicboard_agent', candidateId: 'old-generated' },
        },
      ],
      portals: [
        { id: 'old-a', link: 'old-b', x: 420, y: 500, r: 42, col: '#2f6fe0', source: { kind: 'magicboard_agent', candidateId: 'old-portal' } },
        { id: 'old-b', link: 'old-a', x: 1420, y: 500, r: 42, col: '#2f6fe0', source: { kind: 'magicboard_agent', candidateId: 'old-portal' } },
      ],
      spawns: [],
    },
  }
  const window = {
    DS: {
      Store: {
        data,
        save() {
          saves.push(JSON.parse(JSON.stringify(data)))
        },
      },
      Maps: {
        list() {
          return [{ id: 'meadow' }]
        },
        stageFor(storeData, mapId) {
          if (mapId !== 'meadow') throw new Error('unexpected map')
          return storeData.stage
        },
      },
    },
  }
  const context = vm.createContext({ window, globalThis: window })
  const source = fs.readFileSync(new URL('../js/magicBoardGame.js', import.meta.url), 'utf8')
  vm.runInContext(source, context)
  return { api: window.MagicBoardGame, data, saves }
}

function confirmedPortalPairCandidate(overrides = {}) {
  return confirmedCandidate({
    candidateId: 'portal-candidate',
    geometryHash: 'portal-hash',
    sourceIds: ['portal-a', 'portal-b'],
    semanticType: 'portal_pair',
    geometry: { x: 180, y: 420, w: 1300, h: 360 },
    portalEndpoints: [{ x: 220, y: 460, r: 46 }, { x: 1500, y: 720, r: 44 }],
    answer: { role: 'portal_pair', behavior: 'portal_pair' },
    ...overrides,
  })
}

function confirmedCandidate(overrides = {}) {
  return {
    status: 'confirmed',
    roomId: 'room-1',
    worldId: 'world-1',
    captureVersion: 3,
    candidateId: 'candidate-1',
    geometryHash: 'hash-1',
    sourceIds: ['shape-1'],
    geometry: { x: 120, y: 640, w: 260, h: 36 },
    answer: { role: 'platform', behavior: 'bounce' },
    ...overrides,
  }
}

{
  const { api } = loadFacade()
  const patch = api.buildPatchFromSemanticDraft(
    { roomId: 'room-1', worldId: 'world-1', captureVersion: 3, candidates: [confirmedCandidate()] },
    { mapId: 'meadow', replacePlatforms: true },
  )

  assert.equal(patch.type, 'magicboard_world_patch')
  assert.equal(patch.operations.length, 2)
  assert.equal(patch.operations[0].type, 'replace_platforms')
  assert.equal(patch.operations[1].platform.kind, 'trampoline')
  assert.equal(patch.operations[1].platform.bounce, 1200)
}

{
  const { api } = loadFacade()
  const expectations = {
    solid: { kind: 'drawn', pass: false },
    pass: { kind: 'float', pass: true },
    bounce: { kind: 'trampoline', bounce: 1200 },
    hurt: { kind: 'spikes', hurt: true },
    ice: { kind: 'crystal' },
    breakable: { kind: 'box', hp: 4 },
    cannon: { kind: 'cannon', fire: true },
  }

  Object.entries(expectations).forEach(([behavior, expected], index) => {
    const platform = api.platformFromCandidate(confirmedCandidate({
      candidateId: 'candidate-' + behavior,
      geometryHash: 'hash-' + behavior,
      sourceIds: ['shape-' + index],
      answer: { role: 'platform', behavior },
    }))
    assert.equal(platform.kind, expected.kind)
    if ('pass' in expected) assert.equal(platform.pass, expected.pass)
    if ('bounce' in expected) assert.equal(platform.bounce, expected.bounce)
    if ('hurt' in expected) assert.equal(Boolean(platform.hurt), expected.hurt)
    if ('hp' in expected) assert.equal(platform.hp, expected.hp)
    if ('fire' in expected) assert.equal(Boolean(platform.fire), expected.fire)
  })
}

{
  const { api } = loadFacade()
  const invalid = api.validatePatch({
    type: 'magicboard_world_patch',
    version: 1,
    target: { mapId: 'missing' },
    operations: [{ type: 'run_javascript', code: 'alert(1)' }],
  })

  assert.equal(invalid.ok, false)
  assert.match(invalid.errors.join('\n'), /unknown mapId missing/)
  assert.match(invalid.errors.join('\n'), /unsupported type/)
}

{
  const { api, data, saves } = loadFacade()
  const patch = {
    type: 'magicboard_world_patch',
    version: 1,
    target: { mapId: 'meadow' },
    operations: [
      {
        type: 'replace_platforms',
      },
      {
        type: 'add_platform',
        platform: {
          x: 200,
          y: 500,
          w: 300,
          h: 42,
          kind: 'float',
          pass: true,
          source: { kind: 'magicboard_agent', candidateId: 'candidate-new' },
        },
      },
      {
        type: 'add_platform',
        platform: {
          x: 240,
          y: 440,
          w: 180,
          h: 30,
          kind: 'crystal',
          pass: false,
          source: { kind: 'magicboard_agent', candidateId: 'old-generated' },
        },
      },
      { type: 'set_spawns', spawns: [{ x: 300, y: 760 }, { x: 500, y: 760 }] },
    ],
  }

  const result = api.applyPatch(patch)

  assert.equal(result.ok, true)
  assert.equal(result.applied, 4)
  assert.equal(saves.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(data.stage.spawns)), [{ x: 300, y: 760 }, { x: 500, y: 760 }])
  assert.equal(data.stage.platforms.length, 2)
  assert.equal(data.stage.platforms.some((platform) => platform.kind === 'ground'), false)
  assert.equal(data.stage.platforms.some((platform) => platform.source?.candidateId === 'old-generated' && platform.x === 100), false)
  assert.equal(data.stage.platforms.some((platform) => platform.source?.candidateId === 'candidate-new'), true)
  assert.equal(data.stage.platforms.some((platform) => platform.source?.candidateId === 'old-generated' && platform.kind === 'crystal'), true)
}

{
  const { api, data, saves } = loadFacade()
  const patch = api.buildPatchFromSemanticDraft(
    { roomId: 'room-1', worldId: 'world-1', captureVersion: 4, candidates: [confirmedPortalPairCandidate({ candidateId: 'old-portal' })] },
    { mapId: 'meadow' },
  )

  assert.equal(patch.operations.length, 1)
  assert.equal(patch.operations[0].type, 'add_portal_pair')
  const result = api.applyPatch(patch)

  assert.equal(result.ok, true)
  assert.equal(saves.length, 1)
  assert.equal(data.stage.portals.length, 2)
  assert.equal(data.stage.portals[0].link, data.stage.portals[1].id)
  assert.equal(data.stage.portals[1].link, data.stage.portals[0].id)
  assert.equal(data.stage.portals.some((portal) => portal.id === 'old-a'), false)
  assert.equal(data.stage.portals.every((portal) => portal.source?.candidateId === 'old-portal'), true)
}

{
  const { api, data } = loadFacade()
  const launchBefore = api.validateLaunchReady('meadow')
  assert.equal(launchBefore.ok, false)
  assert.deepEqual(JSON.parse(JSON.stringify(launchBefore.missing)), ['two spawns'])

  const result = api.applyPatch({
    type: 'magicboard_world_patch',
    version: 1,
    target: { mapId: 'meadow' },
    operations: [
      { type: 'set_spawns', spawns: [{ x: 300, y: 760 }, { x: 500, y: 760 }] },
      { type: 'set_roster', roster: ['Sprout', 'Maple'] },
    ],
  })

  assert.equal(result.ok, true)
  assert.equal(result.launch.ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(data.roster)), ['Sprout', 'Maple'])
  assert.deepEqual(JSON.parse(JSON.stringify(data.stage.spawns)), [{ x: 300, y: 760 }, { x: 500, y: 760 }])
}

{
  const { api, data } = loadFacade()
  const result = api.applyPatch({
    type: 'magicboard_world_patch',
    version: 1,
    target: { mapId: 'meadow' },
    operations: [
      { type: 'update_platform', candidateId: 'old-generated', patch: { kind: 'crystal', x: 130, y: 710, w: 240, h: 34 } },
      { type: 'remove_generated', candidateIds: ['old-portal'] },
    ],
  })

  assert.equal(result.ok, true)
  const updated = data.stage.platforms.find((platform) => platform.source?.candidateId === 'old-generated')
  assert.equal(updated.kind, 'crystal')
  assert.equal(updated.x, 130)
  assert.equal(data.stage.portals.length, 0)
}

console.log('MagicBoardGame facade tests passed')
