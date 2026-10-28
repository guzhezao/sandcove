import './style.css'
import { BootMonitor } from './platform/boot'
import { createInterface } from './ui/interface'

const ui = createInterface(document.querySelector<HTMLDivElement>('#app')!)
const monitor = new BootMonitor(ui)

void monitor.run(async () => {
  monitor.stage('Loading simulation')
  const { startSandboard } = await import('./runtime')
  await startSandboard(ui, monitor)
})
