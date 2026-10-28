export function drawingBuffer(width: number, height: number, deviceDpr: number) {
  if (width <= 0 || height <= 0 || !Number.isFinite(width + height)) return null
  const dpr = Math.min(Number.isFinite(deviceDpr) && deviceDpr > 0 ? deviceDpr : 1, 1.7, Math.sqrt(4_000_000 / (width * height)))
  return { width: Math.max(1, Math.floor(width * dpr)), height: Math.max(1, Math.floor(height * dpr)), dpr }
}
