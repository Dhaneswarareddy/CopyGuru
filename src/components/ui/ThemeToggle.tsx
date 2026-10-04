'use client';
import { useEffect, useState } from 'react';

export const THEME_KEY = 'vqa:theme';

/**
 * Runs before the page paints (inlined in <head>) so there is no flash of the
 * wrong theme: a saved choice wins, otherwise the device preference decides.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;

export function ThemeToggle({ className = '' }: { className?: string }) {
  // unknown until mounted: the server cannot know which theme the browser picked
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
    // follow the device while the person has not chosen for themselves
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(THEME_KEY);
      } catch {}
      if (saved) return;
      document.documentElement.classList.toggle('dark', e.matches);
      setDark(e.matches);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', next);
    setDark(next);
    try {
      localStorage.setItem(THEME_KEY, next ? 'dark' : 'light');
    } catch {
      /* storage blocked: the choice simply lasts for this page */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`rounded-lg p-2 text-lg leading-none hover:bg-slate-100 ${className}`}
    >
      <span aria-hidden="true">{dark === null ? '🌗' : dark ? '☀️' : '🌙'}</span>
    </button>
  );
}
