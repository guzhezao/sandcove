import type { InterfaceElements } from '../ui/interface'

export class BootMonitor {
  private currentStage = 'Starting'
  private failure: Error | undefined
  private stop: (() => void) | undefined
  private adapter = 'unavailable'
  private readonly ui: InterfaceElements

  constructor(ui: InterfaceElements) { this.ui = ui }
  stage(stage: string) { this.assertHealthy(); this.currentStage = stage; this.ui.status.textContent = `${stage}…` }
  setAdapter(description: string) { this.adapter = description }
  setStop(stop: () => void) { this.stop = stop }
  assertHealthy() { if (this.failure) throw this.failure }

  async run(start: () => Promise<void>) {
    try {
      await start()
      this.assertHealthy()
      this.currentStage = 'Running'
      this.ui.overlay.classList.add('ready')
      this.ui.overlay.setAttribute('aria-hidden', 'true')
    } catch (error) { this.fail(error) }
  }

  fail(reason: unknown) {
    if (this.failure) return
    const error = reason instanceof Error ? reason : new Error(String(reason))
    this.failure = error
    this.stop?.()
    this.ui.overlay.classList.remove('ready')
    this.ui.overlay.classList.add('failed')
    this.ui.overlay.removeAttribute('aria-hidden')
    this.ui.title.textContent = '沙滩小筑无法继续'
    this.ui.status.textContent = '沙滩小筑需要支持 WebGPU 的浏览器与硬件加速的显卡。没有使用任何低画质替代渲染。'
    this.ui.diagnostics.hidden = false
    this.ui.diagnostics.textContent = [
      `阶段: ${this.currentStage}`, `错误: ${error.message}`,
      `视口: ${window.innerWidth} × ${window.innerHeight}; 设备像素比: ${window.devicePixelRatio}`,
      `绘制缓冲: ${this.ui.canvas.width} × ${this.ui.canvas.height}`,
      `适配器: ${this.adapter}`, `平台: ${navigator.userAgent}`,
    ].join('\n')
    this.ui.reload.hidden = false
    console.error(`[SANDCOVE: ${this.currentStage}]`, error)
  }
}
