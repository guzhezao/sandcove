import type { SandSound } from '../audio/sound'
import { SAND, TOOL, type ToolMode, type Point } from '../config'
import type { SandCamera } from '../render/camera'
import type { InterfaceElements } from '../ui/interface'
import { moldOutline, moldHeight, wallStamp, wallOutline, type MoldKind, type MoldStamp } from '../simulation/molds'
import { StrokeQueue } from './strokes'

const keyboardPointerId = -1

const toolSizing: Record<ToolMode, { min: number; max: number; value: number }> = {
  [TOOL.dig]: { min: 18, max: 90, value: 50 },
  [TOOL.pile]: { min: 10, max: 70, value: 32 },
  [TOOL.water]: { min: 12, max: 44, value: 24 },
  [TOOL.mold]: { min: 25, max: 100, value: 60 },
}

export class InputController {
  readonly strokes = new StrokeQueue()
  readonly stamps: MoldStamp[] = []
  mold: MoldKind = 'tower'
  moldAngle = 0
  buildMode: 'wall' | 'mound' = 'wall'
  private wallDrag?: { id: number; from: Point; to: Point; base: number }
  private hovering = false
  private readonly camera: SandCamera
  showPointer = false
  tool: ToolMode = TOOL.dig
  private readonly pointers = new Set<number>()
  private readonly pointerStartedAt = new Map<number, number>()
  private readonly suppressedPointers = new Set<number>()
  private readonly controller = new AbortController()
  private readonly canvas: HTMLCanvasElement
  private orbitMode = false
  private keyboardDrawing = false
  private interactive = true
  private adjustable = true
  private interactiveSince = -Infinity
  private readonly rememberedRadius = new Map<ToolMode, number>()
  private readonly onToolChange: ((tool: ToolMode) => void) | undefined
  private readonly ui: InterfaceElements

