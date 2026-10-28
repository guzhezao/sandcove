import { EROSION } from './config'
import { TIDE, type TideMode } from './tide'

export type SandboxSettings = { waveHeight: number; surgeDepth: number; erosionStrength: number }
/** Keep the fixed challenge independent of remembered sandbox controls. */
export function environmentFor(mode: TideMode, sandbox: SandboxSettings) {
  return mode === 'tide'
    ? { waveHeight: .004, highLevel: TIDE.highLevel, erosionStrength: EROSION.strength }
    : { waveHeight: sandbox.waveHeight / 1000,
        highLevel: TIDE.beachHeight + sandbox.surgeDepth / 1000,
        erosionStrength: sandbox.erosionStrength }
}
