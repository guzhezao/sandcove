import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SAND, TOOL, type Stroke } from '../src/config'
import { SandSolver } from '../src/simulation/solver'
import { WaterSolver } from '../src/simulation/water-solver'

let device: GPUDevice
// The Dawn instance has to stay referenced for the whole file: a local
// instance inside the hook can be collected while the device is still live.
let gpu: GPU
const errors: string[] = []

beforeAll(async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('Water tests require hardware WebGPU access.')
  device = await adapter!.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
})
afterAll(() => { device?.destroy() })

type Rig = { sand: SandSolver; water: WaterSolver; bed: Float32Array }

async function makeRig(bedResolution: number, waterResolution: number, bed: (x: number, y: number) => number, initSand = false): Promise<Rig> {
  const sand = new SandSolver(device, bedResolution)
  if (initSand) await sand.initialize()
  const water = new WaterSolver(device, sand, waterResolution)
  await water.initialize()
  const heights = new Float32Array(bedResolution * bedResolution * 4)
  for (let y = 0; y < bedResolution; y++) {
    for (let x = 0; x < bedResolution; x++) {
      heights[(y * bedResolution + x) * 4] = bed(x, y)
    }
  }
  for (const buffer of sand.buffers) device.queue.writeBuffer(buffer, 0, heights)
  return { sand, water, bed: heights }
}

async function readWater(water: WaterSolver, resolution: number) {
  const size = resolution * resolution * 16
  const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(water.state, 0, staging, 0, size)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const values = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap(); staging.destroy()
  const depths: number[] = []
  const wetness: number[] = []
  for (let index = 0; index < values.length; index += 4) {
    depths.push(values[index])
    wetness.push(values[index + 3])
  }
  return { depths, wetness }
}

async function readSand(sand: SandSolver) {
  const staging = device.createBuffer({ size: sand.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(sand.state, 0, staging, 0, sand.byteLength)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const values = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap(); staging.destroy()
  return values
}

function runWater(water: WaterSolver, steps: number, contacts: readonly Stroke[] = []) {
  water.writeParams(contacts)
  for (let index = 0; index < steps; index++) {
    const encoder = device.createCommandEncoder()
    water.encode(encoder)
    device.queue.submit([encoder.finish()])
  }
}

function cellWorld(resolution: number, x: number, y: number) {
  return {
    x: ((x + 0.5) / resolution - 0.5) * SAND.extent,
    y: ((y + 0.5) / resolution - 0.5) * SAND.extent,
  }
}

function runSand(sand: SandSolver, stroke: Stroke, steps: number) {
  for (let index = 0; index < steps; index++) {
    const encoder = device.createCommandEncoder()
    sand.encode(encoder, [[stroke]])
    device.queue.submit([encoder.finish()])
  }
}

test('water depth never goes negative and the volume is conserved', async () => {
  const rig = await makeRig(16, 8, () => 0.032)
  try {
    const initial = new Float32Array(rig.water.buffers[0] ? 0 : 0)
    void initial
    const seeded = new Float32Array(8 * 8 * 4)
    for (let index = 0; index < 8 * 8; index++) {
      seeded[index * 4] = index % 3 === 0 ? 0.004 : 0
    }
    for (const buffer of rig.water.buffers) device.queue.writeBuffer(buffer, 0, seeded)
    const before = (await readWater(rig.water, 8)).depths.reduce((sum, value) => sum + value, 0)
    runWater(rig.water, 300)
    const { depths } = await readWater(rig.water, 8)
    expect(depths.every((depth) => Number.isFinite(depth) && depth >= 0)).toBe(true)
    const after = depths.reduce((sum, value) => sum + value, 0)
    expect(after).toBeCloseTo(before, 6)
    expect(errors).toEqual([])
  } finally { rig.water.dispose(); rig.sand.dispose() }
})

test('a berm higher than the water line blocks the flow until it is opened', async () => {
  // A four column row: low, low, berm, low.
  const rig = await makeRig(8, 4, (x) => (x >= 4 && x < 6 ? 0.06 : 0.02))
  try {
    const seeded = new Float32Array(4 * 4 * 4)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 2; x++) seeded[(y * 4 + x) * 4] = 0.02
    }
    for (const buffer of rig.water.buffers) device.queue.writeBuffer(buffer, 0, seeded)
    runWater(rig.water, 240)
    const blocked = (await readWater(rig.water, 4)).depths
    const farSide = blocked.filter((_, index) => index % 4 >= 2)
    expect(farSide.every((depth) => depth === 0)).toBe(true)
    expect(blocked.filter((_, index) => index % 4 < 2).every((depth) => depth > 0.005)).toBe(true)

    // Lower the berm under the water line and the pool finds its way through.
    const lowered = new Float32Array(8 * 8 * 4)
    for (let i = 0; i < 64; i++) lowered[i * 4] = 0.02
    for (let y = 0; y < 8; y++) {
      for (let x = 4; x < 6; x++) lowered[(y * 8 + x) * 4] = 0.03
    }
    for (const buffer of rig.sand.buffers) device.queue.writeBuffer(buffer, 0, lowered)
    const carried = new Float32Array(4 * 4 * 4)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 2; x++) carried[(y * 4 + x) * 4] = 0.02
    }
    for (const buffer of rig.water.buffers) device.queue.writeBuffer(buffer, 0, carried)
    runWater(rig.water, 300)
    const opened = (await readWater(rig.water, 4)).depths
    const past = opened.filter((_, index) => index % 4 >= 2)
    expect(past.some((depth) => depth > 0.001)).toBe(true)
    expect(errors).toEqual([])
  } finally { rig.water.dispose(); rig.sand.dispose() }
})

