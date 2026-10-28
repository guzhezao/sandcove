import {beforeAll,afterAll,expect,test} from 'vitest'
import {create,globals} from 'webgpu'
import {SAND,WATER} from '../src/config'
import {StrokeQueue} from '../src/input/strokes'
import {SandSolver} from '../src/simulation/solver'
import {SandMolds,wallStamp} from '../src/simulation/molds'
import {WaterSolver} from '../src/simulation/water-solver'
import {TIDE,tideTerrainHeight} from '../src/tide'
Object.assign(globalThis,globals)
const gpu=create([])
let device:GPUDevice
const errors:string[]=[]
beforeAll(async()=>{const a=await gpu.requestAdapter();device=await a!.requestDevice();device.addEventListener('uncapturederror',e=>errors.push(e.error.message))})
afterAll(()=>device.destroy())
async function read(buffer:GPUBuffer,size:number){
 const staging=device.createBuffer({size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})
 const e=device.createCommandEncoder();e.copyBufferToBuffer(buffer,0,staging,0,size);device.queue.submit([e.finish()])
 await staging.mapAsync(GPUMapMode.READ);const data=new Float32Array(staging.getMappedRange()).slice();staging.unmap();staging.destroy();return data
}
function at(data:Float32Array,n:number,x:number,z:number){return data[(Math.floor((z/SAND.extent+.5)*n)*n+Math.floor((x/SAND.extent+.5)*n))*4]}
async function dig(sand:SandSolver,from:{x:number;y:number},to:{x:number;y:number}){
 const q=new StrokeQueue();q.radius=.05;q.begin(from,.75,1000);q.move(to,.75,1600);q.end()
 for(let i=0;i<16;i++){const e=device.createCommandEncoder();sand.encode(e,[q.nextBatch(1600)]);device.queue.submit([e.finish()])}
}
test('one drag produces a continuous wall of consistent width and settled height, and a real shovel opens it',async()=>{
 const n=256,sand=new SandSolver(device,n),molds=new SandMolds(device,sand)
 try{
  await sand.initialize();await molds.initialize();sand.resetWithTerrain(()=>.044)
  const e=device.createCommandEncoder();molds.encode(e,[wallStamp({x:-.4,y:.1},{x:.4,y:.1},.032,.044)]);device.queue.submit([e.finish()])
  for(let i=0;i<30;i++){const e=device.createCommandEncoder();sand.encode(e,[[],[],[],[]]);device.queue.submit([e.finish()])}
  let data=await read(sand.state,sand.byteLength)
  for(let x=-.38;x<.39;x+=.01){expect(at(data,n,x,.1)).toBeGreaterThan(.095);expect(at(data,n,x,.16)).toBeCloseTo(.044,5)}
  await dig(sand,{x:0,y:-.04},{x:0,y:.24})
  data=await read(sand.state,sand.byteLength)
  for(let z=.07;z<.14;z+=.008)expect(at(data,n,0,z)).toBeLessThan(.008)
  expect(at(data,n,.2,.1)).toBeGreaterThan(.095)
  expect(errors).toEqual([])
 }finally{molds.dispose();sand.dispose()}
})
test('a single actual shovel sweep connects the sea to an inland channel while untouched beach stays dry',async()=>{
 const n=256,sand=new SandSolver(device,n),water=new WaterSolver(device,sand,128)
 try{
  await sand.initialize();await water.initialize()
  sand.resetWithTerrain((_x,z)=>tideTerrainHeight(z,TIDE.shoreZ))
  await dig(sand,{x:.1,y:-.33},{x:.1,y:.30})
  let bed=await read(sand.state,sand.byteLength)
  // Meaningful storage across the shovel's middle, not just a thin centre dimple.
  for(const x of [.085,.1,.115])expect(at(bed,n,x,.15)).toBeLessThan(-.025)
  water.writeParams([],WATER.step,{shore:TIDE.shoreZ,level:TIDE.lowLevel,drift:0,waveHeight:0})
  for(let i=0;i<300;i++){
   const e=device.createCommandEncoder();sand.encode(e,[[],[]]);water.encode(e,sand.stateIndex);device.queue.submit([e.finish()])
  }
  const wet=await read(water.state,water.byteLength);bed=await read(sand.state,sand.byteLength)
  const inChannel=at(wet,128,.1,.15), untouched=at(wet,128,-.15,.15)
  console.log('Player-dug sea channel:',{inChannel,untouched,bed:at(bed,n,.1,.15)})
  expect(inChannel).toBeGreaterThan(.005)
  expect(untouched).toBeLessThan(.0001)
  expect(at(bed,n,.1,.15)).toBeLessThan(-.020)
  expect(errors).toEqual([])
 }finally{water.dispose();sand.dispose()}
},60_000)
