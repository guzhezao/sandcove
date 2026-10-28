import {afterAll,beforeAll,expect,test} from 'vitest'
import {create,globals} from 'webgpu'
import {SAND} from '../src/config'
import {SandSolver} from '../src/simulation/solver'
import {SandMolds, type MoldKind} from '../src/simulation/molds'
Object.assign(globalThis,globals)
const gpu=create([])
let device:GPUDevice
const errors:string[]=[]
beforeAll(async()=>{const a=await gpu.requestAdapter();device=await a!.requestDevice();device.addEventListener('uncapturederror',e=>errors.push(e.error.message))})
afterAll(()=>device.destroy())
async function read(sand:SandSolver){
 const b=device.createBuffer({size:sand.byteLength,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})
 const e=device.createCommandEncoder();e.copyBufferToBuffer(sand.state,0,b,0,sand.byteLength);device.queue.submit([e.finish()])
 await b.mapAsync(GPUMapMode.READ);const v=new Float32Array(b.getMappedRange()).slice();b.unmap();b.destroy();return v
}
test.each(['tower','wall','arc'] as MoldKind[])('%s mold creates real bounded sand, preserves outside terrain and survives release',async kind=>{
 const sand=new SandSolver(device,256),molds=new SandMolds(device,sand)
 try{
  await sand.initialize();await molds.initialize();sand.resetWithTerrain(()=>SAND.depth)
  const e=device.createCommandEncoder();molds.encode(e,[{point:{x:0,y:0},radius:.075,height:.080,angle:0,kind}]);device.queue.submit([e.finish()])
  const stamped=await read(sand)
  let peak=0,added=0
  for(let z=0;z<256;z++)for(let x=0;x<256;x++){
   const h=stamped[(z*256+x)*4];peak=Math.max(peak,h);added+=h-SAND.depth
   expect(Number.isFinite(h)&&h>=SAND.depth-1e-6&&h<=SAND.depth+.0801).toBe(true)
   if(Math.hypot((x+.5)/256-.5,(z+.5)/256-.5)*SAND.extent>.08)expect(h).toBeCloseTo(SAND.depth,6)
  }
  expect(peak).toBeGreaterThan(.100);expect(added).toBeGreaterThan(1)
  for(let frame=0;frame<150;frame++){const e=device.createCommandEncoder();sand.encode(e,[[],[],[],[]]);device.queue.submit([e.finish()])}
  const settled=await read(sand)
  let settledPeak=0,total=0
  for(let i=0;i<settled.length;i+=4){settledPeak=Math.max(settledPeak,settled[i]);total+=settled[i]-SAND.depth}
  expect(settledPeak).toBeGreaterThan(.090);expect(total).toBeCloseTo(added,3)
  expect(errors).toEqual([])
 }finally{molds.dispose();sand.dispose()}
},30_000)
test('wall rotation changes its footprint and repeated clicks can stack towers',async()=>{
 const sand=new SandSolver(device,128),molds=new SandMolds(device,sand)
 try{
  await sand.initialize();await molds.initialize();sand.resetWithTerrain(()=>SAND.depth)
  const stamp={point:{x:0,y:0},radius:.08,height:.05,angle:0,kind:'wall' as MoldKind}
  let e=device.createCommandEncoder();molds.encode(e,[stamp]);device.queue.submit([e.finish()]);const horizontal=await read(sand)
  sand.resetWithTerrain(()=>SAND.depth)
  e=device.createCommandEncoder();molds.encode(e,[{...stamp,angle:Math.PI/2}]);device.queue.submit([e.finish()]);const vertical=await read(sand)
  const probe=Math.floor((.065/SAND.extent+.5)*128)
  const east=(64*128+probe)*4,north=(probe*128+64)*4
  expect(horizontal[east]).toBeGreaterThan(horizontal[north]+.02)
  expect(vertical[north]).toBeGreaterThan(vertical[east]+.02)
  sand.resetWithTerrain(()=>SAND.depth)
  e=device.createCommandEncoder();molds.encode(e,[{...stamp,kind:'tower'},{...stamp,kind:'tower'}]);device.queue.submit([e.finish()])
  expect((await read(sand))[(64*128+64)*4]).toBeGreaterThan(SAND.depth+.06)
  expect(errors).toEqual([])
 }finally{molds.dispose();sand.dispose()}
})

test('the starter castle stamps all eight parts in one submission and leaves its courtyard open',async()=>{
 const {starterCastle,CASTLE}=await import('../src/starter')
 const {HUTS}=await import('../src/simulation/scenery-physics')
 const {BEACHGOERS}=await import('../src/simulation/beach-life')
 const n=256,sand=new SandSolver(device,n,384),molds=new SandMolds(device,sand)
 try{
  await sand.initialize();await molds.initialize();sand.resetWithTerrain(()=>.044)
  const e=device.createCommandEncoder();molds.encode(e,starterCastle());device.queue.submit([e.finish()])
  let data=await read(sand)
  const height=(x:number,z:number)=>data[(Math.floor((z/SAND.extent+.5)*n)*n+Math.floor((x/SAND.extent+.5)*n))*4]
  for(const x of [-.25,.25])for(const z of [CASTLE.centerZ-CASTLE.halfDepth,CASTLE.centerZ+CASTLE.halfDepth])expect(height(x,z)).toBeGreaterThan(.09)
  for(const [x,z] of [[0,CASTLE.centerZ-.20],[0,CASTLE.centerZ+.20],[-.25,CASTLE.centerZ],[.25,CASTLE.centerZ]])expect(height(x,z)).toBeGreaterThan(.075)
  expect(height(0,CASTLE.centerZ)).toBeCloseTo(.044,6)
  // The cabin deck/stairs and all starting people occupy flat courtyard floor.
  for(const [x,z] of HUTS)for(const dx of [-.041,.041])for(const dz of [-.038,.076])expect(height(x+dx,z+dz)).toBeCloseTo(.044,5)
  for(const [x,z] of BEACHGOERS)expect(height(x,z)).toBeCloseTo(.044,5)
  expect(height(-.30,-.20)).toBeCloseTo(.044,6)
  // The added inland/corner strip is simulated sand, beyond the former ±.4 bed.
  const expanded=device.createCommandEncoder()
  molds.encode(expanded,[{point:{x:.44,y:.42},radius:.025,height:.065,angle:0,kind:'tower'}])
  device.queue.submit([expanded.finish()]);data=await read(sand)
  expect(height(.44,.42)).toBeGreaterThan(.08)
  expect(errors).toEqual([])
 }finally{molds.dispose();sand.dispose()}
})
