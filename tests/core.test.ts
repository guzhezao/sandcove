import { describe, expect, test } from 'vitest'
import { shouldUseMobileGrainFiltering, shouldUseSingleFrameResetPacing } from '../src/platform/mobile'
import { drawingBuffer } from '../src/platform/viewport'
import { FixedClock } from '../src/simulation/clock'
import { SandCamera } from '../src/render/camera'
import { maxQueuedSegmentsPerPointer, StrokeQueue } from '../src/input/strokes'
import { SAND } from '../src/config'
import { WaveResetEffect, crestFront, dryWaterMaskDistance, eraseOriginFront, renderEntryFront, renderExitFrontAt, shorelineOffsetAt } from '../src/reset/effect'
import { waveResetViewport } from '../src/reset/viewport'

describe('Drawing buffer policy', () => {
  test.each([[3840, 2160, 2], [7680, 4320, 2], [1440, 900, 2], [390, 844, 3]])('caps %s × %s at four million pixels', (width, height, dpr) => {
    const result = drawingBuffer(width, height, dpr)!
    expect(result.width * result.height).toBeLessThanOrEqual(4_000_000)
    expect(result.dpr).toBeLessThanOrEqual(1.7)
  })
  test('allows sub-one DPR at 4K and ignores transient empty sizes', () => {
    expect(drawingBuffer(3840, 2160, 2)!.dpr).toBeLessThan(1)
    expect(drawingBuffer(0, 200, 2)).toBeNull()
    expect(drawingBuffer(200, 0, 2)).toBeNull()
    expect(drawingBuffer(200, 200, NaN)!.dpr).toBe(1)
  })
})

