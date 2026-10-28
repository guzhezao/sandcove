import { EROSION, SAND } from '../config'
import { checkedShader } from '../platform/shader'
import type { SandSolver } from './solver'
import type { WaterSolver } from './water-solver'

/** Conservative bed-load and wet-bank slumping, driven by real water flow. */
export const erosionShader = `
struct ErosionInfo { grid: vec4f, water: vec4f, jets: array<vec4f, ${SAND.maxContacts}> }
@group(0) @binding(0) var<uniform> info: ErosionInfo;
@group(0) @binding(1) var<storage, read> bed: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> flux: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> result: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> wash: array<atomic<i32>>;
const directions = array<vec2i, 4>(vec2i(-1,0), vec2i(1,0), vec2i(0,-1), vec2i(0,1));
fn indexAt(p: vec2i) -> u32 {
  let q = clamp(p, vec2i(0), vec2i(i32(info.grid.x), i32(arrayLength(&bed) / u32(info.grid.x))) - vec2i(1));
  return u32(q.y) * u32(info.grid.x) + u32(q.x);
}
fn wetAt(p: vec2i) -> vec4f {
  let q = clamp(vec2i((vec2f(p) + 0.5) * info.water.x / info.grid.x), vec2i(0), vec2i(i32(info.water.x), i32(arrayLength(&water) / u32(info.water.x))) - vec2i(1));
  return water[u32(q.y) * u32(info.water.x) + u32(q.x)];
}
// Pouring adds impact energy even at a still, flat summit. Transport the
// loosened grains to a lower point outside the jet instead of immediately
// propping the same cell back up with its neighbours' deposits.
fn washByJet(p: vec2i, available: f32) {
  let world = (vec2f(p) + .5) * info.grid.y - info.grid.z * .5;
  var impact = 0.0;
  var centre = world;
  var radius = .024;
  for (var i=0u; i<${SAND.maxContacts}u; i++) {
    if (f32(i) >= info.water.z) { break; }
    let jet=info.jets[i];
    let d=length(world-jet.xy)/max(jet.z, 0.001);
    let falloff=max(0.0,1.0-d*d);
    let force=falloff*falloff*jet.w;
    if (force>impact) { impact=force;centre=jet.xy;radius=jet.z; }
  }
  if (impact <= 0.0001 || available <= 0.0) { return; }
  let wet=wetAt(p);
  let radial=world-centre;
  var direction=normalize(radial+vec2f(0.00001,0.000003));
  if (length(wet.yz) > .003) { direction=normalize(wet.yz); }
  let reach=max(.035,radius*2.2);
  var receiver=p;
  var receiverHeight=bed[indexAt(p)].x;
  // Search in order so equal-height sand spreads away from the water jet.
  // A higher wall blocks grain transport just as it blocks the water.
  for (var step=1;step<=8;step++) {
    let q=clamp(p+vec2i(round(direction*reach/info.grid.y*f32(step)/8.0)),vec2i(0),vec2i(i32(info.grid.x), i32(arrayLength(&bed) / u32(info.grid.x))) - vec2i(1));
    let height=bed[indexAt(q)].x;
    if (height>bed[indexAt(p)].x+.002) { break; }
    if (height<=receiverHeight+.0001) { receiver=q;receiverHeight=height; }
  }
  if (all(receiver==p)) { return; }
  let amount=min(available,impact*.005*info.water.y*info.grid.w);
  let grains=i32(round(amount*1e9));
  if (grains<=0) { return; }
  atomicAdd(&wash[indexAt(p)],-grains);
  // A 3x3 deposition fan spreads sediment instead of making a needle at a
  // converging stream. Integer shares sum exactly to the removed material.
  let share=grains/9;
  var distributed=0;
  for(var z=-1;z<=1;z++) { for(var x=-1;x<=1;x++) {
    let deposit=select(share,grains-distributed,x==1 && z==1);
    atomicAdd(&wash[indexAt(receiver+vec2i(x,z))],deposit);
    distributed+=deposit;
  } }
}
@compute @workgroup_size(8,8)
fn transport(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(u32(info.grid.x), arrayLength(&bed) / u32(info.grid.x)))) { return; }
  let p = vec2i(invocation.xy);
  let index = indexAt(p);
  let height = bed[index].x;
  let wet = wetAt(p);
  var amounts = vec4f(0.0);
  var peakImpact = 0.0;
  for (var axis = 0u; axis < 4u; axis++) {
    let q = p + directions[axis];
    if (any(q < vec2i(0)) || any(q >= vec2i(i32(info.grid.x), i32(arrayLength(&bed) / u32(info.grid.x))))) { continue; }
    let otherHeight = bed[indexAt(q)].x;
    let otherWet = wetAt(q);
    // A moving water front can undermine a narrow band just above its level.
    let bankContact = select(0.0, max(0.0, otherHeight + otherWet.x + ${EROSION.bankReach} - height), otherWet.x > 0.0001);
    let contact = max(wet.x, bankContact);
    let saturation = smoothstep(0.0001, 0.002, contact);
    let speed = max(length(wet.yz), length(otherWet.yz));
    let running = smoothstep(0.0004, 0.012, speed);
    let slopeExcess = max(0.0, height - otherHeight - ${EROSION.wetSlope} * info.grid.y);
    let downhill = slopeExcess * ${EROSION.bankRate};
    let along = max(0.0, dot(wet.yz, vec2f(directions[axis])));
    // Transport settled grains downstream, but never push them up a dry bank.
    let bedload = along * ${EROSION.bedload} * smoothstep(0.0001, 0.003, wet.x)
      * (1.0 - smoothstep(0.0, info.grid.y * 0.5, otherHeight - height));
    let strength = info.water.y;
    // Stronger wet-bank collapse, with a per-link stability bound so a
    // storm cannot reintroduce the needle peaks fixed in sand transport.
    // Resolve pressure against the exposed face, rather than using speed
    // alone. A tangential stream scours; a head-on bore also removes support.
    // Local upstream water is required: energy never jumps across a dry wall.
    let outward = vec2f(directions[axis]);
    let incomingSpeed = max(0.0, dot(otherWet.yz, -outward));
    let pressure = min(6.0, incomingSpeed * incomingSpeed / .0225)
      * smoothstep(.0005, .025, otherWet.x);
    let relief = max(0.0, height - otherHeight);
    let toeWet = smoothstep(.0005, .008, otherWet.x)
      * smoothstep(.001, .012, relief)
      * clamp(otherWet.x / max(relief, .006), 0.0, 1.0);
    // Probe a fixed physical distance, so thin walls and exposed corners are
    // weaker than broad banks at both preview and production resolutions.
    let probe = max(1, i32(round(.024 / info.grid.y)));
    let backing = bed[indexAt(p - directions[axis] * probe)].x;
    let side = vec2i(-directions[axis].y, directions[axis].x) * probe;
    let flankA = bed[indexAt(p + side)].x;
    let flankB = bed[indexAt(p - side)].x;
    let thin = smoothstep(.006, .028, height - backing);
    let corner = (smoothstep(.006, .028, height - flankA)
      + smoothstep(.006, .028, height - flankB)) * .5;
    let shape = 1.0 + thin * 1.8 + corner * .65;
    let faceExposure = smoothstep(.0002, .002, relief);
    let impact = pressure * shape * max(saturation, toeWet) * faceExposure;
    peakImpact = max(peakImpact, impact);
    let failure = downhill * running * saturation + .035 * impact;
    // Each face can transfer at most 20% of its height difference. Four
    // concurrent deposits therefore cannot create a new needle peak.
    let slump = min(slopeExcess * 0.20, failure * info.grid.w * strength);
    amounts[axis] = slump + bedload * saturation * info.grid.w * strength;
  }
  let total = dot(amounts, vec4f(1.0));
  let available = min(max(0.0, height - ${SAND.floor}), ${EROSION.maxRate} * (1.0 + peakImpact) * info.grid.w * info.water.y);
  let limited=amounts * min(1.0, available / max(total, 1e-12));
  flux[index] = limited;
  washByJet(p,max(0.0,height-${SAND.floor}-dot(limited,vec4f(1.0))));
}
@compute @workgroup_size(8,8)
fn integrate(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(u32(info.grid.x), arrayLength(&bed) / u32(info.grid.x)))) { return; }
  let p = vec2i(invocation.xy);
  let index = indexAt(p);
  let current = bed[index];
  var incoming = 0.0;
  for (var axis = 0u; axis < 4u; axis++) {
    let q = p + directions[axis];
    if (any(q < vec2i(0)) || any(q >= vec2i(i32(info.grid.x), i32(arrayLength(&bed) / u32(info.grid.x))))) { continue; }
    incoming += flux[indexAt(q)][axis ^ 1u];
  }
  let outgoing = dot(flux[index], vec4f(1.0));
  // Every removed grain is deposited in a neighbour: no terrain wipe or sink.
  let jetTransfer=f32(atomicExchange(&wash[index],0))*1e-9;
  let height = current.x + (incoming - outgoing) + jetTransfer;
  result[index] = vec4f(height, max(current.y, (incoming + outgoing) / max(info.grid.w, 1e-6)), current.zw);
}
`

