/*
 * Steady capture worklet (§8). Runs in the AudioWorkletGlobalScope.
 *  - Downsamples the context's native rate (48 kHz, 44.1 kHz, or a Bluetooth headset's 16/24 kHz)
 *    to 16 kHz with a box-filter (averaging) resampler, which is an adequate anti-alias for speech.
 *  - Gain normalisation for quiet speech: a slow RMS envelope drives a gain of 1–8× toward a
 *    -20 dBFS target; the gain only rises while there is signal above the noise floor (so silence
 *    is not pumped up), and a soft limiter keeps samples within [-1, 1].
 *  - Emits 100 ms chunks (1600 samples) of pcm_s16le as transferable ArrayBuffers, plus levels.
 * processorOptions: { inputRate: number }. The page re-creates the node (and re-reads
 * AudioContext.sampleRate) when the input device changes.
 */
const TARGET_RATE = 16000;
const CHUNK = 1600; // 100 ms at 16 kHz
const TARGET_RMS = 0.1; // ≈ -20 dBFS
const MAX_GAIN = 8;
const NOISE_FLOOR = 0.004;

class SteadyCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.inputRate = opts.inputRate || sampleRate; // `sampleRate` is a worklet global
    this.step = this.inputRate / TARGET_RATE; // input samples per output sample
    this.acc = 0; // running sum for the current output sample
    this.accN = 0; // input samples accumulated
    this.pos = 0; // fractional position toward the next output sample
    this.last = 0;
    this.out = new Int16Array(CHUNK);
    this.outN = 0;
    this.env = 0; // RMS envelope (pre-gain)
    this.gain = 1;
    this.rawSq = 0;
    this.gainSq = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "rate" && e.data.inputRate) {
        this.inputRate = e.data.inputRate;
        this.step = this.inputRate / TARGET_RATE;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0) return true;
    const ch1 = input.length > 1 ? input[1] : null;
    for (let i = 0; i < ch0.length; i++) {
      const x = ch1 ? 0.5 * (ch0[i] + ch1[i]) : ch0[i];
      this.acc += x;
      this.accN++;
      this.pos += 1;
      // `while`, not `if`: a narrowband headset (8 kHz) needs more than one output per input.
      while (this.pos >= this.step) {
        this.pos -= this.step;
        const s = this.accN > 0 ? this.acc / this.accN : this.last;
        this.last = s;
        this.acc = 0;
        this.accN = 0;
        this.emitSample(s);
      }
    }
    return true;
  }

  emitSample(s) {
    // Envelope: fast attack, slow release (per 16 kHz sample).
    const a = s * s;
    const k = a > this.env ? 0.01 : 0.0005;
    this.env += k * (a - this.env);
    const rms = Math.sqrt(this.env);
    if (rms > NOISE_FLOOR) {
      const want = Math.min(MAX_GAIN, Math.max(1, TARGET_RMS / rms));
      // Gain falls quickly (protect against clipping) and rises slowly.
      this.gain += (want < this.gain ? 0.01 : 0.0002) * (want - this.gain);
    }
    let y = s * this.gain;
    if (y > 0.9 || y < -0.9) y = Math.tanh(y); // soft limiter
    if (y > 1) y = 1;
    else if (y < -1) y = -1;
    this.rawSq += s * s;
    this.gainSq += y * y;
    this.out[this.outN++] = y < 0 ? y * 0x8000 : y * 0x7fff;
    if (this.outN === CHUNK) {
      const buf = this.out.buffer;
      this.port.postMessage(
        {
          type: "chunk",
          pcm: buf,
          level: Math.sqrt(this.rawSq / CHUNK), // pre-gain RMS (voice activity)
          meter: Math.sqrt(this.gainSq / CHUNK), // post-gain RMS (level meter)
          gain: this.gain,
        },
        [buf],
      );
      this.out = new Int16Array(CHUNK);
      this.outN = 0;
      this.rawSq = 0;
      this.gainSq = 0;
    }
  }
}

registerProcessor("steady-capture", SteadyCaptureProcessor);
