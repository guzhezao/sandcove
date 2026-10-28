import { WATER } from '../config'
import { checkedShader } from '../platform/shader'
import type { SandSolver } from '../simulation/solver'
import type { WaterSolver } from '../simulation/water-solver'
import type { MoldStamp } from '../simulation/molds'
import { starterCastle } from '../starter'
import { SceneryPhysics, bodyStruct, HUTS, HUT_PARTS } from '../simulation/scenery-physics'
import { BeachLife, actorStruct, BEACHGOERS, BOATS } from '../simulation/beach-life'
import { GLINT_FORMAT, HDR_SCENE_FORMAT } from './postprocess'

type V3 = [number, number, number]
type Color = [number, number, number, number]

// All props are world-space meshes. Their roots sample the current sand bed
// on the GPU, so a flag follows its tower as it is dug away or eroded.
export const sceneryShader = `
struct View { eye:vec4f, forward:vec4f, right:vec4f, up:vec4f, light:vec4f,
 grid:vec4f, pointer:vec4f, shadowBounds:vec4f, shadowControl:vec4f }
@group(0) @binding(0) var<uniform> view:View;
@group(0) @binding(1) var<storage,read> bed:array<vec4f>;
@group(0) @binding(2) var<storage,read> water:array<vec4f>;
${bodyStruct}
@group(0) @binding(3) var<storage,read> bodies:array<Body>;
${actorStruct}
@group(0) @binding(4) var<storage,read> actors:array<Actor>;
fn rotate(p:vec3f,angles:vec3f)->vec3f {
 let a=vec3f(p.x,p.y*cos(angles.x)-p.z*sin(angles.x),p.y*sin(angles.x)+p.z*cos(angles.x));
 let b=vec3f(a.x*cos(angles.y)+a.z*sin(angles.y),a.y,-a.x*sin(angles.y)+a.z*cos(angles.y));
 return vec3f(b.x*cos(angles.z)-b.y*sin(angles.z),b.x*sin(angles.z)+b.y*cos(angles.z),b.z);
}
fn ground(p:vec2f)->f32 {
 let n=u32(view.grid.x); let uv=clamp((p/view.grid.y+.5)*view.grid.x-.5,vec2f(0),vec2f(view.grid.x,f32(arrayLength(&bed)/n))-1.001);
 let q=vec2u(uv); let f=fract(uv);
 return mix(mix(bed[q.y*n+q.x].x,bed[q.y*n+q.x+1u].x,f.x),
 mix(bed[(q.y+1u)*n+q.x].x,bed[(q.y+1u)*n+q.x+1u].x,f.x),f.y);
}
struct In { @location(0) p:vec3f, @location(1) n:vec3f, @location(2) color:vec4f, @location(3) root:vec4f }
struct Out { @builtin(position) position:vec4f, @location(0) color:vec4f, @location(1) normal:vec3f, @location(2) wet:f32 }
@vertex fn vertex(v:In)->Out {
 let time=view.shadowControl.y;
 let wn=${WATER.resolution}u; let waterBounds=vec2f(f32(wn),f32(arrayLength(&water)/wn))-1.0;
 let wc=vec2u(clamp((v.root.xy/view.grid.y+.5)*f32(wn),vec2f(0),waterBounds));
 var wet=water[wc.y*wn+wc.x];
 var local=v.p;
 if(v.root.z==1.0 || v.root.z==8.0){
  let bend=local.y*local.y*11.0;
  local.x+=sin(time*1.7+v.root.w)*bend*.25;
  local.z+=bend*(.35+min(length(wet.yz)*8.0,1.5));
  if(v.root.z==8.0){
   local.x+=sin(time*2.1+local.y*75.0+v.root.w)*local.y*.18+wet.y*local.y*.7;
   local.z+=cos(time*1.7+v.root.w+local.y*50.0)*local.y*.15;
  }
 }
 if(v.root.z==2.0){
  let flutter=clamp(local.x/.035,0.0,1.0);
  local.z+=sin(local.x*140.0-time*5.2+v.root.w)*.0035*flutter;
  local.y+=sin(local.x*90.0-time*3.8+v.root.w)*.0015*flutter;
 }
 var height=ground(v.root.xy);
 if(v.root.z==3.0 || v.root.z==6.0){height=ground(v.root.xy+local.xz);}
 var normal=v.n;var color=v.color;
 var world=vec3f(v.root.x+local.x,height+local.y,v.root.y+local.z);
 if(v.root.z==5.0 || v.root.z==9.0 || (v.root.z>=11.0 && v.root.z<=15.0)){
  let actor=actors[u32(v.root.w)];let pos=actor.pose.xyz;
  let q=vec2u(clamp((pos.xz/view.grid.y+.5)*f32(wn),vec2f(0),waterBounds));
  wet=water[q.y*wn+q.x];
  if(v.root.z==9.0){
   let bob=sin(time*2.3+actor.home.w)*.0018*smoothstep(.002,.015,wet.x);
   let roll=select(sin(time*1.9+actor.home.w)*.065+clamp(wet.y*1.5,-.24,.24),.30,actor.status.x==3.0);
   let angles=vec3f(sin(time*2.1+actor.home.w)*.045,actor.pose.w,roll);
   world=pos+vec3f(0,bob,0)+rotate(local,angles);normal=rotate(normal,angles);
  }else if(v.root.z==11.0){
   world=vec3f(pos.x+local.x,ground(pos.xz+local.xz)+.001,pos.z+local.z);
   color.a*=1.0-smoothstep(.002,.012,wet.x);
  }else{
   let fallen=smoothstep(0.0,.65,actor.status.z);
   let walking=smoothstep(.0005,.007,length(actor.velocity.xy))*select(0.0,1.0,actor.status.x<2.0);
   let swing=sin(actor.velocity.z)*.65*walking;
   if(v.root.z==12.0){
    let hip=vec3f(sign(local.x)*.0032,.015,0);
    let angle=vec3f(swing*sign(local.x),0,0);
    local=hip+rotate(local-hip,angle);normal=rotate(normal,angle);
   }
   if(v.root.z==13.0){
    let shoulder=vec3f(sign(local.x)*.008,.029,0);
    let angle=vec3f(-swing*sign(local.x)*.7,0,0);
    local=shoulder+rotate(local-shoulder,angle);normal=rotate(normal,angle);
   }
   let pitch=fallen*1.48;
   let roll=fallen*(.18*sin(time*2.2+actor.home.w))*smoothstep(.003,.02,wet.x);
   let angles=vec3f(pitch,actor.pose.w,roll);
   world=pos+rotate(local-vec3f(0,.023,0),angles);normal=rotate(normal,angles);
   if((v.root.z==14.0 || v.root.z==15.0) && actor.status.x>=2.0){
    // A loose hat and bucket trail behind, making the impact visible after the wave.
    let isHat=v.root.z==14.0;let spread=min(1.0,actor.status.z*1.4);
    let offset=vec2f(select(-.020,.024,isHat),select(.022,-.015,isHat))*spread;
    let limit=view.grid.y*.5-.020;
    let location=clamp(pos.xz+offset,vec2f(-limit),vec2f(limit,f32(arrayLength(&bed)/u32(view.grid.x))*view.grid.y/view.grid.x-view.grid.y*.5-.020));
    let cell=vec2u(clamp((location/view.grid.y+.5)*f32(wn),vec2f(0),waterBounds));
    let looseWet=water[cell.y*wn+cell.x].x;
    let origin=select(vec3f(.012,.009,.001),vec3f(0,.047,0),isHat);
    let loose=vec3f(location.x,ground(location)+looseWet+.004,location.y)+rotate(local-origin,vec3f(.24,actor.pose.w+.7,select(.8,0.0,isHat)));
    world=mix(world,loose,spread);
   }
  }
 }
 if(v.root.z==10.0 || v.root.z==16.0){
  let phase=time*.32+v.root.w*2.0;
  let flight=vec3f(v.root.x+cos(phase)*.10,.340+v.root.w*.020+.022*sin(phase*.7+v.root.w),v.root.y+sin(phase)*.07);
  // Broad wings flap at the shoulder; dark tips flex more than the body.
  local.y+=sin(time*5.5+v.root.w)*max(0.0,abs(local.x)-.004)*.55;
  let angles=vec3f(0,-phase,cos(phase)*.13);
  world=flight+rotate(local,angles);normal=rotate(normal,angles);
  if(v.root.z==16.0){
   let shadowPos=flight.xz+local.xz+vec2f(.025,.015);
   world=vec3f(shadowPos.x,ground(shadowPos)+.001,shadowPos.y);color=vec4f(.20,.24,.20,.14);
  }
 }
 if(v.root.z==4.0){
  let b=bodies[u32(v.root.w)];
  if(b.state.y>0.5){
   let fallen=smoothstep(0.0,1.1,b.state.x);
   let angles=vec3f(b.pivot.w*fallen,b.motion.z,.32*sin(b.root.w)*fallen);
   world=b.position.xyz+rotate(local-b.pivot.xyz,angles);normal=rotate(normal,angles);
  }else{
   let sway=sin(time*8.0+b.root.w)*.018*min(b.position.w,1.0);
   world.x+=local.y*sway;
  }
 }
 if(v.root.z==6.0){color.a*=1.0-smoothstep(.3,.9,bodies[u32(v.root.w)].position.w);}

 let relative=world-view.eye.xyz; let depth=dot(relative,view.forward.xyz);
 var o:Out;
 o.position=vec4f(dot(relative,view.right.xyz)/(view.eye.w*view.forward.w),dot(relative,view.up.xyz)/view.eye.w,depth*1.001001-.01001001,depth);
 o.normal=normal;o.color=color;o.wet=smoothstep(.001,.018,wet.x)*(1.0-smoothstep(.0,.06,local.y));return o;
}
struct Fragment { @location(0) color:vec4f, @location(1) glint:f32 }
@fragment fn fragment(v:Out)->Fragment {
 if(v.color.a<.01){discard;}
 var o:Fragment;let light=.60+.40*max(0.0,dot(normalize(v.normal),normalize(view.light.xyz)));
 o.color=vec4f(v.color.rgb*light*(1.0-v.wet*.24),v.color.a);o.glint=0.0;return o;
}`

