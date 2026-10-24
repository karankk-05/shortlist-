// Runs before the app paints. No preference means dark, including blocked storage.
try {
  document.documentElement.dataset.theme = localStorage.getItem('shortlist-theme') === 'light' ? 'light' : 'dark';
} catch {
  document.documentElement.dataset.theme = 'dark';
}
