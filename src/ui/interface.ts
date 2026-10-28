import { TOOL, type ToolMode } from '../config'

export type InterfaceElements = ReturnType<typeof createInterface>

const toolIcon = {
  dig: `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 2.5v5.2"/><path d="M6.2 7.7h7.6l-1.5 5.1a3.1 3.1 0 0 1-4.6 0z"/><path d="M2.8 17.4h14.4"/></svg>`,
  pile: `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M2.8 17.2h14.4"/><path d="M10 6.4l4.7 9.4a.7.7 0 0 1-.6 1H5.9a.7.7 0 0 1-.6-1z"/><path d="M10 2.2v3.1"/><path d="M7.9 3.8 10 1.9l2.1 1.9"/></svg>`,
  water: `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 2.4c2.9 3.9 4.8 6.2 4.8 8.6a4.8 4.8 0 0 1-9.6 0c0-2.4 1.9-4.7 4.8-8.6z"/><path d="M7.6 12.1a2.5 2.5 0 0 0 2.1 2.5"/></svg>`,
  mold: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 17V4h3v3h3V4h3v3h3V4h2v13z"/><path d="M8 17v-5h4v5"/></svg>`,
  hand: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12V5a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v7-4a1.5 1.5 0 0 1 3 0v7c0 5-3 7-7 7-3 0-4-1-6-4l-3-5a1.5 1.5 0 0 1 2-2Z"/></svg>`,
  wave: `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M2.2 9.6c1.9-2.6 3.8-2.6 5.7 0s3.8 2.6 5.7 0 2.6-2.2 4.2-1.2"/><path d="M2.2 14.6c1.9-2.6 3.8-2.6 5.7 0s3.8 2.6 5.7 0 2.6-2.2 4.2-1.2"/></svg>`,
} as const

