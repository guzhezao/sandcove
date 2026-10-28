import {expect,test} from 'vitest'
import {TIDE,TideCycle} from '../src/tide'
test('full tide overtops the open beach, holds longer and retains player water settings on reset',()=>{
 const tide=new TideCycle();tide.highLevel=TIDE.beachHeight+.060;tide.waveHeight=.025
 expect(tide.start()).toBe(true)
 for(let i=0;i<481;i++)tide.update(1/60)
 expect(tide.phase).toBe('high');expect(tide.level-TIDE.beachHeight).toBeCloseTo(.060)
 for(let i=0;i<600;i++)tide.update(1/60)
 expect(tide.phase).toBe('high')
 tide.ebb();for(let i=0;i<781;i++)tide.update(1/60)
 expect(tide.phase).toBe('ready');expect(tide.level).toBeCloseTo(TIDE.lowLevel)
 tide.reset();expect(tide.highLevel).toBeCloseTo(.104);expect(tide.waveHeight).toBe(.025)
})

test('tsunami is a finite stronger wave and an early retreat cancels its shoreward push',()=>{
 const tide=new TideCycle();tide.highLevel=.080
 expect(tide.startTsunami()).toBe(true)
 expect(tide.startTsunami()).toBe(false)
 tide.update(2)
 expect(tide.level).toBeGreaterThan(.080)
 expect(tide.surgeSpeed).toBeGreaterThan(.20)
 expect(tide.label).toBe('海啸涌入')
 expect(tide.ebb()).toBe(true)
 expect(tide.surgeSpeed).toBe(0)
 for(let i=0;i<800;i++)tide.update(1/60)
 expect(tide.phase).toBe('ready');expect(tide.tsunami).toBe(false)
 expect(tide.highLevel).toBe(.080)
 expect(tide.start()).toBe(true);tide.update(8)
 expect(tide.level).toBeCloseTo(.080);expect(tide.surgeSpeed).toBe(0)
})