class Mesh {
  data: number[] = []
  anchor: [number, number, number, number] = [0, 0, 0, 0]
  tri(a: V3, b: V3, c: V3, color: Color) {
    const u = b.map((v, i) => v - a[i]!)
    const v = c.map((q, i) => q - a[i]!)
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
    const length = Math.hypot(...n) || 1
    for (const p of [a, b, c]) this.data.push(...p, ...n.map(q => q / length), ...color, ...this.anchor)
  }
  quad(a: V3, b: V3, c: V3, d: V3, color: Color) { this.tri(a, b, c, color); this.tri(a, c, d, color) }
  box(x: number, y: number, z: number, w: number, h: number, d: number, color: Color) {
    const a = x - w / 2, b = x + w / 2, c = z - d / 2, e = z + d / 2, t = y + h
    this.quad([a,y,e],[b,y,e],[b,t,e],[a,t,e],color)
    this.quad([b,y,c],[a,y,c],[a,t,c],[b,t,c],color)
    this.quad([a,y,c],[a,y,e],[a,t,e],[a,t,c],color)
    this.quad([b,y,e],[b,y,c],[b,t,c],[b,t,e],color)
    this.quad([a,t,e],[b,t,e],[b,t,c],[a,t,c],color)
  }
  ellipsoid(center:V3,radius:V3,color:Color) {
    const p=(a:number,b:number):V3=>[center[0]+Math.cos(a)*Math.sin(b)*radius[0],center[1]+Math.cos(b)*radius[1],center[2]+Math.sin(a)*Math.sin(b)*radius[2]]
    for(let j=0;j<6;j++)for(let i=0;i<10;i++){
      const a=i*Math.PI/5,b=(i+1)*Math.PI/5,c=j*Math.PI/6,d=(j+1)*Math.PI/6
      this.quad(p(a,c),p(a,d),p(b,d),p(b,c),color)
    }
  }
  ring(y:number,color:Color) {
    const p=(a:number,b:number):V3=>[Math.cos(a)*(.010+Math.cos(b)*.003),y+Math.sin(b)*.003,Math.sin(a)*(.010+Math.cos(b)*.003)]
    for(let i=0;i<16;i++)for(let j=0;j<6;j++){
      const a=i*Math.PI/8,b=(i+1)*Math.PI/8,c=j*Math.PI/3,d=(j+1)*Math.PI/3
      this.quad(p(a,c),p(b,c),p(b,d),p(a,d),i%4<2?color:[.95,.88,.72,1])
    }
  }
  shadow(rx: number, rz: number) {
    const kind = this.anchor[2]; this.anchor[2] = 3
    for (let i=0;i<20;i++) {
      const a=i*Math.PI/10,b=(i+1)*Math.PI/10
      this.tri([0,.001,0],[Math.cos(a)*rx,.001,Math.sin(a)*rz],[Math.cos(b)*rx,.001,Math.sin(b)*rz],[.21,.17,.09,.23])
    }
    this.anchor[2] = kind
  }
}

