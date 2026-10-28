import { SAND, type Point } from '../config'
import { checkedShader } from '../platform/shader'
import type { SandSolver } from './solver'

export type MoldKind = 'tower' | 'wall' | 'arc'
export type MoldStamp = { point: Point; radius: number; height: number; angle: number; kind: MoldKind; halfLength?: number; baseHeight?: number }
export const moldKinds: MoldKind[] = ['tower', 'wall', 'arc']
export const moldHeight = (kind: MoldKind) => kind === 'tower' ? .085 : .075

/** One swept wall: length never changes its width, height, or tooth spacing. */
export function wallStamp(from: Point, to: Point, halfWidth: number, baseHeight: number, angle = 0): MoldStamp {
  const dx = to.x - from.x, dz = to.y - from.y, distance = Math.hypot(dx, dz)
  return { kind: 'wall', point: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
    radius: halfWidth, height: moldHeight('wall'), angle: distance > .005 ? Math.atan2(dz, dx) : angle,
    halfLength: Math.max(halfWidth, distance / 2), baseHeight }
}

export function wallOutline(stamp: MoldStamp): Point[] {
  const half = stamp.halfLength! + stamp.radius * .5, width = stamp.radius
  const c = Math.cos(stamp.angle), s = Math.sin(stamp.angle)
  return [[-half,-width],[half,-width],[half,width],[-half,width]].map(([x,z]) =>
    ({ x: stamp.point.x + c*x - s*z, y: stamp.point.y + s*x + c*z }))
}

/** Footprint used by the placement preview, in local brush coordinates. */
export function moldOutline(kind: MoldKind): Point[] {
  if (kind === 'wall') return [{x:-1,y:-.34},{x:1,y:-.34},{x:1,y:.34},{x:-1,y:.34}]
  if (kind === 'arc') {
    const points: Point[] = []
    for (let i=0;i<=40;i++) { const a=-1.95+i/40*3.9; points.push({x:Math.sin(a)*.96,y:-Math.cos(a)*.96}) }
    for (let i=40;i>=0;i--) { const a=-1.95+i/40*3.9; points.push({x:Math.sin(a)*.50,y:-Math.cos(a)*.50}) }
    return points
  }
  return Array.from({length:64},(_,i)=>({x:Math.cos(i/64*Math.PI*2),y:Math.sin(i/64*Math.PI*2)}))
}

export const moldShader = `
struct Info { grid: vec4f, placement: vec4f, shape: vec4f }
@group(0) @binding(0) var<uniform> info: Info;
@group(0) @binding(1) var<storage, read> bed: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outputBed: array<vec4f>;
fn profile(q: vec2f, kind: f32) -> f32 {
  let r = length(q);
  if (kind < 0.5) {
    let body = .68 * (1.0 - smoothstep(.82, 1.0, r));
    let rim = smoothstep(.48, .55, r) * (1.0 - smoothstep(.76, .83, r));
    let angle = atan2(q.y, q.x);
    let teeth = smoothstep(.10, .30, cos(angle * 8.0));
    return body + rim * (.10 + .22 * teeth);
  }
  if (kind < 1.5) {
    let body = .70 * (1.0 - smoothstep(.92, 1.0, abs(q.x))) * (1.0 - smoothstep(.24, .34, abs(q.y)));
    let teeth = smoothstep(.05, .30, cos(q.x * 15.70796));
    let top = (1.0 - smoothstep(.20, .25, abs(q.y))) * (1.0 - smoothstep(.90, .96, abs(q.x)));
    return body + .30 * teeth * top;
  }
  let arcAngle = abs(atan2(q.x, -q.y));
  return (1.0 - smoothstep(.10, .23, abs(r - .73))) * (1.0 - smoothstep(1.65, 1.95, arcAngle));
}
@compute @workgroup_size(8,8)
fn stamp(@builtin(global_invocation_id) id: vec3u) {
  let n = u32(info.grid.x);
  if (any(id.xy >= vec2u(n, arrayLength(&bed) / n))) { return; }
  let index = id.y * n + id.x;
  let current = bed[index];
  let world = (vec2f(id.xy) + .5) * info.grid.y - info.grid.z * .5;
  let offset = (world - info.placement.xy) / info.placement.z;
  let c = cos(info.shape.y); let s = sin(info.shape.y);
  let q = vec2f(c * offset.x + s * offset.y, -s * offset.x + c * offset.y);
  var relief = profile(q, info.shape.x);
  if (info.shape.z > 0.0) {
    let local = q * info.placement.z;
    let ends = 1.0 - smoothstep(info.shape.z, info.shape.z + info.placement.z * .5, abs(local.x));
    let body = .76 * (1.0 - smoothstep(.65, 1.0, abs(q.y)));
    let teeth = smoothstep(.05, .30, cos((local.x + info.shape.z) * 179.51958));
    let crown = .24 * teeth * (1.0 - smoothstep(.48, .65, abs(q.y)));
    relief = ends * (body + crown);
  }
  let centre = clamp(vec2i((info.placement.xy / info.grid.z + .5) * info.grid.x), vec2i(0), vec2i(i32(n), i32(arrayLength(&bed) / n)) - vec2i(1));
  // All cells read the pre-stamp bed. A click is one placement, so holding
  // the mouse cannot stack a tower every frame. Subsequent clicks can stack.
  let base = select(bed[u32(centre.y)*n+u32(centre.x)].x, info.shape.w, info.shape.z > 0.0);
  let summit = min(base + relief * info.placement.w, 0.28);
  let height = select(current.x, max(current.x, summit), relief > 0.00001);
  outputBed[index] = vec4f(height, current.yzw);
}
`

export class SandMolds {
  private readonly uniforms: GPUBuffer[]
  private readonly result: GPUBuffer
  private groups: GPUBindGroup[][] = []
  private pipeline!: GPUComputePipeline
  private readonly device: GPUDevice
  private readonly sand: SandSolver
  constructor(device: GPUDevice, sand: SandSolver) {
    this.device=device; this.sand=sand
    this.uniforms = Array.from({length:8},()=>device.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}))
    this.result = device.createBuffer({size:sand.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC})
  }
  async initialize() {
    const module=await checkedShader(this.device,'Sand molds',moldShader)
    this.pipeline=await this.device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'stamp'}})
    this.groups=this.uniforms.map(uniform=>this.sand.buffers.map(bed=>this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:uniform}},{binding:1,resource:{buffer:bed}},{binding:2,resource:{buffer:this.result}},
    ]})))
  }
  encode(encoder:GPUCommandEncoder, stamps:readonly MoldStamp[]) {
    stamps.slice(0,this.uniforms.length).forEach((stamp,slot)=>{
      this.device.queue.writeBuffer(this.uniforms[slot],0,new Float32Array([
        this.sand.resolution,SAND.extent/this.sand.resolution,SAND.extent,0,
        stamp.point.x,stamp.point.y,Math.max(.015,stamp.radius),Math.max(.004,Math.min(SAND.pileHeightLimit,stamp.height)),
        moldKinds.indexOf(stamp.kind),stamp.angle,stamp.halfLength ?? 0,stamp.baseHeight ?? 0,
      ]))
      const pass=encoder.beginComputePass({label:'Place sand mold'})
      pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.groups[slot][this.sand.stateIndex])
      pass.dispatchWorkgroups(Math.ceil(this.sand.resolution/8),Math.ceil(this.sand.rows/8));pass.end()
      this.sand.applySurface(encoder,this.result)
    })
  }
  dispose(){this.uniforms.forEach(b=>b.destroy());this.result.destroy()}
}
