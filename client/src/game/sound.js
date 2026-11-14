// Small synthesised sound set (no audio files): crowd bed, bat, bounce, stumps, cheers.
let ctx = null;
let master = null;
let noise = null;
let bed = null; // crowd murmur level
let ambience = true;
let muted = false;
try {
  muted = localStorage.getItem('pitch_duel_muted') === '1';
} catch {
  /* storage unavailable */
}

function noiseSource(loop = false) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = loop;
  return src;
}

function envelope(peak, attack, decay, at = ctx.currentTime) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  g.connect(master);
  return g;
}

function burst({ freq, q = 1, peak, attack = 0.005, decay, type = 'bandpass' }) {
  if (!ctx) return;
  const src = noiseSource();
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  src.connect(filter).connect(envelope(peak, attack, decay));
  src.start();
  src.stop(ctx.currentTime + attack + decay + 0.05);
}

function tone({ freq, peak, decay, type = 'sine', delay = 0 }) {
  if (!ctx) return;
  const at = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, at + decay);
  osc.connect(envelope(peak, 0.003, decay, at));
  osc.start(at);
  osc.stop(at + decay + 0.05);
}

export const sfx = {
  // Browsers only allow audio after a user gesture, so call this from a click or key press.
  unlock() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // Constant crowd murmur
    const lp = ctx.createBiquadFilter();
    lp.type = 'bandpass';
    lp.frequency.value = 420;
    lp.Q.value = 0.4;
    const murmur = noiseSource(true);
    bed = ctx.createGain();
    bed.gain.value = ambience ? 0.035 : 0; // kept low so the commentary is easy to hear
    murmur.connect(lp).connect(bed).connect(master);
    murmur.start();
  },
  isMuted: () => muted,
  // The stadium crowd is for cricket; the poker table turns it off.
  setAmbience(on) {
    ambience = on;
    if (bed) bed.gain.value = on ? 0.035 : 0;
  },
  setMuted(value) {
    muted = value;
    try {
      localStorage.setItem('pitch_duel_muted', value ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    if (master) master.gain.value = value ? 0 : 1;
    if (value) window.speechSynthesis?.cancel();
  },
  bounce: () => burst({ freq: 240, q: 1.2, peak: 0.25, decay: 0.07, type: 'lowpass' }),
  bat(power = 1) {
    burst({ freq: 1900, q: 2.5, peak: 0.5 * power, decay: 0.07 });
    tone({ freq: 210, peak: 0.35 * power, decay: 0.09, type: 'triangle' });
  },
  stumps() {
    tone({ freq: 820, peak: 0.35, decay: 0.06, type: 'square' });
    tone({ freq: 640, peak: 0.3, decay: 0.08, type: 'square', delay: 0.05 });
    tone({ freq: 980, peak: 0.2, decay: 0.05, type: 'square', delay: 0.11 });
  },
  cheer(level = 1) {
    burst({ freq: 1000, q: 0.5, peak: 0.42 * level, attack: 0.35, decay: 2.2 + level });
    burst({ freq: 2400, q: 0.8, peak: 0.14 * level, attack: 0.5, decay: 1.8 + level });
  },
  gasp: () => burst({ freq: 600, q: 0.6, peak: 0.16, attack: 0.12, decay: 0.9 }),
};

// ---- poker table sounds -----------------------------------------------------

// A burst of filtered noise at a chosen moment: the basis of card and chip sounds.
function swish(delay, { freq, q = 1, peak, attack = 0.004, decay }) {
  if (!ctx) return;
  const at = ctx.currentTime + delay;
  const src = noiseSource();
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  src.connect(filter).connect(envelope(peak, attack, decay, at));
  src.start(at);
  src.stop(at + attack + decay + 0.05);
}

function chipClicks(count, delay = 0, gain = 1) {
  for (let i = 0; i < count; i++) {
    const d = delay + i * 0.045 + Math.random() * 0.015;
    tone({ freq: 2600 + Math.random() * 1800, peak: 0.16 * gain, decay: 0.03, type: 'triangle', delay: d });
    swish(d, { freq: 5200, q: 3, peak: 0.1 * gain, decay: 0.02 });
  }
}

export const pokerSfx = {
  shuffle() {
    for (let i = 0; i < 9; i++) swish(i * 0.055, { freq: 2600 + i * 180, q: 0.9, peak: 0.16, decay: 0.045 });
    for (let i = 0; i < 9; i++) swish(0.62 + i * 0.045, { freq: 3400, q: 0.9, peak: 0.13, decay: 0.035 });
  },
  deal(count = 2, delay = 0) {
    for (let i = 0; i < count; i++) swish(delay + i * 0.14, { freq: 3800, q: 0.7, peak: 0.22, attack: 0.012, decay: 0.07 });
  },
  flip(delay = 0) {
    swish(delay, { freq: 4300, q: 1.2, peak: 0.25, attack: 0.006, decay: 0.05 });
    tone({ freq: 520, peak: 0.12, decay: 0.04, type: 'triangle', delay: delay + 0.03 });
  },
  check() {
    tone({ freq: 150, peak: 0.4, decay: 0.05, type: 'sine' });
    tone({ freq: 140, peak: 0.34, decay: 0.05, type: 'sine', delay: 0.11 });
  },
  call: () => chipClicks(3),
  bet: () => chipClicks(5),
  raise: () => chipClicks(7, 0, 1.1),
  allIn() {
    chipClicks(12, 0, 1.2);
    swish(0.05, { freq: 900, q: 0.6, peak: 0.2, attack: 0.25, decay: 0.5 });
    tone({ freq: 330, peak: 0.18, decay: 0.5, type: 'sawtooth', delay: 0.05 });
  },
  fold() {
    swish(0, { freq: 1800, q: 0.6, peak: 0.2, attack: 0.02, decay: 0.16 });
  },
  win() {
    [660, 880, 1320].forEach((f, i) => tone({ freq: f, peak: 0.2, decay: 0.28, type: 'sine', delay: i * 0.11 }));
    chipClicks(8, 0.25, 0.9);
  },
  lose() {
    tone({ freq: 300, peak: 0.16, decay: 0.3, type: 'sine' });
    tone({ freq: 225, peak: 0.16, decay: 0.4, type: 'sine', delay: 0.16 });
  },
  blindsUp() {
    [523, 659, 784].forEach((f, i) => tone({ freq: f, peak: 0.16, decay: 0.2, type: 'triangle', delay: i * 0.13 }));
  },
  tick() {
    tone({ freq: 1250, peak: 0.12, decay: 0.05, type: 'square' });
  },
  yourTurn() {
    tone({ freq: 990, peak: 0.1, decay: 0.12, type: 'sine' });
  },
};