describe('Mobile grain filtering selection', () => {
  test('enables the alias-safe surface path on phones and tablets', () => {
    expect(shouldUseMobileGrainFiltering({ maxTouchPoints: 5, coarsePointer: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) Mobile', width: 430, height: 932 })).toBe(true)
    expect(shouldUseMobileGrainFiltering({ maxTouchPoints: 5, coarsePointer: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari', width: 1024, height: 1366 })).toBe(true)
  })
  test('keeps the desktop renderer on the original shader', () => {
    expect(shouldUseMobileGrainFiltering({ maxTouchPoints: 0, coarsePointer: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', width: 1440, height: 900 })).toBe(false)
    expect(shouldUseMobileGrainFiltering({ maxTouchPoints: 10, coarsePointer: false, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', width: 1920, height: 1080 })).toBe(false)
  })
})

describe('Reset frame pacing selection', () => {
  test('uses one reset frame in flight on iPhone and iPad WebKit environments', () => {
    expect(shouldUseSingleFrameResetPacing({ maxTouchPoints: 5, coarsePointer: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) Mobile', width: 430, height: 932 })).toBe(true)
    expect(shouldUseSingleFrameResetPacing({ maxTouchPoints: 5, coarsePointer: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari', width: 1024, height: 1366 })).toBe(true)
  })
  test('does not change desktop or Android reset pacing', () => {
    expect(shouldUseSingleFrameResetPacing({ maxTouchPoints: 0, coarsePointer: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', width: 1440, height: 900 })).toBe(false)
    expect(shouldUseSingleFrameResetPacing({ maxTouchPoints: 5, coarsePointer: true, userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel) Mobile', width: 412, height: 915 })).toBe(false)
  })
})

describe('Fixed simulation time', () => {
  test.each([30, 60, 120, 144])('executes 120 steps per second at %s Hz', (hz) => {
    const clock = new FixedClock(SAND.step, SAND.maxSteps)
    let steps = clock.advance(0)
    for (let frame = 1; frame <= hz; frame++) steps += clock.advance(frame * 1000 / hz)
    expect(steps).toBe(120)
  })
  test('bounds catchup and resets hidden-tab debt', () => {
    const clock = new FixedClock(SAND.step, SAND.maxSteps)
    clock.advance(0)
    expect(clock.advance(10000)).toBe(4)
    expect(clock.droppedSeconds).toBeGreaterThan(9)
    clock.reset()
    expect(clock.advance(20000)).toBe(0)
  })
  test('can restart from an explicit handoff timestamp', () => {
    const clock = new FixedClock(SAND.step, SAND.maxSteps)
    clock.reset(1000)
    expect(clock.advance(1000)).toBe(0)
    expect(clock.advance(1000 + 1000 / 30)).toBe(4)
  })
})

describe('Finger sampling', () => {
  test('preserves a stroke even when released before a simulation tick', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0, y: 0 }, 0.5)
    queue.move({ x: 0.1, y: 0 }, 0.5)
    queue.end()
    let length = 0
    for (let index = 0; index < 30; index++) {
      const stroke = queue.next()
      if (stroke.active) length += Math.hypot(stroke.to.x - stroke.from.x, stroke.to.y - stroke.from.y)
    }
    expect(length).toBeCloseTo(0.1)
    expect(queue.next().active).toBe(false)
  })
  test('bounds pathological pointer backlog instead of replaying stale strokes indefinitely', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: -0.3, y: 0 }, 0.75, 1000)
    for (let index = 1; index <= 80; index++) {
      const x = index % 2 === 0 ? -0.3 : 0.3
      queue.move({ x, y: 0 }, 0.75, 1000 + index * 8)
    }
    queue.end()
    let pending = 0
    for (;;) {
      const batch = queue.nextBatch()
      if (!batch.length) break
      pending += batch.length
    }
    expect(pending).toBeLessThanOrEqual(maxQueuedSegmentsPerPointer)
  })
  test('does not turn duplicate WebKit sample timestamps into extreme impact speed', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0, y: 0 }, 0.75, 1000)
    queue.move({ x: 0.1, y: 0 }, 0.75, 1000)
    const stroke = queue.next()
    expect(stroke.active).toBe(true)
    expect(Math.hypot(stroke.velocity.x, stroke.velocity.y)).toBeLessThan(2)
  })
  test('preserves real gesture speed through spatial subdivision', () => {
    const velocityFor = (durationMs: number) => {
      const queue = new StrokeQueue()
      queue.begin({ x: 0, y: 0 }, 0.7, 1000)
      queue.move({ x: 0.1, y: 0 }, 0.7, 1000 + durationMs)
      queue.end()
      return queue.next().velocity.x
    }
    const fast = velocityFor(100)
    const slow = velocityFor(1000)
    expect(fast).toBeCloseTo(1, 5)
    expect(slow).toBeCloseTo(0.1, 5)
    expect(fast / slow).toBeCloseTo(10, 5)
  })
  test('hovering and a stationary press do not emit active contact', () => {
    const queue = new StrokeQueue()
    queue.move({ x: 0.04, y: -0.03 }, 0.7, 1000)
    expect(queue.next().active).toBe(false)
    queue.begin({ x: 0.04, y: -0.03 }, 0.7, 1010)
    expect(queue.next().active).toBe(false)
    queue.end()
    queue.move({ x: 0.05, y: -0.03 }, 0.7, 1020)
    expect(queue.next().active).toBe(false)
  })
  test('never bridges separate gestures', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: -0.1, y: 0 }, 0.6); queue.move({ x: -0.095, y: 0 }, 0.6); queue.end()
    queue.begin({ x: 0.1, y: 0 }, 0.6); queue.move({ x: 0.105, y: 0 }, 0.6); queue.end()
    expect(queue.next().from.x).toBe(-0.1)
    expect(queue.next().from.x).toBe(0.1)
  })
  test('cancellation removes queued input', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0, y: 0 }, 0.6)
    queue.cancel()
    expect(queue.next().active).toBe(false)
  })
  test('travelled distance is independent of input event density', () => {
    const travelled = (samples: number) => {
      const queue = new StrokeQueue()
      queue.begin({ x: -0.1, y: 0 }, 0.75, 1000)
      for (let index = 1; index <= samples; index++) {
        queue.move({ x: -0.1 + 0.2 * index / samples, y: 0 }, 0.75, 1000 + 400 * index / samples)
      }
      queue.end()
      let distance = 0
      for (;;) {
        const batch = queue.nextBatch()
        if (!batch.length) break
        for (const stroke of batch) distance += Math.hypot(stroke.to.x - stroke.from.x, stroke.to.y - stroke.from.y)
      }
      return distance
    }
    expect(travelled(4)).toBeCloseTo(0.2, 6)
    expect(travelled(240)).toBeCloseTo(0.2, 6)
  })
  test('batches independent simultaneous pointers without bridging them', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: -0.12, y: -0.03 }, 0.75, 1000, 11)
    queue.begin({ x: 0.12, y: 0.03 }, 0.75, 1000, 22)
    queue.move({ x: -0.08, y: -0.03 }, 0.75, 1040, 11)
    queue.move({ x: 0.08, y: 0.03 }, 0.75, 1040, 22)
    const batch = queue.nextBatch()
    expect(batch.length).toBeGreaterThanOrEqual(2)
    expect(batch.some((stroke) => stroke.from.x < 0 && stroke.to.x < 0)).toBe(true)
    expect(batch.some((stroke) => stroke.from.x > 0 && stroke.to.x > 0)).toBe(true)
  })
})

test('camera projection and bed picking agree at center and preserve orientation', () => {
  const camera = new SandCamera()
  camera.aspect = 1.6
  const center = camera.screenToBed(800, 500, 1600, 1000)
  expect(center.x).toBeCloseTo(0)
  expect(center.y).toBeCloseTo((SAND.length-SAND.extent)/2)
  expect(camera.screenToBed(400, 500, 1600, 1000).x).toBeLessThan(0)
  expect(camera.screenToBed(800, 100, 1600, 1000).y).toBeLessThan(0)
})


describe('Wave reset timing', () => {
  test('clears the visible entry strip immediately', () => {
    const wave = new WaveResetEffect()
    wave.start(1000, 4)
    const state = wave.update(1000)
    expect(state.active).toBe(true)
    expect(state.erase).toBe(true)
    expect(state.erasePreviousBaseFront).toBe(eraseOriginFront)
    expect(state.eraseCurrentBaseFront).toBe(renderEntryFront)
  })

  test('finishes the entire incoming erase even when a frame skips across the crest', () => {
    const wave = new WaveResetEffect()
    wave.start(1000, 4)
    wave.update(1000)
    const state = wave.update(1000 + 2600)
    expect(state.incoming).toBe(false)
    expect(state.erase).toBe(true)
    expect(state.eraseCurrentBaseFront).toBeCloseTo(crestFront, 12)
  })

  test('keeps water visible until the audio endpoint and exits exactly at that endpoint', () => {
    const wave = new WaveResetEffect()
    const duration = 4
    const startedAt = 1000
    const halfExtent = SAND.extent * 0.5
    const maximumEdgeWaterDistance = (state: ReturnType<WaveResetEffect['update']>) => {
      let maximum = Number.NEGATIVE_INFINITY
      for (let index = 0; index <= 1024; index++) {
        const x = -halfExtent + SAND.extent * index / 1024
        maximum = Math.max(maximum, SAND.length-halfExtent - state.currentBaseFront - shorelineOffsetAt(x, state.time))
      }
      return maximum
    }

    wave.start(startedAt, duration)
    expect(wave.update(startedAt).currentBaseFront).toBe(renderEntryFront)

    const justBeforeEnd = wave.update(startedAt + duration * 1000 - 1)
    expect(justBeforeEnd.active).toBe(true)
    expect(maximumEdgeWaterDistance(justBeforeEnd)).toBeGreaterThan(dryWaterMaskDistance)

    const finished = wave.update(startedAt + duration * 1000)
    expect(finished.justFinished).toBe(true)
    expect(finished.currentBaseFront).toBeCloseTo(renderExitFrontAt(duration), 10)
    expect(maximumEdgeWaterDistance(finished)).toBeLessThanOrEqual(dryWaterMaskDistance + 1e-7)
  })
  test('keeps the retreat inside the finite sand bed when an overview includes background', () => {
    const camera = new SandCamera()
    camera.aspect = 430 / 932
    const viewport = waveResetViewport(camera)
    const wave = new WaveResetEffect()
    const duration = 4
    const startedAt = 1000
    const maximumVisibleWaterDistance = (state: ReturnType<WaveResetEffect['update']>) => {
      let maximum = Number.NEGATIVE_INFINITY
      for (let index = 0; index <= 1024; index++) {
        const x = viewport.minX + (viewport.maxX - viewport.minX) * index / 1024
        maximum = Math.max(maximum, viewport.nearY - state.currentBaseFront - shorelineOffsetAt(x, state.time))
      }
      return maximum
    }

    wave.start(startedAt, duration, viewport)
    const beforeEnd = wave.update(startedAt + duration * 1000 - 100)
    expect(maximumVisibleWaterDistance(beforeEnd)).toBeGreaterThan(dryWaterMaskDistance)

    const finished = wave.update(startedAt + duration * 1000)
    expect(finished.justFinished).toBe(true)
    expect(maximumVisibleWaterDistance(finished)).toBeLessThanOrEqual(dryWaterMaskDistance + 1e-7)
    expect(renderExitFrontAt(duration, viewport)).toBeLessThanOrEqual(renderExitFrontAt(duration) + 1e-7)
  })

})
