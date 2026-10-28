import {SAND} from '../src/config'
import {expect,test} from 'vitest'
import {create,globals} from 'webgpu'
import {SandSolver} from '../src/simulation/solver'
import {WaterSolver} from '../src/simulation/water-solver'
Object.assign(globalThis,globals)
const gpu=create([])

test('an ocean bore advances across the full width without teleporting past a tall wall',async()=>{
 const adapter=await gpu.requestAdapter(),device=await adapter!.requestDevice()
 const n=128,sand=new SandSolver(device,n),water=new WaterSolver(device,sand,n)
 const errors:string[]=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message))
 const buffer=device.createBuffer({size:water.byteLength,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})
 const read=async()=>{
  const e=device.createCommandEncoder();e.copyBufferToBuffer(water.state,0,buffer,0,water.byteLength);device.queue.submit([e.finish()])
  await buffer.mapAsync(GPUMapMode.READ);const data=new Float32Array(buffer.getMappedRange()).slice();buffer.unmap();return data
 }
 const at=(x:number,z:number)=>Math.floor((z/SAND.extent+.5)*n)*n*4+Math.floor((x/SAND.extent+.5)*n)*4
 try{
  await water.initialize()
  const prepare=(wall:boolean)=>{
   const bed=new Float32Array(n*n*4)
   for(let z=0;z<n;z++)for(let x=0;x<n;x++){
    const world=((z+.5)/n-.5)*SAND.extent
    bed[(z*n+x)*4]=wall&&world>.01&&world<.04?.32:world<-.25?.004:.044
   }
   for(const b of sand.buffers)device.queue.writeBuffer(b,0,bed)
   water.reset();water.writeParams([],1/60,{shore:-.25,level:.15,drift:0,surgeSpeed:.27,waveHeight:0})
  }
  const advance=(steps:number)=>{
   for(let batch=0;batch<steps;batch+=30){
    const e=device.createCommandEncoder();for(let j=0;j<Math.min(30,steps-batch);j++)water.encode(e)
    device.queue.submit([e.finish()])
   }
  }
  prepare(false);advance(15);const early=await read()
  expect(early[at(0,.30)]).toBeLessThan(.00001)
  advance(345);const late=await read()
  const widths=[-.30,-.15,0,.15,.30].map(x=>late[at(x,.27)])
  expect(Math.min(...widths)).toBeGreaterThan(.018)
  expect(Math.max(...widths)-Math.min(...widths)).toBeLessThan(.0001)
  expect(late.every(Number.isFinite)).toBe(true)
  for(let i=0;i<late.length;i+=4)expect(late[i]).toBeGreaterThanOrEqual(0)
  prepare(true);advance(360);const blocked=await read()
  expect(blocked[at(0,-.05)]).toBeGreaterThan(.01)
  expect(blocked[at(0,.15)]).toBeLessThan(.00001)
  expect(errors).toEqual([])
  console.log('Coast-wide bore:',{farDepths:widths,behindWall:blocked[at(0,.15)]})
 }finally{buffer.destroy();water.dispose();sand.dispose();device.destroy()}
},60_000)