function beachHut(m: Mesh, house:number, roof: Color, trim: Color) {
  const [x,z]=HUTS[house],base=house*HUT_PARTS.length
  m.anchor=[x,z,6,base]
  // Shadow follows the foundation and fades as its house breaks apart.
  for(let i=0;i<20;i++)m.tri([0,.001,0],[Math.cos(i*Math.PI/10)*.065,.001,Math.sin(i*Math.PI/10)*.061],[Math.cos((i+1)*Math.PI/10)*.065,.001,Math.sin((i+1)*Math.PI/10)*.061],[.21,.17,.09,.23])
  const part=(id:number)=>{m.anchor=[x,z,4,base+id]}
  const wood:Color=[.46,.30,.14,1],ivory:Color=[.88,.77,.55,1],dark:Color=[.055,.11,.12,1]
  part(0);m.box(0,.021,.006,.082,.006,.079,wood)
  part(1);m.box(0,.027,.027,.065,.048,.003,ivory)
  for(let i=-3;i<=3;i++)m.box(i*.009,.028,.029,.003,.046,.001,trim)
  m.box(0,.027,.030,.017,.034,.004,trim);m.box(0,.031,.0325,.011,.026,.0015,dark)
  for(const dx of [-.021,.021]){
    m.box(dx,.046,.030,.015,.015,.002,trim);m.box(dx,.049,.0315,.010,.009,.001,dark);m.box(dx,.049,.032,.0015,.009,.001,ivory)
  }
  m.tri([-.033,.075,.028],[.033,.075,.028],[0,.106,.028],ivory)
  part(2);m.box(0,.027,-.027,.065,.048,.003,ivory)
  m.tri([.033,.075,-.028],[-.033,.075,-.028],[0,.106,-.028],ivory)
  part(3);m.box(-.031,.027,0,.003,.048,.056,trim)
  part(4);m.box(.031,.027,0,.003,.048,.056,trim)
  part(5);m.quad([-.042,.073,-.038],[-.042,.073,.038],[0,.108,.038],[0,.108,-.038],roof)
  part(6);m.quad([0,.108,-.038],[0,.108,.038],[.042,.073,.038],[.042,.073,-.038],roof)
  for(let i=0;i<7;i++){
    const zz=-.034+i*.011,c:Color=[roof[0]*.8,roof[1]*.8,roof[2]*.8,1]
    part(5);m.tri([-.042,.0735,zz],[0,.1085,zz],[0,.1085,zz+.0015],c)
    part(6);m.tri([0,.1085,zz],[.042,.0735,zz],[.042,.0735,zz+.0015],c)
  }
  part(7);for(let i=0;i<3;i++)m.box(0,.002+i*.006,.069-i*.010,.026,.006,.013,ivory)
  for(const [i,dx] of [-.030,.030].entries()){
    part(8+i)
    for(const dz of [-.025,.025])m.box(dx,0,dz,.006,.027,.006,wood)
    for(const dz of [.031,.049])m.box(dx,.025,dz,.003,.018,.003,ivory)
    m.box(dx,.041,.040,.003,.003,.024,ivory)
  }
}

