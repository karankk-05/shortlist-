import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'dark' | 'light';
const savedTheme = (value: string | null): Theme => value === 'light' ? 'light' : 'dark';

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => savedTheme(document.documentElement.dataset.theme || null));
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key !== 'shortlist-theme' && event.key !== null) return;
      const next = savedTheme(event.newValue);
      document.documentElement.dataset.theme = next;
      setTheme(next);
    }
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem('shortlist-theme', next); } catch { /* The toggle still works when storage is unavailable. */ }
  }
  return <button className="theme-toggle" type="button" role="switch" aria-label="Dark mode" aria-checked={theme === 'dark'} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={toggle}>
    <span className="theme-track" aria-hidden="true">
      <Sun className="theme-sun" size={13} /><Moon className="theme-moon" size={13} />
      <span className="theme-thumb">{theme === 'dark' ? <Moon size={14} /> : <Sun size={14} />}</span>
    </span>
  </button>;
}
