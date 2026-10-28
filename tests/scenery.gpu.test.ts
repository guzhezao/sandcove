import {SAND} from '../src/config'
import {expect,test} from 'vitest'
import {create,globals} from 'webgpu'
import {SandSolver} from '../src/simulation/solver'
import {WaterSolver} from '../src/simulation/water-solver'
import {SceneryPhysics,HUTS,HUT_PARTS,BODY_FLOATS} from '../src/simulation/scenery-physics'
Object.assign(globalThis,globals)
const gpu=create([])

test('only the flooded hut breaks; fragments drift, stay broken after drying, and reset',async()=>{
 const adapter=await gpu.requestAdapter(),device=await adapter!.requestDevice()
 const n=128,sand=new SandSolver(device,n),water=new WaterSolver(device,sand,n),props=new SceneryPhysics(device,sand,water)
 const errors:string[]=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message))
 const size=HUTS.length*HUT_PARTS.length*BODY_FLOATS*4
 const readback=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
 const read=async()=>{
  const e=device.createCommandEncoder();e.copyBufferToBuffer(props.bodies,0,readback,0,size);device.queue.submit([e.finish()])
  await readback.mapAsync(GPUMapMode.READ);const data=new Float32Array(readback.getMappedRange()).slice();readback.unmap();return data
 }
 const tick=(seconds:number)=>{
  // Same dt for all encoded updates, just as the fixed-step water solver.
  const e=device.createCommandEncoder();for(let i=0;i<seconds*60;i++)props.encode(e,1/60);device.queue.submit([e.finish()])
 }
 try{
  await props.initialize()
  const bed=new Float32Array(n*n*4);for(let i=0;i<n*n;i++)bed[i*4]=.044
  for(const b of sand.buffers)device.queue.writeBuffer(b,0,bed)
  tick(8);const dry=await read();expect(dry.every(Number.isFinite)).toBe(true)
  for(let i=0;i<20;i++)expect(dry[i*BODY_FLOATS+13]).toBe(0)
  const flow=new Float32Array(n*n*4)
  for(let z=0;z<n;z++)for(let x=0;x<n;x++){
   const wx=((x+.5)/n-.5)*SAND.extent
   if(wx<0){const o=(z*n+x)*4;flow[o]=.075;flow[o+1]=.04;flow[o+2]=.12}
  }
  for(const b of water.buffers)device.queue.writeBuffer(b,0,flow)
  tick(5);const flooded=await read()
  for(let i=0;i<10;i++)expect(flooded[i*BODY_FLOATS+13]).toBe(1)
  for(let i=10;i<20;i++)expect(flooded[i*BODY_FLOATS+13]).toBe(0)
  expect(flooded[8]).toBeGreaterThan(dry[8]+.01)
  expect(flooded[10]).toBeGreaterThan(dry[10]+.025)
  expect(flooded[9]).toBeLessThan(.145)
  for(const b of water.buffers)device.queue.writeBuffer(b,0,new Float32Array(n*n*4))
  tick(5);const settled=await read()
  expect(settled[13]).toBe(1);expect(settled[9]).toBeCloseTo(.053,3)
  expect(settled.every(Number.isFinite)).toBe(true)
  props.reset();tick(1);const reset=await read()
  for(let i=0;i<20;i++){expect(reset[i*BODY_FLOATS+13]).toBe(0);expect(reset[i*BODY_FLOATS+11]).toBe(0)}
  expect(errors).toEqual([])
  console.log('Scenery response:',{dryDamage:dry[11],wetDamage:flooded[11],drift:[flooded[8]-dry[8],flooded[10]-dry[10]],settledHeight:settled[9],shelteredDamage:flooded[10*BODY_FLOATS+11]})
 }finally{readback.destroy();props.dispose();water.dispose();sand.dispose();device.destroy()}
},60_000)
