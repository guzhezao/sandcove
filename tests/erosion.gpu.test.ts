import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SAND, TOOL, type Stroke } from '../src/config'
import { SandSolver } from '../src/simulation/solver'
import { WaterSolver } from '../src/simulation/water-solver'
import { SandErosion } from '../src/simulation/erosion'

Object.assign(globalThis, globals)
const gpu = create([])
let device: GPUDevice
const errors: string[] = []
beforeAll(async () => {
  const adapter = await gpu.requestAdapter()
  device = await adapter!.requestDevice()
  device.addEventListener('uncapturederror', event => errors.push(event.error.message))
})
afterAll(() => device.destroy())
async function read(sand: SandSolver) {
  const buffer = device.createBuffer({ size: sand.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(sand.state, 0, buffer, 0, sand.byteLength)
  device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const values = new Float32Array(buffer.getMappedRange()).slice()
  buffer.unmap(); buffer.destroy()
  return values.filter((_, i) => i % 4 === 0)
}

test('moving water lowers a wet bank and deposits its sand downstream; dry or still water leaves it alone', async () => {
  const n = 32
  const sand = new SandSolver(device, n)
  const water = new WaterSolver(device, sand, n)
  const erosion = new SandErosion(device, sand, water)
  try {
    await water.initialize(); await erosion.initialize()
    const bed = new Float32Array(n * n * 4)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) bed[(y * n + x) * 4] = x <= 15 ? 0.03 : 0.015
    const run = async (depth: number, speed: number) => {
      for (const buffer of sand.buffers) device.queue.writeBuffer(buffer, 0, bed)
      const wet = new Float32Array(n * n * 4)
      for (let i = 0; i < n * n; i++) { wet[i * 4] = depth; wet[i * 4 + 1] = speed }
      for (const buffer of water.buffers) device.queue.writeBuffer(buffer, 0, wet)
      for (let batch = 0; batch < 10; batch++) {
        const encoder = device.createCommandEncoder()
        for (let i = 0; i < 60; i++) erosion.encode(encoder, 1 / 60)
        device.queue.submit([encoder.finish()])
      }
      return read(sand)
    }
    const dry = await run(0, 0.03)
    const still = await run(0.008, 0)
    const flowing = await run(0.008, 0.03)
    const baseline = bed.filter((_, i) => i % 4 === 0)
    expect(Array.from(dry)).toEqual(Array.from(baseline))
    expect(Array.from(still)).toEqual(Array.from(baseline))
    const bank = 16 * n + 15, toe = 16 * n + 16
    expect(flowing[bank]).toBeLessThan(baseline[bank]! - 0.001)
    expect(flowing[toe]).toBeGreaterThan(baseline[toe]! + 0.001)
    expect(flowing.reduce((a,b) => a+b, 0)).toBeCloseTo(baseline.reduce((a,b) => a+b, 0), 4)
    expect(flowing.every(h => Number.isFinite(h) && h >= SAND.floor)).toBe(true)
    expect(errors).toEqual([])
    console.log('Bank erosion/deposition:', baseline[bank]! - flowing[bank]!, flowing[toe]! - baseline[toe]!)
  } finally { erosion.dispose(); water.dispose(); sand.dispose() }
}, 30_000)

test('dig depth follows the local beach height and a held pile has a bounded height', async () => {
  const sand = new SandSolver(device, 128)
  try {
    await sand.initialize()
    const point = (0.5 / 128) * SAND.extent
    const stroke: Stroke = { from: { x: point, y: point }, to: { x: point, y: point }, velocity: { x: 0, y: 0 }, radius: 0.03, pressure: 0.8, active: true, mode: TOOL.dig, dwell: 3 }
    const run = async (base: number, mode: typeof TOOL.dig | typeof TOOL.pile, steps: number) => {
      sand.resetWithTerrain(() => base)
      for (let i = 0; i < steps; i++) {
        const encoder = device.createCommandEncoder()
        sand.encode(encoder, [[{ ...stroke, mode }]])
        device.queue.submit([encoder.finish()])
      }
      return read(sand)
    }
    const low = await run(0.032, TOOL.dig, 180)
    const high = await run(0.044, TOOL.dig, 180)
    const centre = 64 * 128 + 64
    const lowDepth = 0.032 - low[centre]!, highDepth = 0.044 - high[centre]!
    expect(lowDepth).toBeGreaterThan(0.004)
    expect(Math.abs(highDepth - lowDepth)).toBeLessThan(0.0005)
    expect(highDepth).toBeLessThanOrEqual(SAND.maxDigDepth + 0.0005)
    const piled = await run(0.044, TOOL.pile, 2400)
    expect(Math.max(...piled)).toBeLessThanOrEqual(0.044 + SAND.maxPileHeight + 0.0001)
    expect(Math.max(...piled)).toBeGreaterThan(0.048)
    expect(errors).toEqual([])
  } finally { sand.dispose() }
}, 30_000)

test('the real tidal solver supplies enough flow to reshape an overtopped berm', async () => {
  const n = 64
  const sand = new SandSolver(device, n)
  const water = new WaterSolver(device, sand, n)
  const erosion = new SandErosion(device, sand, water)
  try {
    await water.initialize(); await erosion.initialize()
    const bed = new Float32Array(n * n * 4)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) bed[(y * n + x) * 4] = y < 16 ? 0.015 : y < 20 ? 0.038 : 0.023
    for (const buffer of sand.buffers) device.queue.writeBuffer(buffer, 0, bed)
    water.writeParams([], 1 / 60, { shore: -0.2, level: 0.044, drift: 0.002 })
    for (let i = 0; i < 1200; i++) {
      const encoder = device.createCommandEncoder()
      water.encode(encoder)
      erosion.encode(encoder, 1 / 60)
      device.queue.submit([encoder.finish()])
    }
    const after = await read(sand)
    let loss = 0
    for (let y = 16; y < 20; y++) for (let x = 5; x < 59; x++) loss = Math.max(loss, 0.038 - after[y * n + x]!)
    console.log('Real tide maximum berm erosion:', loss)
    expect(loss).toBeGreaterThan(0.001)
    expect(after.reduce((a,b) => a+b, 0)).toBeCloseTo(bed.filter((_,i)=>i%4===0).reduce((a,b)=>a+b,0), 3)
    expect(errors).toEqual([])
  } finally { erosion.dispose(); water.dispose(); sand.dispose() }
}, 30_000)

