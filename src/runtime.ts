import { environmentFor } from './play-mode'
import { SandSound } from './audio/sound'
import { SAND, TOOL, WATER, idleStroke } from './config'
import { TidepoolDemo, type DemoLayout } from './demo'
import { InputController } from './input/controller'
import type { BootMonitor } from './platform/boot'
import { createGpu } from './platform/gpu'
import { WaveResetEffect } from './reset/effect'
import { waveResetViewport } from './reset/viewport'
import { useMobileGrainFiltering, useSingleFrameResetPacing } from './platform/mobile'
import { drawingBuffer } from './platform/viewport'
import { SurfacePicking } from './render/surface-picking'
import { SandRenderer } from './render/renderer'
import { SandCamera } from './render/camera'
import { FixedClock } from './simulation/clock'
import { SandSolver } from './simulation/solver'
import { WaterSolver } from './simulation/water-solver'
import { SandMolds } from './simulation/molds'
import { starterCastle } from './starter'
import { SandErosion } from './simulation/erosion'
import { TIDE, TideCycle, tideTerrainHeight, type TideMode } from './tide'
import type { InterfaceElements } from './ui/interface'

const modeHints: Record<TideMode, string> = {
  free: '挖沟、筑墙、引水；工具尺寸与海浪参数都可以自由调整。',
  tide: '挖深沟分流，筑沙墙守住小院；准备好后，直接点「海啸」。',
}


/**
 * Places the two demo pits and the channel inside what the camera can
 * actually show, so the guided scene stays whole on a phone in portrait as
 * well as on a wide desktop window.
 */
function demoLayout(camera: SandCamera, width: number, height: number): DemoLayout {
  const line = height * 0.56
  const left = camera.screenToBed(width * 0.33, line, width, height)
  const right = camera.screenToBed(width * 0.67, line, width, height)
  const limit = SAND.extent / 2 - 0.085
  const centre = Math.max(-limit, Math.min(limit, (left.x + right.x) / 2))
  const spread = Math.abs(right.x - left.x)
  const half = Math.max(0.035, Math.min(spread / 2, limit))
  const pitRadius = Math.min(0.03, half * 0.46)
  return {
    pitAX: centre - half,
    pitBX: centre + half,
    channelY: Math.max(-limit, Math.min(limit, left.y)),
    pitRadius,
    channelRadius: Math.min(0.018, Math.max(0.011, pitRadius * 0.55)),
  }
}

