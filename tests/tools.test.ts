import { describe, expect, test } from 'vitest'
import { SAND, TOOL, digDepthScale } from '../src/config'
import { StrokeQueue } from '../src/input/strokes'
import { TidepoolDemo, demoScriptLength, demoTotalDuration } from '../src/demo'

// The controller only needs the window and document for its global
// listeners, so a minimal stub is enough to exercise the tool logic.
const globals = globalThis as unknown as { window?: unknown; document?: unknown }
globals.window = { addEventListener: () => {} }
globals.document = { addEventListener: () => {} }

class FakeElement {
  style = { cursor: "" }
  readonly listeners = new Map<string, ((event: unknown) => void)[]>()
  value = '14'
  min = '8'
  max = '30'
  disabled = false
  readonly attributes = new Map<string, string>()
  readonly classes = new Set<string>()
  readonly classList = {
    toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name) },
    add: (name: string) => { this.classes.add(name) },
    remove: (name: string) => { this.classes.delete(name) },
    contains: (name: string) => this.classes.has(name),
  }
  addEventListener(type: string, handler: (event: unknown) => void) {
    const existing = this.listeners.get(type) ?? []
    existing.push(handler)
    this.listeners.set(type, existing)
  }
  dispatch(type: string, event: unknown = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 700 } }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return false }
  focus() {}
}

function makeController() {
  const canvas = new FakeElement()
  const radius = new FakeElement()
  const reset = new FakeElement()
  const demo = new FakeElement()
  const toolButtons = [new FakeElement(), new FakeElement(), new FakeElement()]
  const ui = {
    canvas: canvas as unknown as HTMLCanvasElement,
    overlay: new FakeElement() as unknown as HTMLElement,
    title: new FakeElement() as unknown as HTMLElement,
    status: new FakeElement() as unknown as HTMLElement,
    diagnostics: new FakeElement() as unknown as HTMLElement,
    reload: new FakeElement() as unknown as HTMLButtonElement,
    radius: radius as unknown as HTMLInputElement,
    reset: reset as unknown as HTMLButtonElement,
    demo: demo as unknown as HTMLButtonElement,
    tools: [
      { mode: TOOL.dig, button: toolButtons[0] as unknown as HTMLButtonElement },
      { mode: TOOL.pile, button: toolButtons[1] as unknown as HTMLButtonElement },
      { mode: TOOL.water, button: toolButtons[2] as unknown as HTMLButtonElement },
    ],
  }
  return { ui, canvas, radius, reset, toolButtons }
}

describe('Held dig depth', () => {
  test('a short press and a long press ask for different depths', () => {
    expect(digDepthScale(0)).toBeCloseTo(1, 6)
    expect(digDepthScale(1)).toBeGreaterThan(digDepthScale(0.2))
    expect(digDepthScale(30)).toBeCloseTo(SAND.digDepthScaleMax, 6)
    expect(digDepthScale(-5)).toBeCloseTo(1, 6)
  })
  test('a stationary press keeps deepening while the clock advances', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0.1, y: 0 }, 0.8, 1000, 1)
    const early = queue.heldContacts(1200)[0]
    const late = queue.heldContacts(3000)[0]
    expect(early).toBeDefined()
    expect(late).toBeDefined()
    expect(early!.dwell!).toBeCloseTo(0.2, 6)
    expect(late!.dwell!).toBeCloseTo(2, 6)
    expect(digDepthScale(late!.dwell!)).toBeGreaterThan(digDepthScale(early!.dwell!))
  })
  test('the held contact never moves on its own', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0.1, y: 0 }, 0.8, 1000, 1)
    const contact = queue.heldContacts(2500)[0]
    expect(contact.from.x).toBe(0.1)
    expect(contact.to.x).toBe(0.1)
    expect(contact.velocity.x).toBe(0)
  })
  test('releasing stops the held contact', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0.1, y: 0 }, 0.8, 1000, 1)
    expect(queue.heldContacts(1500)).toHaveLength(1)
    queue.end(1)
    expect(queue.heldContacts(1500)).toHaveLength(0)
    expect(queue.nextBatch(1500).filter((stroke) => stroke.active)).toHaveLength(0)
  })
  test('a batch carries the held contact even when the pointer never moves', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0.1, y: 0 }, 0.8, 1000, 1)
    const batch = queue.nextBatch(1400)
    expect(batch.filter((stroke) => stroke.active)).toHaveLength(1)
    expect(batch[0].dwell).toBeCloseTo(0.4, 6)
  })
})

