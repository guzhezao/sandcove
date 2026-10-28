import { expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SandSolver } from '../src/simulation/solver'
import { WaterSolver } from '../src/simulation/water-solver'

Object.assign(globalThis, globals)
// Keep Dawn's native owner alive for every asynchronous GPU operation.
const gpu = create([])

// Independent acceptance property: the same pool mirrored left/right must
// spread symmetrically. This catches dry-front direction bias, not a detail
// of the particular fluid implementation.
test('water wets a dry neighbour equally from either horizontal direction', async () => {
  const adapter = await gpu.requestAdapter()
  expect(adapter).not.toBeNull()
  const device = await adapter!.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event: GPUUncapturedErrorEvent) => errors.push(event.error.message))
  const sand = new SandSolver(device, 4)
  const water = new WaterSolver(device, sand, 2)
  const readback = device.createBuffer({ size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  try {
    // Use a fixed, explicitly populated bed to isolate water transport.
    // Full sand integration is covered by the existing GPU suite.
    await water.initialize()
    const bed = new Float32Array(4 * 4 * 4)
    for (let i = 0; i < 16; i++) bed[i * 4] = 0.032
    for (const buffer of sand.buffers) device.queue.writeBuffer(buffer, 0, bed)
    const run = async (wetColumn: number) => {
      water.reset()
      const initial = new Float32Array(16)
      initial[wetColumn * 4] = 0.01
      initial[(wetColumn + 2) * 4] = 0.01
      for (const buffer of water.buffers) device.queue.writeBuffer(buffer, 0, initial)
      water.writeParams([])
      for (let i = 0; i < 120; i++) {
        const encoder = device.createCommandEncoder()
        water.encode(encoder)
        device.queue.submit([encoder.finish()])
      }
      const encoder = device.createCommandEncoder()
      encoder.copyBufferToBuffer(water.state, 0, readback, 0, 64)
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ)
      const result = Array.from(new Float32Array(readback.getMappedRange()))
      readback.unmap()
      return [result[0]!, result[4]!, result[8]!, result[12]!]
    }
    const leftWet = await run(0)
    const rightWet = await run(1)
    console.log('Mirrored dry-front depths:', { leftWet, rightWet })
    for (const result of [leftWet, rightWet]) {
      expect(result.every((depth) => Number.isFinite(depth) && depth >= 0)).toBe(true)
      expect(result.reduce((a, b) => a + b, 0)).toBeCloseTo(0.02, 5)
    }
    expect(leftWet[1]).toBeGreaterThan(0.001)
    expect(rightWet[0]).toBeGreaterThan(0.001)
    expect(leftWet[0]).toBeCloseTo(rightWet[1]!, 5)
    expect(leftWet[1]).toBeCloseTo(rightWet[0]!, 5)
    expect(errors).toEqual([])
  } finally {
    readback.destroy()
    water.dispose()
    sand.dispose()
    device.destroy()
  }
}, 30_000)

test('a dry berm blocks water until an actual channel is opened through it', async () => {
  const adapter = await gpu.requestAdapter()
  expect(adapter).not.toBeNull()
  const device = await adapter!.requestDevice()
  const n = 16
  const sand = new SandSolver(device, n)
  const water = new WaterSolver(device, sand, n)
  const readback = device.createBuffer({ size: water.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  try {
    await water.initialize()
    const bed = new Float32Array(n * n * 4)
    const initial = new Float32Array(n * n * 4)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const offset = (y * n + x) * 4
      bed[offset] = x >= 6 && x <= 9 ? 0.04 : 0.01
      initial[offset] = x < 6 ? 0.015 : 0
    }
    for (const buffer of sand.buffers) device.queue.writeBuffer(buffer, 0, bed)
    for (const buffer of water.buffers) device.queue.writeBuffer(buffer, 0, initial)
    water.writeParams([])
    const advance = async (steps: number, expectedVolume = 16 * 6 * 0.015) => {
      for (let i = 0; i < steps; i++) {
        const encoder = device.createCommandEncoder()
        water.encode(encoder)
        device.queue.submit([encoder.finish()])
      }
      const encoder = device.createCommandEncoder()
      encoder.copyBufferToBuffer(water.state, 0, readback, 0, water.byteLength)
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ)
      const values = new Float32Array(readback.getMappedRange()).slice()
      readback.unmap()
      let rightVolume = 0
      let total = 0
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const depth = values[(y * n + x) * 4]!
        expect(Number.isFinite(depth) && depth >= 0).toBe(true)
        total += depth
        if (x >= 10) rightVolume += depth
      }
      expect(total).toBeCloseTo(expectedVolume, 4)
      return rightVolume
    }
    expect(await advance(180)).toBeLessThan(1e-7)
    for (let y = 7; y <= 8; y++) for (let x = 6; x <= 9; x++) bed[(y * n + x) * 4] = 0.009
    for (const buffer of sand.buffers) device.queue.writeBuffer(buffer, 0, bed)
    expect(await advance(600)).toBeGreaterThan(0.01)
    water.reset()
    expect(await advance(1, 0)).toBe(0)
  } finally {
    readback.destroy()
    water.dispose()
    sand.dispose()
    device.destroy()
  }
}, 30_000)