function beachgoer(m:Mesh,id:number,shirt:Color,hat:boolean) {
  const [x,z]=BEACHGOERS[id],seed=id+1
  m.anchor=[x,z,11,id]
  for(let i=0;i<16;i++)m.tri([0,.001,0],[Math.cos(i*Math.PI/8)*.012,.001,Math.sin(i*Math.PI/8)*.008],[Math.cos((i+1)*Math.PI/8)*.012,.001,Math.sin((i+1)*Math.PI/8)*.008],[.21,.17,.09,.20])
  m.anchor[2]=12
  const skin:Color=seed%2?[.76,.45,.27,1]:[.95,.68,.44,1],navy:Color=[.12,.24,.28,1]
  for(const side of [-1,1]){
    m.box(side*.0032,.002,0,.004,.013,.004,skin)
    m.box(side*.0032,0,.002,.0045,.0025,.007,[.33,.20,.10,1])
  }
  m.anchor[2]=5
  m.box(0,.012,0,.012,.007,.007,navy)
  m.box(0,.019,0,.014,.014,.009,shirt)
  m.anchor[2]=13
  for(const side of [-1,1]){
    m.box(side*.008,.022,0,.004,.009,.006,shirt)
    m.box(side*.009,.014,.001,.0035,.010,.004,skin)
  }
  m.anchor[2]=5
  m.ellipsoid([0,.039,0],[.0068,.0075,.0065],skin)
  m.ellipsoid([0,.044,-.001],[.007,.0035,.0067],[.19,.12,.07,1])
  for(const side of [-1,1])m.box(side*.0025,.039,.006,.001,.0016,.001,[.09,.12,.12,1])
  if(hat){
    m.anchor[2]=14
    m.ellipsoid([0,.046,0],[.011,.0017,.010],[.91,.72,.39,1])
    m.ellipsoid([0,.048,0],[.0065,.004,.006],[.88,.66,.31,1])
  }
  m.anchor[2]=15
  m.box(.012,.005,.001,.007,.008,.007,shirt)
}

