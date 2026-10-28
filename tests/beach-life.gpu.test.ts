import {SAND} from '../src/config'
import {expect,test} from 'vitest'
import {create,globals} from 'webgpu'
import {SandSolver} from '../src/simulation/solver'
import {WaterSolver} from '../src/simulation/water-solver'
import {BeachLife,BEACHGOERS,ACTOR_FLOATS} from '../src/simulation/beach-life'
Object.assign(globalThis,globals)
const gpu=create([])

test('beachgoers walk, flee approaching water, tumble and drift; boats float and stranded actors reset',async()=>{
 const adapter=await gpu.requestAdapter(),device=await adapter!.requestDevice()
 const n=128,rows=192,sand=new SandSolver(device,n,rows),water=new WaterSolver(device,sand,n),life=new BeachLife(device,sand,water)
 const errors:string[]=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message))
 const size=7*ACTOR_FLOATS*4,readback=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
 const read=async()=>{
  const e=device.createCommandEncoder();e.copyBufferToBuffer(life.actors,0,readback,0,size);device.queue.submit([e.finish()])
  await readback.mapAsync(GPUMapMode.READ);const a=new Float32Array(readback.getMappedRange()).slice();readback.unmap();return a
 }
 const tick=(seconds:number)=>{
  const e=device.createCommandEncoder();for(let i=0;i<seconds*60;i++)life.encode(e,1/60);device.queue.submit([e.finish()])
 }
 const writeWater=(sample:(x:number,z:number)=>[number,number,number])=>{
  const data=new Float32Array(n*rows*4)
  for(let z=0;z<rows;z++)for(let x=0;x<n;x++)data.set(sample(((x+.5)/n-.5)*SAND.extent,((z+.5)/n-.5)*SAND.extent),(z*n+x)*4)
  for(const b of water.buffers)device.queue.writeBuffer(b,0,data)
 }
 try{
  await life.initialize()
  const bed=new Float32Array(n*rows*4);for(let i=0;i<n*rows;i++)bed[i*4]=.044
  for(const b of sand.buffers)device.queue.writeBuffer(b,0,bed)
  tick(4);const strolling=await read()
  expect(Math.hypot(strolling[4]-BEACHGOERS[0][0],strolling[6]-BEACHGOERS[0][1])).toBeGreaterThan(.015)
  expect(strolling[10]).toBeGreaterThan(10);expect(strolling[12]).toBe(0)
  // Ordinary low-tide waves may be fast, but must not release the mooring.
  writeWater(()=>[.035,.08,.12]);tick(8);const moored=await read()
  for(const i of [5,6]){
   expect(moored[i*ACTOR_FLOATS+13]).toBe(0)
   expect(Math.hypot(moored[i*ACTOR_FLOATS+4]-moored[i*ACTOR_FLOATS],moored[i*ACTOR_FLOATS+6]-moored[i*ACTOR_FLOATS+1])).toBeLessThan(.02)
  }
  // Water reaches the look-ahead sample but not the person's feet.
  life.reset();writeWater((_x,z)=>z<BEACHGOERS[0][1]-.023?[.018,0,.03]:[0,0,0]);tick(.25)
  const fleeing=await read();expect(fleeing[12]).toBe(1);expect(fleeing[9]).toBeGreaterThan(.02)
  expect(fleeing[6]).toBeGreaterThan(BEACHGOERS[0][1])
  // A whole incoming sheet catches the fleeing people and carries boats too.
  writeWater(()=>[.075,.06,.13]);tick(2)
  const swept=await read()
  for(let i=0;i<5;i++)expect(swept[i*ACTOR_FLOATS+12]).toBe(2)
  expect(swept[4]-fleeing[4]).toBeGreaterThan(.025)
  expect(swept[6]-fleeing[6]).toBeGreaterThan(.065)
  const boat=5*ACTOR_FLOATS
  expect(swept[boat+6]).toBeGreaterThan(-.25)
  expect(swept[boat+5]).toBeCloseTo(.120,3)
  expect(swept[boat+13]).toBe(1)
  writeWater(()=>[0,0,0]);tick(2)
  const stranded=await read()
  for(let i=0;i<5;i++){
   expect(stranded[i*ACTOR_FLOATS+12]).toBe(3)
   expect(stranded[i*ACTOR_FLOATS+5]).toBeCloseTo(.051,3)
  }
  expect(stranded.every(Number.isFinite)).toBe(true)
  life.reset();tick(.1);const reset=await read()
  expect(reset[12]).toBe(0);expect(reset[14]).toBe(0)
  expect(Math.hypot(reset[4]-BEACHGOERS[0][0],reset[6]-BEACHGOERS[0][1])).toBeLessThan(.003)
  expect(errors).toEqual([])
 }finally{readback.destroy();life.dispose();water.dispose();sand.dispose();device.destroy()}
},60_000)

