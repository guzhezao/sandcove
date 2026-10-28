import { SAND } from '../src/config'
import { expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SandSolver } from '../src/simulation/solver'
import { WaterSolver } from '../src/simulation/water-solver'

Object.assign(globalThis, globals)
const gpu = create([])

// Independent gameplay property: an ocean boundary must not teleport water
// into inland holes or erase a trapped pool when the sea level falls.
test('tide follows an opened channel and drains it while isolated pools retain water', async () => {
  const adapter = await gpu.requestAdapter()
  expect(adapter).not.toBeNull()
  const device = await adapter!.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event: GPUUncapturedErrorEvent) => errors.push(event.error.message))
  const n = 16
  const sand = new SandSolver(device, n)
  const water = new WaterSolver(device, sand, n)
  const readback = device.createBuffer({ size: water.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  try {
    await water.initialize()
    const bed = new Float32Array(n * n * 4)
    const initial = new Float32Array(n * n * 4)
    const at = (x: number, y: number) => (y * n + x) * 4
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) bed[at(x, y)] = y < 3 ? 0.004 : 0.06
    for (let y = 3; y <= 14; y++) for (let x = 2; x <= 4; x++) bed[at(x, y)] = y === 5 ? 0.06 : 0.01
    for (let y = 8; y <= 11; y++) for (let x = 10; x <= 12; x++) {
      bed[at(x, y)] = 0.006
      initial[at(x, y)] = 0.012
    }
    for (let y = 4; y <= 6; y++) for (let x = 10; x <= 12; x++) bed[at(x, y)] = 0.006
    const uploadBed = () => { for (const buffer of sand.buffers) device.queue.writeBuffer(buffer, 0, bed) }
    uploadBed()
    for (const buffer of water.buffers) device.queue.writeBuffer(buffer, 0, initial)

    const advance = async (level: number, steps: number) => {
      water.writeParams([], 1 / 60, { shore: (3/16-.5)*SAND.extent, level, drift: 0 })
      for (let i = 0; i < steps; i++) {
        const encoder = device.createCommandEncoder()
        water.encode(encoder)
        device.queue.submit([encoder.finish()])
      }
      const encoder = device.createCommandEncoder()
      encoder.copyBufferToBuffer(water.state, 0, readback, 0, water.byteLength)
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ)
      const state = new Float32Array(readback.getMappedRange()).slice()
      readback.unmap()
      for (let i = 0; i < n * n; i++) expect(Number.isFinite(state[i * 4]) && state[i * 4]! >= 0).toBe(true)
      const average = (x0: number, x1: number, y0: number, y1: number) => {
        let sum = 0
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sum += state[at(x, y)]!
        return sum / ((x1 - x0 + 1) * (y1 - y0 + 1))
      }
      const result = { channel: average(2, 4, 9, 14), trapped: average(10, 12, 8, 11), dry: average(10, 12, 4, 6) }
      expect(result.trapped).toBeCloseTo(0.012, 5)
      expect(result.dry).toBeLessThan(1e-7)
      return result
    }

    const blocked = await advance(0.03, 900)
    expect(blocked.channel).toBeLessThan(1e-7)
    for (let x = 2; x <= 4; x++) bed[at(x, 5)] = 0.01
    uploadBed()
    const flooded = await advance(0.03, 900)
    expect(flooded.channel).toBeGreaterThan(0.003)
    const ebbed = await advance(0.005, 1800)
    expect(ebbed.channel).toBeLessThan(flooded.channel * 0.35)
    console.log('Independent tide boundary acceptance:', { blocked, flooded, ebbed })
    expect(errors).toEqual([])
  } finally {
    readback.destroy()
    water.dispose()
    sand.dispose()
    device.destroy()
  }
}, 30_000)

test('fast tidal water settles in an enclosed pool instead of oscillating between cells', async () => {
  const adapter = await gpu.requestAdapter()
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
      const i = (y * n + x) * 4
      const inside = x > 2 && x < 13 && y > 2 && y < 13
      bed[i] = inside ? 0.01 : 0.06
      initial[i] = inside ? 0.008 + (((x + y) % 2) ? 0.001 : -0.001) : 0
    }
    for (const buffer of sand.buffers) device.queue.writeBuffer(buffer, 0, bed)
    for (const buffer of water.buffers) device.queue.writeBuffer(buffer, 0, initial)
    // Enable the faster tidal transport, but put the sea beyond this closed basin.
    water.writeParams([], 1 / 60, { shore: -2, level: 0.024, drift: 0 })
    for (let batch = 0; batch < 10; batch++) {
      const encoder = device.createCommandEncoder()
      for (let i = 0; i < 60; i++) water.encode(encoder)
      device.queue.submit([encoder.finish()])
    }
    const encoder = device.createCommandEncoder()
    encoder.copyBufferToBuffer(water.state, 0, readback, 0, water.byteLength)
    device.queue.submit([encoder.finish()])
    await readback.mapAsync(GPUMapMode.READ)
    const state = new Float32Array(readback.getMappedRange())
    const depths: number[] = []
    for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) depths.push(state[(y * n + x) * 4]!)
    const spread = Math.max(...depths) - Math.min(...depths)
    console.log('Settled tidal pool depth spread:', spread)
    expect(spread).toBeLessThan(0.0001)
    expect(depths.reduce((a, b) => a + b, 0)).toBeCloseTo(0.8, 4)
    readback.unmap()
  } finally {
    readback.destroy()
    water.dispose()
    sand.dispose()
    device.destroy()
  }
}, 30_000)
