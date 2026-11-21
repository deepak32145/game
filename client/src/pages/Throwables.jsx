import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { throwSfx } from '../audio/sound.js';

// Throwables: a seated player taps an opponent's face, picks something, and everyone at the table
// sees it fly from the thrower's seat and land on the target. The server checks who may throw what;
// this file only draws it. Effects are built straight in the DOM (not React state) so a flurry of
// throws never re-renders the table.

// flight: how it travels; hit: what happens on landing; sound: the landing sound.
export const THROWABLES = [
  { id: 'bomb', emoji: '💣', name: 'Bomb', flight: 'spin', hit: 'boom', sound: 'boom' },
  { id: 'egg', emoji: '🥚', name: 'Egg', flight: 'tumble', hit: 'splat', sound: 'splat', c: '#ffd23f', c2: '#fffbe9' },
  { id: 'tomato', emoji: '🍅', name: 'Tomato', flight: 'tumble', hit: 'splat', sound: 'splat', c: '#e3262c', c2: '#ff6b5e' },
  { id: 'slap', emoji: '🖐️', name: 'Slap', flight: 'straight', hit: 'slap', sound: 'slap', word: 'SLAP!' },
  { id: 'slipper', emoji: '🩴', name: 'Slipper', flight: 'spin', hit: 'thwack', sound: 'thwack', word: 'THWACK!' },
  { id: 'punch', emoji: '🥊', name: 'Punch', flight: 'straight', hit: 'punch', sound: 'slap', word: 'POW!' },
  { id: 'poop', emoji: '💩', name: 'Poop', flight: 'tumble', hit: 'splat', sound: 'splat', c: '#6b4423', c2: '#8a5a32' },
  { id: 'cake', emoji: '🎂', name: 'Cake', flight: 'tumble', hit: 'splat', sound: 'splat', c: '#fff1f5', c2: '#ff9ec4' },
  { id: 'fish', emoji: '🐟', name: 'Fish', flight: 'spin', hit: 'flop', sound: 'flop' },
  { id: 'ice', emoji: '🧊', name: 'Freeze', flight: 'spin', hit: 'freeze', sound: 'freeze' },
  { id: 'fire', emoji: '🔥', name: 'Fire', flight: 'straight', hit: 'burn', sound: 'burn' },
  { id: 'beer', emoji: '🍺', name: 'Beer', flight: 'tumble', hit: 'splat', sound: 'splat', c: '#ffd76a', c2: '#fffaf0' },
  { id: 'money', emoji: '💸', name: 'Make it rain', flight: 'float', hit: 'cash', sound: 'cash' },
  { id: 'rose', emoji: '🌹', name: 'Rose', flight: 'float', hit: 'petals', sound: 'sparkle' },
  { id: 'kiss', emoji: '💋', name: 'Kiss', flight: 'float', hit: 'kiss', sound: 'smack' },
  { id: 'crown', emoji: '👑', name: 'Crown', flight: 'float', hit: 'crown', sound: 'sparkle' },
];
const BY_ID = Object.fromEntries(THROWABLES.map((t) => [t.id, t]));
export const THROW_COOLDOWN_MS = 1500; // matches the server

// ---- drawing ------------------------------------------------------------------

const faceOf = (page, seat) => page?.querySelector(`.st[data-seat="${seat}"] .st-face`);
const seatOf = (page, seat) => page?.querySelector(`.st[data-seat="${seat}"]`);
const centre = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: Math.max(r.width, r.height) / 2 };
};

// Puts a piece on the layer at a point and removes it when its time is up.
function spawn(layer, { x, y, text = '', cls, life, style = {} }) {
  const el = document.createElement('span');
  el.className = `tw ${cls}`;
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v);
  layer.appendChild(el);
  setTimeout(() => el.remove(), life);
  return el;
}

const shake = (el, power = 6, ms = 450) =>
  el?.animate(
    [0, -1, 1, -0.8, 0.8, -0.5, 0.5, 0].map((k) => ({ translate: `${k * power}px ${Math.abs(k) * power * 0.25}px` })),
    { duration: ms, easing: 'ease-out' },
  );