test('walkers avoid cliffs and boats cannot cross a dry sand wall',async()=>{
 const adapter=await gpu.requestAdapter(),device=await adapter!.requestDevice()
 const n=256,rows=384,sand=new SandSolver(device,n,rows),water=new WaterSolver(device,sand,n),life=new BeachLife(device,sand,water)
 const size=7*ACTOR_FLOATS*4,readback=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
 try{
  await life.initialize()
  const bed=new Float32Array(n*rows*4)
  for(const barrier of [.18,-.04]){
  life.reset()
  for(let z=0;z<rows;z++)for(let x=0;x<n;x++){
   const wx=((x+.5)/n-.5)*SAND.extent,wz=((z+.5)/n-.5)*SAND.extent
   const radius=Math.max(Math.abs(wx-BEACHGOERS[0][0]),Math.abs(wz-BEACHGOERS[0][1]))
   bed[(z*n+x)*4]=radius>.020&&radius<.040?barrier:.044
  }
  for(const b of sand.buffers)device.queue.writeBuffer(b,0,bed)
  const e=device.createCommandEncoder();for(let i=0;i<1200;i++)life.encode(e,1/60)
  e.copyBufferToBuffer(life.actors,0,readback,0,size);device.queue.submit([e.finish()])
  await readback.mapAsync(GPUMapMode.READ);const a=new Float32Array(readback.getMappedRange()).slice();readback.unmap()
  expect(Math.abs(a[4]-BEACHGOERS[0][0])).toBeLessThan(.022)
  expect(Math.abs(a[6]-BEACHGOERS[0][1])).toBeLessThan(.022)
  expect(a[12]).toBe(0)
  }
  life.reset()
  const flow=new Float32Array(n*rows*4)
  for(let z=0;z<rows;z++)for(let x=0;x<n;x++){
   const wz=((z+.5)/n-.5)*SAND.extent,o=(z*n+x)*4
   bed[o]=wz>-.23&&wz<-.18?.20:.044
   if(wz<-.23){flow[o]=.075;flow[o+2]=.15}
  }
  for(const b of sand.buffers)device.queue.writeBuffer(b,0,bed)
  for(const b of water.buffers)device.queue.writeBuffer(b,0,flow)
  const e=device.createCommandEncoder();for(let i=0;i<360;i++)life.encode(e,1/60)
  e.copyBufferToBuffer(life.actors,0,readback,0,size);device.queue.submit([e.finish()])
  await readback.mapAsync(GPUMapMode.READ);const blocked=new Float32Array(readback.getMappedRange()).slice();readback.unmap()
  for(const i of [5,6]){
   expect(blocked[i*ACTOR_FLOATS+6]).toBeLessThan(-.23)
   expect(blocked[i*ACTOR_FLOATS+6]).toBeGreaterThan(-.29)
  }
 }finally{readback.destroy();life.dispose();water.dispose();sand.dispose();device.destroy()}
},60_000)

test('unobstructed walking has continuous velocity, facing and distance-matched footsteps',async()=>{
 const adapter=await gpu.requestAdapter(),device=await adapter!.requestDevice()
 const n=128,rows=192,sand=new SandSolver(device,n,rows),water=new WaterSolver(device,sand,n),life=new BeachLife(device,sand,water)
 const frames=720,stride=ACTOR_FLOATS*4,readback=device.createBuffer({size:frames*stride,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
 try{
  await life.initialize()
  const bed=new Float32Array(n*rows*4);for(let i=0;i<n*rows;i++)bed[i*4]=.044
  for(const b of sand.buffers)device.queue.writeBuffer(b,0,bed)
  const encoder=device.createCommandEncoder()
  for(let i=0;i<frames;i++){life.encode(encoder,1/60);encoder.copyBufferToBuffer(life.actors,0,readback,i*stride,stride)}
  device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ)
  const a=new Float32Array(readback.getMappedRange()).slice();readback.unmap()
  let maxAcceleration=0,maxTurn=0,distance=0
  for(let i=1;i<frames;i++){
   const p=(i-1)*ACTOR_FLOATS,q=i*ACTOR_FLOATS
   maxAcceleration=Math.max(maxAcceleration,Math.hypot(a[q+8]-a[p+8],a[q+9]-a[p+9]))
   maxTurn=Math.max(maxTurn,Math.abs(a[q+7]-a[p+7]))
   distance+=Math.hypot(a[q+4]-a[p+4],a[q+6]-a[p+6])
   expect(a[q+12]).toBe(0)
  }
  expect(a.every(Number.isFinite)).toBe(true);expect(distance).toBeGreaterThan(.05)
  expect(maxAcceleration).toBeLessThan(.0028);expect(maxTurn).toBeLessThan(.20)
  expect(a[(frames-1)*ACTOR_FLOATS+10]-a[10]).toBeCloseTo(distance*420,2)
 }finally{readback.destroy();life.dispose();water.dispose();sand.dispose();device.destroy()}
},60_000)