  constructor(
    ui: InterfaceElements,
    camera: SandCamera,
    sound: SandSound,
    reset: () => void,
    onToolChange?: (tool: ToolMode) => void,
  ) {
    const { signal } = this.controller
    const canvas = ui.canvas
    this.canvas = canvas
    this.camera = camera
    this.ui = ui
    this.onToolChange = onToolChange
    const pickedPointers = new Map<number, { x: number; y: number; point: Point }>()
    const position = (event: PointerEvent) => {
      // A stationary press keeps sculpting the same place as its height changes.
      // In particular, releasing it must not draw a stroke to a newly exposed wall.
      const previous = pickedPointers.get(event.pointerId)
      if (previous?.x === event.clientX && previous.y === event.clientY) return previous.point
      const rect = canvas.getBoundingClientRect()
      const point = camera.screenToSurface(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height)
      pickedPointers.set(event.pointerId, { x: event.clientX, y: event.clientY, point })
      return point
    }
    const onBed = (point: Point) => Math.abs(point.x) <= SAND.extent / 2 - .03 && point.y >= -SAND.extent / 2 + .03 && point.y <= SAND.length - SAND.extent / 2 - .03
    const pressure = (event: PointerEvent) => event.pointerType === 'pen' ? event.pressure : 0.75
    const eventTimelineTime = (event: PointerEvent) => event.timeStamp > performance.timeOrigin ? event.timeStamp - performance.timeOrigin : event.timeStamp
    const isOlderThanCurrentPointer = (event: PointerEvent) => {
      const startedAt = this.pointerStartedAt.get(event.pointerId)
      if (startedAt === undefined) return false
      const eventTime = eventTimelineTime(event)
      return Number.isFinite(eventTime) && eventTime > 0 && eventTime < startedAt
    }
    const cameraPointers = new Map<number, { x: number; y: number; pan: boolean }>()
    const chooseMold = (kind: MoldKind) => {
      this.mold = kind
      this.setTool(TOOL.mold)
      for (const [button, shape] of [[ui.moldTower,'tower'],[ui.moldWall,'wall'],[ui.moldArc,'arc']] as const) {
        button?.setAttribute('aria-checked', String(shape === kind)); button?.classList.toggle('active', shape === kind)
      }
    }
    ui.moldTower?.addEventListener('click', () => chooseMold('tower'), {signal})
    ui.moldWall?.addEventListener('click', () => chooseMold('wall'), {signal})
    ui.moldArc?.addEventListener('click', () => chooseMold('arc'), {signal})
    ui.moldRotate?.addEventListener('click', () => this.rotateMold(45), {signal})
    for (const [button, mode] of [[ui.buildWall, 'wall'], [ui.buildMound, 'mound']] as const) {
      button?.addEventListener('click', () => {
        cancelAll(); this.buildMode = mode; this.setTool(TOOL.pile)
        for (const [choice, value] of [[ui.buildWall, 'wall'], [ui.buildMound, 'mound']] as const) {
          choice?.setAttribute('aria-checked', String(value === mode)); choice?.classList.toggle('active', value === mode)
        }
      }, {signal})
    }
    canvas.addEventListener('pointerleave', () => { this.hovering = false }, {signal})
    canvas.addEventListener('contextmenu', event => event.preventDefault(), { signal })
    canvas.addEventListener('wheel', event => {
      if (!this.interactive) return
      event.preventDefault()
      camera.dolly(-event.deltaY * 0.001)
    }, { signal, passive: false })
    ui.orbit?.addEventListener('click', () => {
      if (!this.interactive) return
      cancelAll()
      this.setOrbitMode(true)
      ui.showToolMenu?.('hand',true)
    }, { signal })
    ui.zoomIn?.addEventListener('click', () => camera.dolly(0.15), { signal })
    ui.zoomOut?.addEventListener('click', () => camera.dolly(-0.15), { signal })
    canvas.addEventListener('pointerdown', (event) => {
      const eventTime = eventTimelineTime(event)
      // A delayed event from an older WebKit pointer generation must never
      // suppress or replace an already accepted contact that reused the ID.
      if (this.pointers.has(event.pointerId) || this.wallDrag) return
      const staleLockedEvent = Number.isFinite(eventTime) && eventTime > 0 && eventTime < this.interactiveSince
      if (!this.interactive || staleLockedEvent) {
        this.suppressedPointers.add(event.pointerId)
        return
      }
      this.suppressedPointers.delete(event.pointerId)
      if (this.orbitMode || event.button === 2 || event.button === 1 || event.altKey) {
        cancelAll()
        cameraPointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pan: event.shiftKey || event.button === 1 })
        canvas.setPointerCapture(event.pointerId)
        canvas.style.cursor = 'grabbing'
        return
      }
      if (event.pointerType === 'mouse' && event.button !== 0) return
      if (!onBed(position(event))) { this.hovering = false; return }
      if (this.isWallTool) {
        const point = position(event)
        this.wallDrag = { id: event.pointerId, from: point, to: point, base: camera.heightAt(point.x, point.y) }
        this.pointers.add(event.pointerId); this.pointerStartedAt.set(event.pointerId, eventTime)
        this.strokes.move(point, pressure(event), eventTime, event.pointerId)
        canvas.setPointerCapture(event.pointerId); canvas.focus({preventScroll:true})
        this.hovering = true; this.onToolChange?.(this.tool)
        return
      }
      if (this.tool === TOOL.mold) {
        pickedPointers.delete(event.pointerId)
        const point = position(event)
        this.strokes.move(point, pressure(event), eventTime, event.pointerId)
        if (this.stamps.length < 4) this.stamps.push({point, radius:this.strokes.radius, height:moldHeight(this.mold), angle:this.moldAngle*Math.PI/180, kind:this.mold})
        this.hovering = true
        canvas.focus({preventScroll:true})
        this.onToolChange?.(TOOL.mold)
        return
      }
      const startedAt = Number.isFinite(eventTime) && eventTime > 0 ? eventTime : performance.now()
      this.pointers.add(event.pointerId)
      this.pointerStartedAt.set(event.pointerId, startedAt)
      canvas.setPointerCapture(event.pointerId)
      canvas.focus({ preventScroll: true })
      pickedPointers.delete(event.pointerId)
      this.strokes.begin(position(event), pressure(event), startedAt, event.pointerId)
      sound.beginPointer(event, this.tool)
      this.showPointer = true
    }, { signal })
    canvas.addEventListener('pointermove', (event) => {
      this.hovering = true
      const navigating = cameraPointers.get(event.pointerId)
      if (navigating) {
        const dx = event.clientX - navigating.x, dy = event.clientY - navigating.y
        if (navigating.pan) camera.pan(dx, dy, canvas.clientHeight)
        else camera.orbit(dx, dy)
        navigating.x = event.clientX; navigating.y = event.clientY
        pickedPointers.clear()
        return
      }
      if (this.orbitMode) return
      if (!this.interactive || this.suppressedPointers.has(event.pointerId) || isOlderThanCurrentPointer(event)) return
      const samples = event.getCoalescedEvents?.() ?? []
      for (const sample of samples.length ? samples : [event]) {
        if (isOlderThanCurrentPointer(sample)) continue
        const point = position(sample)
        if (!onBed(point)) { cancelPointer(event.pointerId); this.hovering = false; continue }
        if (this.wallDrag?.id === event.pointerId) {
          this.updateWallEnd(point, event.shiftKey); continue
        }
        this.strokes.move(point, pressure(sample), eventTimelineTime(sample), event.pointerId)
        this.showPointer = true
        sound.movePointer(sample, event.pointerId)
      }
    }, { signal })
    canvas.addEventListener('pointerup', (event) => {
      if (cameraPointers.delete(event.pointerId)) {
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
        canvas.style.cursor = this.orbitMode ? 'grab' : 'crosshair'
        return
      }
      if (this.suppressedPointers.has(event.pointerId) && !this.pointers.has(event.pointerId)) {
        this.suppressedPointers.delete(event.pointerId)
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
        return
      }
      if (isOlderThanCurrentPointer(event)) return
      if (!this.interactive && !this.pointers.has(event.pointerId)) return
      if (!this.pointers.has(event.pointerId)) return
      const point = position(event)
      if (!onBed(point)) { cancelPointer(event.pointerId); return }
      if (this.wallDrag?.id === event.pointerId) {
        this.updateWallEnd(point, event.shiftKey); this.finishWall()
      } else {
        this.strokes.move(point, pressure(event), eventTimelineTime(event), event.pointerId)
        sound.movePointer(event)
        this.strokes.end(event.pointerId)
      }
      pickedPointers.delete(event.pointerId)
      sound.endPointer(event.pointerId)
      this.pointers.delete(event.pointerId)
      this.pointerStartedAt.delete(event.pointerId)
      this.suppressedPointers.delete(event.pointerId)
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }, { signal })
    const cancelPointer = (pointerId: number) => {
      if (this.wallDrag?.id === pointerId) this.wallDrag = undefined
      cameraPointers.delete(pointerId)
      pickedPointers.delete(pointerId)
      this.suppressedPointers.delete(pointerId)
      this.pointers.delete(pointerId)
      this.pointerStartedAt.delete(pointerId)
      this.strokes.cancel(pointerId)
      sound.endPointer(pointerId)
    }
    const cancelAll = (suppressActive = false) => {
      this.wallDrag = undefined
      cameraPointers.clear()
      pickedPointers.clear()
      const activePointers = [...this.pointers]
      if (suppressActive) for (const pointerId of activePointers) this.suppressedPointers.add(pointerId)
      this.pointers.clear()
      this.pointerStartedAt.clear()
      for (const pointerId of activePointers) {
        if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
      }
      this.keyboardDrawing = false
      this.strokes.cancel()
      sound.cancelAll()
    }
    canvas.addEventListener('pointercancel', (event) => { if (!isOlderThanCurrentPointer(event)) cancelPointer(event.pointerId) }, { signal })
    canvas.addEventListener('lostpointercapture', (event) => {
      if (this.pointers.has(event.pointerId) && !isOlderThanCurrentPointer(event)) cancelPointer(event.pointerId)
    }, { signal })
    window.addEventListener('blur', () => cancelAll(), { signal })
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAll() }, { signal })
    ui.radius.addEventListener('input', () => { if (!this.adjustable) { this.applyToolSizing(); return }; this.strokes.radius = Number(ui.radius.value) / 1000; this.showPointer = true }, { signal })
    ui.reset.addEventListener('click', () => { if (!this.interactive) return; cancelAll(true); reset() }, { signal })
    for (const entry of ui.tools) {
      entry.button.addEventListener('click', () => { if (!this.interactive) return; this.setTool(entry.mode); ui.showToolMenu?.(entry.mode,true) }, { signal })
    }
    window.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const editing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      const key = event.key.toLowerCase()
      if (key === 'escape') { cancelAll(); return }
      if (key === '1' || key === '2' || key === '3' || key === '4') {
        const mode = key === '1' ? TOOL.dig : key === '2' ? TOOL.pile : key === '3' ? TOOL.water : TOOL.mold
        if (!this.interactive) return
        this.setTool(mode)
        ui.showToolMenu?.(mode)
        return
      }
      if ((key === '5' || key === 'h') && !editing) { if (!this.interactive) return; cancelAll(); this.setOrbitMode(true); ui.showToolMenu?.('hand'); return }
      if (key === 'r') { if (!this.interactive) return; cancelAll(true); reset(); return }
      if (!this.interactive || editing || this.orbitMode) return
      if (this.tool === TOOL.mold && (key === 'q' || key === 'e')) {
        this.rotateMold(key === 'q' ? -15 : 15); return
      }
      if (event.code === 'Space') {
        event.preventDefault()
        if (this.isWallTool) {
          if (!event.repeat && !this.wallDrag) {
            const point = {...this.strokes.position}
            this.wallDrag = {id:keyboardPointerId,from:point,to:point,base:camera.heightAt(point.x,point.y)}
            this.hovering = true
          }
          return
        }
        if (this.tool === TOOL.mold) {
          if (!event.repeat && this.stamps.length < 4) this.stamps.push({point:{...this.strokes.position},radius:this.strokes.radius,height:moldHeight(this.mold),angle:this.moldAngle*Math.PI/180,kind:this.mold})
          return
        }
        if (!this.keyboardDrawing) { this.strokes.begin(this.strokes.position, 0.75, event.timeStamp, keyboardPointerId); this.keyboardDrawing = true }
      }
      const movement: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
      const direction = movement[event.key]
      if (direction) {
        event.preventDefault()
        this.showPointer = true
        this.strokes.move({ x: this.strokes.position.x + direction[0] * 0.003, y: this.strokes.position.y + direction[1] * 0.003 }, 0.75, event.timeStamp, keyboardPointerId)
        if (this.wallDrag?.id === keyboardPointerId) this.updateWallEnd(this.strokes.position, event.shiftKey)
      }
      if (this.adjustable && (event.key === '[' || event.key === ']')) {
        ui.radius.value = String(Number(ui.radius.value) + (event.key === '[' ? -1 : 1))
        this.strokes.radius = Number(ui.radius.value) / 1000
        this.showPointer = true
      }
    }, { signal })
    window.addEventListener('keyup', (event) => {
      if (event.code === 'Space') {
        if (this.wallDrag?.id === keyboardPointerId) this.finishWall()
        this.strokes.end(keyboardPointerId); this.keyboardDrawing = false
      }
    }, { signal })
    this.applyToolSizing(TOOL.dig)
    if (ui.orbit) this.setOrbitMode(true)
  }

  /**
   * Switching tools truncates whatever the previous tool was doing. A press
   * that is still held starts again with the new tool from the same spot, so
   * no old stroke can keep digging or keep pouring behind the user's back.
   */
  setTool(mode: ToolMode) {
    this.wallDrag = undefined
    this.setOrbitMode(false)
    if (mode === this.tool) return
    // The slider is the source of truth for the size, so each tool remembers
    // the width the player last set for it.
    if (this.adjustable) this.rememberedRadius.set(this.tool, Number(this.ui.radius.value))
    const held = this.strokes.heldContacts()
    this.strokes.cancel()
    this.tool = mode
    this.strokes.mode = mode
    this.applyToolSizing()
    for (const contact of mode === TOOL.mold || this.isWallTool ? [] : held) {
      this.strokes.begin(contact.from, contact.pressure, performance.now(), contact.pointerId ?? keyboardPointerId)
    }
    this.onToolChange?.(mode)
  }

  private rotateMold(degrees: number) {
    this.moldAngle = (this.moldAngle + degrees + 360) % 360
    if (this.ui.moldAngle) this.ui.moldAngle.value = `${this.moldAngle}°`
  }

  get isWallTool() { return (this.tool === TOOL.pile && this.buildMode === 'wall') || (this.tool === TOOL.mold && this.mold === 'wall') }
  get usesPlacementPreview() { return this.tool === TOOL.mold || this.isWallTool }

  private updateWallEnd(point: Point, snap = false) {
    const drag = this.wallDrag
    if (!drag) return
    let x = point.x, y = point.y
    if (snap) {
      const length = Math.hypot(x-drag.from.x,y-drag.from.y)
      const angle = Math.round(Math.atan2(y-drag.from.y,x-drag.from.x)/(Math.PI/4))*Math.PI/4
      x = drag.from.x + Math.cos(angle)*length; y = drag.from.y + Math.sin(angle)*length
    }
    const margin = this.strokes.radius + .012
    drag.to = {x:Math.max(-SAND.extent/2+margin,Math.min(SAND.extent/2-margin,x)),
      y:Math.max(-SAND.extent/2+margin,Math.min(SAND.length-SAND.extent/2-margin,y))}
    this.strokes.move(drag.to,.75)
  }

  private finishWall() {
    const drag = this.wallDrag
    if (drag && this.stamps.length < 4) this.stamps.push(wallStamp(drag.from,drag.to,this.strokes.radius,drag.base,this.moldAngle*Math.PI/180))
    this.wallDrag = undefined
  }

  updateMoldPreview() {
    if (this.ui.feedback) {
      const drawing = this.wallDrag !== undefined
      this.ui.feedback.hidden = this.orbitMode || !this.interactive
      this.ui.feedback.textContent = drawing ? '松手筑成整面沙墙 · Shift 对齐 · Esc 取消'
        : this.isWallTool ? '按住拖动拉出沙墙，松手筑成' : this.tool === TOOL.dig ? '拖动挖沟 · 长按清底 · 连通海边可引水'
        : this.tool === TOOL.pile ? '按住堆起沙丘，拖动加厚堤坝' : this.tool === TOOL.water ? '按住倒水，让水沿沟渠流动' : '点击放置模具 · Q / E 转向'
    }
    const svg = this.ui.moldPreview
    if (!svg) return
    const visible = this.usesPlacementPreview && this.hovering && !this.orbitMode && this.interactive
    svg.style.display = visible ? '' : 'none'
    svg.toggleAttribute('hidden', !visible)
    if (!visible) return
    const rect = this.canvas.getBoundingClientRect(), centre = this.strokes.position
    if (this.isWallTool) {
      const drag = this.wallDrag ?? {from:centre,to:centre,base:this.camera.heightAt(centre.x,centre.y)}
      const stamp = wallStamp(drag.from,drag.to,this.strokes.radius,drag.base,this.moldAngle*Math.PI/180)
      const outline = wallOutline(stamp)
      const project = (h:number) => outline.map(p=>this.camera.project(p.x,h,p.y,rect.width,rect.height))
      const base = project(drag.base+.001), top = project(drag.base+stamp.height)
      const path = (points:Point[]) => points.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')+' Z'
      this.ui.moldFootprint.setAttribute('d',path(base)+' '+path(top)+' '+base.map((p,i)=>`M${p.x},${p.y} L${top[i].x},${top[i].y}`).join(' '))
      return
    }
    const angle = this.moldAngle*Math.PI/180, c=Math.cos(angle), s=Math.sin(angle)
    const points = moldOutline(this.mold).map(p => {
      const x=centre.x+(c*p.x-s*p.y)*this.strokes.radius, z=centre.y+(s*p.x+c*p.y)*this.strokes.radius
      return this.camera.project(x,this.camera.heightAt(x,z)+.0008,z,rect.width,rect.height)
    })
    this.ui.moldFootprint.setAttribute('d', points.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')+' Z')
  }

  private setOrbitMode(enabled: boolean) {
    if (enabled) this.wallDrag = undefined
    this.orbitMode = enabled
    this.ui.orbit?.setAttribute('aria-pressed', String(enabled))
    this.ui.orbit?.classList.toggle('active', enabled)
    this.canvas.style.cursor = enabled ? 'grab' : 'crosshair'
    for(const entry of this.ui.tools){
      const selected=!enabled && entry.mode===this.tool
      entry.button.classList.toggle('active',selected);entry.button.setAttribute('aria-checked',String(selected))
    }
  }

  private applyToolSizing(mode?: ToolMode) {
    const target = mode ?? this.tool
    const sizing = toolSizing[target]
    const remembered = this.adjustable ? this.rememberedRadius.get(target) : undefined
    const radius = this.ui.radius
    radius.min = String(sizing.min)
    radius.max = String(sizing.max)
    radius.value = String(Math.max(sizing.min, Math.min(sizing.max, remembered ?? sizing.value)))
    this.strokes.radius = Number(radius.value) / 1000
    this.ui.updateRadiusLabel?.()
    for (const entry of this.ui.tools) {
      const active = entry.mode === target
      entry.button.classList.toggle('active', active)
      entry.button.setAttribute('aria-checked', active ? 'true' : 'false')
    }
  }

  /** Challenge sizes are fixed; sandbox choices survive a round trip. */
  setAdjustable(adjustable: boolean) {
    if (this.adjustable === adjustable) return
    if (this.adjustable) this.rememberedRadius.set(this.tool, Number(this.ui.radius.value))
    this.adjustable = adjustable
    this.strokes.cancel()
    this.wallDrag = undefined
    this.applyToolSizing()
    this.setOrbitMode(this.orbitMode)
  }

  setInteractive(interactive: boolean) {
    if (this.interactive === interactive) return
    this.interactive = interactive
    if (!interactive) {
      this.wallDrag = undefined
      this.stamps.length = 0
      const activePointers = [...this.pointers]
      for (const pointerId of activePointers) this.suppressedPointers.add(pointerId)
      this.pointers.clear()
      this.pointerStartedAt.clear()
      for (const pointerId of activePointers) {
        if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId)
      }
      this.keyboardDrawing = false
      this.showPointer = false
      this.strokes.cancel()
      return
    }

    // Start every post-reset interaction from a completely clean queue. Any
    // touch that physically began while locked remains quarantined until its
    // pointerup/cancel, and delayed WebKit events older than this boundary are
    // rejected by their event timestamp.
    this.strokes.cancel()
    this.interactiveSince = performance.now()
  }

  dispose() { this.wallDrag = undefined; this.stamps.length = 0; this.controller.abort(); this.pointers.clear(); this.pointerStartedAt.clear(); this.suppressedPointers.clear(); this.strokes.cancel() }
}
