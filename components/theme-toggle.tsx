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
  return <button className="secondary theme-toggle" type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={toggle}>
    {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}<span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
  </button>;
}
