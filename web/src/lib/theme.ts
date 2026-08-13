import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const KEY = 'processor.theme';

/**
 * One theme, shared by every component that asks for it.
 *
 * This is a module-level store rather than per-component state on purpose:
 * useState inside a hook gives each caller its own copy, so the sidebar toggle
 * and the settings panel would drift apart — the app going dark while Settings
 * still insists the preference is "system".
 */
let current: Theme = read();
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    // Private browsing can refuse localStorage entirely.
    return 'system';
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setTheme(next: Theme): void {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Not being able to persist is not a reason to refuse the change.
  }
  apply(next);
  for (const listener of listeners) listener();
}

/** Applied before React mounts, so the first paint is already the right colour. */
export function initTheme(): void {
  apply(current);
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current, () => current);

  // Follow the OS while the preference is "system".
  useEffect(() => {
    if (theme !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      apply('system');
      for (const listener of listeners) listener();
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  const resolved: 'light' | 'dark' =
    theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme;

  return { theme, resolved, setTheme: useCallback(setTheme, []) };
}
