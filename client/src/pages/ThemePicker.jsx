import { useEffect } from 'react';
import { THEMES, setTableTheme } from '../tableTheme.js';

// Choose how the table looks. The change shows straight away; the picker stays open to compare.
export default function ThemePicker({ current, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="tp-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div className="tp" role="dialog" aria-label="Table theme" onClick={(e) => e.stopPropagation()}>
        <div className="tp-head">
          <h3>Table theme</h3>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="muted small tp-note">Only you see your theme. It applies to every table you open.</p>
        <div className="tp-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`tp-option ${current === t.id ? 'on' : ''}`}
              onClick={() => setTableTheme(t.id)}
              aria-pressed={current === t.id}
            >
              <span className={`tp-swatch theme-${t.id}`}><i /><b /></span>
              {t.name}
              <small>{t.note}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
