import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SAND, idleStroke, type Stroke } from '../src/config'
import { SandSolver } from '../src/simulation/solver'
import { WaterSolver } from '../src/simulation/water-solver'
import { AirborneShadow } from '../src/render/airborne-shadow'
import { SandRenderer } from '../src/render/renderer'
import { BedLighting } from '../src/render/lighting'

let device: GPUDevice
let gpu: GPU
const errors: string[] = []

beforeAll(async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('GPU tests require hardware WebGPU access; run outside the filesystem sandbox.')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
})
afterAll(() => { device?.destroy() })

async function readState(solver: SandSolver) {
  const staging = device.createBuffer({ size: solver.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(solver.state, 0, staging, 0, solver.byteLength)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const values = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap(); staging.destroy()
  return values
}
function volume(state: Float32Array) {
  let sum = 0
  for (let index = 0; index < state.length; index += 4) sum += state[index]
  return sum
}
async function readParticles(solver: SandSolver) {
  const size = solver.particleCount * 32
  const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(solver.particles, 0, staging, 0, size)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const values = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap(); staging.destroy()
  return values
}
async function particleMass(solver: SandSolver) {
  const values = await readParticles(solver)
  let total = 0
  for (let index = 3; index < values.length; index += 8) total += values[index]
  return total
}
function step(solver: SandSolver, stroke: Stroke, count: number) {
  for (let index = 0; index < count; index++) {
    const encoder = device.createCommandEncoder()
    solver.encode(encoder, [[stroke]])
    device.queue.submit([encoder.finish()])
  }
}

test('a shovel removes a groove without a raised ring, then settles conservatively', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const stroke: Stroke = { from: { x: -0.06, y: 0 }, to: { x: 0.06, y: 0 }, velocity: { x: 0.45, y: 0 }, radius: 0.050, pressure: 0.8, active: true }
    step(solver, stroke, 80)
    const pressed = await readState(solver)
    const airborne = await particleMass(solver)
    expect(airborne).toBeGreaterThan(0)
    expect(volume(pressed) + airborne).toBeLessThan(volume(initial) - 0.05)
    let deepest = 0
    let highest = 0
    for (let index = 0; index < pressed.length; index += 4) {
      expect(Number.isFinite(pressed[index])).toBe(true)
      expect(pressed[index]).toBeGreaterThanOrEqual(SAND.floor - 1e-6)
      deepest = Math.max(deepest, initial[index] - pressed[index])
      highest = Math.max(highest, pressed[index] - initial[index])
    }
    expect(deepest).toBeGreaterThan(0.004)
    expect(highest).toBeLessThan(0.001)
    step(solver, idleStroke(), 360)
    const settled = await readState(solver)
    expect(Math.abs((volume(settled) + await particleMass(solver)) / (volume(pressed) + airborne) - 1)).toBeLessThan(0.000004)
    const center = ((SAND.resolution / 2) * SAND.resolution + SAND.resolution / 2) * 4
    expect(settled[center]).toBeLessThan(SAND.depth - 0.002)
    step(solver, idleStroke(), 120)
    const later = await readState(solver)
    let drift = 0
    for (let index = 0; index < later.length; index += 4) drift = Math.max(drift, Math.abs(later[index] - settled[index]))
    expect(drift).toBeLessThan(0.00015)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test.each([0, 16, 31])('eight-neighbor transport conserves a pile at grid coordinate %s', async (coordinate) => {
  const solver = new SandSolver(device, 32)
  await solver.initialize()
  try {
    const initial = new Float32Array(32 * 32 * 4)
    for (let index = 0; index < initial.length; index += 4) initial[index] = SAND.floor
    // Deliberately exceed the cohesive angle so all eight links transfer mass.
    initial[(coordinate * 32 + coordinate) * 4] = SAND.floor + SAND.repose * (SAND.extent / 32) * Math.SQRT2 + 0.05
    device.queue.writeBuffer(solver.state, 0, initial)
    step(solver, idleStroke(), 1)
    const transported = await readState(solver)
    const direction = coordinate === 31 ? -1 : 1
    const diagonal = ((coordinate + direction) * 32 + coordinate + direction) * 4
    expect(transported[diagonal]).toBeGreaterThan(SAND.floor + 0.001 - 1e-6)
    if (coordinate === 16) {
      for (const [horizontal, vertical] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        expect(transported[((coordinate + vertical) * 32 + coordinate + horizontal) * 4]).toBeCloseTo(transported[diagonal], 7)
      }
    }
    step(solver, idleStroke(), 120)
    const settled = await readState(solver)
    for (let index = 0; index < settled.length; index += 4) {
      expect(Number.isFinite(settled[index])).toBe(true)
      expect(settled[index]).toBeGreaterThanOrEqual(SAND.floor - 1e-7)
    }
    expect(Math.abs((volume(settled) + await particleMass(solver)) / volume(initial) - 1)).toBeLessThan(0.000002)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test.each([-0.1, 0, 0.1])('grain impacts respect slope %s and return their mass to the bed', async (slope) => {
  const solver = new SandSolver(device, 32)
  await solver.initialize()
  try {
    const initial = new Float32Array(32 * 32 * 4)
    for (let row = 0; row < 32; row++) {
      for (let column = 0; column < 32; column++) {
        initial[(row * 32 + column) * 4] = 0.08 + slope * ((column + 0.5) * SAND.extent / 32 - SAND.extent / 2)
      }
    }
    device.queue.writeBuffer(solver.state, 0, initial)
    device.queue.writeBuffer(solver.particles, 0, new Float32Array([0, 0.0802, 0, 0.000004, 0, -0.2, 0, 0]))
    step(solver, idleStroke(), 1)
    const grains = await readParticles(solver)
    expect(grains[3]).toBeCloseTo(0.000004, 9)
    expect(grains[5]).toBeGreaterThan(0)
    expect(grains[4]).toBeCloseTo(-slope * grains[5], 6)
    expect(Math.hypot(grains[4], grains[5], grains[6])).toBeLessThan(0.2 + 9.81 * SAND.step)
    expect(grains[1]).toBeCloseTo(0.08018, 6)
    step(solver, idleStroke(), 120)
    expect(await particleMass(solver)).toBe(0)
    expect(Math.abs(volume(await readState(solver)) - volume(initial) - 0.000004)).toBeLessThan(1e-7)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a fast settled-bed impact immediately cuts deeper and ejects from the advancing frontier', async () => {
  const slow = new SandSolver(device, 128)
  const fast = new SandSolver(device, 128)
  await Promise.all([slow.initialize(), fast.initialize()])
  try {
    const slowInitial = await readState(slow)
    const fastInitial = await readState(fast)
    const base = { from: { x: -0.055, y: 0 }, to: { x: 0.055, y: 0 }, radius: 0.050, pressure: 0.82, active: true }
    step(slow, { ...base, velocity: { x: 0.08, y: 0 } }, 1)
    step(fast, { ...base, velocity: { x: 1.1, y: 0 } }, 1)
    const slowState = await readState(slow)
    const fastState = await readState(fast)
    const fastGrains = await readParticles(fast)
    let slowDepth = 0
    let fastDepth = 0
    for (let index = 0; index < slowState.length; index += 4) {
      slowDepth = Math.max(slowDepth, slowInitial[index] - slowState[index])
      fastDepth = Math.max(fastDepth, fastInitial[index] - fastState[index])
      expect(fastState[index]).toBeGreaterThanOrEqual(SAND.floor - 1e-6)
    }
    let airborne = 0
    let forwardParticles = 0
    let forwardMomentum = 0
    let totalParticles = 0
    for (let index = 0; index < fastGrains.length; index += 8) {
      if (fastGrains[index + 3] <= 0) continue
      airborne += fastGrains[index + 3]
      totalParticles++
      if (fastGrains[index] > base.to.x - base.radius * 0.35) forwardParticles++
      forwardMomentum += fastGrains[index + 4]
    }
    expect(fastDepth).toBeGreaterThan(slowDepth * 1.05)
    expect(airborne).toBeGreaterThan(0)
    expect(totalParticles).toBeGreaterThan(0)
    expect(forwardParticles / totalParticles).toBeGreaterThan(0.65)
    expect(forwardMomentum).toBeGreaterThan(0)
    expect(volume(fastState) + airborne).toBeLessThan(volume(fastInitial))
    expect(errors).toEqual([])
  } finally { slow.dispose(); fast.dispose() }
})

test('fast impact builds a sustained centimeter-scale ballistic spray before redepositing', async () => {
  const solver = new SandSolver(device, 128)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const stroke: Stroke = {
      from: { x: -0.055, y: 0 }, to: { x: 0.055, y: 0 }, velocity: { x: 1.1, y: 0 },
      radius: 0.050, pressure: 0.82, active: true,
    }
    step(solver, stroke, 6)
    const state = await readState(solver)
    const grains = await readParticles(solver)
    let count = 0
    let elevated = 0
    let airborne = 0
    let maximumHeight = -Infinity
    let forwardMomentum = 0
    for (let index = 0; index < grains.length; index += 8) {
      const mass = grains[index + 3]
      if (mass <= 0) continue
      count++
      airborne += mass
      maximumHeight = Math.max(maximumHeight, grains[index + 1])
      if (grains[index + 1] > SAND.depth + 0.004) elevated++
      forwardMomentum += grains[index + 4]
    }
    expect(count).toBeGreaterThan(100)
    expect(elevated).toBeGreaterThan(count * 0.08)
    expect(maximumHeight).toBeGreaterThan(SAND.depth + 0.008)
    expect(forwardMomentum).toBeGreaterThan(0)
    expect(volume(state) + airborne).toBeLessThan(volume(initial))
    step(solver, idleStroke(), 180)
    expect(await particleMass(solver)).toBeLessThan(airborne * 0.02)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('gesture speed changes shovel momentum and airborne mass while removing sand', async () => {
  const slow = new SandSolver(device, 128)
  const fast = new SandSolver(device, 128)
  await Promise.all([slow.initialize(), fast.initialize()])
  try {
    const slowInitial = await readState(slow)
    const fastInitial = await readState(fast)
    const base = { from: { x: -0.055, y: 0 }, to: { x: 0.055, y: 0 }, radius: 0.050, pressure: 0.82, active: true }
    step(slow, { ...base, velocity: { x: 0.08, y: 0 } }, 18)
    step(fast, { ...base, velocity: { x: 1.1, y: 0 } }, 18)
    const slowState = await readState(slow)
    const fastState = await readState(fast)
    const slowAirborne = await particleMass(slow)
    const fastAirborne = await particleMass(fast)
    let slowMomentum = 0
    let fastMomentum = 0
    for (let index = 0; index < slowState.length; index += 4) {
      slowMomentum += Math.hypot(slowState[index + 2], slowState[index + 3])
      fastMomentum += Math.hypot(fastState[index + 2], fastState[index + 3])
    }
    expect(fastMomentum).toBeGreaterThan(slowMomentum * 1.15)
    expect(fastAirborne).toBeGreaterThan(slowAirborne)
    expect(volume(slowState) + slowAirborne).toBeLessThan(volume(slowInitial))
    expect(volume(fastState) + fastAirborne).toBeLessThan(volume(fastInitial))
    expect(errors).toEqual([])
  } finally { slow.dispose(); fast.dispose() }
})

test('inactive cursor position cannot influence the bed', async () => {
  const left = new SandSolver(device, 64)
  const right = new SandSolver(device, 64)
  await Promise.all([left.initialize(), right.initialize()])
  try {
    const inactive = (x: number): Stroke => ({
      from: { x, y: 0 }, to: { x, y: 0 }, velocity: { x: 0, y: 0 },
      radius: 0.018, pressure: 1, active: false,
    })
    step(left, inactive(-0.12), 30)
    step(right, inactive(0.12), 30)
    const leftState = await readState(left)
    const rightState = await readState(right)
    let difference = 0
    for (let index = 0; index < leftState.length; index++) difference = Math.max(difference, Math.abs(leftState[index] - rightState[index]))
    expect(difference).toBeLessThan(1e-7)
    expect(errors).toEqual([])
  } finally { left.dispose(); right.dispose() }
})

test('horizon lighting leaves planes open, occludes trenches, and refreshes after reset and paired steps', async () => {
  const solver = new SandSolver(device, 64)
  await solver.initialize()
  const uniform = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const lighting = new BedLighting(device, solver, uniform)
  const staging = device.createBuffer({ size: solver.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const view = new Float32Array(28)
  view.set([1, 0.65, 0, 0, 64, SAND.extent, 256, 192], 16)
  device.queue.writeBuffer(uniform, 0, view)
  async function readLighting(angle: number) {
    const encoder = device.createCommandEncoder()
    lighting.encode(encoder, angle)
    encoder.copyBufferToBuffer(lighting.buffer, 0, staging, 0, solver.byteLength)
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const result = new Float32Array(staging.getMappedRange()).slice()
    staging.unmap()
    for (const value of result) expect(Number.isFinite(value)).toBe(true)
    return result
  }
  try {
    await lighting.initialize()
    const state = new Float32Array(64 * 64 * 4)
    for (let row = 0; row < 64; row++) {
      for (let column = 0; column < 64; column++) state[(row * 64 + column) * 4] = 0.08 + column * 0.001
    }
    device.queue.writeBuffer(solver.state, 0, state)
    const center = (32 * 64 + 32) * 4
    const plane = await readLighting(0)
    expect(plane[center]).toBeCloseTo(1, 5)
    expect(plane[center + 1]).toBeCloseTo(1, 5)
    for (let row = 0; row < 64; row++) {
      for (let column = 0; column < 64; column++) state[(row * 64 + column) * 4] = Math.abs(column - 32) <= 1 ? 0.03 : 0.08
    }
    device.queue.writeBuffer(solver.state, 0, state)
    const trench = await readLighting(1)
    expect(trench[center]).toBeLessThan(0.2)
    expect(trench[center + 1]).toBeLessThan(0.8)
    const revision = solver.revision
    const stateIndex = solver.stateIndex
    step(solver, { ...idleStroke(), active: true, pressure: 0.75, radius: 0.04, from: { x: 0.00625, y: 0.00625 }, to: { x: 0.00625, y: 0.00625 } }, 2)
    expect(solver.stateIndex).toBe(stateIndex)
    expect(solver.revision).toBe(revision + 2)
    const changed = await readLighting(1)
    expect(changed[center + 1]).not.toBe(trench[center + 1])
    solver.reset()
    const reset = await readLighting(1)
    expect(reset[center]).toBeGreaterThan(0.99)
    expect(reset[center + 1]).toBeGreaterThan(0.99)
    expect(errors).toEqual([])
  } finally { lighting.dispose(); uniform.destroy(); staging.destroy(); solver.dispose() }
})

test('airborne grains build a nonzero collective optical-depth shadow', async () => {
  const solver = new SandSolver(device, 32)
  await solver.initialize()
  const shadow = new AirborneShadow(device, solver)
  const resolution = SAND.airborneShadowResolution
  const bytesPerRow = resolution * 4
  const staging = device.createBuffer({ size: bytesPerRow * resolution, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  try {
    await shadow.initialize()
    const particles = new Float32Array(64 * 8)
    for (let index = 0; index < 64; index++) {
      const offset = index * 8
      particles[offset] = (index % 8 - 3.5) * 0.001
      particles[offset + 1] = SAND.depth + 0.028
      particles[offset + 2] = (Math.floor(index / 8) - 3.5) * 0.001
      particles[offset + 3] = SAND.airborneReferenceMass
    }
    device.queue.writeBuffer(solver.particles, 0, particles)
    const encoder = device.createCommandEncoder()
    shadow.encode(encoder, [1, 0.65, 0])
    encoder.copyTextureToBuffer({ texture: shadow.texture }, { buffer: staging, bytesPerRow }, [resolution, resolution])
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const pixels = new Uint8Array(staging.getMappedRange())
    let maximum = 0
    for (let index = 0; index < pixels.length; index += 4) maximum = Math.max(maximum, pixels[index])
    staging.unmap()
    expect(maximum).toBeGreaterThan(10)
    expect(errors).toEqual([])
  } finally { shadow.dispose(); solver.dispose(); staging.destroy() }
})

test('surface pipeline compiles and renders nonuniform opaque pixels offscreen', async () => {
  const solver = new SandSolver(device, 128)
  await solver.initialize()
  const water = new WaterSolver(device, solver, 128)
  await water.initialize()
  const renderer = new SandRenderer(device, solver, water, 'rgba8unorm')
  const texture = device.createTexture({ size: [256, 192], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  const staging = device.createBuffer({ size: 256 * 192 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  try {
    await renderer.initialize()
    renderer.resize(256, 192)
    step(solver, { from: { x: -0.07, y: 0 }, to: { x: 0.07, y: 0 }, velocity: { x: 0.5, y: 0 }, radius: 0.022, pressure: 1, active: true }, 100)
    device.pushErrorScope('validation')
    const encoder = device.createCommandEncoder()
    renderer.encode(encoder, texture.createView(), idleStroke(), 0)
    encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: 1024 }, [256, 192])
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const pixels = new Uint8Array(staging.getMappedRange())
    let minimum = 255; let maximum = 0
    for (let index = 0; index < pixels.length; index += 4) {
      minimum = Math.min(minimum, pixels[index]); maximum = Math.max(maximum, pixels[index])
      expect(pixels[index + 3]).toBe(255)
    }
    expect(maximum - minimum).toBeGreaterThan(5)
    expect(minimum).toBeGreaterThan(20)
    staging.unmap()
    expect(await device.popErrorScope()).toBeNull()
    expect(errors).toEqual([])
  } finally { renderer.dispose(); solver.dispose(); water.dispose(); texture.destroy(); staging.destroy() }
})


test('one quick pointer sweep cuts a continuous channel instead of disconnected pits', async () => {
  const {StrokeQueue} = await import('../src/input/strokes')
  const solver = new SandSolver(device, 128)
  try {
    await solver.initialize()
    solver.resetWithTerrain(()=>SAND.depth)
    solver.setToolHeights(.060,.056)
    const queue = new StrokeQueue()
    queue.radius=.020
    queue.begin({x:-.10,y:.003125},.75,1000)
    queue.move({x:.10,y:.003125},.75,1300)
    queue.end()
    for(let i=0;i<5;i++) {
      const e=device.createCommandEncoder();solver.encode(e,[queue.nextBatch(1400)])
      device.queue.submit([e.finish()])
    }
    const state=await readState(solver)
    for(let x=Math.ceil((-.09/SAND.extent+.5)*128);x<Math.floor((.09/SAND.extent+.5)*128);x++) expect(state[(64*128+x)*4]).toBeLessThan(SAND.depth-.020)
    for(let i=0;i<state.length;i+=4) expect(state[i]).toBeLessThan(SAND.depth+.001)
    expect(errors).toEqual([])
  } finally {solver.dispose()}
})
