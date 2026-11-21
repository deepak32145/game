import { useEffect, useState } from 'react';

// The look of the poker table. It is a personal choice, kept in this browser only,
// and applies to every table the player has open.

export const THEMES = [
  { id: 'classic', name: 'Emerald', note: 'The classic green' },
  { id: 'royal', name: 'Royal Blue', note: 'Blue felt, walnut rail' },
  { id: 'crimson', name: 'Crimson Velvet', note: 'Red felt, black rail' },
  { id: 'neon', name: 'Midnight Neon', note: 'Dark felt, neon glow' },
  { id: 'galaxy', name: 'Purple Galaxy', note: 'Violet felt, starlight' },
  { id: 'gold', name: 'Black & Gold', note: 'High-roller VIP' },
  { id: 'ocean', name: 'Ocean', note: 'Teal felt, driftwood rail' },
];

const KEY = 'pitch_duel_table_theme';
const EVENT = 'pitch-duel-table-theme';

function load() {
  try {
    const id = localStorage.getItem(KEY);
    return THEMES.some((t) => t.id === id) ? id : 'classic';
  } catch {
    return 'classic';
  }
}

export function setTableTheme(id) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Storage blocked: the choice still applies until the page is reloaded.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
}

// The current theme, kept in step across every open table.
export function useTableTheme() {
  const [theme, setTheme] = useState(load);
  useEffect(() => {
    const onChange = (e) => setTheme(e.detail);
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return theme;
}
