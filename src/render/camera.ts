import { SAND, type Point } from '../config'

export type Vector3 = [number, number, number]
export function normalize(vector: Vector3): Vector3 {
  const length = Math.hypot(...vector)
  return vector.map((component) => component / length) as Vector3
}
export type CameraView = keyof typeof cameraViews
export const cameraViews = {
  original: [0, 1.55, 1.30],
  low: [0, 1.468, 1.70],
  top: [0, 2.2, 0],
  left: [-1.40, 1.528, 1.00],
  right: [1.40, 1.528, 1.00],
  reverse: [0, 1.528, -1.72],
} as const

export class SandCamera {
  eye: Vector3 = [cameraViews.original[0], cameraViews.original[1], cameraViews.original[2] + (SAND.length-SAND.extent)/2]
  forward = normalize([0, SAND.depth - this.eye[1], -cameraViews.original[2]])
  right: Vector3 = [1, 0, 0]
  up: Vector3 = [0, -this.forward[2], this.forward[1]]
  view: CameraView | 'custom' = 'original'
  target: Vector3 = [0, SAND.depth, (SAND.length-SAND.extent)/2]
  zoom = 1
  aspect = 1
  get distance() { return Math.hypot(...this.eye.map((v, i) => v - this.target[i])) }
  get tanHalfFov() {
    // Fit the whole finite bed in the shorter viewport dimension. A distant
    // eye keeps sand castles in a restrained, near-isometric perspective.
    return 0.62 * (Math.hypot(SAND.extent, SAND.length) / Math.SQRT2 / .8) / this.zoom / this.distance / Math.min(1, this.aspect)
  }
  setView(view: CameraView) {
    this.view = view
    this.eye = [cameraViews[view][0], cameraViews[view][1], cameraViews[view][2] + (SAND.length-SAND.extent)/2]
    this.target = [0, SAND.depth, (SAND.length-SAND.extent)/2]
    this.zoom = 1
    this.updateBasis()
  }
  orbit(dx: number, dy: number) {
    const distance = Math.max(1.7, this.distance)
    const oldDistance = this.distance
    const yaw = Math.atan2(this.eye[0] - this.target[0], this.eye[2] - this.target[2]) - dx * 0.006
    const pitch = Math.max(0.20, Math.min(1.52, Math.asin((this.eye[1] - this.target[1]) / oldDistance) + dy * 0.005))
    this.eye = [this.target[0] + distance * Math.cos(pitch) * Math.sin(yaw), this.target[1] + distance * Math.sin(pitch), this.target[2] + distance * Math.cos(pitch) * Math.cos(yaw)]
    this.view = 'custom'
    this.updateBasis()
  }
  dolly(amount: number) { this.zoom = Math.max(0.35, Math.min(2.6, this.zoom * Math.exp(amount))) }
  pan(dx: number, dy: number, viewportHeight: number) {
    const scale = 2 * this.distance * this.tanHalfFov / Math.max(1, viewportHeight)
    const offset: Vector3 = [-dx * this.right[0] * scale + dy * this.up[0] * scale, 0, -dx * this.right[2] * scale + dy * this.up[2] * scale]
    for (const axis of [0, 2]) {
      const bounded = Math.max(-0.28, Math.min(axis === 2 ? SAND.length-SAND.extent+.28 : .28, this.target[axis] + offset[axis]))
      this.eye[axis] += bounded - this.target[axis]
      this.target[axis] = bounded
    }
    this.view = 'custom'
  }
  private updateBasis() {
    this.forward = normalize(this.target.map((v, i) => v - this.eye[i]) as Vector3)
    const f = this.forward
    this.right = Math.abs(f[1]) > 0.9999 ? [1, 0, 0] : normalize([-f[2], 0, f[0]])
    const r = this.right
    this.up = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
  }
  private surface?: { heights: Float32Array; resolution: number; min: number; max: number }
  setSurface(heights: Float32Array, resolution: number) {
    let min = Infinity, max = -Infinity
    for (const h of heights) { min = Math.min(min, h); max = Math.max(max, h) }
    this.surface = { heights, resolution, min, max }
  }
  clearSurface() { this.surface = undefined }
  /** Pick the first visible sand surface, including raised walls and deep pits. */
  screenToSurface(clientX: number, clientY: number, width: number, height: number): Point {
    const surface = this.surface
    if (!surface) return this.screenToBed(clientX, clientY, width, height)
    const horizontal = (2 * clientX / width - 1) * this.tanHalfFov * this.aspect
    const vertical = (1 - 2 * clientY / height) * this.tanHalfFov
    const d = this.forward.map((v, axis) => v + horizontal * this.right[axis] + vertical * this.up[axis])
    const half = SAND.extent / 2
    let start = 0, end = Infinity
    for (const [axis, lo, hi] of [[0, -half, half], [1, surface.min - 0.001, surface.max + 0.001], [2, -half, SAND.length-half]]) {
      if (Math.abs(d[axis]) < 1e-9) {
        if (this.eye[axis] < lo || this.eye[axis] > hi) return this.screenToBed(clientX, clientY, width, height)
      } else {
        const a = (lo - this.eye[axis]) / d[axis], b = (hi - this.eye[axis]) / d[axis]
        start = Math.max(start, Math.min(a, b)); end = Math.min(end, Math.max(a, b))
      }
    }
    const sample = (x: number, z: number) => this.heightAt(x, z)
    const gap = (t: number) => this.eye[1] + d[1] * t - sample(this.eye[0] + d[0] * t, this.eye[2] + d[2] * t)
    const step = SAND.extent / surface.resolution * 0.5 / Math.max(0.25, Math.hypot(d[0], d[2]))
    let previous = start
    for (let t = start; t <= end + step; t += step) {
      const current = Math.min(t, end)
      if (gap(current) <= 0) {
        let lo = previous, hi = current
        for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (gap(mid) > 0) lo = mid; else hi = mid }
        return { x: this.eye[0] + d[0] * hi, y: this.eye[2] + d[2] * hi }
      }
      previous = current
    }
    return this.screenToBed(clientX, clientY, width, height)
  }
  heightAt(x: number, z: number) {
    const surface = this.surface
    if (!surface) return SAND.depth
      const n = surface.resolution
      const rows = surface.heights.length / n
      const gx = Math.max(0, Math.min(n - 1, (x / SAND.extent + 0.5) * n - 0.5))
      const gz = Math.max(0, Math.min(rows - 1, (z / SAND.extent + 0.5) * n - 0.5))
      const ix = Math.floor(gx), iz = Math.floor(gz), jx = Math.min(n - 1, ix + 1), jz = Math.min(rows - 1, iz + 1)
      const fx = gx - ix, fz = gz - iz, h = surface.heights
      return (h[iz * n + ix] * (1 - fx) + h[iz * n + jx] * fx) * (1 - fz)
        + (h[jz * n + ix] * (1 - fx) + h[jz * n + jx] * fx) * fz
    }
  project(x: number, height: number, z: number, width: number, viewportHeight: number): Point {
    const relative = [x - this.eye[0], height - this.eye[1], z - this.eye[2]]
    const dot = (v: Vector3) => v.reduce((sum, n, i) => sum + n * relative[i], 0)
    const distance = Math.max(.01, dot(this.forward))
    return {x:(dot(this.right)/(this.tanHalfFov*this.aspect*distance)+1)*width/2,
      y:(1-dot(this.up)/(this.tanHalfFov*distance))*viewportHeight/2}
  }
  screenToBed(clientX: number, clientY: number, width: number, height: number): Point {
    const horizontal = (2 * clientX / width - 1) * this.tanHalfFov * this.aspect
    const vertical = (1 - 2 * clientY / height) * this.tanHalfFov
    const direction = this.forward.map((component, axis) => component + horizontal * this.right[axis] + vertical * this.up[axis])
    const distance = (SAND.depth - this.eye[1]) / direction[1]
    return { x: this.eye[0] + direction[0] * distance, y: this.eye[2] + direction[2] * distance }
  }
}
