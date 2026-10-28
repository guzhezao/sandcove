import {SAND} from '../config'
import {checkedShader} from '../platform/shader'
import type {SandSolver} from './solver'
import type {WaterSolver} from './water-solver'
import {HUTS} from './scenery-physics'
import {CASTLE} from '../starter'

export const BEACHGOERS = [[0,.045],[-.105,.075],[.105,.075],[-.05,.112],[.05,.112]]
  .map(([x,z])=>[x,CASTLE.centerZ+z] as const)
export const BOATS = [[-.20,-.325],[.17,-.305]] as const
export const ACTOR_FLOATS = 16
export const actorStruct = `struct Actor { home:vec4f, pose:vec4f, velocity:vec4f, status:vec4f }`
// status.x: 0 stroll / 1 flee / 2 swept away / 3 stranded; status.z: time fallen.
const lifeShader = `
${actorStruct}
struct Params { grid:vec4f }
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> bed:array<vec4f>;
@group(0) @binding(2) var<storage,read> water:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> actors:array<Actor>;
fn ground(p:vec2f)->f32 {
 let n=u32(params.grid.x);let bounds=vec2f(f32(n),f32(arrayLength(&bed)/n))-1.001;
 let uv=clamp((p/params.grid.z+.5)*f32(n)-.5,vec2f(0),bounds);
 let q=vec2u(uv);let f=fract(uv);
 return mix(mix(bed[q.y*n+q.x].x,bed[q.y*n+q.x+1u].x,f.x),
 mix(bed[(q.y+1u)*n+q.x].x,bed[(q.y+1u)*n+q.x+1u].x,f.x),f.y);
}
fn wetAt(p:vec2f)->vec4f {
 let n=u32(params.grid.y);let q=vec2u(clamp((p/params.grid.z+.5)*f32(n),vec2f(0),vec2f(f32(n),f32(arrayLength(&water)/n))-1.0));
 return water[q.y*n+q.x];
}
fn bounded(p:vec2f)->vec2f{let limit=params.grid.z*.5-.037;return clamp(p,vec2f(-limit),vec2f(limit,f32(arrayLength(&bed)/u32(params.grid.x))*params.grid.z/params.grid.x-params.grid.z*.5-.037));}
fn hutDistance(p:vec2f)->f32 {
 let a=length(max(abs(p-vec2f(${HUTS[0].join(',')}))-vec2f(.045,.076),vec2f(0)));
 let b=length(max(abs(p-vec2f(${HUTS[1].join(',')}))-vec2f(.045,.076),vec2f(0)));
 return min(a,b);
}
@compute @workgroup_size(32) fn update(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=arrayLength(&actors)){return;}
 var a=actors[id.x];let dt=params.grid.w;let seed=a.home.w;
 a.velocity.w+=dt;let time=a.velocity.w;
 var pos=a.pose.xz;let bedY=ground(pos);let wet=wetAt(pos);let speed=length(wet.yz);
 a.status.w=wet.x;
 if(a.home.z>0.5){
  // Moored at low water, with slack rope; a strong advancing current breaks it.
  if((wet.x>.065 && speed>.05) || wet.x>.105){a.status.y=1.0;}
  let afloat=smoothstep(.002,.009,wet.x);
  let slack=a.home.xy+vec2f(sin(time*.6+seed)*.008,cos(time*.5+seed)*.006);
  var drift=wet.yz*.85;
  if(a.status.y<1.0){drift=(slack-pos)*2.0+wet.yz*.04;}
  a.velocity=vec4f(mix(a.velocity.xy,drift,1.0-exp(-dt*2.3))*afloat,a.velocity.zw);
  let boatStep=bounded(pos+a.velocity.xy*dt);
  let ahead=boatStep+normalize(a.velocity.xy+vec2f(.000001,0))*.018;
  if(ground(ahead)>bedY+wet.x+.004){a.velocity=vec4f(a.velocity.xy*.05,a.velocity.zw);}
  else{pos=boatStep;}
  a.pose=vec4f(pos.x,ground(pos)+max(.005,wetAt(pos).x)+.001,pos.y,a.pose.w);
  a.pose.w+=dt*(a.velocity.x*.8+sin(time*.7+seed)*.065*afloat);
  a.status.x=select(3.0,0.0,wetAt(pos).x>.004);
 }else{
  // Exposure and a collapsing patch underfoot can knock a tiny beachgoer over.
  let hit=smoothstep(.009,.032,wet.x)*(speed*8.0+.15)+smoothstep(.030,.060,wet.x)*1.5;
  a.status.y=clamp(a.status.y+dt*(hit-select(.12,0.0,wet.x>.005)),0.0,2.0);
  let undermined=time>dt*1.5 && a.pose.y-.023-bedY>.020;
  if(a.status.x<2.0 && (a.status.y>.22 || undermined)){a.status.x=2.0;a.status.z=0.0;}
  if(a.status.x>=2.0){
   a.status.z+=dt;
   let afloat=smoothstep(.002,.012,wet.x);
   a.velocity=vec4f(mix(a.velocity.xy,wet.yz*.96,1.0-exp(-dt*3.0))*exp(-dt*(1.0-afloat)*8.0),a.velocity.zw);
   pos=bounded(pos+a.velocity.xy*dt);
   let waterHere=wetAt(pos);
   a.pose=vec4f(pos.x,mix(a.pose.y,ground(pos)+max(0.0,waterHere.x-.001)+.007,1.0-exp(-dt*7.0)),pos.y,a.pose.w);
   if(speed>.012){
    let direction=atan2(wet.y,wet.z);
    a.pose.w+=atan2(sin(direction-a.pose.w),cos(direction-a.pose.w))*min(1.0,dt*3.0);
   }
   a.status.x=select(3.0,2.0,waterHere.x>.004 || a.status.z<.8);
  }else{
   let incoming=wetAt(pos+vec2f(0,select(-.035,-.055,a.status.x==1.0)));
   let danger=wet.x>.003 || incoming.x>.010;
   a.status.x=select(0.0,1.0,danger);
   let theta=time*.35+seed;
   // Stroll inside the courtyard; fleeing and water transport can leave it.
   let destination=clamp(a.home.xy+vec2f(sin(theta)*.035,cos(theta*.8)*.018),vec2f(-.19,${CASTLE.centerZ-.125}),vec2f(.19,${CASTLE.centerZ+.125}));
   let remaining=length(destination-pos);
   var desired=normalize(destination-pos+vec2f(.000001,0));
   if(danger){
    let wx=wetAt(pos+vec2f(-.018,0)).x-wetAt(pos+vec2f(.018,0)).x;
    let wz=wetAt(pos+vec2f(0,-.018)).x-wetAt(pos+vec2f(0,.018)).x;
    desired=normalize(vec2f(wx,wz+.015));
   }
   var best=-10000.0;var direction=vec2f(0);
   // Look ahead around pits/walls and cabins; a blocked actor waits instead of teleporting.
   let heading=atan2(desired.x,desired.y);
   for(var k=0u;k<13u;k++){
    // First try the exact destination direction, then fan around obstacles.
    let side=select(-1.0,1.0,k%2u==1u);
    let angle=heading+ceil(f32(k)*.5)*.4833219*side;
    let d=vec2f(sin(angle),cos(angle));let q=pos+d*.018;
    let heightChange=ground(q)-bedY;
    if((any(q<vec2f(-params.grid.z*.5+.035)) || q.x>params.grid.z*.5-.035 || q.y>f32(arrayLength(&bed)/u32(params.grid.x))*params.grid.z/params.grid.x-params.grid.z*.5-.035) || abs(heightChange)>.010 || hutDistance(q)<.008){continue;}
    let continuity=dot(d,normalize(a.velocity.xy+desired*.001));
    let score=dot(d,desired)+continuity*.16-wetAt(q).x*select(10.0,65.0,danger)-abs(heightChange)*12.0;
    if(score>best){best=score;direction=d;}
   }
   let arrival=select(smoothstep(.001,.013,remaining),1.0,danger);
   let walkSpeed=select(.012,.043,danger)*arrival;
   // Smooth acceleration and turns, without carrying someone through a wall.
   var movement=mix(a.velocity.xy,direction*walkSpeed,1.0-exp(-dt*select(7.0,12.0,danger)));
   let ahead=pos+normalize(movement+vec2f(.000001,0))*.012;
   if(abs(ground(ahead)-bedY)>.010 || hutDistance(ahead)<.008){movement=vec2f(0);}
   let next=bounded(pos+movement*dt);
   if(abs(ground(next)-bedY)<.010 && hutDistance(next)>=.008){pos=next;}
   else{movement=vec2f(0);}
   a.velocity=vec4f(movement,a.velocity.z+length(movement)*dt*420.0,time);
   if(length(movement)>.0005){
    let facing=atan2(movement.x,movement.y);
    a.pose.w+=atan2(sin(facing-a.pose.w),cos(facing-a.pose.w))*(1.0-exp(-dt*7.0));
   }
   a.pose=vec4f(pos.x,mix(a.pose.y,ground(pos)+.023,1.0-exp(-dt*18.0)),pos.y,a.pose.w);
  }
 }
 actors[id.x]=a;
}`

