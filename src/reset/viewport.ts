import { SAND } from '../config'
import type { SandCamera } from '../render/camera'
import type { WaveResetViewport } from './effect'

export function waveResetViewport(camera: SandCamera): WaveResetViewport {
  // Intersect the visible area with the finite bed. Overview cameras include
  // background, where the reset wave must not continue travelling.
  const half = SAND.extent / 2
  const bound = (v: number) => Math.max(-half, Math.min(half, v))
  const bottomLeft = camera.screenToBed(0, 1, 1, 1)
  const bottomRight = camera.screenToBed(1, 1, 1, 1)
  const minX = Math.min(bottomLeft.x, bottomRight.x)
  const maxX = Math.max(bottomLeft.x, bottomRight.x)
  const nearY = Math.max(bottomLeft.y, bottomRight.y)
  return { minX: bound(minX), maxX: bound(maxX), nearY: Math.max(-half, Math.min(SAND.length-half, nearY)) }
}
