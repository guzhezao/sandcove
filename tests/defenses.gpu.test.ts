import {afterAll,beforeAll,expect,test} from 'vitest'
import {create,globals} from 'webgpu'
import {SAND,WATER} from '../src/config'
import {SandSolver} from '../src/simulation/solver'
import {WaterSolver} from '../src/simulation/water-solver'
Object.assign(globalThis,globals)
const gpu=create([])
let device:GPUDevice
const errors:string[]=[]
beforeAll(async()=>{const a=await gpu.requestAdapter();device=await a!.requestDevice();device.addEventListener('uncapturederror',e=>errors.push(e.error.message))})
afterAll(()=>device.destroy())

// A finite, identical parcel isolates storage/diversion from the replenishing
// ocean boundary. Erosion is deliberately off: this measures the terrain's
// hydraulic effect separately from its strength under an impact.
async function parcel(defense:'flat'|'wall'|'moat'){
 const n=128,sand=new SandSolver(device,n),water=new WaterSolver(device,sand,n)
 const staging=device.createBuffer({size:water.byteLength,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})
 try{
  await water.initialize()
  const bed=new Float32Array(n*n*4),initial=new Float32Array(n*n*4)
  let before=0
  for(let z=0;z<n;z++)for(let x=0;x<n;x++){
   const world=((z+.5)/n-.5)*SAND.extent,i=(z*n+x)*4
   bed[i]=defense==='wall'&&Math.abs(world)<.05?.160:defense==='moat'&&Math.abs(world)<.085?-.096:.044
   initial[i]=world<-.15&&world>-.45?.08:0;before+=initial[i]
  }
  for(const b of sand.buffers)device.queue.writeBuffer(b,0,bed)
  for(const b of water.buffers)device.queue.writeBuffer(b,0,initial)
  // Coastal transport with its reservoir outside the closed test basin.
  water.writeParams([],WATER.step,{shore:-2,level:.124,drift:0,waveHeight:0})
  for(let frame=0;frame<720;frame+=30){const e=device.createCommandEncoder();for(let i=0;i<30;i++)water.encode(e);device.queue.submit([e.finish()])}
  const e=device.createCommandEncoder();e.copyBufferToBuffer(water.state,0,staging,0,water.byteLength);device.queue.submit([e.finish()])
  await staging.mapAsync(GPUMapMode.READ);const wet=new Float32Array(staging.getMappedRange()).slice();staging.unmap()
  let after=0,behind=0,stored=0,peak=0
  for(let z=0;z<n;z++)for(let x=0;x<n;x++){
   const d=wet[(z*n+x)*4],world=((z+.5)/n-.5)*SAND.extent
   expect(Number.isFinite(d)&&d>=0).toBe(true)
   after+=d;if(world>.15)behind+=d;if(Math.abs(world)<.085)stored+=d;peak=Math.max(peak,d)
  }
  const cellArea=(SAND.extent/n)**2
  return {before:before*cellArea,after:after*cellArea,behind:behind*cellArea,stored:stored*cellArea,peak}
 }finally{staging.destroy();water.dispose();sand.dispose()}
}
test('walls block a finite water pulse; deep moats store it without deleting water',async()=>{
 const flat=await parcel('flat'),wall=await parcel('wall'),moat=await parcel('moat')
 console.log('Equal-volume defense comparison at 12 seconds:',JSON.stringify({flat,wall,moat}))
 for(const sample of [flat,wall,moat])expect(Math.abs(sample.after/sample.before-1)).toBeLessThan(.0001)
 expect(flat.behind).toBeGreaterThan(.001)
 expect(wall.behind).toBeLessThan(flat.behind*.01)
 expect(moat.behind).toBeLessThan(flat.behind*.25)
 expect(moat.stored).toBeGreaterThan(moat.before*.55)
 expect(moat.peak).toBeGreaterThan(.075)
 expect(errors).toEqual([])
},60_000)
