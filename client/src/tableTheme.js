import { useEffect, useState } from 'react';

// The look of the poker table. It is a personal choice, kept in this browser only,
// and applies to every table the player has open.

export const THEMES = [
  { id: 'classic', name: 'Emerald', note: 'Floating suits, casino glow' },
  { id: 'royal', name: 'Royal Blue', note: 'Aurora sky, spotlight' },
  { id: 'crimson', name: 'Crimson Velvet', note: 'Rising embers, velvet sheen' },
  { id: 'neon', name: 'Midnight Neon', note: 'Synthwave grid, neon rail' },
  { id: 'galaxy', name: 'Purple Galaxy', note: 'Nebula, shooting stars' },
  { id: 'gold', name: 'Black & Gold', note: 'Gold dust, light rays' },
  { id: 'ocean', name: 'Ocean', note: 'Bubbles, waves, caustics' },
];

const KEY = 'pitch_duel_table_theme';
const EVENT = 'pitch-duel-table-theme';
const FX_KEY = 'pitch_duel_table_fx';
const FX_EVENT = 'pitch-duel-table-fx';

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

// Animated scenery on or off (on unless the player turned it off).
function loadFx() {
  try {
    return localStorage.getItem(FX_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setTableFx(on) {
  try {
    localStorage.setItem(FX_KEY, on ? 'on' : 'off');
  } catch {
    // Storage blocked: applies until the page is reloaded.
  }
  window.dispatchEvent(new CustomEvent(FX_EVENT, { detail: on }));
}

export function useTableFx() {
  const [on, setOn] = useState(loadFx);
  useEffect(() => {
    const onChange = (e) => setOn(e.detail);
    window.addEventListener(FX_EVENT, onChange);
    return () => window.removeEventListener(FX_EVENT, onChange);
  }, []);
  return on;
}

// Throwables from other players shown or hidden (shown unless the player hid them).
const THROWS_KEY = 'pitch_duel_show_throws';
const THROWS_EVENT = 'pitch-duel-show-throws';
function loadThrows() {
  try {
    return localStorage.getItem(THROWS_KEY) !== 'off';
  } catch {
    return true;
  }
}
export function setShowThrows(on) {
  try {
    localStorage.setItem(THROWS_KEY, on ? 'on' : 'off');
  } catch {
    // Storage blocked: applies until the page is reloaded.
  }
  window.dispatchEvent(new CustomEvent(THROWS_EVENT, { detail: on }));
}
export function useShowThrows() {
  const [on, setOn] = useState(loadThrows);
  useEffect(() => {
    const onChange = (e) => setOn(e.detail);
    window.addEventListener(THROWS_EVENT, onChange);
    return () => window.removeEventListener(THROWS_EVENT, onChange);
  }, []);
  return on;
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