export class SandErosion {
  private readonly uniform: GPUBuffer
  private readonly flux: GPUBuffer
  private readonly output: GPUBuffer
  private readonly wash: GPUBuffer
  private transport!: GPUComputePipeline
  private integrate!: GPUComputePipeline
  private groups: GPUBindGroup[][] = []
  private readonly device: GPUDevice
  private readonly sand: SandSolver
  private readonly water: WaterSolver
  constructor(device: GPUDevice, sand: SandSolver, water: WaterSolver) {
    this.device = device; this.sand = sand; this.water = water
    this.uniform = device.createBuffer({ size: 32 + SAND.maxContacts * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.wash = device.createBuffer({size:sand.resolution*sand.rows*4,usage:GPUBufferUsage.STORAGE})
    this.flux = device.createBuffer({ size: sand.byteLength, usage: GPUBufferUsage.STORAGE })
    this.output = device.createBuffer({ size: sand.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
  }
  async initialize() {
    const module = await checkedShader(this.device, 'Flow-driven sand erosion', erosionShader)
    const layout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ] })
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] })
    this.transport = await this.device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: 'transport' } })
    this.integrate = await this.device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: 'integrate' } })
    this.groups = this.sand.buffers.map(bed => this.water.buffers.map(water => this.device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: this.uniform } },
      { binding: 1, resource: { buffer: bed } },
      { binding: 2, resource: { buffer: water } },
      { binding: 3, resource: { buffer: this.flux } },
      { binding: 4, resource: { buffer: this.output } },
      { binding: 5, resource: { buffer: this.wash } },
    ] })))
  }
  encode(encoder: GPUCommandEncoder, seconds: number, strength: number = EROSION.strength) {
    const contacts=this.water.activePourContacts.slice(0,SAND.maxContacts)
    const data=new Float32Array(8+SAND.maxContacts*4)
    data.set([
      this.sand.resolution, SAND.extent / this.sand.resolution, SAND.extent, seconds,
      this.water.resolution, Math.max(0, Math.min(6, strength)), contacts.length, 0,
    ])
    contacts.forEach((c,i)=>data.set([c.from.x,c.from.y,c.radius,c.pressure],8+i*4))
    this.device.queue.writeBuffer(this.uniform,0,data)
    const pass = encoder.beginComputePass({ label: 'Wet banks and bed-load transport' })
    pass.setBindGroup(0, this.groups[this.sand.stateIndex][this.water.stateIndex])
    pass.setPipeline(this.transport)
    pass.dispatchWorkgroups(Math.ceil(this.sand.resolution / 8), Math.ceil(this.sand.rows / 8))
    pass.setPipeline(this.integrate)
    pass.dispatchWorkgroups(Math.ceil(this.sand.resolution / 8), Math.ceil(this.sand.rows / 8))
    pass.end()
    this.sand.applySurface(encoder, this.output)
  }
  dispose() { this.uniform.destroy(); this.flux.destroy(); this.output.destroy(); this.wash.destroy() }
}
