import { SAND, WATER } from '../config'
import { checkedShader } from '../platform/shader'
import type { WaterSolver } from '../simulation/water-solver'

const waterSurfaceShader = `
struct View {
  eye: vec4f,
  forward: vec4f,
  right: vec4f,
  up: vec4f,
  light: vec4f,
  grid: vec4f,
  pointer: vec4f,
  shadowBounds: vec4f,
  shadowControl: vec4f,
}
struct WaterInfo { field: vec4f }
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<uniform> info: WaterInfo;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read> bed: array<vec4f>;

fn waterResolution() -> u32 { return u32(info.field.x); }
fn waterSpacing() -> f32 { return info.field.y; }
fn waterIndex(cell: vec2i) -> u32 {
  let bounded = clamp(cell, vec2i(0), vec2i(i32(waterResolution()), i32(arrayLength(&water) / waterResolution())) - vec2i(1));
  return u32(bounded.y) * waterResolution() + u32(bounded.x);
}
fn waterAt(cell: vec2i) -> vec4f { return water[waterIndex(cell)]; }
fn bedHeightAt(world: vec2f) -> f32 {
  let bedResolution = view.grid.x;
  let base = u32(bedResolution);
  let limit = i32(bedResolution) - 1;
  let rowLimit = i32(arrayLength(&bed) / base) - 1;
  let coordinate = (world / view.grid.y + 0.5) * bedResolution - 0.5;
  let cell = vec2i(floor(coordinate));
  let blend = fract(coordinate);
  let row0 = u32(clamp(cell.y, 0, rowLimit));
  let row1 = u32(clamp(cell.y + 1, 0, rowLimit));
  let column0 = u32(clamp(cell.x, 0, limit));
  let column1 = u32(clamp(cell.x + 1, 0, limit));
  let h00 = bed[row0 * base + column0].x;
  let h10 = bed[row0 * base + column1].x;
  let h01 = bed[row1 * base + column0].x;
  let h11 = bed[row1 * base + column1].x;
  return mix(mix(h00, h10, blend.x), mix(h01, h11, blend.x), blend.y);
}
fn rawSurfaceAt(cell: vec2i) -> f32 {
  let world = (vec2f(cell) + 0.5) * waterSpacing() - view.grid.y * 0.5;
  return bedHeightAt(world) + max(waterAt(cell).x, 0.0);
}
// Extend a wet surface horizontally across the dry mesh fringe. Otherwise
// a dry vertex on a tall sand wall creates a blue triangular spike.
fn surfaceAt(cell: vec2i) -> f32 {
  if (waterAt(cell).x > 0.00006) { return rawSurfaceAt(cell); }
  var total = 0.0;
  var weight = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = cell + vec2i(x, y);
      if (waterAt(q).x > 0.00006) { total += rawSurfaceAt(q); weight += 1.0; }
    }
  }
  if (weight > 0.0) { return total / weight; }
  return rawSurfaceAt(cell);
}
fn project(position: vec3f) -> vec4f {
  let relative = position - view.eye.xyz;
  let depth = dot(relative, view.forward.xyz);
  return vec4f(dot(relative, view.right.xyz) / (view.eye.w * view.forward.w),
    dot(relative, view.up.xyz) / view.eye.w, depth * 1.001001 - 0.01001001, depth);
}
fn environment(direction: vec3f) -> vec3f {
  let upward = max(direction.y, 0.0);
  let sky = mix(vec3f(0.72, 0.67, 0.57), vec3f(0.42, 0.56, 0.78), pow(upward, 0.45));
  let ground = mix(vec3f(0.25, 0.19, 0.13), vec3f(0.52, 0.42, 0.29), smoothstep(-1.0, 0.0, direction.y));
  return select(ground, sky, direction.y >= 0.0);
}
fn foamNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = fract(sin(dot(i, vec2f(127.1, 311.7))) * 43758.5453);
  let b = fract(sin(dot(i + vec2f(1,0), vec2f(127.1, 311.7))) * 43758.5453);
  let c = fract(sin(dot(i + vec2f(0,1), vec2f(127.1, 311.7))) * 43758.5453);
  let d = fract(sin(dot(i + vec2f(1,1), vec2f(127.1, 311.7))) * 43758.5453);
  return mix(mix(a,b,u.x), mix(c,d,u.x),u.y);
}
// Two bounded advection phases hide the periodic rewind. Changes in velocity
// can move a sample by at most one short cycle, never by the total runtime.
fn rippleSample(position: vec2f, time: f32) -> vec2f {
  let phaseA = dot(position, vec2f(118.0, 86.0)) + sin(time * 0.55) * 0.35;
  let phaseB = dot(position, vec2f(-74.0, 103.0)) + sin(time * 0.43) * 0.25;
  return vec2f(cos(phaseA), cos(phaseA) * 0.73) * 0.012
    + vec2f(cos(phaseB) * -0.72, cos(phaseB)) * 0.008;
}
fn rippleGradient(position: vec2f, time: f32, strength: f32, flow: vec2f) -> vec2f {
  let phase = fract(time / 1.8);
  let other = fract(phase + 0.5);
  let weight = abs(phase * 2.0 - 1.0);
  let a = rippleSample(position - flow * phase * 1.8, time);
  let b = rippleSample(position - flow * other * 1.8, time);
  return mix(a, b, weight) * strength;
}
fn streakSample(position: vec2f, direction: vec2f) -> f32 {
  let side = vec2f(-direction.y, direction.x);
  let across = dot(position, side);
  let along = dot(position, direction);
  let lanes = pow(0.5 + 0.5 * sin(across * 450.0 + sin(across * 137.0)), 5.0);
  return lanes * pow(0.5 + 0.5 * sin(along * 180.0), 3.0);
}
/** Small highlights move along the measured current; still water has none. */
fn flowStreak(position: vec2f, flow: vec2f, time: f32) -> f32 {
  let speed = length(flow);
  if (speed < 0.0001) { return 0.0; }
  let direction = flow / speed;
  let phase = fract(time / 1.8);
  let other = fract(phase + 0.5);
  let weight = abs(phase * 2.0 - 1.0);
  let a = streakSample(position - flow * phase * 1.8, direction);
  let b = streakSample(position - flow * other * 1.8, direction);
  return mix(a, b, weight) * smoothstep(0.0003, 0.018, speed);
}
struct VertexOutput {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) depth: f32,
  @location(2) normal: vec3f,
  @location(3) flow: vec2f,
  @location(4) crest: f32,
}
@vertex fn vertex(@builtin(vertex_index) index: u32) -> VertexOutput {
  let cell = vec2i(i32(index % waterResolution()), i32(index / waterResolution()));
  let world = (vec2f(cell) + 0.5) * waterSpacing() - view.grid.y * 0.5;
  let state = waterAt(cell);
  let depth = max(state.x, 0.0);
  let elevation = surfaceAt(cell);
  let spacing = waterSpacing();
  let left = surfaceAt(cell + vec2i(-1, 0));
  let right = surfaceAt(cell + vec2i(1, 0));
  let back = surfaceAt(cell + vec2i(0, -1));
  let front = surfaceAt(cell + vec2i(0, 1));
  var output: VertexOutput;
  output.world = vec3f(world.x, elevation, world.y);
  output.clip = project(output.world);
  output.depth = depth;
  output.normal = normalize(vec3f(left - right, 2.0 * spacing, back - front));
  output.flow = state.yz;
  output.crest = max(0.0, 2.0 * elevation - back - front) / (spacing * spacing);
  return output;
}
@fragment fn fragment(input: VertexOutput) -> @location(0) vec4f {
  let depth = input.depth;
  let cell = vec2i((input.world.xz / view.grid.y + 0.5) * info.field.x);
  if (depth <= 0.00006 || waterAt(cell).x <= 0.00004 || input.world.y < bedHeightAt(input.world.xz) - 0.0001) { discard; }
  let time = info.field.z;
  let flow = input.flow;
  let speed = length(flow);
  // A still pool keeps a slow ambient shimmer, a running current gains
  // travelling texture that follows the direction of the flow.
  let travelling = min(speed * 18.0, 1.0);
  let rippleStrength = smoothstep(0.00015, 0.0018, depth) * (0.30 + travelling * 0.95);
  let gradient = rippleGradient(input.world.xz, time, rippleStrength, flow);
  let normal = normalize(input.normal + vec3f(gradient.x, 0.0, gradient.y));
  let light = normalize(view.light.xyz);
  let towardEye = normalize(view.eye.xyz - input.world);
  let halfway = normalize(light + towardEye);
  let viewCosine = max(dot(normal, towardEye), 0.02);
  let fresnel = 0.02 + 0.98 * pow(1.0 - viewCosine, 5.0);

  // Clear blue water: the sand under a thin sheet still reads through it, and
  // only a real depth turns the sheet into blue water of its own.
  let clarity = exp(-depth * 125.0);
  let tint = mix(vec3f(0.20, 0.55, 0.82), vec3f(0.04, 0.22, 0.50), 1.0 - clarity);
  let sheen = environment(reflect(-towardEye, normal)) * fresnel * 0.30;
  let specular = pow(max(dot(normal, halfway), 0.0), 220.0) * 2.2;
  let streak = flowStreak(input.world.xz, flow, time);

  // A quiet meniscus catches the light where the sheet thins out.
  let edge = (1.0 - smoothstep(0.00006, 0.0006, depth)) * 0.09;
  // A film that is barely there must stay barely there: the damp sand under
  // it tells the story, not a milky sheet of colour.
  var alpha = clamp(0.05 + 0.62 * (1.0 - clarity) + fresnel * 0.20 + edge + streak * 0.10, 0.0, 0.84);
  var color = tint * (0.74 + 0.26 * (1.0 - clarity)) + sheen + vec3f(1.0, 0.96, 0.88) * specular;
  color += vec3f(0.62, 0.80, 0.95) * streak * 0.16;
  color += vec3f(1.0, 0.97, 0.90) * edge * 0.5;
  // Foam follows the simulated wave crest and the moving shallow swash.
  let lace = smoothstep(0.22, 0.70, foamNoise(input.world.xz * 260.0 - flow * fract(time * 0.2) * 90.0));
  let swash = (1.0 - smoothstep(0.001, 0.007, depth)) * smoothstep(0.003, 0.025, speed);
  let breaking = smoothstep(1.0, 7.0, input.crest) * smoothstep(0.003, 0.018, speed);
  // A fast, steep advancing bore reads as one foaming front across the coast.
  let bore = smoothstep(0.04, 0.18, speed) * smoothstep(0.10, 0.55, length(input.normal.xz)) * smoothstep(0.003, 0.015, depth);
  // Do not turn a fast, almost dry film into an opaque white blanket.
  // Keep the eroded sand readable underneath the spreading water.
  let wetFilm = smoothstep(0.00015, 0.0008, depth);
  let foam = clamp(max(max(swash * 0.45, breaking * 0.32) * lace, bore * (0.55 + lace * 0.4)) * wetFilm, 0.0, 0.85);
  color = mix(color, vec3f(0.91, 0.96, 0.93), foam);
  alpha = mix(alpha, 0.92, foam);
  return vec4f(color, alpha);
}
`

