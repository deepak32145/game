import { sfx } from './sound.js';

// Spoken commentary using the browser's built-in speech voice (no audio files).
// Each outcome has several lines so the same call isn't repeated ball after ball.

const LINES = {
  six: [
    "That's a huge six!",
    'Six! That has gone all the way into the crowd!',
    'What a strike! Maximum!',
    'He has absolutely launched that one. Six runs!',
    'Up, up and away! That is out of here!',
  ],
  fourPerfect: [
    'What a shot! Four runs!',
    'Beautifully timed! That races away to the boundary.',
    'Shot of the day! Nobody is stopping that.',
    'Cracking shot! Four all the way.',
  ],
  four: [
    'Four runs! Finds the gap nicely.',
    'That will run away for four.',
    'Boundary! Good placement.',
    'Edged, and it flies away for four. He will take it!',
  ],
  runs: [
    'Good running between the wickets.',
    'Worked away nicely, and they pick up {runs}.',
    'Pushed into the gap for {runs}.',
    'Smart cricket. {runs} more to the total.',
  ],
  single: [
    'Just a single.',
    'Tapped away for one.',
    'Quick single taken.',
    'They rotate the strike.',
  ],
  defend: [
    'Solid defence.',
    'Well defended. Nothing given away there.',
    'Good, watchful defence.',
    'Right behind the line. Safely played.',
  ],
  fielder: [
    'Straight to the fielder. No run.',
    'Well hit, but he finds the fielder.',
    'Good fielding. Dot ball.',
    'No run there. The pressure is building.',
  ],
  beaten: [
    'Good bowling! Beats the bat.',
    'Oh, what a delivery! That went right past the edge.',
    'Played and missed! Lovely bowling.',
    'Beaten all ends up! Great ball.',
  ],
  left: [
    'Left alone. Good judgement.',
    'No shot offered.',
    'He lets that one go through to the keeper.',
  ],
  bowled: [
    'Bowled him! The stumps are shattered!',
    'Clean bowled! What a delivery!',
    'Timber! He has knocked him over!',
    'Through the gate, and the stumps go flying!',
  ],
  lbw: [
    'Big appeal, and that is out! L B W!',
    'Trapped in front! The finger goes up.',
    'Plumb in front. He has to go.',
  ],
  caught: [
    'In the air, and taken! He is out!',
    'Caught! What a catch that is!',
    'He has holed out! Straight down the fielder\'s throat.',
    'Mistimed, and that is safely taken. Big wicket!',
  ],
  wide: [
    'That is a wide. An extra run.',
    'Too wide. The umpire stretches out his arms.',
    'Wayward from the bowler. Wide ball.',
  ],
};

// The line is chosen from the ball itself (not at random), so both players'
// screens always get the same call for the same delivery.
function lineFor(r) {
  let seed = Math.abs(r.offset || 0);
  for (const ch of r.text || '') seed = (seed * 31 + ch.charCodeAt(0)) % 100003;
  const pick = (key) => LINES[key][seed % LINES[key].length];

  if (!r.legal) return { text: pick('wide'), excited: false };
  if (r.wicket) return { text: pick(r.wicket), excited: true };
  if (r.runs === 6) return { text: pick('six'), excited: true };
  if (r.runs === 4) return { text: pick(r.quality === 'perfect' || r.quality === 'good' ? 'fourPerfect' : 'four'), excited: true };
  if (r.runs >= 2) return { text: pick('runs').replace('{runs}', r.runs === 2 ? 'two' : 'three'), excited: false };
  if (r.runs === 1) return { text: pick('single'), excited: false };
  if (!r.shot) return { text: pick('left'), excited: false };
  if (!r.contact) return { text: pick('beaten'), excited: false };
  if (r.shot.style === 'defend') return { text: pick('defend'), excited: false };
  return { text: pick('fielder'), excited: false };
}

let voice = null;

function chooseVoice() {
  const voices = window.speechSynthesis.getVoices();
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  const by = (code) => english.find((v) => v.lang.toLowerCase().replace('_', '-') === code);
  voice = by('en-in') || by('en-gb') || by('en-au') || english[0] || null;
}

// Browsers load their voice list late; pick again when it arrives so the
// commentator doesn't change voice partway through a match.
if (typeof window !== 'undefined' && window.speechSynthesis) {
  window.speechSynthesis.addEventListener('voiceschanged', chooseVoice);
}

export function say(text, excited = false) {
  const synth = window.speechSynthesis;
  if (!synth || sfx.isMuted() || !text) return;
  // Only the window you are actually using talks. Without this, two game windows
  // open on one computer each speak the ball, giving two voices at once.
  if (!document.hasFocus()) return;
  if (!voice) chooseVoice();
  synth.cancel(); // never let old lines queue up behind the action
  const u = new SpeechSynthesisUtterance(text);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  u.rate = excited ? 1.18 : 1.08;
  u.pitch = excited ? 1.25 : 1;
  u.volume = 1;
  synth.speak(u);
}

// Picks a line for the ball, speaks it shortly after the bat sound, and returns the text for the caption.
export function commentate(result) {
  const { text, excited } = lineFor(result);
  setTimeout(() => say(text, excited), 300);
  return text;
}