// Pieces flung outwards from a point (debris, droplets, petals).
function burst(layer, at, { count, text = '', cls, spread, life, fall = 0 }) {
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const dist = spread * (0.6 + Math.random() * 0.6);
    const el = spawn(layer, { x: at.x, y: at.y, text, cls, life });
    el.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist + fall}px)) scale(1) rotate(${Math.random() * 360}deg)`, opacity: 0 },
      ],
      { duration: life, easing: 'cubic-bezier(0.2, 0.7, 0.4, 1)', fill: 'forwards' },
    );
  }
}

function land(layer, page, shot, item, at) {
  const target = seatOf(page, shot.to);
  const r = Math.max(at.r, 28); // never smaller than this, so a hit reads clearly even on a small avatar
  throwSfx.hit(item.sound);
  switch (item.hit) {
    case 'boom':
      spawn(layer, { x: at.x, y: at.y, text: '💥', cls: 'tw-boom', life: 700 });
      spawn(layer, { x: at.x, y: at.y, cls: 'tw-ring', life: 650 });
      spawn(layer, { x: at.x, y: at.y + r * 0.2, text: '💨', cls: 'tw-smoke', life: 1400 });
      burst(layer, at, { count: 10, cls: 'tw-debris', spread: 90, life: 650 });
      shake(target, 11, 600);
      page.querySelector('.pk-felt')?.animate([{ translate: '0 0' }, { translate: '3px -2px' }, { translate: '-3px 2px' }, { translate: '0 0' }], { duration: 260 });
      break;
    case 'splat':
      spawn(layer, { x: at.x, y: at.y, cls: 'tw-splat', life: 3400, style: { '--c': item.c, '--c2': item.c2, '--r': `${r * 3.2}px` } });
      burst(layer, at, { count: 7, cls: 'tw-drop', spread: 55, life: 600, fall: 20 });
      shake(target, 4, 300);
      break;
    case 'slap':
      spawn(layer, { x: at.x - r * 1.3, y: at.y, text: '🖐️', cls: 'tw-swing', life: 600 });
      spawn(layer, { x: at.x, y: at.y - r * 1.4, text: item.word, cls: 'tw-word', life: 900 });
      spawn(layer, { x: at.x + r * 0.35, y: at.y + r * 0.1, cls: 'tw-cheek', life: 1600, style: { '--r': `${r}px` } });
      shake(target, 9, 420);
      break;
    case 'punch':
      spawn(layer, { x: at.x, y: at.y - r * 1.4, text: item.word, cls: 'tw-word pow', life: 900 });
      burst(layer, at, { count: 6, text: '✦', cls: 'tw-spark', spread: 50, life: 500 });
      shake(target, 10, 420);
      break;
    case 'thwack':
      spawn(layer, { x: at.x, y: at.y - r * 1.4, text: item.word, cls: 'tw-word', life: 900 });
      for (let i = 0; i < 3; i++) spawn(layer, { x: at.x, y: at.y - r * 0.9, text: '⭐', cls: 'tw-dizzy', life: 1700, style: { 'animation-delay': `${-i * 0.33}s`, '--r': `${r * 1.1}px` } });
      shake(target, 8, 420);
      break;
    case 'flop':
      spawn(layer, { x: at.x, y: at.y, text: '🐟', cls: 'tw-flop', life: 1300 });
      burst(layer, at, { count: 8, cls: 'tw-drop water', spread: 50, life: 600, fall: 15 });
      shake(target, 5, 350);
      break;
    case 'freeze':
      spawn(layer, { x: at.x, y: at.y, cls: 'tw-frost', life: 3200, style: { '--r': `${r * 2.6}px` } });
      for (let i = 0; i < 5; i++) {
        const a = (Math.PI * 2 * i) / 5;
        spawn(layer, { x: at.x + Math.cos(a) * r * 1.4, y: at.y + Math.sin(a) * r * 1.4, text: '❄️', cls: 'tw-flake', life: 3200, style: { 'animation-delay': `${i * 0.08}s` } });
      }
      target?.animate([{ translate: '0 0' }, { translate: '1.5px 0' }, { translate: '-1.5px 0' }, { translate: '0 0' }], { duration: 120, iterations: 12 });
      break;
    case 'burn':
      spawn(layer, { x: at.x, y: at.y, cls: 'tw-glow', life: 2600, style: { '--r': `${r * 2.6}px` } });
      for (let i = 0; i < 4; i++) spawn(layer, { x: at.x + (i - 1.5) * r * 0.7, y: at.y + r * 0.3, text: '🔥', cls: 'tw-flame', life: 2600, style: { 'animation-delay': `${i * 0.12}s` } });
      spawn(layer, { x: at.x, y: at.y - r, text: '💨', cls: 'tw-smoke late', life: 2600 });
      shake(target, 3, 300);
      break;
    case 'cash':
      for (let i = 0; i < 12; i++) {
        spawn(layer, { x: at.x + (Math.random() - 0.5) * r * 5, y: at.y - r * 3, text: '💵', cls: 'tw-rain', life: 2000, style: { 'animation-delay': `${Math.random() * 0.6}s`, '--sway': `${(Math.random() - 0.5) * 50}px` } });
      }
      spawn(layer, { x: at.x, y: at.y - r * 1.2, text: '💰', cls: 'tw-pop', life: 1200 });
      break;
    case 'petals':
      burst(layer, at, { count: 9, text: '🌸', cls: 'tw-petal', spread: 70, life: 1400, fall: 40 });
      spawn(layer, { x: at.x, y: at.y - r, text: '❤️', cls: 'tw-pop', life: 1300 });
      break;
    case 'kiss':
      spawn(layer, { x: at.x + r * 0.2, y: at.y, text: '💋', cls: 'tw-stamp', life: 3200 });
      for (let i = 0; i < 3; i++) spawn(layer, { x: at.x + (i - 1) * r * 0.9, y: at.y - r * 0.6, text: '💕', cls: 'tw-heart', life: 1600, style: { 'animation-delay': `${i * 0.15}s` } });
      break;
    case 'crown':
      spawn(layer, { x: at.x, y: at.y - r * 1.25, text: '👑', cls: 'tw-crown', life: 3400 });
      for (let i = 0; i < 4; i++) spawn(layer, { x: at.x + (Math.random() - 0.5) * r * 3, y: at.y - r * (1 + Math.random()), text: '✨', cls: 'tw-twinkle', life: 2000, style: { 'animation-delay': `${i * 0.2}s` } });
      break;
    default:
  }
}

// Plays one throw on the layer: flight from the thrower's face to the target's, then the landing.
export function playThrow(layer, shot) {
  const item = BY_ID[shot.item];
  const page = layer?.closest('.pk-page');
  const fromEl = faceOf(page, shot.from);
  const toEl = faceOf(page, shot.to);
  if (!item || !fromEl || !toEl) return;
  const b = centre(toEl);
  // A device that asks for less motion just sees what landed.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    spawn(layer, { x: b.x, y: b.y, text: item.emoji, cls: 'tw-still', life: 1600 });
    return;
  }
  const a = centre(fromEl);
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const arc = item.flight === 'straight' ? dist * 0.08 : item.flight === 'float' ? dist * 0.45 : dist * 0.3;
  const duration = (item.flight === 'float' ? 1100 : item.flight === 'straight' ? 420 : 700) + dist * 0.25;
  const spin = { spin: 900, tumble: 420, straight: 0, float: 0 }[item.flight];
  const frames = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t - arc * 4 * t * (1 - t);
    const rot = item.flight === 'float' ? Math.sin(t * Math.PI * 3) * 14 : spin * t;
    const scale = 0.7 + Math.sin(t * Math.PI) * 0.7;
    frames.push({ transform: `translate(${x}px, ${y}px) translate(-50%, -50%) rotate(${rot}deg) scale(${scale})` });
  }
  const el = document.createElement('span');
  el.className = 'tw tw-fly';
  el.textContent = item.emoji;
  layer.appendChild(el);
  throwSfx.launch();
  const anim = el.animate(frames, { duration, easing: item.flight === 'float' ? 'ease-in-out' : 'cubic-bezier(0.3, 0.1, 0.7, 1)', fill: 'forwards' });
  anim.onfinish = () => {
    el.remove();
    land(layer, page, shot, item, centre(toEl));
  };
}

// ---- the menu ------------------------------------------------------------------

// Opens next to the opponent whose face was tapped.
// Closes as soon as a throw is on its way, so the menu never hides the flight;
// stays open only to say why the server refused one.
export function ThrowMenu({ target, canThrow, readyAt, onThrow, onClose }) {
  const box = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  const [cooling, setCooling] = useState(() => Date.now() < readyAt);
  useEffect(() => {
    if (!cooling) return;
    const t = setTimeout(() => setCooling(false), Math.max(0, readyAt - Date.now()));
    return () => clearTimeout(t);
  }, [cooling, readyAt]);
  const [note, setNote] = useState('');

  useLayoutEffect(() => {
    const m = box.current.getBoundingClientRect();
    const r = target.rect;
    const gap = 10;
    const below = r.bottom + gap + m.height <= innerHeight - 8;
    const top = below ? r.bottom + gap : Math.max(8, r.top - gap - m.height);
    const left = Math.min(Math.max(8, r.left + r.width / 2 - m.width / 2), innerWidth - m.width - 8);
    setPos({ left, top });
  }, [target]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (item) => {
    if (cooling || !canThrow) return;
    setNote('');
    setCooling(true);
    onThrow(item.id, (r) => {
      if (r?.ok) onClose();
      else {
        setNote(r?.error || 'Could not throw that');
        setCooling(false);
      }
    });
  };

  return (
    <div className="tw-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div ref={box} className="tw-menu" style={pos} role="dialog" aria-label={`Throw something at ${target.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="tw-menu-head">
          <b>Throw at {target.name}</b>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {!canThrow && <p className="muted small tw-menu-note">Take a seat to throw things at players.</p>}
        <div className={`tw-grid ${cooling ? 'cooling' : ''}`}>
          {THROWABLES.map((t) => (
            <button key={t.id} className="tw-item" disabled={!canThrow || cooling} onClick={() => pick(t)} title={t.name}>
              <span>{t.emoji}</span>
              <small>{t.name}</small>
            </button>
          ))}
        </div>
        {cooling && <div className="tw-cool" style={{ animationDuration: `${Math.max(200, readyAt - Date.now())}ms` }} />}
        {note && <p className="error small tw-menu-note">{note}</p>}
        <p className="muted small tw-menu-foot">Everyone at the table sees it. Turn throwables off in 🎨 Table theme.</p>
      </div>
    </div>
  );
}
