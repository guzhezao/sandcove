import { expect, test } from 'vitest'
import { surfaceShader } from '../src/render/shaders'
import { lightingShader } from '../src/render/lighting'
import { particleShader, simulationShader } from '../src/simulation/shaders'
import { waterOverlayShader } from '../src/render/water-reset'

const shaders = [
  ['surface', surfaceShader],
  ['lighting', lightingShader],
  ['transport', simulationShader],
  ['particles', particleShader],
] as const

test.each(shaders)('%s WGSL avoids multi-component swizzle assignment', (_name, shader) => {
  expect(shader).not.toMatch(/\.[xyzwrgba]{2,4}\s*(?:[+*/%&|^-]?=(?!=)|\+\+|--)/)
})

test.each(shaders)('%s WGSL avoids browser-reserved local identifiers', (_name, shader) => {
  expect(shader).not.toMatch(/\b(?:let|var)\s+(?:active|patch)\b/)
})


test('bed grain search stays bounded to one candidate per 3x3 neighbor cell', () => {
  const helper = surfaceShader.match(/fn grainAppearance[\s\S]*?(?=struct SandMaterial)/)?.[0]
  expect(helper).toBeDefined()
  expect(helper).toContain('for (var row = -1; row <= 1; row++)')
  expect(helper).toContain('for (var column = -1; column <= 1; column++)')
  expect(helper).not.toMatch(/for \(var slot/)
})

test('reflective glint helper keeps derivatives in uniform fragment control flow', () => {
  const helper = surfaceShader.match(/fn reflectiveGlintAt[\s\S]*?(?=struct FragmentOutput)/)?.[0]
  expect(helper).toBeDefined()
  expect(helper).not.toMatch(/\bdpd[xy]\s*\(/)
})

test('surface and loose-grain fragments provide the dedicated glint target', () => {
  expect(surfaceShader).toMatch(/struct FragmentOutput \{[^}]*@location\(1\) glint: f32/s)
  expect(surfaceShader).toMatch(/struct GrainFragmentOutput \{[^}]*@location\(1\) glint: f32/s)
})

test('mobile grain filtering preserves full visible material detail', () => {
  const mobileFragment = surfaceShader.match(/@fragment fn fragmentMobile[\s\S]*?(?=struct GrainOutput)/)?.[0]
  expect(mobileFragment).toBeDefined()
  expect(mobileFragment).toContain('let appearanceDetail = 1.0;')
  expect(mobileFragment).toContain('let depthDetail = 1.0 - smoothstep(0.48, 0.90, footprint);')
  expect(mobileFragment).toContain('let stochasticAmount = smoothstep(0.32, 0.58, footprint);')
  expect(mobileFragment).not.toContain('let detail = 1.0 - smoothstep(0.55, 2.1, footprint);')
})


test('reset water keeps optical shading continuous at framebuffer edges', () => {
  expect(waterOverlayShader).toContain('fn edgeSafeRefractionUv')
  expect(waterOverlayShader).toContain('let mirrored = vec2f(1.0) - abs(fract(normalized * 0.5)')
  expect(waterOverlayShader).not.toContain('fn refractionViewportWeight')
  expect(waterOverlayShader).not.toContain('safeScale')
  expect(waterOverlayShader).not.toMatch(/abs\(bed\.[xy]\) > overlay\.waveFront\.w/)
  expect(waterOverlayShader).toContain('edgeSafeRefractionUv(projectedRed, sourceDimensions)')
})
