export const SAND = {
  resolution: 768, rows: 1152, extent: 1.2, length: 1.8, depth: 0.032, floor: -0.180,
  // Cohesive beach sand holds carved walls; flowing water erodes it separately.
  repose: 4.5, dynamicRepose: 4.0, rate: 32,
  step: 1 / 120, maxSteps: 4, radius: 0.012, indentation: 0.012,
  impactSpeedStart: 0.5, impactSpeedFull: 1.2, impactIndentation: 0.004,
  impactEvacuation: 0.86, impactEjectionFraction: 0.075,
  impactParticleMassMin: 0.0000012, impactParticleMassMax: 0.0000032,
  airborneGrainRadius: 0.00016, airborneReferenceMass: 0.000004,
  airborneShadowResolution: 512, airborneShadowStrength: 1.7,
  particles: 16384, maxContacts: 8,
  // Holding a tool in place keeps working instead of releasing a single
  // sample. The dwell term deepens a pit the longer it is held, so a tap and
  // a deliberate hold are not the same gesture.
  digDepthGain: 0.70, digDepthScaleMax: 1.7, maxDigDepth: 0.140, digDepthLimit: 0.180,
  // Stacking sand adds material at the contact patch and lets the existing
  // cohesive slope limit round its edge without flattening the whole mound.
  pileRate: 0.035, pileRadiusScale: 1.0, maxPileHeight: 0.075, pileHeightLimit: 0.120,
} as const

export const WATER = {
  resolution: 384,
  step: 1 / 60, maxSteps: 2,
  // Diffusive-wave flow: the transfer rate follows the difference between
  // neighbouring water surface elevations and is damped by a build-up time.
  flowRate: 62, responseTau: 0.048,
  // The coastal scene spans longer channels than the small pouring pools.
  // Keep one tide leg readable without changing free-play transport.
  tideFlowRate: 480, tideSubsteps: 8,
  mobilityDepth: 0.0006,
  pourRate: 0.08,
  maxDepth: 0.380,
  dryRate: 0.030, wetReference: 0.0008,
  velocityDamping: 5.5,
} as const

export const EROSION = {
  strength: 3,
  wetSlope: 0.18,
  bankReach: 0.008,
  bankRate: 6.5,
  bedload: 0.045,
  maxRate: 0.0080,
} as const

export const TOOL = {
  dig: 0,
  pile: 1,
  water: 2,
  mold: 3,
} as const

export type ToolMode = typeof TOOL[keyof typeof TOOL]

/**
 * How much deeper a held dig goes compared with a quick tap. Holding a tool
 * in place is a deliberate act, so the pit keeps going down instead of
 * stopping at the depth of the first frame.
 */
export const digDepthScale = (dwell: number) => {
  const seconds = Number.isFinite(dwell) && dwell > 0 ? dwell : 0
  return Math.min(1 + seconds * SAND.digDepthGain, SAND.digDepthScaleMax)
}

export type Point = { x: number; y: number }
export type Stroke = {
  from: Point
  to: Point
  velocity: Point
  radius: number
  pressure: number
  active: boolean
  /** Tool semantics for this contact. Defaults to digging when omitted. */
  mode?: ToolMode
  /** Seconds the pointer has been held down, used to deepen a dig. */
  dwell?: number
  /** Input pointer that produced this contact. */
  pointerId?: number
}
export const idleStroke = (): Stroke => ({
  from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, velocity: { x: 0, y: 0 },
  radius: SAND.radius, pressure: 0, active: false,
})
