/** Short sand/bucket impact, generated locally; no network asset dependency. */
export function buildImpactSamples(sampleRate: number) {
  const samples = new Float32Array(Math.ceil(sampleRate * .38))
  let seed = 0x5645189, low = 0
  for (let i = 0; i < samples.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    const noise = (seed >>> 0) / 0xffffffff * 2 - 1
    low += (noise - low) * .16
    const t = i / sampleRate, attack = Math.min(1, t / .008)
    const tail = Math.max(0, 1 - t / .38)
    const thud = Math.sin(2 * Math.PI * (100 * t - 55 * t * t)) * Math.exp(-t * 20)
    samples[i] = attack * tail * (low * .50 * Math.exp(-t * 9) + thud * .17)
  }
  return samples
}