test('water poured into one pit travels through a channel into the other pit', async () => {
  // Two basins joined by a narrow channel, everything else is high ground.
  const basin = (x: number) => (x >= 2 && x <= 4) || (x >= 12 && x <= 14)
  const channel = (x: number, y: number) => y >= 6 && y <= 9 && x >= 2 && x <= 14
  const rig = await makeRig(16, 8, (x, y) => {
    if (channel(x, y)) return 0.02
    if (basin(x) && (y >= 5 && y <= 10)) return 0.012
    return 0.05
  })
  try {
    const source = cellWorld(8, 1, 3)
    const pour: Stroke = {
      from: source, to: source, velocity: { x: 0, y: 0 },
      radius: 0.02, pressure: 1, active: true, mode: TOOL.water,
    }
    let arrivalStep = -1
    for (let step = 0; step < 420; step++) {
      runWater(rig.water, 1, [pour])
      if (arrivalStep < 0) {
        const { depths } = await readWater(rig.water, 8)
        if (depths[3 * 8 + 6] > 0.0002) arrivalStep = step
      }
    }
    const { depths } = await readWater(rig.water, 8)
    const leftPit = depths[3 * 8 + 1]
    const rightPit = depths[3 * 8 + 6]
    expect(leftPit).toBeGreaterThan(0.0005)
    expect(rightPit).toBeGreaterThan(0.0002)
    // The guided scene has to show the water arriving while people watch.
    expect(arrivalStep).toBeGreaterThanOrEqual(0)
    expect(arrivalStep * (1 / 60)).toBeLessThan(15)
    const total = depths.reduce((sum, value) => sum + value, 0)
    expect(total).toBeGreaterThan(0)
    expect(depths.every((depth) => Number.isFinite(depth) && depth >= 0)).toBe(true)
    expect(errors).toEqual([])
  } finally { rig.water.dispose(); rig.sand.dispose() }
})

test('a reset leaves no water and no wet sand behind', async () => {
  const rig = await makeRig(16, 8, () => 0.032)
  try {
    const source = cellWorld(8, 4, 4)
    const pour: Stroke = {
      from: source, to: source, velocity: { x: 0, y: 0 },
      radius: 0.02, pressure: 1, active: true, mode: TOOL.water,
    }
    runWater(rig.water, 120, [pour])
    const wet = await readWater(rig.water, 8)
    expect(wet.depths.some((depth) => depth > 0)).toBe(true)
    expect(wet.wetness.some((value) => value > 0)).toBe(true)
    rig.water.reset()
    const cleared = await readWater(rig.water, 8)
    expect(cleared.depths.every((depth) => depth === 0)).toBe(true)
    expect(cleared.wetness.every((value) => value === 0)).toBe(true)
    expect(errors).toEqual([])
  } finally { rig.water.dispose(); rig.sand.dispose() }
})

