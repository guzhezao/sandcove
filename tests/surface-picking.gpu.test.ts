import { expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SAND } from '../src/config'
import { SandCamera } from '../src/render/camera'
import { SurfacePicking } from '../src/render/surface-picking'
import { SandSolver } from '../src/simulation/solver'

Object.assign(globalThis, globals)
const gpu = create([])
test('terrain picking reads actual GPU heights and rejects an old scene after reset', async () => {
  const adapter = await gpu.requestAdapter()
  const device = await adapter!.requestDevice()
  const solver = new SandSolver(device,32)
  const camera = new SandCamera()
  camera.setView('low'); camera.aspect = 1280 / 720
  const picking = new SurfacePicking(solver,camera)
  const point = () => camera.screenToSurface(640,360,1280,720)
  try {
    await solver.initialize()
    solver.resetWithTerrain(() => 0.14)
    let encoder = device.createCommandEncoder()
    expect(picking.encode(encoder,0)).toBe(true)
    device.queue.submit([encoder.finish()]); await picking.read()
    expect(point().y).toBeCloseTo(camera.target[2] + (0.14 - SAND.depth) * (camera.eye[2]-camera.target[2]) / (camera.eye[1] - SAND.depth), 4)
    encoder = device.createCommandEncoder()
    expect(picking.encode(encoder,200)).toBe(true)
    device.queue.submit([encoder.finish()])
    picking.reset()
    await picking.read()
    expect(point().y).toBeCloseTo(camera.target[2],6)
    solver.resetWithTerrain(() => -0.048)
    encoder = device.createCommandEncoder()
    expect(picking.encode(encoder,400)).toBe(true)
    device.queue.submit([encoder.finish()]); await picking.read()
    expect(point().y).toBeCloseTo(camera.target[2] + (-0.048 - SAND.depth) * (camera.eye[2]-camera.target[2]) / (camera.eye[1] - SAND.depth), 4)
  } finally { picking.dispose(); solver.dispose(); device.destroy() }
})
