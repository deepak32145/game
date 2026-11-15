// Small synthesised sound set (no audio files): poker table sounds and lobby music.
let ctx = null;
let master = null;
let noise = null;
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

  },
  isMuted: () => muted,
  setMuted(value) {
    muted = value;
    try {
      localStorage.setItem('pitch_duel_muted', value ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    if (master) master.gain.value = value ? 0 : 1;
  },
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

// ---- lobby music ------------------------------------------------------------
// A slow, mellow loop built from soft chords, a gentle plucked melody and a quiet beat.
// It plays only in the lobby, has its own on/off switch, and also obeys the main mute.

const midi = (n) => 440 * 2 ** ((n - 69) / 12);
const BPM = 78;
const BEAT = 60 / BPM;
// Four bars, one chord each: A minor 9, F major 7, C major 7, G6.
const BARS = [
  { bass: 45, pad: [57, 60, 64, 67, 71], arp: [69, 72, 76, 79, 76, 72, 71, 72] },
  { bass: 41, pad: [53, 57, 60, 64], arp: [69, 72, 76, 77, 76, 72, 69, 72] },
  { bass: 48, pad: [55, 59, 60, 64], arp: [67, 72, 76, 79, 76, 72, 71, 67] },
  { bass: 43, pad: [55, 59, 62, 64], arp: [67, 71, 74, 76, 74, 71, 67, 71] },
];

let musicOn = true;
try {
  musicOn = localStorage.getItem('pitch_duel_music') !== '0';
} catch {
  /* storage unavailable */
}
let musicBus = null; // everything musical goes through here, so it can be faded as one
let echo = null;
let scheduler = null;
let nextBar = 0;
let barIndex = 0;
let wanted = false; // the lobby is open and would like music

function voice(type, freq, at, { peak, attack, hold, release, cutoff, to }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(peak, at + attack);
  g.gain.setValueAtTime(peak, at + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
  osc.connect(filter).connect(g).connect(to);
  osc.start(at);
  osc.stop(at + attack + hold + release + 0.05);
}

function scheduleBar(at, bar) {
  const len = BEAT * 4;
  // Warm chord pad: two slightly detuned layers per note
  for (const n of bar.pad) {
    voice('triangle', midi(n), at, { peak: 0.05, attack: 0.5, hold: len - 1.1, release: 1.4, cutoff: 1100, to: musicBus });
    voice('sawtooth', midi(n) * 1.004, at, { peak: 0.012, attack: 0.7, hold: len - 1.3, release: 1.4, cutoff: 700, to: musicBus });
  }
  // Soft bass on beat one and just before beat three
  for (const beat of [0, 1.5, 2]) {
    voice('sine', midi(bar.bass), at + beat * BEAT, { peak: 0.16, attack: 0.02, hold: 0.12, release: 0.5, cutoff: 400, to: musicBus });
  }
  // Plucked melody in eighth notes, with an echo
  bar.arp.forEach((n, i) => {
    if (i === 3 && barIndex % 2) return; // leave a little space every other bar
    voice('triangle', midi(n), at + i * (BEAT / 2), { peak: 0.06, attack: 0.008, hold: 0.02, release: 0.45, cutoff: 2400, to: echo });
  });
  // A quiet beat: soft kick, brushed off-beat, light tick
  for (const beat of [0, 2]) {
    const t = at + beat * BEAT;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(105, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(g).connect(musicBus);
    osc.start(t);
    osc.stop(t + 0.25);
  }
  for (let i = 0; i < 8; i++) {
    const t = at + i * (BEAT / 2);
    const src = noiseSource();
    const filter = ctx.createBiquadFilter();
    filter.type = i % 4 === 2 ? 'bandpass' : 'highpass';
    filter.frequency.value = i % 4 === 2 ? 1900 : 7500;
    const g = ctx.createGain();
    const peak = i % 4 === 2 ? 0.05 : i % 2 ? 0.018 : 0.008;
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (i % 4 === 2 ? 0.14 : 0.04));
    src.connect(filter).connect(g).connect(musicBus);
    src.start(t);
    src.stop(t + 0.2);
  }
}

function pump() {
  // Keep about two bars queued ahead of the clock.
  while (nextBar < ctx.currentTime + BEAT * 4 * 1.5) {
    scheduleBar(nextBar, BARS[barIndex % BARS.length]);
    nextBar += BEAT * 4;
    barIndex += 1;
  }
}

function fadeMusic(to, seconds) {
  const g = musicBus.gain;
  g.cancelScheduledValues(ctx.currentTime);
  g.setValueAtTime(g.value, ctx.currentTime);
  g.linearRampToValueAtTime(to, ctx.currentTime + seconds);
}

function applyMusic() {
  if (!ctx) return;
  const shouldPlay = wanted && musicOn;
  if (shouldPlay && !scheduler) {
    if (!musicBus) {
      musicBus = ctx.createGain();
      musicBus.gain.value = 0;
      const soften = ctx.createBiquadFilter();
      soften.type = 'lowpass';
      soften.frequency.value = 5200;
      musicBus.connect(soften).connect(master);
      echo = ctx.createGain();
      const delay = ctx.createDelay(1);
      delay.delayTime.value = BEAT * 0.75;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.32;
      echo.connect(musicBus);
      echo.connect(delay);
      delay.connect(feedback).connect(delay);
      delay.connect(musicBus);
    }
    nextBar = ctx.currentTime + 0.15;
    barIndex = 0;
    pump();
    scheduler = setInterval(pump, 400);
    fadeMusic(0.55, 1.8);
  } else if (!shouldPlay && scheduler) {
    clearInterval(scheduler);
    scheduler = null;
    fadeMusic(0, 0.6); // notes already queued die away under the fade
  }
}

export const music = {
  // Call when the lobby opens (and again on the first tap, once the browser allows sound).
  start() {
    wanted = true;
    applyMusic();
  },
  stop() {
    wanted = false;
    applyMusic();
  },
  isOn: () => musicOn,
  setOn(on) {
    musicOn = on;
    try {
      localStorage.setItem('pitch_duel_music', on ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    applyMusic();
  },
};
