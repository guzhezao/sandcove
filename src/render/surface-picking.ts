import type { SandSolver } from '../simulation/solver'
import type { SandCamera } from './camera'

/** Throttled readback: at most one pending copy, no GPU wait in the frame loop. */
export class SurfacePicking {
  private readonly staging: GPUBuffer
  private pending = false
  private disposed = false
  private lastRead = -Infinity
  private generation = 0
  private readGeneration = 0
  private readonly solver: SandSolver
  private readonly camera: SandCamera
  constructor(solver: SandSolver, camera: SandCamera) {
    this.solver = solver; this.camera = camera
    this.staging = solver.device.createBuffer({ label: 'Terrain pointer picking', size: solver.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  }
  reset() { this.generation++; this.camera.clearSurface(); this.lastRead = -Infinity }
  encode(encoder: GPUCommandEncoder, now: number) {
    if (this.pending || this.disposed || now - this.lastRead < 160) return false
    this.pending = true
    this.readGeneration = this.generation
    this.lastRead = now
    encoder.copyBufferToBuffer(this.solver.state, 0, this.staging, 0, this.solver.byteLength)
    return true
  }
  async read() {
    try {
      await this.staging.mapAsync(GPUMapMode.READ)
      if (!this.disposed && this.readGeneration === this.generation) {
        const data = new Float32Array(this.staging.getMappedRange())
        const heights = new Float32Array(this.solver.resolution * this.solver.rows)
        for (let i = 0; i < heights.length; i++) heights[i] = data[i * 4]
        this.camera.setSurface(heights, this.solver.resolution)
      }
      this.staging.unmap()
    } catch (error) {
      if (!this.disposed) throw error
    } finally { this.pending = false }
  }
  dispose() { this.disposed = true; this.staging.destroy(); this.camera.clearSurface() }
}
