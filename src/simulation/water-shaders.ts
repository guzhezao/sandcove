import { SAND, TOOL, WATER } from '../config'

const waterParamsLayout = `
struct ToolContact {
  start: vec4f,
  end: vec4f,
  motion: vec4f,
}
struct WaterParams {
  grid: vec4f,
  bed: vec4f,
  tool: vec4f,
  tide: vec4f,
  contacts: array<ToolContact, ${SAND.maxContacts}>,
}
`

/**
 * Shallow water over the sand bed.
 *
 * Every cell stores a real water depth. The water surface is the terrain
 * height plus that depth, and water only ever moves from a higher surface to
 * a lower one, so a berm that stands above the water line is a wall, not a
 * suggestion. Transfers are limited by the water a cell actually owns, which
 * keeps the solver non-negative and conservative: the volume leaving a cell
 * is exactly the volume arriving at its neighbour.
 */
export const waterShader = `
${waterParamsLayout}
@group(0) @binding(0) var<uniform> params: WaterParams;
@group(0) @binding(1) var<storage, read> bed: array<vec4f>;
@group(0) @binding(2) var<storage, read> source: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> destination: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> pipe: array<vec4f>;

const WATER_MODE = ${TOOL.water}.0;

fn resolution() -> u32 { return u32(params.grid.x); }
fn address(cell: vec2i) -> u32 {
  let bounded = clamp(cell, vec2i(0), vec2i(i32(params.grid.x), i32(arrayLength(&source) / u32(params.grid.x))) - vec2i(1));
  return u32(bounded.y) * u32(params.grid.x) + u32(bounded.x);
}
fn location(cell: vec2i) -> vec2f {
  return (vec2f(cell) + 0.5) * params.grid.y - params.grid.z * 0.5;
}
fn bedHeight(cell: vec2i) -> f32 {
  let bounded = clamp(cell, vec2i(0), vec2i(i32(params.bed.x), i32(arrayLength(&bed) / u32(params.bed.x))) - vec2i(1));
  return bed[u32(bounded.y) * u32(params.bed.x) + u32(bounded.x)].x;
}
fn bedHeightAt(world: vec2f) -> f32 {
  let coordinate = (world / params.grid.z + 0.5) * params.bed.x - 0.5;
  let cell = vec2i(floor(coordinate));
  let blend = fract(coordinate);
  let lower = mix(bedHeight(cell), bedHeight(cell + vec2i(1, 0)), blend.x);
  let upper = mix(bedHeight(cell + vec2i(0, 1)), bedHeight(cell + vec2i(1, 1)), blend.x);
  return mix(lower, upper, blend.y);
}
fn seaLevel(world: vec2f) -> f32 {
  // A crest travels toward the beach. Only the open sea is driven; inland
  // pools and trenches receive each wave through the conservative pipe flux.
  let phase = params.bed.w * 1.496 - (world.y - params.tide.y) * 36.96 + sin(world.x * 19.0) * 0.18;
  let crest = pow(0.5 + 0.5 * sin(phase), 3.0);
  return params.tide.z + params.tool.z * (crest * 1.5 - 0.35);
}
fn surfaceAt(cell: vec2i) -> f32 {
  let world = location(cell);
  let terrain = bedHeightAt(world);
  if (isSea(world)) { return seaLevel(world); }
  return terrain + max(source[address(cell)].x, 0.0);
}
fn mobility(depth: f32) -> f32 {
  return sqrt(clamp(depth / ${WATER.mobilityDepth}, 0.0, 1.0));
}
/**
 * The rate a pipe carries. The mobility belongs to the cell that is actually
 * supplying the water: a dry cell next to a wet one must still be able to
 * receive, otherwise the wet front can only ever move one way.
 */
fn pipeRate(surface: f32, neighborSurface: f32, depth: f32, neighborDepth: f32) -> f32 {
  let supply = select(neighborDepth, depth, surface >= neighborSurface);
  let rate = select(${WATER.flowRate}.0, ${WATER.tideFlowRate}.0, params.tide.x > 0.5);
  return rate * (surface - neighborSurface) * mobility(supply);
}
// Momentum may carry water uphill, but cannot cross dry terrain above its head.
fn blockedRate(rate: f32, a: vec2i, b: vec2i) -> f32 {
  if (rate > 0.0 && surfaceAt(a) <= bedHeightAt(location(b))) { return 0.0; }
  if (rate < 0.0 && surfaceAt(b) <= bedHeightAt(location(a))) { return 0.0; }
  return rate;
}
fn relax(previous: f32, desired: f32) -> f32 {
  let blend = 1.0 - exp(-params.grid.w / ${WATER.responseTau});
  return previous + (desired - previous) * blend;
}
fn pourAt(world: vec2f) -> f32 {
  var amount = 0.0;
  for (var index = 0u; index < ${SAND.maxContacts}u; index++) {
    if (f32(index) >= params.tool.x) { break; }
    let tool = params.contacts[index];
    if (tool.end.w != WATER_MODE) { continue; }
    let distance = length(world - tool.start.xy) / max(tool.start.z, 1e-7);
    let envelope = max(0.0, 1.0 - distance * distance);
    amount += envelope * envelope * tool.start.w;
  }
  return amount * params.tool.y;
}

/** True for the strip of cells that belongs to the open sea. */
fn isSea(world: vec2f) -> bool {
  return params.tide.x > 0.5 && world.y < params.tide.y;
}

@compute @workgroup_size(8, 8)
fn clear(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(resolution(), arrayLength(&source) / resolution()))) { return; }
  let index = invocation.y * resolution() + invocation.x;
  destination[index] = vec4f(0.0);
  pipe[index] = vec4f(0.0);
}

@compute @workgroup_size(8, 8)
fn rates(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(resolution(), arrayLength(&source) / resolution()))) { return; }
  let cell = vec2i(invocation.xy);
  let index = address(cell);
  let state = source[index];
  let depth = max(state.x, 0.0);
  let surface = surfaceAt(cell);
  let previous = pipe[index];
  var flow = previous;
  flow.x = 0.0;
  flow.y = 0.0;
  let right = cell + vec2i(1, 0);
  if (right.x < i32(resolution())) {
    let neighbor = source[address(right)];
    flow.x = blockedRate(relax(previous.x, pipeRate(surface, surfaceAt(right), depth, max(neighbor.x, 0.0))), cell, right);
  }
  let up = cell + vec2i(0, 1);
  if (up.y < i32(arrayLength(&source) / resolution())) {
    let neighbor = source[address(up)];
    // A tsunami carries shoreward momentum across the entire wet front. This
    // is an ordinary conservative pipe transfer, never inland water creation.
    // A wall above the supplying surface still blocks it.
    let headroom = max(0.0, surface - bedHeightAt(location(up)));
    let carriedDepth = min(depth, headroom);
    // A wall reflects the bore: a prescribed velocity must not pump water
    // indefinitely up its face. Convert the incoming speed to a finite head.
    let boreHead = seaLevel(location(up)) + .004 + params.tool.w * params.tool.w / 19.62;
    let drive = clamp((boreHead - max(surface, surfaceAt(up))) / .008, 0.0, 1.0);
    let surge = params.tool.w * carriedDepth / params.grid.y * drive;
    flow.y = blockedRate(relax(previous.y, pipeRate(surface, surfaceAt(up), depth, max(neighbor.x, 0.0)) + surge), cell, up);
  }
  pipe[index] = vec4f(flow.x, flow.y, previous.z, 0.0);
}

@compute @workgroup_size(8, 8)
fn limits(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(resolution(), arrayLength(&source) / resolution()))) { return; }
  let cell = vec2i(invocation.xy);
  let index = address(cell);
  if (isSea(location(cell))) {
    // The open sea is not a bucket: it always has water to give, and it
    // swallows whatever the beach sends back.
    pipe[index].z = 1.0;
    return;
  }
  let depth = max(source[index].x, 0.0);
  let own = pipe[index];
  var outflow = max(0.0, own.x) + max(0.0, own.y);
  let left = cell - vec2i(1, 0);
  if (left.x >= 0) { outflow += max(0.0, -pipe[address(left)].x); }
  let down = cell - vec2i(0, 1);
  if (down.y >= 0) { outflow += max(0.0, -pipe[address(down)].y); }
  var scale = 1.0;
  if (outflow > 1e-12) {
    scale = min(1.0, depth / max(outflow * params.grid.w, 1e-12));
  }
  pipe[index].z = scale;
}

@compute @workgroup_size(8, 8)
fn update(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(resolution(), arrayLength(&source) / resolution()))) { return; }
  let cell = vec2i(invocation.xy);
  let index = address(cell);
  let state = source[index];
  let depth = max(state.x, 0.0);
  let own = pipe[index];
  var inflow = 0.0;
  var outflow = 0.0;
  var drift = vec2f(0.0);

  let right = cell + vec2i(1, 0);
  if (right.x < i32(resolution())) {
    let rate = own.x;
    if (rate > 0.0) {
      let transfer = rate * own.z;
      outflow += transfer;
      drift.x += transfer;
    } else {
      let transfer = -rate * pipe[address(right)].z;
      inflow += transfer;
      drift.x -= transfer;
    }
  }
  let left = cell - vec2i(1, 0);
  if (left.x >= 0) {
    let rate = pipe[address(left)].x;
    if (rate > 0.0) {
      let transfer = rate * pipe[address(left)].z;
      inflow += transfer;
      drift.x += transfer;
    } else {
      let transfer = -rate * own.z;
      outflow += transfer;
      drift.x -= transfer;
    }
  }
  let up = cell + vec2i(0, 1);
  if (up.y < i32(arrayLength(&source) / resolution())) {
    let rate = own.y;
    if (rate > 0.0) {
      let transfer = rate * own.z;
      outflow += transfer;
      drift.y += transfer;
    } else {
      let transfer = -rate * pipe[address(up)].z;
      inflow += transfer;
      drift.y -= transfer;
    }
  }
  let down = cell - vec2i(0, 1);
  if (down.y >= 0) {
    let rate = pipe[address(down)].y;
    if (rate > 0.0) {
      let transfer = rate * pipe[address(down)].z;
      inflow += transfer;
      drift.y += transfer;
    } else {
      let transfer = -rate * own.z;
      outflow += transfer;
      drift.y -= transfer;
    }
  }

  let dt = params.grid.w;
  let world = location(cell);
  let terrain = bedHeightAt(world);
  if (isSea(world)) {
    // The sea surface is exactly the tide level. Water reaches the beach
    // through the ordinary neighbouring cells, never by filling the pits
    // directly.
    let seaDepth = max(0.0, seaLevel(world) - terrain);
    let seaWet = smoothstep(0.0, ${WATER.wetReference}, seaDepth);
    let seaWetness = max(seaWet, max(state.w, 0.0) - ${WATER.dryRate} * dt);
    let waveDrift = params.tool.z * 3.5 * sin(params.bed.w * 1.496 - (world.y - params.tide.y) * 36.96);
    destination[index] = vec4f(seaDepth, 0.0, params.tide.w + waveDrift + params.tool.w, seaWetness);
    return;
  }
  var nextDepth = depth + (inflow - outflow) * dt;
  nextDepth = max(nextDepth, 0.0);
  nextDepth += pourAt(world) * dt;
  nextDepth = min(nextDepth, ${WATER.maxDepth});

  let spacing = params.grid.y;
  let speed = drift * spacing / max(nextDepth, 2e-4);
  let damping = exp(-${WATER.velocityDamping} * dt);
  let velocity = (state.yz + (speed - state.yz) * 0.45) * damping;

  let wetTarget = smoothstep(0.0, ${WATER.wetReference}, nextDepth);
  let wetness = max(wetTarget, max(state.w, 0.0) - ${WATER.dryRate} * dt);

  destination[index] = vec4f(nextDepth, velocity.x, velocity.y, wetness);
}
`
