import { expect, test } from 'vitest'
import { environmentFor } from '../src/play-mode'
import { TideCycle } from '../src/tide'

test('sandbox controls cannot change the challenge wave, volume or erosion',()=>{
 const low={waveHeight:0,surgeDepth:12,erosionStrength:1}
 const high={waveHeight:30,surgeDepth:70,erosionStrength:6}
 expect(environmentFor('tide',low)).toEqual(environmentFor('tide',high))
 expect(environmentFor('free',low)).not.toEqual(environmentFor('free',high))
 const tide=new TideCycle()
 Object.assign(tide,environmentFor('free',high));tide.startTsunami();tide.update(2)
 tide.reset();Object.assign(tide,environmentFor('tide',high));tide.startTsunami();tide.update(4)
 expect(tide.peakLevel).toBeCloseTo(.174)
 expect(tide.level).toBeCloseTo(.174)
 expect(tide.startTsunami()).toBe(false)
})
