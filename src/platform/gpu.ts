import type { BootMonitor } from './boot'

export async function createGpu(canvas: HTMLCanvasElement, monitor: BootMonitor) {
  if (!navigator.gpu) throw new Error('此浏览器没有提供 WebGPU。请使用支持 WebGPU 的浏览器，并通过 https 或 localhost 打开。')
  monitor.stage('Requesting GPU')
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('没有找到可用的 WebGPU 显卡适配器。')
  if (adapter.info.isFallbackAdapter) throw new Error('需要硬件加速的 WebGPU 适配器，不接受软件回退渲染。')
  monitor.setAdapter([adapter.info.vendor, adapter.info.architecture, adapter.info.description].filter(Boolean).join(' / '))
  const device = await adapter.requestDevice({ label: 'Sandboard GPU' })
  let disposed = false
  void device.lost.then((info) => {
    if (!disposed) monitor.fail(new Error(`GPU device lost (${info.reason}): ${info.message}`))
  })
  device.addEventListener('uncapturederror', (event) => monitor.fail(new Error(`Uncaptured GPU error: ${event.error.message}`)))
  const context = canvas.getContext('webgpu')
  try {
    monitor.assertHealthy()
    if (!context) throw new Error('浏览器无法创建 WebGPU 画布上下文。')
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'opaque' })
    return { device, context, format, dispose: () => { disposed = true; context.unconfigure(); device.destroy() } }
  } catch (error) { disposed = true; device.destroy(); throw error }
}
