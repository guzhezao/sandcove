import { expect, test } from 'vitest'
import { SAND } from '../src/config'
import { SandCamera, cameraViews, type CameraView } from '../src/render/camera'

test.each(Object.keys(cameraViews) as CameraView[])('%s view preserves screen-to-bed picking in portrait and landscape', view => {
  const camera = new SandCamera()
  camera.setView(view)
  for (const [width, height] of [[1280,720], [390,844]]) {
    camera.aspect = width! / height!
    for (const [sx, sy] of [[0.2,0.2], [0.5,0.5], [0.8,0.8]]) {
      const x = sx! * width!, y = sy! * height!
      const world = camera.screenToBed(x, y, width!, height!)
      const relative = [world.x - camera.eye[0], SAND.depth - camera.eye[1], world.y - camera.eye[2]]
      const dot = (v: number[]) => v.reduce((sum, n, i) => sum + n * relative[i]!, 0)
      const distance = dot(camera.forward)
      const screenX = (dot(camera.right) / (camera.tanHalfFov * camera.aspect * distance) + 1) * width! / 2
      const screenY = (1 - dot(camera.up) / (camera.tanHalfFov * distance)) * height! / 2
      expect(screenX).toBeCloseTo(x, 5)
      expect(screenY).toBeCloseTo(y, 5)
      expect(Number.isFinite(distance) && distance > 0).toBe(true)
    }
  }
})


test.each(Object.keys(cameraViews) as CameraView[])('%s view picks real raised and excavated surfaces', view => {
  const camera = new SandCamera()
  camera.setView(view)
  camera.aspect = 1280 / 720
  for (const elevation of [-0.048, 0.152]) {
    camera.setSurface(new Float32Array(64 * 64).fill(elevation), 64)
    const world = camera.screenToSurface(640, 360, 1280, 720)
    const relative = [world.x - camera.eye[0], elevation - camera.eye[1], world.y - camera.eye[2]]
    const dot = (v: number[]) => v.reduce((sum, n, i) => sum + n * relative[i]!, 0)
    expect(dot(camera.right)).toBeCloseTo(0, 5)
    expect(dot(camera.up)).toBeCloseTo(0, 5)
  }
})

test('low view picks the visible front of a tall mound before the flat bed behind it', () => {
  const camera = new SandCamera()
  camera.setView('low')
  camera.aspect = 1280 / 720
  const n = 256, heights = new Float32Array(n * n)
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const wx = ((x + 0.5) / n - 0.5) * SAND.extent, wz = ((z + 0.5) / n - 0.5) * SAND.extent
    heights[z * n + x] = SAND.depth + Math.max(0, 0.12 - 2 * Math.hypot(wx, wz - (camera.target[2] + 0.1)))
  }
  camera.setSurface(heights, n)
  const point = camera.screenToSurface(640, 360, 1280, 720)
  expect(point.y).toBeGreaterThan(camera.target[2]+0.10)
  expect(point.y).toBeLessThan(camera.target[2]+0.16)
  camera.clearSurface()
  expect(camera.screenToSurface(640,360,1280,720).y).toBeCloseTo(camera.target[2], 6)
})


test.each(Object.keys(cameraViews) as CameraView[])('%s overview fits the whole finite bed in portrait and landscape', view => {
  const camera = new SandCamera()
  camera.setView(view)
  for (const [width,height] of [[1280,720],[390,844]]) {
    camera.aspect=width/height
    for(const x of [-SAND.extent/2,SAND.extent/2]) for(const z of [-SAND.extent/2,SAND.length-SAND.extent/2]) {
      const p=camera.project(x,SAND.depth,z,width,height)
      expect(p.x).toBeGreaterThan(0);expect(p.x).toBeLessThan(width)
      expect(p.y).toBeGreaterThan(0);expect(p.y).toBeLessThan(height)
    }
  }
})

test('free orbit, zoom and pan keep finite orthonormal picking through full rotations', () => {
  const camera = new SandCamera()
  camera.aspect = 611 / 764
  camera.setSurface(new Float32Array(64 * 64).fill(SAND.depth), 64)
  for (let i = 0; i < 40; i++) {
    camera.orbit(90, i % 2 ? 200 : -250)
    camera.dolly(i % 2 ? 0.8 : -0.5)
    camera.pan(20, -10, 764)
    const dot = (a: number[], b: number[]) => a.reduce((s, n, j) => s + n * b[j], 0)
    expect(dot(camera.forward, camera.up)).toBeCloseTo(0, 6)
    expect(dot(camera.forward, camera.right)).toBeCloseTo(0, 6)
    expect(Math.hypot(...camera.up)).toBeCloseTo(1, 6)
    const point = camera.screenToSurface(305.5, 382, 611, 764)
    expect(point.x).toBeCloseTo(camera.target[0], 4)
    expect(point.y).toBeCloseTo(camera.target[2], 4)
    expect(camera.eye[1]).toBeGreaterThan(SAND.depth)
  }
  camera.setView('original')
  expect(camera.zoom).toBe(1)
  expect(camera.target).toEqual([0, SAND.depth, (SAND.length-SAND.extent)/2])
})


test('startup orbit keeps the elongated beach above the toolbar',()=>{
 const c=new SandCamera();c.orbit(75,0);c.zoom=.70
 for(const [w,h] of [[1280,720],[390,844]]){
  c.aspect=w/h
  for(const x of [-SAND.extent/2,SAND.extent/2])for(const z of [-SAND.extent/2,SAND.length-SAND.extent/2]){
   for (const elevation of [SAND.depth, SAND.floor-.018]) {
   const p=c.project(x,elevation,z,w,h)
   expect(p.x).toBeGreaterThan(10);expect(p.x).toBeLessThan(w-10)
   expect(p.y).toBeGreaterThan(100);expect(p.y).toBeLessThan(h-75)
   }
  }
 }
})