test('player depth and height settings change the actual terrain and survive reset', async () => {
  const sand = new SandSolver(device, 128)
  try {
    await sand.initialize()
    const point = SAND.extent / 256
    const stroke: Stroke = { from: { x: point, y: point }, to: { x: point, y: point }, velocity: { x: 0, y: 0 }, radius: 0.04, pressure: 0.8, active: true, dwell: 3, mode: TOOL.dig }
    const run = async (dig: number, pile: number, mode: typeof TOOL.dig | typeof TOOL.pile, steps: number) => {
      sand.setToolHeights(dig, pile)
      sand.resetWithTerrain(() => 0.044)
      for (let i = 0; i < steps; i++) {
        const encoder = device.createCommandEncoder()
        sand.encode(encoder, [[{ ...stroke, mode }]])
        device.queue.submit([encoder.finish()])
      }
      return (await read(sand))[64 * 128 + 64]!
    }
    const shallow = await run(0.004, 0.014, TOOL.dig, 180)
    const deep = await run(0.026, 0.014, TOOL.dig, 180)
    expect(shallow - deep).toBeGreaterThan(0.010)
    const short = await run(0.014, 0.004, TOOL.pile, 1200)
    const tall = await run(0.014, 0.040, TOOL.pile, 1200)
    expect(tall - short).toBeGreaterThan(0.006)
    expect(short).toBeLessThanOrEqual(0.0481)
    expect(tall).toBeLessThanOrEqual(0.0841)
    sand.reset()
    expect(sand.digDepth).toBe(0.014)
    expect(sand.pileHeight).toBe(0.040)
    expect(errors).toEqual([])
    console.log('User controls terrain heights:', { shallow, deep, short, tall })
  } finally { sand.dispose() }
}, 30_000)

test.each([TOOL.dig, TOOL.pile])('deep sculpture survives release for tool %s at the production grid resolution', async mode => {
  const sand = new SandSolver(device)
  try {
    await sand.initialize()
    sand.resetWithTerrain(() => SAND.depth)
    sand.setToolHeights(0.080, 0.120)
    const point = SAND.extent / (2 * SAND.resolution)
    const stroke: Stroke = { from: { x: point, y: point }, to: { x: point, y: point }, velocity: { x: 0, y: 0 }, radius: mode === TOOL.dig ? 0.024 : 0.055, pressure: 0.75, active: true, dwell: 4, mode }
    const step = async (contact: boolean, seconds: number) => {
      for (let frame = 0; frame < seconds * 30; frame++) {
        const encoder = device.createCommandEncoder()
        sand.encode(encoder, Array.from({length: 4}, () => contact ? [stroke] : []))
        device.queue.submit([encoder.finish()])
        if (frame % 30 === 0) await device.queue.onSubmittedWorkDone()
      }
    }
    await step(true, mode === TOOL.dig ? 2 : 12)
    const held = await read(sand)
    await step(false, 10)
    const released = await read(sand)
    const centre = (SAND.resolution / 2) * (SAND.resolution + 1)
    const heldRelief = Math.abs(held[centre]! - SAND.depth)
    const retainedRelief = Math.abs(released[centre]! - SAND.depth)
    console.log('Release retention:', {mode, heldRelief, retainedRelief})
    expect(retainedRelief).toBeGreaterThan(mode === TOOL.dig ? 0.055 : 0.080)
    expect(retainedRelief / heldRelief).toBeGreaterThan(0.80)
    expect(released.every(h => Number.isFinite(h) && h >= SAND.floor - 1e-6)).toBe(true)
    expect(released.reduce((a,b)=>a+b,0)).toBeCloseTo(held.reduce((a,b)=>a+b,0), 2)
    expect(errors).toEqual([])
  } finally { sand.dispose() }
}, 60_000)

