export type LibraryView = { query: string; round: string; expanded: Record<string, boolean>; scrollY: number };
const STORAGE_KEY = 'shortlist-library-view-v1';
const emptyView = (): LibraryView => ({ query: '', round: '', expanded: {}, scrollY: 0 });

/** Store browsing preferences only; no student records or credentials. */
export function parseLibraryView(value: string | null): LibraryView {
  try {
    const saved = JSON.parse(value || 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return emptyView();
    const expanded = saved.expanded && typeof saved.expanded === 'object' && !Array.isArray(saved.expanded)
      ? Object.fromEntries(Object.entries(saved.expanded).filter(([key, open]) => key.length <= 2000 && typeof open === 'boolean').slice(-2000)) as Record<string, boolean>
      : {};
    return {
      query: typeof saved.query === 'string' ? saved.query.slice(0, 200) : '',
      round: typeof saved.round === 'string' ? saved.round.slice(0, 200) : '',
      expanded,
      scrollY: typeof saved.scrollY === 'number' && Number.isFinite(saved.scrollY) ? Math.max(0, saved.scrollY) : 0,
    };
  } catch { return emptyView(); }
}

export function readLibraryView(): LibraryView {
  try { return parseLibraryView(sessionStorage.getItem(STORAGE_KEY)); }
  catch { return emptyView(); }
}

export function saveLibraryView(view: LibraryView) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(view)); }
  catch { /* In-page navigation still preserves the view when storage is unavailable. */ }
}

/** Stable identities survive server reordering; filtered browsing has its own expansion state. */
export function libraryFoldKey(filterKey: string, ...path: string[]) {
  return JSON.stringify([filterKey, ...path]);
}
