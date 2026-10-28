import { SAND, TOOL, type Point, type Stroke } from './config'

export type DemoLayout = {
  pitAX: number
  pitBX: number
  channelY: number
  pitRadius: number
  channelRadius: number
}

type DemoStep = {
  kind: 'dig' | 'pour' | 'pile' | 'wait'
  from: 'left' | 'right' | 'channel' | 'none'
  to: 'channelEnd' | 'none'
  duration: number
  radius: 'pit' | 'channel' | 'none'
  label: string
}

const script: DemoStep[] = [
  { kind: 'dig', from: 'left', to: 'none', duration: 1.15, radius: 'pit', label: '挖出第一个坑' },
  { kind: 'dig', from: 'right', to: 'none', duration: 1.15, radius: 'pit', label: '挖出第二个坑' },
  { kind: 'dig', from: 'left', to: 'channelEnd', duration: 1.7, radius: 'channel', label: '挖一条沟连起来' },
  { kind: 'wait', from: 'none', to: 'none', duration: 0.5, radius: 'none', label: '让沙自己落稳' },
  { kind: 'pour', from: 'left', to: 'none', duration: 3.0, radius: 'pit', label: '往左边的坑倒水' },
  { kind: 'wait', from: 'none', to: 'none', duration: 3.2, radius: 'none', label: '水顺着沟流进右边的坑' },
]

export const demoScriptLength = script.length
export const demoTotalDuration = script.reduce((total, step) => total + step.duration, 0)

export type DemoFrame = {
  strokes: Stroke[]
  contacts: Stroke[]
  label: string
  running: boolean
}

/**
 * A short guided scene that uses the real tools: two pits, a channel between
 * them, and water poured into the first pit. It never fakes a result, it only
 * drives the same dig and pour paths the player uses. The layout follows the
 * camera, so the two pits stay inside the visible sand on a phone as well.
 */
export class TidepoolDemo {
  private index = 0
  private elapsed = 0
  private pointer: Point = { x: 0, y: 0 }
  private previous: Point = { x: 0, y: 0 }
  private started = false
  private launched = false
  private layout: DemoLayout = { pitAX: -0.105, pitBX: 0.105, channelY: 0.04, pitRadius: 0.03, channelRadius: 0.018 }

  /** The scene only runs once the player asks for it. */
  get running() { return this.launched && this.index < script.length }
  get label() { return this.index < script.length ? script[this.index].label : '' }
  get progress() { return this.index / script.length }

  setLayout(layout: DemoLayout) { this.layout = layout }

  restart() {
    this.index = 0
    this.elapsed = 0
    this.started = false
    this.launched = true
    this.pointer = this.anchor('left')
    this.previous = { ...this.pointer }
  }

  stop() {
    this.launched = false
    this.index = script.length
    this.elapsed = 0
  }

  private anchor(which: 'left' | 'right' | 'channel' | 'none'): Point {
    if (which === 'left') return { x: this.layout.pitAX, y: this.layout.channelY }
    if (which === 'right') return { x: this.layout.pitBX, y: this.layout.channelY }
    if (which === 'channel') return { x: this.layout.pitAX, y: this.layout.channelY }
    return { x: 0, y: 0 }
  }

  private radiusFor(kind: 'pit' | 'channel' | 'none') {
    if (kind === 'pit') return this.layout.pitRadius
    if (kind === 'channel') return this.layout.channelRadius
    return 0.01
  }

  step(dt: number): DemoFrame {
    if (!this.running) return { strokes: [], contacts: [], label: '', running: false }
    const step = script[this.index]
    if (!this.started) {
      this.started = true
      this.pointer = this.anchor(step.from)
      this.previous = { ...this.pointer }
    }
    this.elapsed += dt
    if (step.kind === 'dig' && step.to === 'channelEnd') {
      const t = Math.min(1, this.elapsed / step.duration)
      const end = { x: this.layout.pitBX, y: this.layout.channelY }
      const start = { x: this.layout.pitAX, y: this.layout.channelY }
      this.pointer = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }
    } else {
      this.pointer = this.anchor(step.from)
    }
    if (this.elapsed >= step.duration) {
      this.elapsed = 0
      this.started = false
      this.index++
      if (!this.running) return { strokes: [], contacts: [], label: '', running: false }
      this.pointer = this.anchor(script[this.index].from)
      this.previous = { ...this.pointer }
      return { strokes: [], contacts: [], label: script[this.index].label, running: true }
    }
    const dwell = this.elapsed
    const from = { ...this.previous }
    const to = { ...this.pointer }
    const stroke: Stroke = {
      from, to,
      velocity: { x: (to.x - from.x) / Math.max(dt, 1e-4), y: (to.y - from.y) / Math.max(dt, 1e-4) },
      radius: this.radiusFor(step.radius),
      pressure: 0.85,
      active: true,
      mode: step.kind === 'pour' ? TOOL.water : step.kind === 'pile' ? TOOL.pile : TOOL.dig,
      dwell,
    }
    this.previous = to
    if (step.kind === 'pour') return { strokes: [], contacts: [stroke], label: step.label, running: true }
    if (step.kind === 'wait') return { strokes: [], contacts: [], label: step.label, running: true }
    return { strokes: [stroke], contacts: [], label: step.label, running: true }
  }
}

export const demoRadiusLimit = SAND.extent / 2 - 0.03