export class BeachLife {
  readonly actors:GPUBuffer
  private readonly uniform:GPUBuffer
  private pipeline!:GPUComputePipeline
  private groups:GPUBindGroup[][]=[]
  private readonly device:GPUDevice
  private readonly sand:SandSolver
  private readonly water:WaterSolver
  constructor(device:GPUDevice,sand:SandSolver,water:WaterSolver){
    this.device=device;this.sand=sand;this.water=water
    this.actors=device.createBuffer({label:'Beachgoers and boats',size:(BEACHGOERS.length+BOATS.length)*ACTOR_FLOATS*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST})
    this.uniform=device.createBuffer({label:'Beach life step',size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    this.reset()
  }
  async initialize(){
    const module=await checkedShader(this.device,'Beach life WGSL',lifeShader)
    this.pipeline=await this.device.createComputePipelineAsync({label:'Walk, flee, tumble and float',layout:'auto',compute:{module,entryPoint:'update'}})
    this.groups=this.sand.buffers.map(bed=>this.water.buffers.map(water=>this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:bed}},{binding:2,resource:{buffer:water}},{binding:3,resource:{buffer:this.actors}},
    ]})))
  }
  reset(){
    const data=new Float32Array((BEACHGOERS.length+BOATS.length)*ACTOR_FLOATS)
    ;[...BEACHGOERS,...BOATS].forEach(([x,z],i)=>{
      const boat=i>=BEACHGOERS.length
      data.set([x,z,boat?1:0,i*1.618+1,x,SAND.depth+(boat?.005:.023),z,boat?.5:i*.9],i*ACTOR_FLOATS)
    })
    this.device.queue.writeBuffer(this.actors,0,data)
  }
  encode(encoder:GPUCommandEncoder,dt:number){
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([this.sand.resolution,this.water.resolution,SAND.extent,Math.min(.05,dt)]))
    const pass=encoder.beginComputePass({label:'Beach life'})
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.groups[this.sand.stateIndex][this.water.stateIndex]);pass.dispatchWorkgroups(1);pass.end()
  }
  dispose(){this.actors.destroy();this.uniform.destroy()}
}
