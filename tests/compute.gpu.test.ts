import { expect, test } from 'vitest'
import { create, globals } from 'webgpu'

test('WGSL storage arrays copy correctly over three submitted frames', async () => {
  Object.assign(globalThis, globals)
  const gpu = create([])
  const adapter = await gpu.requestAdapter()
  expect(adapter, 'A real WebGPU adapter is required').not.toBeNull()
  const device = await adapter!.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event: GPUUncapturedErrorEvent) => errors.push(event.error.message))
  try {
    const source = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    const destination = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    const readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const shader = device.createShaderModule({ code: `
      @group(0) @binding(0) var<storage, read> source: array<f32>;
      @group(0) @binding(1) var<storage, read_write> destination: array<f32>;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3u) {
        if (id.x < arrayLength(&source)) { destination[id.x] = source[id.x]; }
      }` })
    const info = await shader.getCompilationInfo()
    expect(info.messages.filter((message: GPUCompilationMessage) => message.type === 'error')).toEqual([])
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } })
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: destination } },
    ] })
    for (let frame = 0; frame < 3; frame++) {
      const input = Float32Array.from({ length: 64 }, (_, index) => frame * 100 + index * 0.25)
      device.queue.writeBuffer(source, 0, input)
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindings)
      pass.dispatchWorkgroups(1)
      pass.end()
      encoder.copyBufferToBuffer(destination, 0, readback, 0, 256)
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ)
      expect(Array.from(new Float32Array(readback.getMappedRange()))).toEqual(Array.from(input))
      readback.unmap()
    }
    expect(errors).toEqual([])
    source.destroy()
    destination.destroy()
    readback.destroy()
  } finally {
    device.destroy()
  }
})