describe('Tool switching', () => {
  test('switching tools truncates the strokes of the previous tool', async () => {
    const { ui, toolButtons } = makeController()
    const { InputController } = await import('../src/input/controller')
    const controller = new InputController(ui as never, { screenToBed: () => ({ x: 0, y: 0 }) } as never, {} as never, () => {})
    controller.strokes.begin({ x: 0.2, y: 0 }, 0.8, 1000, 1)
    controller.strokes.move({ x: 0.22, y: 0 }, 0.8, 1100, 1)
    expect(controller.strokes.nextBatch(1200).length).toBeGreaterThan(0)
    controller.setTool(TOOL.water)
    expect(controller.tool).toBe(TOOL.water)
    expect(controller.strokes.mode).toBe(TOOL.water)
    // The queued dig segments are gone and the press starts again as water.
    const held = controller.strokes.heldContacts(1300)
    expect(held).toHaveLength(1)
    expect(held[0].mode).toBe(TOOL.water)
    expect(held[0].from.x).toBeCloseTo(0.22, 6)
    expect(toolButtons[2].attributes.get('aria-checked')).toBe('true')
    expect(toolButtons[0].attributes.get('aria-checked')).toBe('false')
  })
  test('a keyboard tool shortcut and a tool button select the same numeric mode', async () => {
    const { ui, toolButtons } = makeController()
    const { InputController } = await import('../src/input/controller')
    const controller = new InputController(ui as never, { screenToBed: () => ({ x: 0, y: 0 }) } as never, {} as never, () => {})
    toolButtons[1].dispatch('click')
    expect(controller.tool).toBe(TOOL.pile)
    expect(controller.tool).toBe(1)
    expect(toolButtons[1].attributes.get('aria-checked')).toBe('true')
  })
  test('each tool remembers the size the player last set for it', async () => {
    const { ui, radius } = makeController()
    const { InputController } = await import('../src/input/controller')
    const controller = new InputController(ui as never, { screenToBed: () => ({ x: 0, y: 0 }) } as never, {} as never, () => {})
    radius.value = '27'
    radius.dispatch('input')
    expect(controller.strokes.radius).toBeCloseTo(0.027, 6)
    controller.setTool(TOOL.water)
    expect(radius.value).not.toBe('27')
    controller.setTool(TOOL.dig)
    expect(radius.value).toBe('27')
    expect(controller.strokes.radius).toBeCloseTo(0.027, 6)
  })
})

describe('Guided demo', () => {
  test('the scene stays still until the player asks for it', () => {
    const demo = new TidepoolDemo()
    expect(demo.running).toBe(false)
    const frame = demo.step(1 / 120)
    expect(frame.strokes).toHaveLength(0)
    expect(frame.contacts).toHaveLength(0)
    expect(demo.running).toBe(false)
  })
  test('the script digs two pits, joins them and pours into the first one', () => {
    const demo = new TidepoolDemo()
    demo.restart()
    expect(demo.running).toBe(true)
    let digSteps = 0
    let pourSteps = 0
    let frames = 0
    while (demo.running && frames < 10000) {
      const frame = demo.step(1 / 120)
      if (frame.strokes.length) digSteps++
      if (frame.contacts.length) pourSteps++
      frames++
    }
    expect(demo.running).toBe(false)
    expect(digSteps).toBeGreaterThan(100)
    expect(pourSteps).toBeGreaterThan(100)
    expect(demoScriptLength).toBeGreaterThan(3)
    expect(demoTotalDuration).toBeGreaterThan(5)
  })
  test('the demo pours with the water tool and digs with the shovel', () => {
    const demo = new TidepoolDemo()
    demo.restart()
    const modes = new Set<number>()
    for (let index = 0; index < 2000 && demo.running; index++) {
      const frame = demo.step(1 / 120)
      for (const stroke of frame.strokes) modes.add(stroke.mode!)
      for (const contact of frame.contacts) modes.add(contact.mode!)
    }
    expect(modes.has(TOOL.dig)).toBe(true)
    expect(modes.has(TOOL.water)).toBe(true)
    expect(modes.has(TOOL.pile)).toBe(false)
  })
})


