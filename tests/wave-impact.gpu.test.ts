import {afterAll,beforeAll,expect,test} from 'vitest'
import {create,globals} from 'webgpu'
import {SAND,TOOL,type Stroke} from '../src/config'
import {SandSolver} from '../src/simulation/solver'
import {WaterSolver} from '../src/simulation/water-solver'
import {SandErosion} from '../src/simulation/erosion'
import {SandMolds} from '../src/simulation/molds'
Object.assign(globalThis,globals)
const gpu=create([])
let device:GPUDevice
const errors:string[]=[]
beforeAll(async()=>{device=await (await gpu.requestAdapter())!.requestDevice();device.addEventListener('uncapturederror',e=>errors.push(e.error.message))})
afterAll(()=>device.destroy())
async function read(buffer:GPUBuffer,size:number){
 const b=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
 const e=device.createCommandEncoder();e.copyBufferToBuffer(buffer,0,b,0,size);device.queue.submit([e.finish()])
 await b.mapAsync(GPUMapMode.READ);const data=new Float32Array(b.getMappedRange()).slice();b.unmap();b.destroy();return data
}

test('head-on wave energy and thin support change damage while dry banks stay intact and sand is conserved',async()=>{
 const n=192,sand=new SandSolver(device,n),water=new WaterSolver(device,sand,n),erosion=new SandErosion(device,sand,water)
 try{
  await water.initialize();await erosion.initialize()
  const run=async(speed:number,direction:'normal'|'tangent',thickness:number,depth=.035)=>{
   const bed=new Float32Array(n*n*4),wet=new Float32Array(n*n*4)
   const front=90
   for(let z=0;z<n;z++)for(let x=0;x<n;x++){
    const i=(z*n+x)*4;bed[i]=z>=front&&z<front+thickness?.068:.008
    wet[i]=depth;wet[i+(direction==='normal'?2:1)]=speed
   }
   for(const b of sand.buffers)device.queue.writeBuffer(b,0,bed)
   for(const b of water.buffers)device.queue.writeBuffer(b,0,wet)
   // Observe the first impact before the two sides of a thin wall meet.
   for(let frame=0;frame<18;frame++) {const e=device.createCommandEncoder();erosion.encode(e,1/60);device.queue.submit([e.finish()])}
   const after=await read(sand.state,sand.byteLength)
   const initial=bed.filter((_,i)=>i%4===0),heights=after.filter((_,i)=>i%4===0)
   const mass=(a:Float32Array)=>a.reduce((a,b)=>a+b,0)
   expect(Math.abs(mass(heights)-mass(initial))/mass(initial)).toBeLessThan(1e-5)
   expect(heights.every(h=>Number.isFinite(h)&&h>=SAND.floor)).toBe(true)
   expect(Math.max(...heights)).toBeLessThanOrEqual(.080)
   let loss=0;for(let x=70;x<120;x++)loss+=bed[(front*n+x)*4]-after[(front*n+x)*4]
   return loss/50
  }
  const weak=await run(.025,'normal',16),strong=await run(.24,'normal',16)
  const parallel=await run(.24,'tangent',16),thin=await run(.24,'normal',3),dry=await run(.24,'normal',3,0)
  console.log('Wave face loss, mm',{weak:weak*1000,strong:strong*1000,parallel:parallel*1000,thin:thin*1000,dry})
  expect(strong).toBeGreaterThan(weak*1.5)
  expect(strong).toBeGreaterThan(parallel*1.35)
  expect(thin).toBeGreaterThan(strong*1.10)
  expect(dry).toBe(0)
  expect(errors).toEqual([])
 }finally{erosion.dispose();water.dispose();sand.dispose()}
})

test('rear extension contains editable, pickable sand and flowing water with square cells',async()=>{
 const n=128,rows=192,sand=new SandSolver(device,n,rows),water=new WaterSolver(device,sand,n),molds=new SandMolds(device,sand),erosion=new SandErosion(device,sand,water)
 const idx=(x:number,z:number)=>(Math.floor((z/SAND.extent+.5)*n)*n+Math.floor((x/SAND.extent+.5)*n))*4
 try{
  await sand.initialize();await water.initialize();await molds.initialize();await erosion.initialize()
  sand.resetWithTerrain(()=>.044)
  expect(sand.byteLength).toBe(n*rows*16);expect(water.rows).toBe(rows)
  let e=device.createCommandEncoder();molds.encode(e,[{point:{x:.18,y:.78},kind:'tower',radius:.04,height:.08,angle:0}]);device.queue.submit([e.finish()])
  let data=await read(sand.state,sand.byteLength)
  expect(data[idx(.18,.78)]).toBeGreaterThan(.090)
  expect(data[idx(.18,.28)]).toBeCloseTo(.044,6)
  const stroke:Stroke={from:{x:-.16,y:.76},to:{x:-.16,y:.76},velocity:{x:0,y:0},radius:.045,pressure:.8,active:true,dwell:5,mode:TOOL.dig}
  for(let frame=0;frame<90;frame++){
   water.writeParams([{...stroke,mode:TOOL.water}],1/60)
   e=device.createCommandEncoder();sand.encode(e,[[stroke],[stroke]]);water.encode(e);erosion.encode(e,1/60);device.queue.submit([e.finish()])
  }
  data=await read(sand.state,sand.byteLength)
  const wet=await read(water.state,water.byteLength)
  expect(data[idx(-.16,.76)]).toBeLessThan(.025)
  expect(wet[idx(-.16,.76)]).toBeGreaterThan(.01)
  expect(data.every(Number.isFinite)&&wet.every(Number.isFinite)).toBe(true)
  // Copy the complete rectangular height field, including rows past the old edge.
  const {SandCamera}=await import('../src/render/camera')
  const camera=new SandCamera();camera.setView('top');camera.aspect=1280/720
  camera.setSurface(data.filter((_,i)=>i%4===0),n)
  const h=camera.heightAt(.18,.78),screen=camera.project(.18,h,.78,1280,720)
  const hit=camera.screenToSurface(screen.x,screen.y,1280,720)
  expect(hit.x).toBeCloseTo(.18,3);expect(hit.y).toBeCloseTo(.78,3)
  expect(errors).toEqual([])
 }finally{erosion.dispose();molds.dispose();water.dispose();sand.dispose()}
})