function smallBoat(m:Mesh,id:number) {
  const [x,z]=BOATS[id];m.anchor=[x,z,9,BEACHGOERS.length+id]
  const hull:Color=id?[.65,.23,.14,1]:[.12,.36,.46,1],rim:Color=[.82,.65,.38,1],inside:Color=[.60,.40,.22,1]
  const outline=[ [0,.047],[.014,.028],[.017,-.021],[.010,-.036],[-.010,-.036],[-.017,-.021],[-.014,.028] ]
  for(let i=0;i<outline.length;i++){
    const [ax,az]=outline[i],[bx,bz]=outline[(i+1)%outline.length]
    m.quad([ax*.65,-.009,az*.85],[bx*.65,-.009,bz*.85],[bx,.012,bz],[ax,.012,az],hull)
    m.quad([ax,.012,az],[bx,.012,bz],[bx*.83,.012,bz*.92],[ax*.83,.012,az*.92],rim)
    m.quad([ax*.83,.012,az*.92],[bx*.83,.012,bz*.92],[bx*.62,-.002,bz*.83],[ax*.62,-.002,az*.83],inside)
    m.tri([0,-.002,0],[ax*.62,-.002,az*.83],[bx*.62,-.002,bz*.83],inside)
  }
  for(const zz of [-.018,.015])m.box(0,.006,zz,.027,.003,.008,rim)
  if(id===0){
    m.box(0,.002,-.002,.0024,.068,.0024,[.52,.32,.13,1])
    m.tri([.001,.067,0],[.001,.016,.031],[.001,.016,0],[.93,.86,.65,1])
    m.tri([-.001,.059,-.004],[-.001,.016,-.004],[-.001,.016,-.028],[.83,.48,.20,1])
    m.tri([0,.071,-.001],[0,.064,-.001],[.015,.068,-.001],[.76,.20,.12,1])
    m.box(0,.014,.014,.002,.002,.035,rim)
  }else{
    for(const side of [-1,1]){
      m.box(side*.023,.014,-.004,.035,.002,.003,inside)
      m.box(side*.039,.013,-.004,.011,.002,.007,rim)
    }
    m.box(0,0,-.008,.012,.008,.011,[.33,.46,.37,1])
    m.ring(.012,[.89,.42,.16,1])
  }
}

function gull(m:Mesh,x:number,z:number,id:number){
  m.anchor=[x,z,10,id]
  const white:Color=[.92,.94,.87,1],grey:Color=[.65,.73,.72,1],tip:Color=[.20,.29,.30,1]
  m.ellipsoid([0,0,0],[.004,.004,.013],white)
  m.ellipsoid([0,.002,.011],[.0045,.0045,.005],white)
  m.tri([-.002,.001,.014],[.002,.001,.014],[0,0,.022],[.93,.62,.17,1])
  for(const side of [-1,1]){
    m.quad([side*.003,.001,.006],[side*.019,.003,.003],[side*.027,.002,-.010],[side*.004,0,-.005],white)
    m.tri([side*.019,.003,.003],[side*.036,0,-.014],[side*.027,.002,-.010],grey)
    m.tri([side*.031,.001,-.009],[side*.041,-.002,-.018],[side*.034,-.001,-.018],tip)
  }
  m.tri([-.003,0,-.008],[.003,0,-.008],[0,.001,-.023],grey)
  m.anchor[2]=16
  m.tri([-.033,0,-.010],[.033,0,-.010],[0,0,.009],[.2,.2,.2,.14])
}

