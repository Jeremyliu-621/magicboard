// Core-game desktop smoke test: boot the zero-build game from file://, run attract mode
// (#demo: two fighters auto-battle), and assert it loads clean, the core globals are wired,
// two fighters spawn (stick-figure default, no drawn skin), and the sim actually advances.
import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // #demo = attract mode: the game starts itself with two AI fighters.
  await page.goto('file://' + path.resolve('index.html') + '#demo')
  await page.waitForFunction(() => window.DS && window.DS.game && window.DS.Store?.data)
  // let the sim run a couple of seconds of real frames
  await page.waitForTimeout(2000)

  const state = await page.evaluate(() => {
    const DS = window.DS
    const g = DS.game
    const f = (g.fighters || [])[0]
    const skin = f && f.ch && f.ch.skin
    return {
      hasCore: !!(DS.Game && DS.Maps && DS.Store && DS.Fighter),
      fighterCount: (g.fighters || []).length,
      gameState: g.state,
      // built-in fighters now start with NO drawn skin (blank Draw canvas; stick-figure default)
      noDrawnSkinByDefault: !(skin && skin.parts && skin.parts.head && skin.parts.head.strokes &&
        skin.parts.head.strokes.length > 0),
      // the AI/pipeline globals must be gone after the strip
      noStrippedGlobals: !DS.AI && !DS.Prop && !DS.Graph && !DS.Finishers &&
        !DS.LevelPreview && !DS.WorldLibrary && !DS.MagicBoardGame && !DS.UltimateRecorder,
    }
  })

  assert.deepEqual(pageErrors, [], 'page must load with no JS errors: ' + JSON.stringify(pageErrors))
  assert.equal(state.hasCore, true, 'core globals (Game/Maps/Store/Fighter) must be present')
  assert.equal(state.fighterCount, 2, 'attract mode must spawn two fighters')
  assert.equal(state.gameState, 'playing', 'attract mode should be running the match')
  assert.equal(state.noDrawnSkinByDefault, true, 'built-in fighters must start with no drawn skin')
  assert.equal(state.noStrippedGlobals, true, 'stripped AI/pipeline globals must not exist')

  // ---- menu + editor paths (attract mode skips these; they must also load clean) ----
  const page2 = await browser.newPage({ viewport: { width: 1400, height: 800 } })
  const menuErrors = []
  page2.on('pageerror', (error) => menuErrors.push(error.message))
  await page2.goto('file://' + path.resolve('index.html')) // default load -> main menu
  await page2.waitForFunction(() => window.DS?.Store?.data)
  await page2.waitForTimeout(500)
  const maps = await page2.evaluate(() => ({
    count: window.DS.Maps.list().length,
    anyUndefined: window.DS.Maps.list().some((m) => !m || !m.id || !m.name),
  }))
  // open the Editor tab (iterates the same map list as the menu did)
  await page2.evaluate(() => {
    document.querySelectorAll('.tab, button').forEach((b) => { if (b.textContent.trim() === 'Editor') b.click() })
  })
  await page2.waitForTimeout(600)

  // ---- a REAL match with ultimates charged: exercises ult update/render paths (catches
  // missing-method regressions that #demo's short window can miss) ----
  await page2.evaluate(() => {
    const g = window.DS.game
    g.ultPick = ['hammer', 'sniper']
    g.start()
    g.fighters.forEach((f) => { f.charge = 1 }) // fill the ult meter so ult-ready/HUD paths run
  })
  await page2.waitForTimeout(1500)
  const match = await page2.evaluate(() => ({
    state: window.DS.game.state,
    fighters: window.DS.game.fighters.length,
    ultReadyIsFn: typeof window.DS.game.fighters[0]._ultReady === 'function',
  }))

  assert.deepEqual(menuErrors, [], 'menu/editor/match must load with no JS errors: ' + JSON.stringify([...new Set(menuErrors)]))
  assert.equal(maps.anyUndefined, false, 'every map in Maps.list() must be defined (no phantom _order ids)')
  assert.ok(maps.count >= 1, 'menu must list at least one map')
  assert.equal(match.state, 'playing', 'a real match must run')
  assert.equal(match.ultReadyIsFn, true, 'the ultimate system must be wired (fighters have _ultReady)')

  console.log(`✅ desktop smoke OK — battling + real match w/ ultimates, menu + editor clean (${maps.count} maps), no errors`)
} finally {
  await browser.close()
}
