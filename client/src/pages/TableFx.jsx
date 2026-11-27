import { memo } from 'react';

// Animated scenery for the table themes: a background scene behind the whole table page,
// and a layer of light on the felt. Pure decoration: CSS animations only, never clickable,
// hidden from screen readers, and switched off by the player's "animations" setting or
// their device's reduced-motion preference (see styles.css, "Animated table themes").

// Repeatable pseudo-random numbers, so particles land in the same places on every render.
const rand = (i, seed) => {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const spread = (count, seed) => Array.from({ length: count }, (_, i) => ({
  i,
  x: rand(i, seed) * 100,
  size: rand(i, seed + 1),
  speed: rand(i, seed + 2),
  delay: rand(i, seed + 3),
}));

// Kept small: every moving piece costs a phone some work on each frame.
const GOLD = spread(12, 1);
const BUBBLES = spread(9, 2);
const EMBERS = spread(12, 3);
const SUITS = spread(7, 4);
const SUIT_GLYPHS = ['♠', '♥', '♦', '♣'];

// Rising particles: each gets its own lane, size, speed and a negative delay so the screen starts full.
const rising = (list, className, { min, max, slow, fast }, render = () => null) =>
  list.map((p) => (
    <i
      key={p.i}
      className={className}
      style={{
        left: `${p.x}%`,
        '--s': `${min + p.size * (max - min)}px`,
        animationDuration: `${slow - p.speed * (slow - fast)}s`,
        animationDelay: `-${p.delay * slow}s`,
      }}
    >
      {render(p)}
    </i>
  ));

export const SceneFx = memo(function SceneFx({ theme }) {
  switch (theme) {
    case 'neon':
      return (
        <div className="fx fx-neon" aria-hidden="true">
          <div className="fx-glow a" />
          <div className="fx-glow b" />
          <div className="fx-floor"><div className="fx-grid" /></div>
          <div className="fx-floor top"><div className="fx-grid" /></div>
        </div>
      );
    case 'galaxy':
      return (
        <div className="fx fx-galaxy" aria-hidden="true">
          <div className="fx-nebula" />
          <div className="fx-stars s1" />
          <div className="fx-stars s2" />
          <i className="fx-shoot a" />
          <i className="fx-shoot b" />
          <i className="fx-shoot c" />
        </div>
      );
    case 'gold':
      return (
        <div className="fx fx-gold" aria-hidden="true">
          <div className="fx-rays" />
          {rising(GOLD, 'fx-mote', { min: 4, max: 14, slow: 20, fast: 10 })}
        </div>
      );
    case 'ocean':
      return (
        <div className="fx fx-ocean" aria-hidden="true">
          <div className="fx-shafts" />
          {rising(BUBBLES, 'fx-bubble', { min: 5, max: 16, slow: 16, fast: 8 })}
          <div className="fx-wave back" />
          <div className="fx-wave front" />
        </div>
      );
    case 'crimson':
      return (
        <div className="fx fx-crimson" aria-hidden="true">
          <div className="fx-smoke" />
          {rising(EMBERS, 'fx-ember', { min: 3, max: 6, slow: 11, fast: 5 })}
        </div>
      );
    case 'royal':
      return (
        <div className="fx fx-royal" aria-hidden="true">
          <div className="fx-aurora a" />
          <div className="fx-aurora b" />
          <div className="fx-aurora c" />
          <div className="fx-stars s2" />
        </div>
      );
    default:
      return (
        <div className="fx fx-classic" aria-hidden="true">
          <div className="fx-spot" />
          {rising(SUITS, 'fx-suit', { min: 18, max: 40, slow: 30, fast: 18 }, (p) => SUIT_GLYPHS[p.i % 4])}
        </div>
      );
  }
});

// Light moving across the felt. Its look comes entirely from the theme class above it.
export const FeltFx = memo(function FeltFx() {
  return <span className="fx-felt" aria-hidden="true" />;
});