export class BeachScenery {
  readonly physics: SceneryPhysics
  readonly life: BeachLife
  private readonly device: GPUDevice
  private readonly sand: SandSolver
  private readonly water: WaterSolver
  private readonly view: GPUBuffer
  private pipeline!: GPURenderPipeline
  private groups: GPUBindGroup[][] = []
  private vertices: GPUBuffer | undefined
  private count = 0
  private flags: {x:number,z:number,scale:number}[] = []
  constructor(device:GPUDevice,sand:SandSolver,water:WaterSolver,view:GPUBuffer) {
    this.device=device;this.sand=sand;this.water=water;this.view=view
    this.physics=new SceneryPhysics(device,sand,water)
    this.life=new BeachLife(device,sand,water)
    this.reset()
  }
  async initialize() {
    await Promise.all([this.physics.initialize(),this.life.initialize()])
    const module=await checkedShader(this.device,'Beach scenery WGSL',sceneryShader)
    this.pipeline=await this.device.createRenderPipelineAsync({label:'Grass, beach huts and flags',layout:'auto',
      vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:56,attributes:[
        {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
        {shaderLocation:2,offset:24,format:'float32x4'},{shaderLocation:3,offset:40,format:'float32x4'},
      ]}]},fragment:{module,entryPoint:'fragment',targets:[{format:HDR_SCENE_FORMAT,blend:{
        color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},
      }},{format:GLINT_FORMAT}]},primitive:{topology:'triangle-list',cullMode:'none'},
      depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less'},
    })
    this.groups=this.sand.buffers.map(bed=>this.water.buffers.map(water=>this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.view}},{binding:1,resource:{buffer:bed}},{binding:2,resource:{buffer:water}},{binding:3,resource:{buffer:this.physics.bodies}},{binding:4,resource:{buffer:this.life.actors}},
    ]})))
  }
  reset() {
    this.physics.reset();this.life.reset()
    this.flags=[]
    this.addFlags(starterCastle())
  }
  addFlags(stamps: readonly MoldStamp[]) {
    let changed=false
    for(const stamp of stamps){
      if(stamp.kind!=='tower'||this.flags.some(f=>Math.hypot(f.x-stamp.point.x,f.z-stamp.point.y)<.018))continue
      this.flags.push({x:stamp.point.x,z:stamp.point.y,scale:Math.min(1.3,Math.max(.65,stamp.radius/.045))});changed=true
    }
    if(this.flags.length>64)this.flags=this.flags.slice(-64)
    if(changed||!this.vertices)this.rebuild()
  }
  private rebuild() {
    const m=new Mesh()
    beachHut(m,0,[.12,.40,.39,1],[.34,.56,.49,1])
    beachHut(m,1,[.61,.22,.12,1],[.67,.44,.23,1])
    beachgoer(m,0,[.91,.60,.10,1],true)
    beachgoer(m,1,[.78,.23,.15,1],false)
    beachgoer(m,2,[.10,.48,.53,1],true)
    beachgoer(m,3,[.90,.76,.44,1],true)
    beachgoer(m,4,[.28,.46,.68,1],false)
    smallBoat(m,0);smallBoat(m,1)
    gull(m,-.20,-.17,0);gull(m,.12,-.12,1);gull(m,.03,.20,2)
    // Wind-swept dune grasses frame the open sand without occupying the courtyard.
    let seed=1471
    const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296}
    for(const [cx,cz,r] of [[-.39,.02,.035],[-.40,.27,.04],[-.30,.86,.028],[.24,.88,.025],[.41,-.04,.025],[-.10,.86,.022],[-.43,.63,.025],[.42,.70,.026]]){
      for(let tuft=0;tuft<7;tuft++){
        const a=rand()*Math.PI*2,d=rand()*r
        m.anchor=[cx+Math.cos(a)*d,cz+Math.sin(a)*d,1,rand()*8]
        m.shadow(.011,.009)
        for(let blade=0;blade<8;blade++){
          const angle=rand()*Math.PI*2,h=.018+rand()*.025,w=.0013+rand()*.001
          const dx=Math.cos(angle),dz=Math.sin(angle),lean=.004+rand()*.012
          const tint=rand(),c:Color=[.14+tint*.17,.26+tint*.15,.075+tint*.08,1]
          m.quad([-dz*w,0,dx*w],[dz*w,0,-dx*w],[dx*lean+dz*w*.55,h*.6,dz*lean-dx*w*.55],[dx*lean-dz*w*.55,h*.6,dz*lean+dx*w*.55],c)
          m.tri([dx*lean-dz*w*.55,h*.6,dz*lean+dx*w*.55],[dx*lean+dz*w*.55,h*.6,dz*lean-dx*w*.55],[dx*lean*1.65,h,dz*lean*1.65],c)
        }
      }
    }
    // Kelp rooted in the shallow seabed: broad ribbons sway with local current.
    for(const [cx,cz] of [[-.31,-.255],[-.07,-.285],[.30,-.25],[.08,-.35]]){
      for(let plant=0;plant<5;plant++){
        const px=cx+(rand()-.5)*.026,pz=cz+(rand()-.5)*.020
        for(let blade=0;blade<5;blade++){
          m.anchor=[px,pz,8,rand()*6.28]
          const angle=rand()*6.28,h=.027+rand()*.019,w=.0018+rand()*.0013
          const color:Color=[.10+rand()*.08,.29+rand()*.12,.18+rand()*.06,1]
          const p=(t:number,side:number):V3=>{
            const bend=Math.sin(t*2.4)*.008,spread=Math.sin(t*Math.PI)*w*side
            return [Math.cos(angle)*bend-Math.sin(angle)*spread,t*h,Math.sin(angle)*bend+Math.cos(angle)*spread]
          }
          for(let k=0;k<6;k++)m.quad(p(k/6,-1),p(k/6,1),p((k+1)/6,1),p((k+1)/6,-1),color)
        }
      }
    }
    // A few sun-bleached shells along the front edge.
    for(let i=0;i<12;i++){
      m.anchor=[-.40+rand()*.76,.83+rand()*.065,0,0]
      const r=.003+rand()*.003
      for(let k=0;k<8;k++)m.tri([0,r*.65,0],[Math.cos(k*Math.PI/4)*r,0,Math.sin(k*Math.PI/4)*r*.7],[Math.cos((k+1)*Math.PI/4)*r,0,Math.sin((k+1)*Math.PI/4)*r*.7],[.83,.70+rand()*.10,.54,1])
    }
    this.flags.forEach((f,i)=>{
      m.anchor=[f.x,f.z,0,i*1.7]
      const h=.058*f.scale,w=.031*f.scale
      m.box(0,0,0,.0024,h,.0024,[.45,.26,.11,1])
      m.box(0,h,0,.004,.004,.004,[.75,.53,.19,1])
      m.anchor[2]=2
      const color:Color=i%2?[.86,.50,.12,1]:[.72,.16,.095,1]
      for(let k=0;k<8;k++){
        const a=k/8,b=(k+1)/8
        m.quad([a*w,h-.002,0],[b*w,h-.002,0],[b*w,h-.020+b*.010,0],[a*w,h-.020+a*.010,0],color)
      }
    })
    this.vertices?.destroy()
    const data=new Float32Array(m.data);this.count=data.length/14
    this.vertices=this.device.createBuffer({label:'Beach scenery mesh',size:data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
    this.device.queue.writeBuffer(this.vertices,0,data)
  }
  step(encoder:GPUCommandEncoder,dt:number){this.physics.encode(encoder,dt);this.life.encode(encoder,dt)}
  encode(pass:GPURenderPassEncoder) {
    if(!this.vertices)return
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.groups[this.sand.stateIndex][this.water.stateIndex])
    pass.setVertexBuffer(0,this.vertices);pass.draw(this.count)
  }
  dispose(){this.vertices?.destroy();this.physics.dispose();this.life.dispose()}
}