export function createInterface(root: HTMLDivElement) {
  root.innerHTML = `
    <canvas class="surface" aria-label="沙滩小筑沙盘。自由玩沙：按住挖沙，拖动挖沟，切换工具堆沙或倒水。海啸来袭：挖沟引水、堆堤护住城堡小院，准备好后点发动海啸。数字键 1 2 3 4 切换工具，5 或 H 选择手形旋转，R 键恢复初始沙堡。" tabindex="0"></canvas>
    <button id="sound-toggle" class="sound-toggle" type="button" aria-pressed="true" aria-label="关闭海边声音" title="海浪环境声与操作音效；首次点击后播放"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8h3l4-4v12l-4-4H3Z"/><path class="sound-waves" d="M13 7a5 5 0 0 1 0 6m2-9a9 9 0 0 1 0 12"/><path class="sound-slash" d="m3 3 14 14"/></svg><span id="sound-label">海边声</span></button>
    <svg id="mold-preview" class="mold-preview" aria-hidden="true" hidden><path id="mold-footprint" /></svg>
    <header class="masthead">
      <h1 class="brand" aria-label="沙滩小筑 SANDCOVE"><span class="cn">沙滩小筑</span><span class="latin">SANDCOVE</span></h1>
      <p class="hint" id="hint">按住挖沙，拖出沟渠；倒进水，它会自己找路。</p>
      <div class="modes" role="radiogroup" aria-label="玩法">
        <button id="mode-free" class="mode active" type="button" role="radio" aria-checked="true">自由玩沙</button>
        <button id="mode-tide" class="mode" type="button" role="radio" aria-checked="false">海啸来袭</button>
      </div>
      <div class="tide-panel" id="tide-panel"><div class="tide-meter" role="img" aria-label="海啸进程"><div class="tide-fill" id="tide-fill"></div></div><span class="tide-phase" id="tide-phase">等待海啸</span></div>
    </header>
    <aside id="tool-menu" class="tool-menu" role="dialog" aria-labelledby="tool-menu-title" hidden>
      <div class="menu-heading"><strong id="tool-menu-title">工具设置</strong><button id="menu-close" type="button" aria-label="关闭工具设置">×</button></div>
      <div id="size-setting" data-adjustable data-settings="0 1 2 3" hidden><label class="tuning-slider" for="radius"><span>尺寸</span><output id="radius-value">24 mm</output><input id="radius" type="range" min="10" max="60" step="1" value="24" aria-label="工具尺寸，单位毫米" /></label></div>
      <div data-settings="0" hidden><p class="menu-note">按住拖动，一笔挖出宽底沟渠。长按继续清底；从海边连进来，水会沿低处流入。</p></div>
      <div data-settings="1" hidden>
        <div class="build-options" role="radiogroup" aria-label="筑沙方式">
          <button id="build-wall" class="active" type="button" role="radio" aria-checked="true">拉出沙墙</button>
          <button id="build-mound" type="button" role="radio" aria-checked="false">自由堆沙</button>
        </div>
        <p class="menu-note">沙墙：按下定起点，拖动定长度，松手筑成。<br>Shift 对齐方向 · Esc 取消。自由堆沙可按住堆起沙丘。</p>
      </div>
      <div data-adjustable data-settings="2" hidden>      <label class="tuning-slider" for="erosion-strength"><span>冲刷力度</span><output id="erosion-value">强 · 3×</output>
        <input id="erosion-strength" type="range" min="1" max="6" step="1" value="3" aria-label="冲刷力度" /></label>
</div>
      <div id="mold-tray" data-settings="3" hidden>      <div class="mold-options" role="radiogroup" aria-label="模具形状">
        <button id="mold-tower" class="mold-choice active" type="button" role="radio" aria-checked="true"><svg viewBox="0 0 40 34" aria-hidden="true"><path d="M9 29V8l4-3v6h6V5h5v6h5V5l3 3v21Z"/><path d="M9 17q12 7 23 0M17 29v-7q4-4 8 0v7"/></svg>城堡塔楼</button>
        <button id="mold-wall" class="mold-choice" type="button" role="radio" aria-checked="false"><svg viewBox="0 0 40 34" aria-hidden="true"><path d="M4 29V9h6v5h6V9h7v5h6V9h7v20Z"/><path d="M4 22h32"/></svg>垛口城墙</button>
        <button id="mold-arc" class="mold-choice" type="button" role="radio" aria-checked="false"><svg viewBox="0 0 40 34" aria-hidden="true"><path d="M6 28V20a14 14 0 0 1 28 0v8h-7v-8a7 7 0 0 0-14 0v8Z"/></svg>弧形堤坝</button>
        <button id="mold-rotate" class="mold-turn" type="button" title="旋转模具45度">↻<output id="mold-angle">0°</output></button>
      </div>
<p class="menu-note">塔楼 / 弧堤：点击放置。城墙：按住拖出整条。<br>Q / E 转向 · Esc 取消</p></div>
      <div data-settings="hand" hidden>
        <div class="camera-actions"><button id="zoom-out" type="button">− 拉远</button><button id="zoom-in" type="button">＋ 拉近</button></div>
        <p class="menu-note">拖动旋转 · 滚轮缩放<br>Shift＋拖动平移</p>
      </div>
      <div data-adjustable data-settings="tide" hidden>      <label class="tuning-slider" id="wave-control" for="wave-height"><span>海浪强度</span><output id="wave-value">巨浪</output>
        <input id="wave-height" type="range" min="0" max="30" step="1" value="22" aria-label="海浪强度" /></label>
      <label class="tuning-slider" id="surge-control" for="surge-depth"><span>海啸水量</span><output id="surge-value">漫滩 60 mm</output>
        <input id="surge-depth" type="range" min="12" max="70" step="2" value="60" aria-label="海啸漫滩水量，单位毫米" /></label>


      </div>
      <p class="menu-note" data-settings="2" hidden>按住倒水，观察水沿沟渠流向低处。沙墙挡水，深沟蓄水；水满后才会漫过。</p><p class="menu-note tsunami-note" data-settings="tide" hidden>海浪随强度持续拍岸。调好水量后，点底部「海啸」试冲；这些参数仅作用于自由玩沙。</p>
    </aside>
    <p id="tool-feedback" class="tool-feedback" aria-live="polite" hidden></p>
    <nav class="toolbar" aria-label="沙盘工具">
      <div class="tool-group" role="radiogroup" aria-label="工具">
        <button id="tool-dig" class="tool" type="button" role="radio" aria-checked="true" data-mode="${TOOL.dig}" title="挖沙 (1)">${toolIcon.dig}<span>挖沙</span></button>
        <button id="tool-pile" class="tool" type="button" role="radio" aria-checked="false" data-mode="${TOOL.pile}" title="筑沙：拉墙或堆沙 (2)">${toolIcon.pile}<span>筑沙</span></button>
        <button id="tool-water" class="tool" type="button" role="radio" aria-checked="false" data-mode="${TOOL.water}" title="倒水 (3)">${toolIcon.water}<span>倒水</span></button>
        <button id="tool-mold" class="tool" type="button" role="radio" aria-checked="false" data-mode="${TOOL.mold}" title="沙堡模具 (4)">${toolIcon.mold}<span>模具</span></button>
        <button id="orbit" class="tool" type="button" aria-pressed="false" aria-label="手形：旋转视角 (5)" title="手形：旋转视角 (5)">${toolIcon.hand}<span>转动</span></button>
      </div>
      <span class="divider" aria-hidden="true"></span>
      <button id="tide-tsunami" class="tool tsunami-action" type="button" title="发动海啸" aria-label="发动海啸">${toolIcon.wave}<span id="tsunami-label">海啸</span></button>
      <button id="tide-settings" class="ghost" type="button" title="自由玩沙环境设置" aria-label="自由玩沙环境设置" aria-expanded="false" aria-controls="tool-menu">环境</button>
      <button id="demo" class="ghost" type="button" title="演示：挖两坑、挖沟、引水">试试引水</button>
      <button id="reset" class="ghost" type="button" title="重新开始：恢复初始沙堡 (R)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7a6.5 6.5 0 1 1-.3 5M4 3v4h4"/></svg><span>重来</span></button>
    </nav>
    <a class="source-credit" href="/about.html" target="_blank" rel="noopener">源码与许可 ↗</a>
    <section class="overlay" aria-live="polite">
      <div class="boot-panel"><h2>沙滩小筑</h2><p class="status">正在准备沙床…</p><div class="boot-line"></div><pre class="diagnostics" hidden></pre><button id="reload" hidden>重新开始</button></div>
    </section>`
  const element = <ElementType extends Element>(selector: string) => root.querySelector<ElementType>(selector)!
  const menu=element<HTMLElement>('#tool-menu')
  let adjustable = false
  let openMenu: ToolMode | 'hand' | 'tide' | null = null
  const updateRadiusLabel=()=>{element<HTMLOutputElement>('#radius-value').value=`${element<HTMLInputElement>('#radius').value} mm`}
  const showToolMenu=(kind:ToolMode|'hand'|'tide'|null,toggle=false)=>{
    const next=toggle && openMenu===kind ? null : kind
    openMenu=next;menu.hidden=next===null
    const names:Record<string,string>={'0':'挖沙','1':'筑沙','2':'倒水','3':'沙堡模具',hand:'转动视角',tide:'海浪与水量'}
    element<HTMLElement>('#tool-menu-title').textContent=next===null?'工具设置':names[String(next)]
    for(const section of root.querySelectorAll<HTMLElement>('[data-settings]')) section.hidden=next===null||!section.dataset.settings!.split(' ').includes(String(next))||(!adjustable&&section.hasAttribute('data-adjustable'))
    for(const [selector,key] of [['#tool-dig',0],['#tool-pile',1],['#tool-water',2],['#tool-mold',3],['#orbit','hand'],['#tide-settings','tide']] as const){
      const button=element<HTMLButtonElement>(selector)
      button.setAttribute('aria-expanded',String(next===key));button.setAttribute('aria-controls','tool-menu')
    }
    updateRadiusLabel()
  }
  element<HTMLButtonElement>('#menu-close').onclick=()=>showToolMenu(null)
  element<HTMLInputElement>('#radius').addEventListener('input',updateRadiusLabel)
  element<HTMLButtonElement>('#tide-settings').onclick=()=>showToolMenu('tide',true)
  element<HTMLCanvasElement>('canvas').addEventListener('pointerdown',()=>showToolMenu(null))
  root.addEventListener('keydown',event=>{if(event.key==='Escape')showToolMenu(null)})
  element<HTMLButtonElement>('#reload').onclick = () => window.location.reload()
  // A numeric list, so a tool mode is always a number and never a string key.
  const tools = [
    { mode: TOOL.dig as ToolMode, button: element<HTMLButtonElement>('#tool-dig') },
    { mode: TOOL.pile as ToolMode, button: element<HTMLButtonElement>('#tool-pile') },
    { mode: TOOL.water as ToolMode, button: element<HTMLButtonElement>('#tool-water') },
    { mode: TOOL.mold as ToolMode, button: element<HTMLButtonElement>('#tool-mold') },
  ]
  return {
    canvas: element<HTMLCanvasElement>('canvas'), overlay: element<HTMLElement>('.overlay'),
    title: element<HTMLElement>('.boot-panel h2'), status: element<HTMLElement>('.status'),
    diagnostics: element<HTMLElement>('.diagnostics'), reload: element<HTMLButtonElement>('#reload'),
    radius: element<HTMLInputElement>('#radius'), reset: element<HTMLButtonElement>('#reset'),
    buildWall: element<HTMLButtonElement>('#build-wall'), buildMound: element<HTMLButtonElement>('#build-mound'),
    feedback: element<HTMLElement>('#tool-feedback'),
    soundToggle: element<HTMLButtonElement>('#sound-toggle'), soundLabel: element<HTMLElement>('#sound-label'),
    orbit: element<HTMLButtonElement>('#orbit'), zoomIn: element<HTMLButtonElement>('#zoom-in'), zoomOut: element<HTMLButtonElement>('#zoom-out'),
    waveControl: element<HTMLElement>('#wave-control'), waveHeight: element<HTMLInputElement>('#wave-height'), waveValue: element<HTMLOutputElement>('#wave-value'),
    erosionStrength: element<HTMLInputElement>('#erosion-strength'), erosionValue: element<HTMLOutputElement>('#erosion-value'),
    surgeControl: element<HTMLElement>('#surge-control'), surgeDepth: element<HTMLInputElement>('#surge-depth'), surgeValue: element<HTMLOutputElement>('#surge-value'),
    moldTray: element<HTMLElement>('#mold-tray'), moldRotate: element<HTMLButtonElement>('#mold-rotate'), moldAngle: element<HTMLOutputElement>('#mold-angle'),
    moldTower: element<HTMLButtonElement>('#mold-tower'), moldWall: element<HTMLButtonElement>('#mold-wall'), moldArc: element<HTMLButtonElement>('#mold-arc'),
    moldPreview: element<SVGSVGElement>('#mold-preview'), moldFootprint: element<SVGPathElement>('#mold-footprint'),
    setAdjustable(value: boolean) { adjustable=value; showToolMenu(null) },
    tsunamiLabel: element<HTMLElement>('#tsunami-label'),
    showToolMenu, updateRadiusLabel, tideSettings: element<HTMLButtonElement>('#tide-settings'),
    demo: element<HTMLButtonElement>('#demo'), tools,
    hint: element<HTMLElement>('#hint'),
    modeFree: element<HTMLButtonElement>('#mode-free'), modeTide: element<HTMLButtonElement>('#mode-tide'),
    tidePanel: element<HTMLElement>('#tide-panel'), tideFill: element<HTMLElement>('#tide-fill'),
    tidePhase: element<HTMLElement>('#tide-phase'),
    tideTsunami: element<HTMLButtonElement>('#tide-tsunami'),
  }
}