test('right-button orbit never queues a digging stroke and tools still work afterwards', async () => {
  const {ui, canvas} = makeController()
  const {InputController} = await import('../src/input/controller')
  let rotations = 0
  const camera = {orbit: () => rotations++, screenToSurface: () => ({x:0.05,y:0.02})}
  const sound = {cancelAll(){},beginPointer(){},movePointer(){},endPointer(){}}
  const controller = new InputController(ui as never, camera as never, sound as never, () => {})
  const event = {pointerId:1,pointerType:'mouse',button:2,clientX:200,clientY:300,timeStamp:performance.now()}
  canvas.dispatch('pointerdown',event)
  canvas.dispatch('pointermove',{...event,clientX:280})
  canvas.dispatch('pointerup',{...event,clientX:280})
  expect(rotations).toBe(1)
  expect(controller.strokes.heldContacts()).toHaveLength(0)
  expect(controller.strokes.nextBatch().filter(s=>s.active)).toHaveLength(0)
  canvas.dispatch('pointerdown',{...event,button:0,timeStamp:performance.now()})
  expect(controller.strokes.heldContacts()).toHaveLength(1)
  canvas.dispatch('pointerup',{...event,button:0,timeStamp:performance.now()})
  expect(controller.strokes.heldContacts()).toHaveLength(0)
  controller.dispose()
})

test('a mold places once per click, never paints repeated stamps during a drag',async()=>{
 const {ui,canvas}=makeController()
 const {InputController}=await import('../src/input/controller')
  const controller=new InputController(ui as never,{screenToSurface:()=>({x:.04,y:.02})} as never, {movePointer(){}} as never,()=>{})
 controller.setTool(TOOL.mold)
 const event={pointerId:7,pointerType:'mouse',button:0,clientX:200,clientY:300,timeStamp:performance.now()}
 canvas.dispatch('pointerdown',event)
 for(let i=0;i<10;i++)canvas.dispatch('pointermove',{...event,clientX:200+i})
 canvas.dispatch('pointerup',event)
 expect(controller.stamps).toHaveLength(1)
 expect(controller.stamps[0].height).toBe(.085)
 expect(controller.strokes.heldContacts()).toHaveLength(0)
 expect(controller.strokes.nextBatch().filter(s=>s.active)).toHaveLength(0)
 controller.setInteractive(false)
 expect(controller.stamps).toHaveLength(0)
 controller.dispose()
})


test('background clicks and strokes leaving the finite bed do not sculpt a clamped border', async()=>{
 const {ui,canvas}=makeController()
 const {InputController}=await import('../src/input/controller')
 let point={x:.6,y:0}
 const sound={cancelAll(){},beginPointer(){},movePointer(){},endPointer(){}}
 const controller=new InputController(ui as never,{screenToSurface:()=>point} as never,sound as never,()=>{})
 const event={pointerId:8,pointerType:'mouse',button:0,clientX:100,clientY:100,timeStamp:performance.now()}
 canvas.dispatch('pointerdown',event)
 expect(controller.strokes.heldContacts()).toHaveLength(0)
 point={x:.44,y:.86}
 canvas.dispatch('pointerdown',{...event,clientX:250})
 expect(controller.strokes.heldContacts()[0].from).toEqual(point)
 canvas.dispatch('pointerup',{...event,clientX:250})
 point={x:0,y:0}
 canvas.dispatch('pointerdown',{...event,clientX:300})
 expect(controller.strokes.heldContacts()).toHaveLength(1)
 point={x:.7,y:0}
 canvas.dispatch('pointermove',{...event,clientX:700})
 expect(controller.strokes.heldContacts()).toHaveLength(0)
 expect(controller.strokes.nextBatch().filter(s=>s.active)).toHaveLength(0)
 controller.dispose()
})

