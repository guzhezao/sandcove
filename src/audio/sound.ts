import { TOOL, type ToolMode } from '../config'
import { buildImpactSamples } from './effects'
import { sandWorkletSource } from './sand-worklet'

type GestureTrack = {
  x: number
  y: number
  time: number
  velocityX: number
  velocityY: number
  filteredSpeed: number
  speed: number
  pressure: number
  turn: number
  audibleUntil: number
  mode: ToolMode
}

type NavigatorWithAudioSession = Navigator & {
  audioSession?: { type: string }
}

// The source recording averages -35 dBFS: the old 0.08 gain made it inaudible.
const ambientVolume = 1.15
const waveVolume = 3.2
const proceduralVolume = 1.2
const minimumSampleMilliseconds = 1
const motionHoldMilliseconds = 55

function normalizedSpeed(pxPerSecond: number) {
  return Math.max(0, Math.min(1, (pxPerSecond - 24) / 1080))
}

function penPressure(event: PointerEvent) {
  return event.pointerType === 'pen' ? event.pressure : 0
}

function isAppleMobile() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function requestPlaybackAudioSession() {
  if (!isAppleMobile()) return
  const session = (navigator as NavigatorWithAudioSession).audioSession
  if (!session) return
  try {
    session.type = 'playback'
  } catch {
    return
  }
}

export class SandSound {
  private readonly ambient = new Audio('/scene_assets/beach.mp3')
  private readonly wave = new Audio('/scene_assets/wave.mp3')
  private readonly gestures = new Map<number, GestureTrack>()
  private readonly unlockController = new AbortController()
  private context: AudioContext | undefined
  private ambientSource: MediaElementAudioSourceNode | undefined
  private ambientGain: GainNode | undefined
  private waveSource: MediaElementAudioSourceNode | undefined
  private waveGain: GainNode | undefined
  private sandNode: AudioWorkletNode | undefined
  private proceduralReady: Promise<void> | undefined
  private prepareReady: Promise<void> | undefined
  private readonly waveMetadataReady: Promise<void>
  private waveDuration = 4.754
  private disposed = false
  private userActivated = false
  private master: GainNode | undefined
  private output: DynamicsCompressorNode | undefined
  private impact: AudioBuffer | undefined
  private tsunami = false
  private mutedValue = false
  private lastBuild = -Infinity
  private metadataTimer: ReturnType<typeof setTimeout> | undefined
  get muted() { return this.mutedValue }

  setMuted(muted: boolean) {
    this.mutedValue = muted
    try { localStorage.setItem('sandcove-sound', muted ? 'off' : 'on') } catch { /* Private browsing. */ }
    this.applyMute()
    if (!muted) this.activatePlayback()
  }

  private applyMute() {
    const silent = this.mutedValue || document.hidden
    if (this.context && this.master) {
      this.master.gain.setTargetAtTime(silent ? 0 : 1, this.context.currentTime, .025)
    }
    if (silent) { this.ambient.pause(); this.wave.pause() }
  }

  playBuild() {
    if (this.disposed || this.mutedValue || document.hidden) return
    this.activatePlayback()
    const context = this.context
    if (!context || !this.master || context.currentTime - this.lastBuild < .08) return
    this.lastBuild = context.currentTime
    if (!this.impact) {
      const data = buildImpactSamples(context.sampleRate)
      this.impact = context.createBuffer(1, data.length, context.sampleRate)
      this.impact.copyToChannel(data, 0)
    }
    const node = context.createBufferSource()
    node.buffer = this.impact; node.connect(this.master)
    node.onended = () => node.disconnect()
    node.start()
  }

  playTsunami() {
    this.tsunami = true
    this.wave.loop = true
    this.activatePlayback()
    if (!this.mutedValue && !document.hidden && this.userActivated) void this.wave.play().catch(() => undefined)
  }

  stopTsunami() {
    this.tsunami = false; this.wave.loop = false; this.wave.pause()
    try { this.wave.currentTime = 0 } catch { /* Media not ready. */ }
    if (this.context && this.ambientGain) this.ambientGain.gain.setTargetAtTime(ambientVolume,this.context.currentTime,.5)
  }

  setSeaProgress(progress: number) {
    if (!this.context) return
    const p = this.tsunami ? Math.max(0,Math.min(1,progress)) : 0
    this.ambientGain?.gain.setTargetAtTime(ambientVolume*(1+p*.35),this.context.currentTime,.5)
    this.waveGain?.gain.setTargetAtTime(waveVolume*(.55+p*.45),this.context.currentTime,.3)
  }