test('pouring adds water that pools in a basin and wets the ground around it', async () => {
  // A shallow basin in the middle of dry high ground.
  const rig = await makeRig(128, 64, (x, y) => {
    const inside = x >= 52 && x <= 76 && y >= 52 && y <= 76
    return inside ? 0.02 : 0.05
  })
  try {
    const source = cellWorld(64, 32, 32)
    const pour: Stroke = {
      from: source, to: source, velocity: { x: 0, y: 0 },
      radius: 0.02, pressure: 1, active: true, mode: TOOL.water,
    }
    runWater(rig.water, 240, [pour])
    const { depths, wetness } = await readWater(rig.water, 64)
    const centre = depths[32 * 64 + 32]
    expect(centre).toBeGreaterThan(0.0005)
    expect(wetness[32 * 64 + 32]).toBeGreaterThan(0.5)
    expect(wetness[32 * 64 + 33]).toBeGreaterThan(0)
    const total = depths.reduce((sum, value) => sum + value, 0)
    expect(total).toBeGreaterThan(0)
    expect(depths.every((depth) => Number.isFinite(depth) && depth >= 0)).toBe(true)
    expect(errors).toEqual([])
  } finally { rig.water.dispose(); rig.sand.dispose() }
})

test('digging lowers the bed, stacking raises it, and pouring never moves sand', async () => {
  const digRig = await makeRig(64, 32, () => SAND.depth, true)
  const pileRig = await makeRig(64, 32, () => SAND.depth, true)
  const waterRig = await makeRig(64, 32, () => SAND.depth, true)
  try {
    const dig: Stroke = {
      from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, velocity: { x: 0, y: 0 },
      radius: 0.02, pressure: 0.8, active: true, mode: TOOL.dig, dwell: 0,
    }
    runSand(digRig.sand, dig, 90)
    const dug = await readSand(digRig.sand)
    const dugCentre = dug[(32 * 64 + 32) * 4]
    expect(dugCentre).toBeLessThan(SAND.depth - 0.005)

    const pile: Stroke = {
      from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, velocity: { x: 0, y: 0 },
      radius: 0.02, pressure: 0.8, active: true, mode: TOOL.pile, dwell: 0,
    }
    runSand(pileRig.sand, pile, 90)
    const piled = await readSand(pileRig.sand)
    const piledCentre = piled[(32 * 64 + 32) * 4]
    expect(piledCentre).toBeGreaterThan(SAND.depth + 0.0008)

    const pour: Stroke = {
      from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, velocity: { x: 0, y: 0 },
      radius: 0.02, pressure: 0.8, active: true, mode: TOOL.water, dwell: 0,
    }
    runSand(waterRig.sand, pour, 90)
    const poured = await readSand(waterRig.sand)
    let moved = 0
    for (let index = 0; index < poured.length; index += 4) moved = Math.max(moved, Math.abs(poured[index] - SAND.depth))
    expect(moved).toBeLessThan(0.0005)
    expect(errors).toEqual([])
  } finally {
    digRig.water.dispose(); digRig.sand.dispose()
    pileRig.water.dispose(); pileRig.sand.dispose()
    waterRig.water.dispose(); waterRig.sand.dispose()
  }
})

test('holding the shovel in one place digs a deeper pit than a quick tap', async () => {
  const tapRig = await makeRig(64, 32, () => SAND.depth, true)
  const holdRig = await makeRig(64, 32, () => SAND.depth, true)
  try {
    const contact = (dwell: number): Stroke => ({
      from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, velocity: { x: 0, y: 0 },
      radius: 0.02, pressure: 0.8, active: true, mode: TOOL.dig, dwell,
    })
    runSand(tapRig.sand, contact(0), 90)
    runSand(holdRig.sand, contact(2.5), 90)
    const tapped = (await readSand(tapRig.sand))[(32 * 64 + 32) * 4]
    const held = (await readSand(holdRig.sand))[(32 * 64 + 32) * 4]
    expect(held).toBeLessThan(tapped - 0.0005)
    expect(errors).toEqual([])
  } finally { tapRig.water.dispose(); tapRig.sand.dispose(); holdRig.water.dispose(); holdRig.sand.dispose() }
})

test('an 80 mm excavation can hold more than the old 35 mm water cap', async () => {
  // Keep this basin's physical cell size/volume constant as the whole beach expands.
  const n = Math.round(SAND.extent / .025), mid = n / 2
  const rig = await makeRig(n, n, (x,y) => Math.abs(x-mid) <= 3 && Math.abs(y-mid) <= 3 ? -0.048 : 0.032)
  try {
    const point = cellWorld(n,mid,mid)
    const pour: Stroke = { from:point, to:point, radius:0.055, pressure:1, active:true, velocity:{x:0,y:0}, mode:TOOL.water }
    runWater(rig.water, 600, [pour])
    runWater(rig.water, 120)
    const {depths} = await readWater(rig.water,n)
    expect(depths[mid*n+mid]).toBeGreaterThan(0.055)
    expect(depths.every(h => Number.isFinite(h) && h >= 0)).toBe(true)
    expect(errors).toEqual([])
  } finally { rig.water.dispose(); rig.sand.dispose() }
})