export class WaterSurface {
  readonly device: GPUDevice
  private readonly water: WaterSolver
  private readonly viewUniform: GPUBuffer
  private readonly uniform: GPUBuffer
  private readonly indices: GPUBuffer
  private readonly indexCount: number
  private pipeline!: GPURenderPipeline
  private groups: GPUBindGroup[][] = []
  private readonly resolution: number
  private readonly data = new Float32Array(4)

  constructor(device: GPUDevice, water: WaterSolver, viewUniform: GPUBuffer) {
    this.device = device
    this.water = water
    this.viewUniform = viewUniform
    this.resolution = water.resolution
    this.uniform = device.createBuffer({ label: 'Water surface frame', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.indexCount = (this.resolution - 1) * (water.rows - 1) * 6
    const indices = new Uint32Array(this.indexCount)
    let offset = 0
    for (let row = 0; row < water.rows - 1; row++) {
      for (let column = 0; column < this.resolution - 1; column++) {
        const vertex = row * this.resolution + column
        indices.set([vertex, vertex + this.resolution, vertex + 1, vertex + 1, vertex + this.resolution, vertex + this.resolution + 1], offset)
        offset += 6
      }
    }
    this.indices = device.createBuffer({ label: 'Water grid topology', size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(this.indices, 0, indices)
  }

  async initialize(bedBuffers: readonly GPUBuffer[]) {
    const module = await checkedShader(this.device, 'Water surface WGSL', waterSurfaceShader)
    this.pipeline = await this.device.createRenderPipelineAsync({ label: 'Standing water', layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{
        format: 'rgba16float',
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    })
    this.groups = this.water.buffers.map((buffer) => bedBuffers.map((bed) => this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.viewUniform } },
        { binding: 1, resource: { buffer: this.uniform } },
        { binding: 2, resource: { buffer } },
        { binding: 3, resource: { buffer: bed } },
      ],
    })))
  }

  encode(encoder: GPUCommandEncoder, bedIndex: number, time: number, target: GPUTextureView, depth: GPUTextureView) {
    this.data.set([this.resolution, SAND.extent / this.resolution, time, WATER.maxDepth])
    this.device.queue.writeBuffer(this.uniform, 0, this.data)
    const pass = encoder.beginRenderPass({ label: 'Water surface', colorAttachments: [
      { view: target, loadOp: 'load', storeOp: 'store' },
    ], depthStencilAttachment: { view: depth, depthLoadOp: 'load', depthStoreOp: 'store' } })
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.groups[this.water.stateIndex][bedIndex])
    pass.setIndexBuffer(this.indices, 'uint32')
    pass.drawIndexed(this.indexCount)
    pass.end()
  }

  dispose() { this.uniform.destroy(); this.indices.destroy() }
}
