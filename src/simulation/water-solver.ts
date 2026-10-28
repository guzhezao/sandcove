import { SAND, TOOL, WATER, type Stroke } from '../config'
import { checkedShader } from '../platform/shader'
import type { SandSolver } from './solver'
import { waterShader } from './water-shaders'

const paramVectors = 4 + SAND.maxContacts * 3
const paramBytes = paramVectors * 16

export type TideBoundary = {
  /** The bed coordinate of the shoreline; the sea is everything beyond it. */
  shore: number
  /** The current tide level. */
  level: number
  /** How fast the sea surface is travelling, in metres per second. */
  drift: number
  waveTime?: number
  waveHeight?: number
  /** Positive shoreward advection for a coast-wide incoming bore. */
  surgeSpeed?: number
}

/**
 * Water that actually behaves like water: a real depth per cell, a surface
 * that follows the terrain, and transfers that are limited by the water a
 * cell owns. The solver owns no CPU mirror of the bed, so the 512² sand grid
 * never has to be read back.
 */
export class WaterSolver {
  readonly device: GPUDevice
  readonly resolution: number
  readonly rows: number
  readonly buffers: GPUBuffer[]
  readonly pipe: GPUBuffer
  readonly byteLength: number
  private readonly uniform: GPUBuffer
  private readonly sand: SandSolver
  private readonly data = new Float32Array(paramVectors * 4)
  private pipelines!: Record<'clear' | 'rates' | 'limits' | 'update', GPUComputePipeline>
  private groups: GPUBindGroup[][] = []
  private current = 0
  private generation = 0
  private substeps = 1
  activePourContacts: readonly Stroke[] = []

  constructor(device: GPUDevice, sand: SandSolver, resolution: number = WATER.resolution) {
    this.device = device
    this.sand = sand
    this.resolution = resolution
    this.rows = Math.round(resolution * sand.rows / sand.resolution)
    this.byteLength = resolution * this.rows * 16
    this.buffers = [0, 1].map((index) => device.createBuffer({
      label: `Water state ${index}`, size: this.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    }))
    this.pipe = device.createBuffer({ label: 'Water pipe rates and limits', size: this.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.uniform = device.createBuffer({ label: 'Water parameters', size: paramBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  get state() { return this.buffers[this.current] }
  get stateIndex() { return this.current }
  get revision() { return this.generation }

  async initialize() {
    const module = await checkedShader(this.device, 'Shallow water WGSL', waterShader)
    const layout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ] })
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] })
    const make = (entryPoint: string) => this.device.createComputePipelineAsync({ label: entryPoint, layout: pipelineLayout, compute: { module, entryPoint } })
    const [clear, rates, limits, update] = await Promise.all([make('clear'), make('rates'), make('limits'), make('update')])
    this.pipelines = { clear, rates, limits, update }
    this.groups = this.buffers.map((buffer, index) => this.sand.buffers.map((bed) => this.device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: this.uniform } },
      { binding: 1, resource: { buffer: bed } },
      { binding: 2, resource: { buffer } },
      { binding: 3, resource: { buffer: this.buffers[1 - index] } },
      { binding: 4, resource: { buffer: this.pipe } },
    ] })))
    this.reset()
  }

  /**
   * Publishes the pouring contacts, the fixed step used by the solver and the
   * sea boundary. Without a tide the solver behaves exactly as it did in the
   * free play mode.
   */
  writeParams(contacts: readonly Stroke[], step: number = WATER.step, tide?: TideBoundary) {
    const active = contacts
      .filter((stroke) => stroke.active && stroke.pressure > 0 && (stroke.mode ?? TOOL.dig) === TOOL.water)
      .slice(0, SAND.maxContacts)
    this.activePourContacts = active
    this.substeps = tide ? WATER.tideSubsteps : 1
    this.data.fill(0)
    this.data.set([
      this.resolution, SAND.extent / this.resolution, SAND.extent, step / this.substeps,
      this.sand.resolution, SAND.extent / this.sand.resolution, SAND.extent, tide?.waveTime ?? 0,
      active.length, WATER.pourRate, tide?.waveHeight ?? 0, tide?.surgeSpeed ?? 0,
      tide ? 1 : 0, tide?.shore ?? 0, tide?.level ?? 0, tide?.drift ?? 0,
    ])
    active.forEach((stroke, index) => {
      const offset = 16 + index * 12
      this.data.set([stroke.from.x, stroke.from.y, stroke.radius, stroke.pressure], offset)
      this.data.set([stroke.to.x, stroke.to.y, 1, TOOL.water], offset + 4)
      this.data.set([0, 0, 0, 0], offset + 8)
    })
    this.device.queue.writeBuffer(this.uniform, 0, this.data)
    return active.length
  }

  reset() {
    this.writeParams([])
    const encoder = this.device.createCommandEncoder()
    this.encodeClear(encoder)
    this.device.queue.submit([encoder.finish()])
  }

  encodeClear(encoder: GPUCommandEncoder) {
    const pass = encoder.beginComputePass({ label: 'Water clear' })
    pass.setPipeline(this.pipelines.clear)
    const groups = Math.ceil(this.resolution / 8)
    for (const group of this.groups) {
      pass.setBindGroup(0, group[0])
      pass.dispatchWorkgroups(groups, Math.ceil(this.rows / 8))
      pass.setBindGroup(0, group[1])
      pass.dispatchWorkgroups(groups, Math.ceil(this.rows / 8))
    }
    pass.end()
    this.generation++
  }

  /**
   * Advances the water by one fixed step against the current sand bed. The
   * three passes are ordered inside a single compute pass, so the bed read in
   * the rate pass is the bed the update pass reacts to.
   */
  encode(encoder: GPUCommandEncoder, bedIndex: number = this.sand.stateIndex) {
    const groups = Math.ceil(this.resolution / 8)
    const pass = encoder.beginComputePass({ label: 'Shallow water transport' })
    // Faster coastal transport needs shorter integration steps to avoid
    // checkerboard oscillation in shallow or enclosed pools.
    for (let step = 0; step < this.substeps; step++) {
      pass.setBindGroup(0, this.groups[this.current][bedIndex])
      pass.setPipeline(this.pipelines.rates)
      pass.dispatchWorkgroups(groups, Math.ceil(this.rows / 8))
      pass.setPipeline(this.pipelines.limits)
      pass.dispatchWorkgroups(groups, Math.ceil(this.rows / 8))
      pass.setPipeline(this.pipelines.update)
      pass.dispatchWorkgroups(groups, Math.ceil(this.rows / 8))
      this.current = 1 - this.current
    }
    pass.end()
    this.generation++
  }

  dispose() { [...this.buffers, this.pipe, this.uniform].forEach((buffer) => buffer.destroy()) }
}