test('the bottom hand rotates on left drag without drawing, and a sculpting button restores tools',async()=>{
 const {ui,canvas,toolButtons}=makeController(),hand=new FakeElement()
 const {InputController}=await import('../src/input/controller')
 let turns=0
 const menus:unknown[]=[]
 const sound={cancelAll(){},beginPointer(){},movePointer(){},endPointer(){}}
 const controller=new InputController({...ui,orbit:hand,showToolMenu:(mode:unknown)=>menus.push(mode)} as never,{orbit(){turns++},screenToSurface:()=>({x:0,y:0})} as never,sound as never,()=>{})
 expect(hand.attributes.get('aria-pressed')).toBe('true')
 const event={pointerId:9,pointerType:'mouse',button:0,clientX:100,clientY:100,timeStamp:performance.now()}
 canvas.dispatch('pointerdown',event)
 canvas.dispatch('pointermove',{...event,clientX:160})
 canvas.dispatch('pointerup',{...event,clientX:160})
 expect(turns).toBe(1);expect(controller.strokes.heldContacts()).toHaveLength(0)
 toolButtons[0].dispatch('click')
 canvas.dispatch('pointerdown',{...event,clientX:300,timeStamp:performance.now()})
 expect(hand.attributes.get('aria-pressed')).toBe('false')
 expect(controller.strokes.heldContacts()).toHaveLength(1)
 hand.dispatch('click')
 expect(controller.strokes.heldContacts()).toHaveLength(0)
 expect(menus).toEqual([TOOL.dig,'hand'])
 controller.dispose()
})


test('dragging a sand wall previews without changing terrain, then releases exactly one length-independent wall', async()=>{
 const {ui,canvas}=makeController()
 const {InputController}=await import('../src/input/controller')
 let point={x:-.3,y:.1}
 const sound={cancelAll(){},beginPointer(){},movePointer(){},endPointer(){}}
 const controller=new InputController(ui as never,{screenToSurface:()=>point,heightAt:()=>.044} as never,sound as never,()=>{})
 controller.setTool(TOOL.pile)
 const event={pointerId:10,pointerType:'mouse',button:0,clientX:100,clientY:100,timeStamp:performance.now()}
 canvas.dispatch('pointerdown',event)
 for(let i=1;i<=8;i++){point={x:-.3+i*.075,y:.1};canvas.dispatch('pointermove',{...event,clientX:100+i*10})}
 expect(controller.stamps).toHaveLength(0)
 expect(controller.strokes.nextBatch().filter(s=>s.active)).toHaveLength(0)
 canvas.dispatch('pointerup',{...event,clientX:180})
 expect(controller.stamps).toHaveLength(1)
 expect(controller.stamps[0].halfLength).toBeCloseTo(.3)
 expect(controller.stamps[0].radius).toBeCloseTo(.032)
 expect(controller.stamps[0].height).toBeCloseTo(.075)
 expect(controller.stamps[0].baseHeight).toBeCloseTo(.044)
 canvas.dispatch('pointerup',{...event,clientX:180})
 expect(controller.stamps).toHaveLength(1)
 controller.dispose()
})

test.each(['pointercancel','lostpointercapture','reset','tool'])('a wall cancelled by %s never places on a later release', async reason=>{
 const {ui,canvas,reset}=makeController()
 const {InputController}=await import('../src/input/controller')
 const sound={cancelAll(){},beginPointer(){},movePointer(){},endPointer(){}}
 const controller=new InputController(ui as never,{screenToSurface:()=>({x:0,y:0}),heightAt:()=>.044} as never,sound as never,()=>{})
 controller.setTool(TOOL.pile)
 const e={pointerId:11,pointerType:'mouse',button:0,clientX:100,clientY:100,timeStamp:performance.now()}
 canvas.dispatch('pointerdown',e)
 if(reason==='reset')reset.dispatch('click')
 else if(reason==='tool')controller.setTool(TOOL.dig)
 else canvas.dispatch(reason,e)
 canvas.dispatch('pointerup',e)
 expect(controller.stamps).toHaveLength(0)
 expect(controller.strokes.nextBatch().filter(s=>s.active)).toHaveLength(0)
 controller.dispose()
})


test('challenge widths are fixed and sandbox widths are restored after switching back', async()=>{
 const {ui,radius}=makeController()
 const {InputController}=await import('../src/input/controller')
 const c=new InputController(ui as never,{} as never,{} as never,()=>{})
 radius.value='72';radius.dispatch('input')
 c.setAdjustable(false)
 expect(c.strokes.radius).toBeCloseTo(.050)
 radius.value='88';radius.dispatch('input')
 expect(c.strokes.radius).toBeCloseTo(.050)
 c.setTool(TOOL.pile);expect(c.strokes.radius).toBeCloseTo(.032)
 c.setTool(TOOL.dig);expect(c.strokes.radius).toBeCloseTo(.050)
 c.setAdjustable(true);expect(c.strokes.radius).toBeCloseTo(.072)
 c.dispose()
})
