import { SAND } from '../config'
import { checkedShader } from '../platform/shader'
import type { SandSolver } from './solver'
import type { WaterSolver } from './water-solver'
import { CASTLE } from '../starter'

export const HUTS = [[-.11,CASTLE.centerZ-.08],[.11,CASTLE.centerZ-.08]] as const
// Part centres and the angle at which each panel falls. Geometry shares this order.
export const HUT_PARTS = [
  [0,.024,.006,.16], [0,.055,.028,1.45], [0,.055,-.028,-1.45],
  [-.032,.051,0,1.32], [.032,.051,0,-1.32],
  [-.021,.090,0,.70], [.021,.090,0,-.70], [0,.012,.058,.42],
  [-.03,.023,.012,1.4], [.03,.023,.012,-1.4],
] as const
export const BODY_FLOATS = 20
export const bodyStruct = `struct Body { root:vec4f, pivot:vec4f, position:vec4f, state:vec4f, motion:vec4f }`

const physicsShader = `
${bodyStruct}
struct Params { grid:vec4f }
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> bed:array<vec4f>;
@group(0) @binding(2) var<storage,read> water:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> bodies:array<Body>;
fn sampleBed(p:vec2f)->f32 {
 let n=u32(params.grid.x);let q=vec2u(clamp((p/params.grid.z+.5)*f32(n),vec2f(0),vec2f(f32(n),f32(arrayLength(&bed)/n))-1.0));
 return bed[q.y*n+q.x].x;
}
fn sampleWater(p:vec2f)->vec4f {
 let n=u32(params.grid.y);let q=vec2u(clamp((p/params.grid.z+.5)*f32(n),vec2f(0),vec2f(f32(n),f32(arrayLength(&water)/n))-1.0));
 return water[q.y*n+q.x];
}
@compute @workgroup_size(32) fn update(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=arrayLength(&bodies)){return;}
 var b=bodies[id.x];let dt=params.grid.w;
 let ground=sampleBed(b.root.xy);
 if(b.state.w==0.0){b.state.z=ground;b.state.w=1.0;}
 if(b.state.y==0.0){
  // Pressure is sampled at the foundation, not from a global tide timer.
  // Sheltered houses stay intact; progressive scour also removes support.
  var wet=sampleWater(b.root.xy);
  for(var k=0u;k<4u;k++){
   let offset=vec2f(select(-.032,.032,(k&1u)!=0u),select(-.026,.026,(k&2u)!=0u));
   let w=sampleWater(b.root.xy+offset);if(w.x>wet.x){wet=w;}
  }
  let flow=min(length(wet.yz),.4);
  let load=smoothstep(.009,.045,wet.x)*(.045+flow*4.5)+smoothstep(.035,.085,wet.x)*.45;
  let scour=smoothstep(.014,.045,b.state.z-ground)*.65;
  b.position.w=min(2.0,b.position.w+(load+scour)*dt);
  b.position=vec4f(b.root.x+b.pivot.x,ground+b.pivot.y,b.root.y+b.pivot.z,b.position.w);
  if(b.position.w>=b.root.z){
   b.state.y=1.0;
   b.motion=vec4f(wet.yz*.7+b.pivot.xz*.9+vec2f(sin(b.root.w),cos(b.root.w))*.016,b.motion.zw);
  }
 }else{
  b.state.x+=dt;
  let wet=sampleWater(b.position.xz);let afloat=smoothstep(.002,.015,wet.x);
  b.motion=vec4f(mix(b.motion.xy,wet.yz*.8,1.0-exp(-dt*2.4))*exp(-dt*(1.0-afloat)*5.0),b.motion.zw);
  let edge=params.grid.z*.5-.015;
  b.position.x=clamp(b.position.x+b.motion.x*dt,-edge,edge);
  let rear=f32(arrayLength(&bed)/u32(params.grid.x))*params.grid.z/params.grid.x-params.grid.z*.5-.015;
  b.position.z=clamp(b.position.z+b.motion.y*dt,-edge,rear);
  let floor=sampleBed(b.position.xz);
  let floatHeight=floor+max(0.0,wet.x-.002)+.009;
  b.position.y=mix(b.position.y,floatHeight,1.0-exp(-dt*4.0));
  b.motion.z+=dt*afloat*(sin(b.root.w)*.32+length(wet.yz)*1.5);
 }
 bodies[id.x]=b;
}`

/** Twenty light props, simulated beside the GPU water without a grid readback. */
export class SceneryPhysics {
  readonly bodies: GPUBuffer
  private readonly uniform: GPUBuffer
  private pipeline!: GPUComputePipeline
  private groups: GPUBindGroup[][] = []
  private readonly device: GPUDevice
  private readonly sand: SandSolver
  private readonly water: WaterSolver
  constructor(device:GPUDevice,sand:SandSolver,water:WaterSolver) {
    this.device=device;this.sand=sand;this.water=water
    this.bodies=device.createBuffer({label:'Breakable beach hut parts',size:HUTS.length*HUT_PARTS.length*BODY_FLOATS*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC})
    this.uniform=device.createBuffer({label:'Scenery step',size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    this.reset()
  }
  async initialize() {
    const module=await checkedShader(this.device,'Breakable scenery WGSL',physicsShader)
    this.pipeline=await this.device.createComputePipelineAsync({label:'Water damage and floating debris',layout:'auto',compute:{module,entryPoint:'update'}})
    this.groups=this.sand.buffers.map(bed=>this.water.buffers.map(water=>this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:bed}},
      {binding:2,resource:{buffer:water}},{binding:3,resource:{buffer:this.bodies}},
    ]})))
  }
  reset() {
    const data=new Float32Array(HUTS.length*HUT_PARTS.length*BODY_FLOATS)
    HUTS.forEach(([x,z],house)=>HUT_PARTS.forEach((pivot,part)=>{
      const i=house*HUT_PARTS.length+part,o=i*BODY_FLOATS
      data.set([x,z,.78+part*.025,i*2.399],o)
      data.set(pivot,o+4)
      data.set([x+pivot[0],SAND.depth+pivot[1],z+pivot[2],0],o+8)
    }))
    this.device.queue.writeBuffer(this.bodies,0,data)
  }
  encode(encoder:GPUCommandEncoder,dt:number) {
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([this.sand.resolution,this.water.resolution,SAND.extent,Math.min(dt,.05)]))
    const pass=encoder.beginComputePass({label:'Scenery water response'})
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.groups[this.sand.stateIndex][this.water.stateIndex]);pass.dispatchWorkgroups(1);pass.end()
  }
  dispose(){this.bodies.destroy();this.uniform.destroy()}
}