export async function startSandboard(ui: InterfaceElements, monitor: BootMonitor) {
  const gpu = await createGpu(ui.canvas, monitor)
  const solver = new SandSolver(gpu.device)
  const water = new WaterSolver(gpu.device, solver)
  const erosion = new SandErosion(gpu.device, solver, water)
  const molds = new SandMolds(gpu.device, solver)
  const renderer = new SandRenderer(gpu.device, solver, water, gpu.format, useMobileGrainFiltering())
  const picking = new SurfacePicking(solver, renderer.camera)
  const sound = new SandSound()
  const soundReady = sound.prepare().catch(error => console.warn('[Sandcove audio] Sound unavailable; gameplay continues.',error))
  const updateSoundButton = () => {
    ui.soundToggle.setAttribute('aria-pressed',String(!sound.muted))
    ui.soundToggle.setAttribute('aria-label',sound.muted?'开启海边声音':'关闭海边声音')
    ui.soundLabel.textContent=sound.muted?'已静音':'海边声'
  }
  updateSoundButton()
  const clock = new FixedClock(SAND.step, SAND.maxSteps)
  const waterClock = new FixedClock(WATER.step, WATER.maxSteps)
  const demo = new TidepoolDemo()
  const tide = new TideCycle()
  let mode: TideMode = 'tide'
  let pendingMode: TideMode | undefined
  let starterPending = true
  let shoreZ = 0
  let toolbarInteractive = true
  const listeners = new AbortController()
  let input: InputController | undefined
  let animation = 0
  let stopped = false
  let framesInFlight = 0
  let lastSceneFrame = 0
  let resizePending = true
  let resetPending = false
  let waveResetInteractive = false
  let waveResetNeedsTransientClear = false
  const singleFrameResetPacing = useSingleFrameResetPacing()
  const resetFrameBudget = singleFrameResetPacing ? 1 : 2
  const waveReset = new WaveResetEffect()
  const environment = () => environmentFor(mode, {
    waveHeight: Number(ui.waveHeight.value), surgeDepth: Number(ui.surgeDepth.value),
    erosionStrength: Number(ui.erosionStrength.value),
  })
  const applyEnvironment = () => Object.assign(tide, {waveHeight: environment().waveHeight, highLevel: environment().highLevel})
  const updateTideControls = () => {
    const progress = Math.round(tide.progress * 100)
    ui.tideFill.style.width = `${progress}%`
    ui.tideFill.parentElement?.setAttribute('aria-label', `潮位 ${progress}%，${tide.label}`)
    if (ui.tidePhase.textContent !== tide.label) ui.tidePhase.textContent = tide.label
    ui.tideTsunami.disabled = !toolbarInteractive || !tide.canFlood
    ui.tsunamiLabel.textContent = tide.running ? '海啸中' : '海啸'
    ui.tideTsunami.setAttribute('aria-label', tide.running ? tide.label : '发动海啸')
  }
  const updateModeInterface = () => {
    for (const [button, selected] of [[ui.modeFree, mode === 'free'], [ui.modeTide, mode === 'tide']] as const) {
      button.classList.toggle('active', selected)
      button.setAttribute('aria-checked', String(selected))
      button.title = '切换玩法会重新铺沙'
    }
    ui.hint.textContent = modeHints[mode]
    ui.tideSettings.hidden = mode !== 'free'
    ui.setAdjustable(mode === 'free')
    input?.setAdjustable(mode === 'free')
    ui.demo.hidden = mode !== 'free'
    updateTideControls()
  }
  const setToolbarInteractive = (interactive: boolean) => {
    toolbarInteractive = interactive
    ui.reset.disabled = !interactive
    ui.radius.disabled = !interactive || mode !== 'free'
    ui.demo.disabled = !interactive
    ui.modeFree.disabled = !interactive
    ui.modeTide.disabled = !interactive
    for (const control of [ui.buildWall, ui.buildMound, ui.orbit, ui.tideSettings, ui.zoomIn, ui.zoomOut, ui.waveHeight, ui.surgeDepth, ui.erosionStrength, ui.moldTower, ui.moldWall, ui.moldArc, ui.moldRotate]) control.disabled = !interactive
    input?.setInteractive(interactive)
    updateTideControls()
  }
  const resetDemoButton = () => {
    ui.demo.classList.remove('running')
    ui.demo.textContent = '试试引水'
  }
  const stopDemo = () => {
    if (demo.running) demo.stop()
    resetDemoButton()
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(animation)
    listeners.abort()
    input?.dispose()
    sound.dispose()
    picking.dispose(); molds.dispose(); renderer.dispose(); erosion.dispose(); solver.dispose(); water.dispose(); gpu.dispose()
  }
  monitor.setStop(stop)
  const resize = () => {
    if (!resizePending) return
    const size = drawingBuffer(window.innerWidth, window.innerHeight, window.devicePixelRatio)
    if (!size) return
    resizePending = false
    ui.canvas.width = size.width; ui.canvas.height = size.height
    renderer.resize(size.width, size.height)
    demo.setLayout(demoLayout(renderer.camera, window.innerWidth, window.innerHeight))
  }
  // Only an explicit scene change rebuilds terrain. A tide phase change
  // merely changes the ocean boundary; the player's sand and pools remain.
  const rebuildScene = (nextMode: TideMode, now: number) => {
    setToolbarInteractive(false)
    stopDemo()
    sound.cancelAll(); sound.stopTsunami()
    mode = nextMode
    tide.reset()
    applyEnvironment()
    shoreZ = TIDE.shoreZ
    solver.resetWithTerrain((_x, z) => tideTerrainHeight(z, shoreZ))
    water.reset()
    picking.reset()
    clock.reset(now)
    waterClock.reset(now)
    resetPending = false
    starterPending = true
    renderer.scenery.reset()
    ui.showToolMenu(null)
    updateModeInterface()
    setToolbarInteractive(true)
  }
  try {
    monitor.stage('正在初始化沙粒输运')
    await solver.initialize()
    monitor.stage('正在准备潮池水体')
    await water.initialize()
    await erosion.initialize()
    await molds.initialize()
    monitor.stage('正在编译颗粒光照')
    await renderer.initialize()
    monitor.stage('正在渲染第一帧沙面')
    // Desktop side panels may load in a hidden 0×0 view. Wait for an actual
    // drawing area instead of misreporting that the GPU is unsupported.
    await new Promise<void>((resolve) => {
      const visibleViewport = () => {
        if (stopped || drawingBuffer(window.innerWidth, window.innerHeight, window.devicePixelRatio)) resolve()
        else animation = requestAnimationFrame(visibleViewport)
      }
      visibleViewport()
    })
    if (stopped) return
    resize()
    renderer.camera.orbit(75,0)
    renderer.camera.zoom = .70
    rebuildScene(mode,performance.now())
    const encoder = gpu.device.createCommandEncoder()
    molds.encode(encoder,starterCastle())
    starterPending=false
    solver.encode(encoder, [[], []])
    water.encode(encoder, solver.stateIndex)
    renderer.encode(encoder, gpu.context.getCurrentTexture().createView(), idleStroke(), performance.now())
    gpu.device.queue.submit([encoder.finish()])
    await gpu.device.queue.onSubmittedWorkDone()
    monitor.assertHealthy()
    await soundReady
    input = new InputController(ui, renderer.camera, sound, () => { resetPending = true }, (tool) => { stopDemo(); sound.setToolMode(tool) })
    ui.soundToggle.addEventListener('click',()=>{sound.setMuted(!sound.muted);updateSoundButton()}, {signal:listeners.signal})
    ui.waveHeight.addEventListener('input', () => {
      if (mode !== 'free') return
      applyEnvironment()
      ui.waveValue.value = tide.waveHeight === 0 ? '平静' : tide.waveHeight < 0.010 ? '轻浪' : tide.waveHeight < 0.020 ? '强浪' : '巨浪'
    }, { signal: listeners.signal })
    ui.surgeDepth.addEventListener('input', () => {
      if (mode !== 'free') return
      applyEnvironment()
      ui.surgeValue.value = `漫滩 ${ui.surgeDepth.value} mm`
    }, {signal:listeners.signal})
    ui.erosionStrength.addEventListener('input', () => {
      const amount = Number(ui.erosionStrength.value)
      ui.erosionValue.value = `${amount <= 2 ? '轻' : amount <= 4 ? '强' : '猛烈'} · ${amount}×`
    }, {signal:listeners.signal})
    ui.modeFree.addEventListener('click', () => {
      if (toolbarInteractive && mode !== 'free') pendingMode = 'free'
    }, { signal: listeners.signal })
    ui.modeTide.addEventListener('click', () => {
      if (toolbarInteractive && mode !== 'tide') pendingMode = 'tide'
    }, { signal: listeners.signal })
    ui.tideTsunami.addEventListener('click', () => {
      if (toolbarInteractive) { applyEnvironment(); if(tide.startTsunami()) sound.playTsunami(); ui.showToolMenu(null) }
      updateTideControls()
    }, { signal: listeners.signal })
    ui.demo.addEventListener('click', () => {
      if (mode !== 'free' || !toolbarInteractive) return
      if (!demo.running) {
        demo.setLayout(demoLayout(renderer.camera, window.innerWidth, window.innerHeight))
        demo.restart()
        ui.demo.classList.add('running')
        ui.demo.textContent = '演示中'
      } else {
        stopDemo()
      }
    }, { signal: listeners.signal })
    updateModeInterface()
    setToolbarInteractive(true)
    const frame = (now: number) => {
      if (stopped) return
      animation = requestAnimationFrame(frame)
      sound.update(now)
      const frameBudget = waveResetInteractive ? resetFrameBudget : 1
      if (document.hidden || !drawingBuffer(window.innerWidth, window.innerHeight, window.devicePixelRatio)) { clock.reset(); waterClock.reset(); lastSceneFrame=0; return }
      // GPU backpressure must not erase elapsed simulation time. On iOS WebKit
      // queue completion can arrive a display interval late; resetting here
      // starves the fixed-step solver while pointer samples continue to queue.
      if (framesInFlight >= frameBudget) return
      try {
        resize()
        if (pendingMode && !waveResetInteractive) {
          rebuildScene(pendingMode, now)
          pendingMode = undefined
        }
        if (resetPending && mode === 'tide' && !waveResetInteractive) rebuildScene(mode, now)
        if (resetPending && !waveResetInteractive) {
          resetPending = false
          waveResetInteractive = true
          sound.cancelAll()
          picking.reset()
          waveReset.start(now, sound.playResetWave(), waveResetViewport(renderer.camera))
          waveResetNeedsTransientClear = true
          clock.reset()
          waterClock.reset()
          stopDemo()
          setToolbarInteractive(false)
        }
        const sceneDt=lastSceneFrame ? Math.min(.05,Math.max(0,(now-lastSceneFrame)/1000)) : 1/60
        lastSceneFrame=now
        const encoder = gpu.device.createCommandEncoder()
        const activeInput = input!
        const waveState = waveReset.update(now)
        if (waveResetInteractive) {
          clock.reset()
          waterClock.reset()
          if (waveResetNeedsTransientClear) {
            solver.clearTransientState(encoder)
            water.encodeClear(encoder)
            waveResetNeedsTransientClear = false
          }
          if (waveState.erase) solver.encodeWaveReset(encoder, waveState)
          if (waveState.justFinished) {
            waveResetInteractive = false
            solver.resetWithTerrain((_x, z) => tideTerrainHeight(z, shoreZ))
            water.reset(); tide.reset(); applyEnvironment(); picking.reset()
            starterPending = true
            clock.reset(now)
            waterClock.reset(now)
            // The final dry frame is submitted below before browser input can
            // dispatch again. Re-enable immediately at the audio endpoint;
            // the one-frame GPU gate still prevents simulation overtaking it.
            setToolbarInteractive(true)
          }
        }
        const count = waveResetInteractive ? 0 : clock.advance(now)
        const held = activeInput.strokes.heldContacts(now)
        if (demo.running && held.length) stopDemo()
        const demoWasRunning = demo.running
        let demoContacts = [] as ReturnType<InputController['strokes']['heldContacts']>
        if (count > 0) {
          const batches = []
          for (let index = 0; index < count; index++) {
            const user = activeInput.strokes.nextBatch(now)
            const frame2 = demo.running ? demo.step(SAND.step) : undefined
            if (frame2) demoContacts = frame2.contacts
            batches.push(frame2 ? [...user, ...frame2.strokes] : user)
          }
          solver.encode(encoder, batches)
        }
        if (!waveResetInteractive && starterPending) {
          molds.encode(encoder,starterCastle());renderer.scenery.reset();starterPending=false
        } else if (!waveResetInteractive && activeInput.stamps.length) {
          const stamps=activeInput.stamps.splice(0,4)
          molds.encode(encoder,stamps);renderer.scenery.addFlags(stamps);sound.playBuild()
        }
        activeInput.updateMoldPreview()
        // A scene that reached its last step on its own still has to put the
        // button back the way it was.
        if (demoWasRunning && !demo.running) resetDemoButton()
        const waterSteps = waveResetInteractive ? 0 : waterClock.advance(now)
        if (waterSteps > 0) {
          const wasRunning=tide.running
          tide.update(waterSteps * WATER.step)
          if(wasRunning&&!tide.running) sound.stopTsunami()
          sound.setSeaProgress(tide.progress)
          water.writeParams(
            [...held.filter((contact) => (contact.mode ?? TOOL.dig) === TOOL.water), ...demoContacts],
            WATER.step,
            { shore: shoreZ, level: tide.level, drift: tide.velocity, waveTime: tide.waveTime, waveHeight: tide.boundaryWaveHeight, surgeSpeed:tide.surgeSpeed },
          )
          for (let index = 0; index < waterSteps; index++) water.encode(encoder, solver.stateIndex)
          erosion.encode(encoder, waterSteps * WATER.step, environment().erosionStrength)
          updateTideControls()
        }
        if (!waveResetInteractive) renderer.scenery.step(encoder, sceneDt)
        renderer.encode(encoder, gpu.context.getCurrentTexture().createView(), activeInput.strokes.cursor, now, activeInput.showPointer && !activeInput.usesPlacementPreview, waveState)
        const readSurface = !waveResetInteractive && picking.encode(encoder, now)
        gpu.device.queue.submit([encoder.finish()])
        if (readSurface) void picking.read().catch((error: unknown) => monitor.fail(error))
        framesInFlight++
        void gpu.device.queue.onSubmittedWorkDone().then(() => {
          framesInFlight = Math.max(0, framesInFlight - 1)
        }).catch((error: unknown) => monitor.fail(error))
      } catch (error) { monitor.fail(error) }
    }
    window.addEventListener('resize', () => { resizePending = true }, { signal: listeners.signal })
    window.visualViewport?.addEventListener('resize', () => { resizePending = true }, { signal: listeners.signal })
    document.addEventListener('visibilitychange', () => { clock.reset(); waterClock.reset() }, { signal: listeners.signal })
    window.addEventListener('pagehide', stop, { once: true, signal: listeners.signal })
    import.meta.hot?.dispose(stop)
    animation = requestAnimationFrame(frame)
  } catch (error) { stop(); throw error }
}