test('travelling sea waves cross a low berm, erode it and leave sheltered land dry', async () => {
  const n = 64
  const sand = new SandSolver(device, n), water = new WaterSolver(device, sand, n)
  const erosion = new SandErosion(device, sand, water)
  try {
    await water.initialize(); await erosion.initialize()
    const bed = new Float32Array(n * n * 4)
    // Two parallel coasts: one low berm and one high, continuous sea wall.
    for (let y=0; y<n; y++) for (let x=0; x<n; x++) {
      bed[(y*n+x)*4] = y < 16 ? .008 : (x >= 32 && x <= 35) ? .070 : y < 19 ? (x < 32 ? .037 : .070) : .025
    }
    for (const b of sand.buffers) device.queue.writeBuffer(b, 0, bed)
    const probe = device.createBuffer({size: water.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST})
    const seaSamples: number[] = [], frontSamples: number[] = []
    for (let frame=0; frame<960; frame++) {
      water.writeParams([], 1/60, {shore:(16/n-.5)*SAND.extent, level:.031, drift:0, waveTime:frame/60, waveHeight:.012})
      const e = device.createCommandEncoder(); water.encode(e); erosion.encode(e, 1/60)
      if (frame%60===0) e.copyBufferToBuffer(water.state,0,probe,0,water.byteLength)
      device.queue.submit([e.finish()])
      if (frame%60===0) {
        await probe.mapAsync(GPUMapMode.READ)
        const values = new Float32Array(probe.getMappedRange())
        seaSamples.push(values[(12*n+12)*4]); frontSamples.push(values[(19*n+12)*4])
        expect(values.every(Number.isFinite)).toBe(true)
        // Far behind the high wall: waves cannot teleport through it.
        expect(values[(23*n+56)*4]).toBeLessThan(.0001)
        probe.unmap()
      }
    }
    probe.destroy()
    const after = await read(sand)
    let loss=0
    for(let y=16;y<19;y++) for(let x=5;x<26;x++) loss=Math.max(loss,.037-after[y*n+x])
    expect(Math.max(...seaSamples)-Math.min(...seaSamples)).toBeGreaterThan(.010)
    expect(Math.max(...frontSamples)).toBeGreaterThan(.001)
    expect(loss).toBeGreaterThan(.002)
    const initialMass=bed.filter((_,i)=>i%4===0).reduce((a,b)=>a+b,0)
    const massError=Math.abs(after.reduce((a,b)=>a+b,0)-initialMass)
    // 960 f32 integration steps accumulate sub-micron height rounding. Bound
    // the relative error to 10 ppm instead of a grid-size-dependent decimal.
    expect(massError/initialMass).toBeLessThan(1e-5)
    expect(errors).toEqual([])
    console.log('Wave test:', {seaRange:Math.max(...seaSamples)-Math.min(...seaSamples), inlandDepth:Math.max(...frontSamples), bermLoss:loss})
  } finally {erosion.dispose();water.dispose();sand.dispose()}
},30_000)