  constructor() {
    try { this.mutedValue = localStorage.getItem('sandcove-sound') === 'off' } catch { /* Storage unavailable. */ }
    this.ambient.loop = true
    this.ambient.preload = 'auto'
    // Keep the media element itself at unity. iOS has historically ignored or
    // inconsistently applied HTMLMediaElement.volume, so the audible level is
    // controlled by the shared Web Audio gain stage instead.
    this.ambient.volume = 1
    this.ambient.setAttribute('playsinline', '')

    this.wave.preload = 'auto'
    this.wave.volume = 1
    this.wave.setAttribute('playsinline', '')
    this.waveMetadataReady = this.loadWaveMetadata()

    const unlock = () => { this.userActivated = true; this.activatePlayback() }
    const { signal } = this.unlockController
    window.addEventListener('pointerdown', unlock, { signal, passive: true })
    window.addEventListener('keydown', unlock, { signal })
    document.addEventListener('visibilitychange', () => { this.applyMute(); if (!document.hidden) this.activatePlayback() }, {signal})
  }

  prepare() {
    if (this.prepareReady) return this.prepareReady
    this.prepareReady = Promise.all([this.prepareAudio(), this.waveMetadataReady]).then(() => undefined)
    return this.prepareReady
  }

  beginPointer(event: PointerEvent, mode: ToolMode = TOOL.dig) {
    if (this.disposed) return
    this.activatePlayback()
    this.gestures.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      velocityX: 0,
      velocityY: 0,
      filteredSpeed: 0,
      speed: 0.025,
      pressure: penPressure(event),
      turn: 0,
      audibleUntil: performance.now() + motionHoldMilliseconds,
      mode,
    })
    this.sendGestureState()
  }

  movePointer(event: PointerEvent, pointerId = event.pointerId) {
    const track = this.gestures.get(pointerId)
    if (!track) return

    const dt = Math.max(minimumSampleMilliseconds, event.timeStamp - track.time) / 1000
    const dx = event.clientX - track.x
    const dy = event.clientY - track.y
    const distance = Math.hypot(dx, dy)
    const rawSpeed = distance / dt
    const blend = 1 - Math.exp(-dt * 18)
    track.filteredSpeed += (rawSpeed - track.filteredSpeed) * blend

    const velocityX = dx / dt
    const velocityY = dy / dt
    const velocityMagnitude = Math.hypot(velocityX, velocityY)
    const oldMagnitude = Math.hypot(track.velocityX, track.velocityY)
    let turn = 0
    if (velocityMagnitude > 20 && oldMagnitude > 20) {
      const dot = (velocityX * track.velocityX + velocityY * track.velocityY) / (velocityMagnitude * oldMagnitude)
      turn = Math.max(0, Math.min(1, (1 - dot) * 0.72))
    }
    const acceleration = Math.hypot(velocityX - track.velocityX, velocityY - track.velocityY) / Math.max(3000, velocityMagnitude * 8)
    turn = Math.min(1, turn + acceleration * 0.35)

    track.x = event.clientX
    track.y = event.clientY
    track.time = event.timeStamp
    track.velocityX = velocityX
    track.velocityY = velocityY
    track.speed = normalizedSpeed(track.filteredSpeed)
    track.pressure = penPressure(event)
    track.turn = turn
    if (distance > 0) track.audibleUntil = performance.now() + motionHoldMilliseconds
    this.sendGestureState()
  }

  setToolMode(mode: ToolMode) {
    for (const track of this.gestures.values()) track.mode = mode
  }

  update(now: number) {
    if (this.gestures.size) this.sendGestureState(now)
  }

  endPointer(pointerId: number) {
    if (!this.gestures.delete(pointerId)) return
    this.sendGestureState()
  }

  cancelAll() {
    if (!this.gestures.size) return
    this.gestures.clear()
    this.sendGestureState()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.unlockController.abort()
    clearTimeout(this.metadataTimer)
    this.cancelAll()
    this.sandNode?.disconnect()
    this.sandNode = undefined
    this.ambientSource?.disconnect()
    this.ambientSource = undefined
    this.ambientGain?.disconnect()
    this.ambientGain = undefined
    this.waveSource?.disconnect()
    this.waveSource = undefined
    this.waveGain?.disconnect()
    this.waveGain = undefined
    this.master?.disconnect(); this.output?.disconnect()
    if (this.context) void this.context.close().catch(() => undefined)
    this.context = undefined
    this.ambient.pause()
    this.wave.pause()
    this.wave.currentTime = 0
    this.ambient.removeAttribute('src')
    this.wave.removeAttribute('src')
    this.ambient.load()
    this.wave.load()
  }

  private async prepareAudio() {
    if (this.disposed) return
    const context = this.ensureContext()
    const procedural = this.ensureProcedural(context)

    // Playback starts from a real gesture; loading audio never blocks gameplay.
    this.applyMute()
    await procedural
  }

  private activatePlayback() {
    if (this.disposed || this.mutedValue || document.hidden || !this.userActivated) return
    let context: AudioContext
    try { context = this.ensureContext() } catch { return }
    this.applyMute()

    // Keep resume() and media play() in the same synchronous user-activation
    // stack. In particular, do not await AudioWorklet.addModule() here: WebKit
    // can consume the transient activation before an asynchronous continuation.
    if (context.state !== 'running') void context.resume().catch(() => undefined)
    void this.playAmbient()
    if (this.tsunami && this.wave.paused) void this.wave.play().catch(() => undefined)
    void this.ensureProcedural(context).then(() => this.sendGestureState())
  }

  private ensureContext() {
    if (this.context) return this.context

    // WebKit maps ordinary Web Audio to an ambient session on iOS, which can
    // be muted by the Ring/Silent switch while HTML media remains audible.
    // A playback session keeps both parts of this game's mix on one route.
    requestPlaybackAudioSession()

    const context = new AudioContext({ latencyHint: 'interactive' })
    const master = new GainNode(context, {gain:this.mutedValue || document.hidden ? 0 : 1})
    const output = new DynamicsCompressorNode(context,{threshold:-8,knee:8,ratio:4,attack:.005,release:.2})
    master.connect(output).connect(context.destination)
    this.master=master; this.output=output
    const ambientSource = context.createMediaElementSource(this.ambient)
    const ambientGain = new GainNode(context, { gain: ambientVolume })
    ambientSource.connect(ambientGain).connect(master)

    const waveSource = context.createMediaElementSource(this.wave)
    const waveGain = new GainNode(context, { gain: waveVolume })
    waveSource.connect(waveGain).connect(master)

    this.context = context
    this.ambientSource = ambientSource
    this.ambientGain = ambientGain
    this.waveSource = waveSource
    this.waveGain = waveGain
    return context
  }

  get resetDurationSeconds() { return this.waveDuration }

  playResetWave() {
    if (this.disposed) return this.waveDuration
    this.stopTsunami()
    this.activatePlayback()
    this.wave.pause()
    try { this.wave.currentTime = 0 } catch {
      // Some browsers throw while the media pipeline is still attaching.
    }
    if (!this.mutedValue && !document.hidden && this.userActivated) void this.wave.play().catch(() => undefined)
    return this.waveDuration
  }

  private loadWaveMetadata() {
    return new Promise<void>((resolve) => {
      this.metadataTimer = setTimeout(resolve,2500)
      const finalize = () => {
        clearTimeout(this.metadataTimer)
        const duration = this.wave.duration
        if (Number.isFinite(duration) && duration > 0) this.waveDuration = duration
        resolve()
      }
      if (this.wave.readyState >= HTMLMediaElement.HAVE_METADATA) {
        finalize()
        return
      }
      this.wave.addEventListener('loadedmetadata', finalize, { once: true })
      this.wave.addEventListener('error', () => resolve(), { once: true })
      this.wave.load()
    })
  }

  private async playAmbient() {
    if (this.disposed || this.mutedValue || document.hidden || !this.userActivated || !this.ambient.paused) return
    await this.ambient.play().catch(() => undefined)
  }

  private ensureProcedural(context: AudioContext) {
    if (this.proceduralReady) return this.proceduralReady
    this.proceduralReady = this.createProcedural(context).catch((error: unknown) => {
      console.warn('[Sandboard audio] Procedural drawing sound unavailable.', error)
    })
    return this.proceduralReady
  }

  private async createProcedural(context: AudioContext) {
    if (this.disposed || this.sandNode) return
    const blob = new Blob([sandWorkletSource], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    if (this.disposed || context !== this.context) return

    const sandNode = new AudioWorkletNode(context, 'sand-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    const highpass = new BiquadFilterNode(context, { type: 'highpass', frequency: 90, Q: 0.7 })
    const presence = new BiquadFilterNode(context, { type: 'peaking', frequency: 2200, Q: 0.75, gain: -4.8 })
    const soften = new BiquadFilterNode(context, { type: 'lowpass', frequency: 4800, Q: 0.42 })
    const compressor = new DynamicsCompressorNode(context, {
      threshold: -18,
      knee: 16,
      ratio: 2.2,
      attack: 0.004,
      release: 0.09,
    })
    const master = new GainNode(context, { gain: proceduralVolume })

    sandNode.connect(highpass).connect(presence).connect(soften).connect(compressor).connect(master).connect(this.master!)
    this.sandNode = sandNode
  }

  private sendGestureState(now = performance.now()) {
    if (!this.sandNode) return
    if (!this.gestures.size) {
      this.sandNode.port.postMessage({ type: 'state', gate: 0, speed: 0, pressure: 0, turn: 0 })
      return
    }

    let strongest: GestureTrack | undefined
    let strongestEnergy = -1
    for (const track of this.gestures.values()) {
      const hold = track.mode === TOOL.water ? .28 : .14
      const energy = Math.max(track.audibleUntil < now ? 0 : track.speed, hold) * (0.92 + track.pressure * 0.08)
      if (energy > strongestEnergy) {
        strongest = track
        strongestEnergy = energy
      }
    }
    if (!strongest) {
      this.sandNode.port.postMessage({ type: 'state', gate: 0, speed: 0, pressure: 0, turn: 0 })
      return
    }
    this.sandNode.port.postMessage({
      type: 'state',
      gate: 1,
      speed: Math.max(strongest.audibleUntil < now ? 0 : strongest.speed, strongest.mode === TOOL.water ? .28 : .14),
      mode: strongest.mode,
      pressure: strongest.pressure,
      turn: strongest.turn,
    })
  }
}
