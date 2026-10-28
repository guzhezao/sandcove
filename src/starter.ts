import type { MoldStamp } from './simulation/molds'
import { SAND } from './config'
import { TIDE } from './tide'

/** Centre of the playable land, excluding the open sea strip. */
export const CASTLE = {
  centerZ: (TIDE.shoreZ + SAND.length - SAND.extent / 2) / 2,
  halfWidth: .25,
  halfDepth: .20,
} as const

/** An editable castle, stamped into the same sand bed as player-built shapes. */
export function starterCastle(): MoldStamp[] {
  const xs = [-CASTLE.halfWidth, CASTLE.halfWidth]
  const zs = [CASTLE.centerZ-CASTLE.halfDepth, CASTLE.centerZ+CASTLE.halfDepth]
  const towers: MoldStamp[] = xs.flatMap(x=>zs.map(y=>({
    point:{x,y},radius:.05,height:.08,angle:0,kind:'tower' as const,
  })))
  const walls: MoldStamp[] = zs.map(y=>({point:{x:0,y},radius:.22,height:.056,angle:0,kind:'wall'}))
  const sides: MoldStamp[] = xs.map(x=>({point:{x,y:CASTLE.centerZ},radius:.17,height:.056,angle:Math.PI/2,kind:'wall'}))
  // Walls first so the taller towers remain visually distinct at the corners.
  return [...walls,...sides,...towers]
}
