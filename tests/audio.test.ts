import {afterEach,expect,test,vi} from 'vitest'
import {buildImpactSamples} from '../src/audio/effects'
import {sandWorkletSource} from '../src/audio/sand-worklet'
import {SandSound} from '../src/audio/sound'

const energy=(data:Float32Array)=>data.reduce((s,v)=>s+v*v,0)/data.length

test('bucket impact has finite, bounded energy and a soft start and ending',()=>{
 for(const rate of [44100,48000]){
  const a=buildImpactSamples(rate)
  expect(a.length).toBe(Math.ceil(rate*.38));expect(a.every(Number.isFinite)).toBe(true)
  expect(energy(a)).toBeGreaterThan(.0001);expect(Math.max(...a.map(Math.abs))).toBeLessThan(.5)
  expect(Math.abs(a[0])).toBe(0);expect(Math.abs(a.at(-1)!)).toBeLessThan(.00001)
  expect(energy(a.slice(-rate*.03))).toBeLessThan(energy(a.slice(rate*.01,rate*.04))*.01)
 }
})

test('held sand and water sounds remain audible, differ, stay finite and release quietly',()=>{
 let Processor:any
 new Function('AudioWorkletProcessor','registerProcessor','sampleRate',sandWorkletSource)(
  class {port={onmessage:undefined}},(_name:string,p:any)=>{Processor=p},48000)
 const render=(p:any,frames:number)=>{
  const a=new Float32Array(frames*128)
  for(let i=0;i<frames;i++){const left=new Float32Array(128),right=new Float32Array(128);p.process([],[[left,right]]);a.set(left,i*128)}
  return a
 }
 const sand=new Processor(),water=new Processor()
 sand.port.onmessage({data:{type:'state',gate:1,mode:0,speed:.28}})
 water.port.onmessage({data:{type:'state',gate:1,mode:2,speed:.28}})
 const a=render(sand,375),b=render(water,375)
 for(const data of [a,b]){expect(data.every(Number.isFinite)).toBe(true);expect(energy(data.slice(-4800))).toBeGreaterThan(.000001);expect(Math.max(...data.map(Math.abs))).toBeLessThan(1)}
 expect(Math.abs(energy(a)-energy(b))).toBeGreaterThan(.0001)
 for(const p of [sand,water]){p.port.onmessage({data:{type:'state',gate:0}});expect(energy(render(p,375).slice(-4800))).toBeLessThan(1e-10)}
})

function audioEnvironment(saved='on') {
 const media:any[]=[],gains:any[]=[],worklets:any[]=[]
 class Media extends EventTarget {
  loop=false;paused=true;preload='';volume=1;readyState=1;duration=4.75;currentTime=0
  play=vi.fn(async()=>{this.paused=false});pause=vi.fn(()=>{this.paused=true})
  constructor(public src:string){super();media.push(this)}
  setAttribute(){} removeAttribute(){} load(){}
 }
 class Node {connect(n:unknown){return n} disconnect(){}}
 class Gain extends Node {gain:{value:number,setTargetAtTime:(v:number)=>void};constructor(_c:unknown,o:any){super();this.gain={value:o.gain,setTargetAtTime:(v)=>{this.gain.value=v}};gains.push(this)}}
 class Context {
  state='suspended';currentTime=1;sampleRate=48000;destination=new Node();audioWorklet={addModule:async()=>{}}
  resume=vi.fn(async()=>{this.state='running'});close=vi.fn(async()=>{})
  createMediaElementSource(){return new Node()}
 }
 class Worklet extends Node {port={postMessage:vi.fn()};constructor(){super();worklets.push(this)}}
 const win=new EventTarget(),doc=Object.assign(new EventTarget(),{hidden:false})
 let preference=saved
 for(const [key,value] of Object.entries({Audio:Media,HTMLMediaElement:{HAVE_METADATA:1},AudioContext:Context,GainNode:Gain,DynamicsCompressorNode:Node,BiquadFilterNode:Node,AudioWorkletNode:Worklet,window:win,document:doc,navigator:{userAgent:'test',platform:'test'},localStorage:{getItem:()=>preference,setItem:(_k:string,v:string)=>{preference=v}}}))vi.stubGlobal(key,value)
 return {media,gains,worklets,win,doc,preference:()=>preference}
}
afterEach(()=>vi.unstubAllGlobals())

test('audio waits for a gesture; mute persists and cannot be bypassed by tools or waves',async()=>{
 const e=audioEnvironment(),s=new SandSound()
 try{
  await s.prepare();expect(e.media[0].play).not.toHaveBeenCalled()
  e.win.dispatchEvent(new Event('pointerdown'));expect(e.media[0].paused).toBe(false)
  s.playTsunami();expect(e.media[1].loop).toBe(true);expect(e.media[1].paused).toBe(false)
  s.setMuted(true);expect(e.preference()).toBe('off');expect(e.gains[0].gain.value).toBe(0)
  const plays=e.media[0].play.mock.calls.length
  e.win.dispatchEvent(new Event('pointerdown'));s.playTsunami();s.playResetWave();s.playBuild()
  expect(e.media[0].play.mock.calls.length).toBe(plays);expect(e.media.every(m=>m.paused)).toBe(true)
  s.setMuted(false);expect(e.media[0].paused).toBe(false);expect(e.preference()).toBe('on')
 }finally{s.dispose()}
})

test('saved mute is respected; backgrounding pauses both ambience and tsunami',async()=>{
 const e=audioEnvironment('off'),s=new SandSound()
 try{
  await s.prepare();e.win.dispatchEvent(new Event('keydown'));expect(s.muted).toBe(true);expect(e.media.every(m=>m.paused)).toBe(true)
  s.setMuted(false);s.playTsunami()
  e.doc.hidden=true;e.doc.dispatchEvent(new Event('visibilitychange'))
  expect(e.media.every(m=>m.paused)).toBe(true);expect(e.gains[0].gain.value).toBe(0)
  e.win.dispatchEvent(new Event('pointerdown'));expect(e.media.every(m=>m.paused)).toBe(true)
  e.doc.hidden=false;e.doc.dispatchEvent(new Event('visibilitychange'))
  expect(e.media.every(m=>!m.paused)).toBe(true);expect(e.gains[0].gain.value).toBe(1)
  s.stopTsunami();expect(e.media[1].loop).toBe(false);expect(e.media[1].paused).toBe(true)
 }finally{s.dispose()}
})
