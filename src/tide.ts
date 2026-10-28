import { SAND } from './config'

export type TidePhase = 'ready' | 'flood' | 'high' | 'ebb'
export type TideMode = 'free' | 'tide'

export const TIDE = {
  /** Fixed coast: enlarging the bed creates more playable inland sand. */
  shoreZ: -0.24,
  /** Where the shoreline sits on screen, so the coast is always framed. */
  shoreScreenY: 0.24,
  lowLevel: 0.024, highLevel: 0.104,
  floodSeconds: 8, highSeconds: 16, ebbSeconds: 13,
  seaFloor: 0.004, beachHeight: 0.044,
  seaRamp: 0.03, beachRun: 0.14,
} as const

export const tidePhaseLabels: Record<TidePhase, string> = {
  ready: '等待海啸',
  flood: '涨潮中',
  high: '满潮',
  ebb: '退潮中',
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const smooth = (value: number) => {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount

/**
 * The tide sets the mean sea level, while travelling waves modulate the sea band. The
 * water grid follows that level exactly, and everything inland is reached the
 * same way any other water is: through the terrain and the neighbouring
 * cells.
 */
export class TideCycle {
  phase: TidePhase = 'ready'
  elapsed = 0
  waveTime = 0
  waveHeight = 0.022
  highLevel: number = TIDE.highLevel
  level: number = TIDE.lowLevel
  /** Metres per second the sea edge is travelling, used for the surface drift. */
  velocity = 0
  /** A short, coast-wide bore; ordinary tides keep their original pacing. */
  tsunami = false
  get peakLevel() { return this.tsunami ? Math.max(.150, this.highLevel + .070) : this.highLevel }
  get surgeSpeed() {
    if (!this.tsunami) return 0
    if (this.phase === 'flood') return .27 * smooth(this.elapsed / .7)
    if (this.phase === 'high') return .27 * (1 - smooth(this.elapsed / 4))
    return 0
  }
  get boundaryWaveHeight() { return this.tsunami ? .004 : this.waveHeight * (1 + this.progress * .5) }
  /** The level the current leg started from. */
  private from: number = TIDE.lowLevel

  get running() { return this.phase !== 'ready' }
  get label() { return this.tsunami ? ({ready:'等待海啸',flood:'海啸涌入',high:'大浪漫滩',ebb:'余浪回流'} as const)[this.phase] : tidePhaseLabels[this.phase] }
  /** 0 at low water, 1 at high water. */
  get progress() { return clamp((this.level - TIDE.lowLevel) / (this.peakLevel - TIDE.lowLevel), 0, 1) }
  /** The tide can be called in only when the water is at its lowest. */
  get canFlood() { return this.phase === 'ready' }
  /** The tide can be turned around while it is still coming in. */
  get canEbb() { return this.phase === 'flood' || this.phase === 'high' }

  reset() {
    this.phase = 'ready'
    this.waveTime = 0
    this.elapsed = 0
    this.level = TIDE.lowLevel
    this.velocity = 0
    this.from = TIDE.lowLevel
    this.tsunami = false
  }

  /** Starts the flood. Returns false when the tide is already moving. */
  start() {
    if (this.phase !== 'ready') return false
    this.phase = 'flood'
    this.elapsed = 0
    this.from = this.level
    this.tsunami = false
    return true
  }

  startTsunami() {
    if (!this.start()) return false
    this.tsunami = true
    return true
  }

  /** Lets the tide fall early. Returns false unless the sea is on its way in. */
  ebb() {
    if (this.phase !== 'flood' && this.phase !== 'high') return false
    this.phase = 'ebb'
    this.elapsed = 0
    this.from = this.level
    return true
  }

  update(dt: number) {
    this.waveTime += dt
    if (this.phase === 'ready') { this.level = TIDE.lowLevel; this.velocity = 0; return }
    if (this.phase === 'high') {
      this.elapsed += dt
      this.level = this.peakLevel
      this.velocity = 0
      if (this.elapsed >= (this.tsunami ? 6 : TIDE.highSeconds)) {
        this.phase = 'ebb'
        this.elapsed = 0
        this.from = this.peakLevel
      }
      return
    }
    this.elapsed += dt
    const seconds = this.phase === 'flood' ? (this.tsunami ? 4 : TIDE.floodSeconds) : TIDE.ebbSeconds
    const t = Math.min(1, this.elapsed / seconds)
    const previous = this.level
    const target = this.phase === 'flood' ? this.peakLevel : TIDE.lowLevel
    this.level = mix(this.from, target, smooth(t))
    this.velocity = (this.level - previous) / Math.max(dt, 1e-4)
    if (t >= 1) {
      if (this.phase === 'flood') {
        this.phase = 'high'
        this.elapsed = 0
        this.velocity = 0
        this.from = this.peakLevel
      } else {
        this.phase = 'ready'
        this.elapsed = 0
        this.level = TIDE.lowLevel
        this.velocity = 0
        this.from = TIDE.lowLevel
        this.tsunami = false
      }
    }
  }
}

/**
 * The beach in tide mode. Beyond the shoreline the ground drops away into a
 * sea that is already deep at low water, so the strip of blue is on screen
 * from the moment the scene opens. From the shoreline inland the strand
 * climbs above low water. A full tide overtops the open beach; walls and
 * moats decide which parts remain sheltered.
 */
export function tideTerrainHeight(z: number, shoreZ: number) {
  if (z < shoreZ) {
    const t = smooth((shoreZ - z) / TIDE.seaRamp)
    return mix(TIDE.lowLevel, TIDE.seaFloor, t)
  }
  const t = smooth((z - shoreZ) / TIDE.beachRun)
  return mix(TIDE.lowLevel, TIDE.beachHeight, t)
}

/** The bed coordinate of the shoreline, derived from the camera so the coast
 *  is framed the same way on a wide window and on a narrow phone screen. */
export function shoreCoordinate(screenToBed: (x: number, y: number) => { x: number; y: number }, width: number, height: number) {
  const point = screenToBed(width * 0.5, height * TIDE.shoreScreenY)
  return clamp(point.y, -SAND.extent * 0.5 + 0.05, SAND.extent * 0.5 - 0.05)
}
