export const sandWorkletSource = String.raw`
class SandProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.waterTarget = 0;
    this.waterBlend = 0;
    this.bubblePhase = 0;
    this.gateTarget = 0;
    this.speedTarget = 0;
    this.pressureTarget = 0;
    this.turnTarget = 0;

    this.gate = 0;
    this.speed = 0;
    this.pressure = 0;
    this.turn = 0;

    this.seedL = 0x12345678;
    this.seedR = 0x87654321;

    this.lpL = this.lpR = 0;
    this.lp2L = this.lp2R = 0;
    this.slowL = this.slowR = 0;
    this.highLpL = this.highLpR = 0;

    this.grainEnvL = this.grainEnvR = 0;
    this.grainToneL = this.grainToneR = 0;
    this.grainPhaseL = this.grainPhaseR = 0;
    this.grainFreqL = this.grainFreqR = 2600;

    this.crunchEnv = 0;
    this.ridgePhase = 0;

    this.port.onmessage = e => {
      const d = e.data || {};
      if (d.type === 'state') {
        this.gateTarget = d.gate ? 1 : 0;
        this.waterTarget = d.mode === 2 ? 1 : 0;

        if (d.gate) {
          this.speedTarget = Math.max(0, Math.min(1.25, d.speed || 0));
          this.pressureTarget = Math.max(0, Math.min(1, d.pressure || 0));
          this.turnTarget = Math.max(0, Math.min(1, d.turn || 0));
        }
      }
    };
  }

  rnd(side) {
    if (side === 0) {
      let x = this.seedL | 0;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      this.seedL = x | 0;
      return ((x >>> 0) / 4294967296) * 2 - 1;
    } else {
      let x = this.seedR | 0;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      this.seedR = x | 0;
      return ((x >>> 0) / 4294967296) * 2 - 1;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const sr = sampleRate;

    for (let i = 0; i < L.length; i++) {
      this.waterBlend += (this.waterTarget-this.waterBlend)*.0007;
      const gCoef = this.gateTarget > this.gate ? 0.0045 : 0.00013;
      this.gate += (this.gateTarget - this.gate) * gCoef;

      if (this.gateTarget > 0.5) {
        this.speed += (this.speedTarget - this.speed) * 0.0017;
        this.pressure += (this.pressureTarget - this.pressure) * 0.0015;
        this.turn += (this.turnTarget - this.turn) * 0.0014;
      } else {
        this.speed *= 0.99970;
        this.pressure *= 0.99976;
        this.turn *= 0.99940;
      }

      const s = Math.max(0, Math.min(1, this.speed));
      const p = Math.max(0, Math.min(1, this.pressure));
      const strength = Math.pow(s, 0.78);
      const contact = this.gate * (0.055 + 0.70 * strength) * (0.92 + p * 0.08);

      const nL = this.rnd(0);
      const nR = this.rnd(1);
      const aBody = 0.010 + s * 0.032;
      const aSoft = 0.0030 + s * 0.0075;
      const aAir  = 0.11 + s * 0.10;

      this.lpL += (nL - this.lpL) * aBody;
      this.lpR += (nR - this.lpR) * aBody;
      this.slowL += (nL - this.slowL) * aSoft;
      this.slowR += (nR - this.slowR) * aSoft;
      this.highLpL += (nL - this.highLpL) * aAir;
      this.highLpR += (nR - this.highLpR) * aAir;

      const bodyL = this.lpL - this.slowL;
      const bodyR = this.lpR - this.slowR;
      const airL = nL - this.highLpL;
      const airR = nR - this.highLpR;

      const density = 20 + 520 * Math.pow(s, 1.35);
      if (Math.random() < density / sr) {
        this.grainEnvL = 0.10 + Math.random() * 0.38;
        this.grainFreqL = 1200 + Math.random() * (1700 + s * 2300);
      }
      if (Math.random() < density / sr) {
        this.grainEnvR = 0.10 + Math.random() * 0.38;
        this.grainFreqR = 1200 + Math.random() * (1700 + s * 2300);
      }

      this.grainPhaseL += this.grainFreqL / sr;
      this.grainPhaseR += this.grainFreqR / sr;
      if (this.grainPhaseL >= 1) this.grainPhaseL -= 1;
      if (this.grainPhaseR >= 1) this.grainPhaseR -= 1;
      const pingL = Math.sin(this.grainPhaseL * Math.PI * 2) * this.grainEnvL;
      const pingR = Math.sin(this.grainPhaseR * Math.PI * 2) * this.grainEnvR;
      const grainDecay = 0.978 - s * 0.004;
      this.grainEnvL *= grainDecay;
      this.grainEnvR *= grainDecay;

      const crunchRate = 1 + 18 * this.turn * (0.2 + s);
      if (Math.random() < crunchRate / sr) this.crunchEnv = .10 + Math.random() * .28;
      const crunch = (nL + nR) * .5 * this.crunchEnv;
      this.crunchEnv *= 0.986;

      this.ridgePhase += (18 + 54 * s) / sr;
      if (this.ridgePhase >= 1) this.ridgePhase -= 1;
      const ridge = Math.max(0, Math.sin(this.ridgePhase * Math.PI * 2));
      const ridgeMod = 0.97 + ridge * 0.03;

      const softMix = 0.50 - s * 0.09;
      const airMix = 0.007 + s * 0.025;
      const grainMix = 0.0025 + s * 0.010;

      let yL = bodyL * softMix + airL * airMix + pingL * grainMix + crunch * 0.018;
      let yR = bodyR * softMix + airR * airMix + pingR * grainMix + crunch * 0.018;

      yL = Math.tanh(yL * 1.05) * contact * ridgeMod;
      yR = Math.tanh(yR * 1.05) * contact * ridgeMod;

      // A held pour is a low, continuous splash with soft irregular bubbles.
      this.bubblePhase += (320 + 140 * Math.sin(this.ridgePhase * Math.PI * 2)) / sr;
      if (this.bubblePhase >= 1) this.bubblePhase -= 1;
      const bubble = Math.sin(this.bubblePhase * Math.PI * 2) * Math.pow(Math.max(0,Math.sin(this.ridgePhase * Math.PI * 2)),8) * .012;
      const waterL = (this.lpL * .65 + bodyL * .35 + bubble) * this.gate;
      const waterR = (this.lpR * .65 + bodyR * .35 + bubble) * this.gate;
      yL += (waterL-yL)*this.waterBlend;
      yR += (waterR-yR)*this.waterBlend;
      const mid = (yL + yR) * .5;
      L[i] = mid * .72 + yL * .28;
      R[i] = mid * .72 + yR * .28;
    }
    return true;
  }
}
registerProcessor('sand-processor', SandProcessor);
`