test('the default strong tide floods open beach at production water resolution without pouring', async () => {
  const {TideCycle,tideTerrainHeight}=await import('../src/tide')
  const sand=new SandSolver(device,128),water=new WaterSolver(device,sand)
  const tide=new TideCycle()
  try {
    await sand.initialize();await water.initialize()
    sand.resetWithTerrain((_x,z)=>tideTerrainHeight(z,-.20))
    tide.start()
    for(let frame=0;frame<1440;frame++){
      tide.update(1/60)
      water.writeParams([],1/60,{shore:-.20,level:tide.level,drift:tide.velocity,waveTime:tide.waveTime,waveHeight:tide.waveHeight*(1+tide.progress*.5)})
      const e=device.createCommandEncoder();water.encode(e);device.queue.submit([e.finish()])
      if(frame%60===0)await device.queue.onSubmittedWorkDone()
    }
    const b=device.createBuffer({size:water.byteLength,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})
    const e=device.createCommandEncoder();e.copyBufferToBuffer(water.state,0,b,0,water.byteLength);device.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ)
    const data=new Float32Array(b.getMappedRange())
    const n=water.resolution
    let mean=0,count=0
    // Sample the high flat beach 180–220 mm inland, not just the sea strip.
    for(let z=122;z<134;z++)for(let x=80;x<176;x++){mean+=data[(z*n+x)*4];count++}
    expect(mean/count).toBeGreaterThan(.012)
    expect(data.every(Number.isFinite)).toBe(true)
    for(let i=0;i<data.length;i+=4)expect(data[i]).toBeGreaterThanOrEqual(0)
    b.unmap();b.destroy()
    expect(errors).toEqual([])
  }finally{water.dispose();sand.dispose()}
},60_000)

test('erosion strength visibly changes bank loss while conserving sand',async()=>{
 const n=64,sand=new SandSolver(device,n),water=new WaterSolver(device,sand,n),erosion=new SandErosion(device,sand,water)
 try{
  await water.initialize();await erosion.initialize()
  const bed=new Float32Array(n*n*4),wet=new Float32Array(n*n*4)
  for(let z=0;z<n;z++)for(let x=0;x<n;x++){
   const i=(z*n+x)*4;bed[i]=x<32?.065:.025;wet[i]=.008;wet[i+1]=.05
  }
  const run=async(strength:number)=>{
   for(const b of sand.buffers)device.queue.writeBuffer(b,0,bed)
   for(const b of water.buffers)device.queue.writeBuffer(b,0,wet)
   for(let frame=0;frame<120;frame++){const e=device.createCommandEncoder();erosion.encode(e,1/60,strength);device.queue.submit([e.finish()])}
   return read(sand)
  }
  const gentle=await run(1),strong=await run(6),edge=32*n+31
  expect(gentle[edge]-strong[edge]).toBeGreaterThan(.003)
  expect(.065-strong[edge]).toBeGreaterThan(.010)
  const initial=bed.filter((_,i)=>i%4===0).reduce((a,b)=>a+b,0)
  expect(strong.reduce((a,b)=>a+b,0)).toBeCloseTo(initial,4)
  expect(strong.every(v=>Number.isFinite(v)&&v>=SAND.floor)).toBe(true)
  expect(errors).toEqual([])
 }finally{erosion.dispose();water.dispose();sand.dispose()}
})

test('a held water jet cuts a high mound within three seconds and carries its sand outward',async()=>{
 const n=256,sand=new SandSolver(device,n),water=new WaterSolver(device,sand,n),erosion=new SandErosion(device,sand,water)
 try{
  await sand.initialize();await water.initialize();await erosion.initialize()
  const p=SAND.extent/(2*n)
  sand.resetWithTerrain((x,z)=>SAND.depth+.080*Math.exp(-((x-p)**2+(z-p)**2)/(.040**2)))
  const initial=await read(sand),centre=128*n+128
  const pour:Stroke={from:{x:p,y:p},to:{x:p,y:p},radius:.024,pressure:.75,velocity:{x:0,y:0},active:true,mode:TOOL.water}
  for(let frame=0;frame<180;frame++){
   water.writeParams([pour],1/60)
   const e=device.createCommandEncoder();sand.encode(e,[[],[]]);water.encode(e);erosion.encode(e,1/60,6);device.queue.submit([e.finish()])
   if(frame%30===0)await device.queue.onSubmittedWorkDone()
  }
  const after=await read(sand)
  console.log('Three-second jet cut (mm):',(initial[centre]-after[centre])*1000)
  expect(initial[centre]-after[centre]).toBeGreaterThan(.025)
  expect(after.reduce((a,b)=>a+b,0)).toBeCloseTo(initial.reduce((a,b)=>a+b,0),2)
  let outsideGain=0
  for(let z=0;z<n;z++)for(let x=0;x<n;x++){
   if(Math.hypot((x-128)*SAND.extent/n,(z-128)*SAND.extent/n)>.03)outsideGain+=Math.max(0,after[z*n+x]-initial[z*n+x])
  }
  expect(outsideGain).toBeGreaterThan(.1)
  expect(after.every(v=>Number.isFinite(v)&&v>=SAND.floor-1e-6)).toBe(true)
  expect(errors).toEqual([])
 }finally{erosion.dispose();water.dispose();sand.dispose()}
},60_000)
