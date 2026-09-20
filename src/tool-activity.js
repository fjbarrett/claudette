// Shared classification for low-signal, read-only exploration. These calls
// remain in provider message history (resumes need exact tool pairing), while
// terminal output, derived transcripts, and persisted traces may summarize
// successful runs of them.
const ROUTINE_EXPLORATION_TOOLS = new Set([
  'read_file',
  'list_dir',
  'glob',
  'search_code',
  'grep', // legacy alias retained in older sessions
]);

export function isRoutineExplorationTool(name) {
  return ROUTINE_EXPLORATION_TOOLS.has(String(name ?? ''));
}

export function explorationStats(names = []) {
  const byTool = {};
  for (const name of names) {
    const key = String(name ?? 'unknown');
    byTool[key] = (byTool[key] ?? 0) + 1;
  }
  return { calls: names.length, byTool };
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function formatExplorationSummary(names = [], verb = 'Explored') {
  const { calls, byTool } = explorationStats(names);
  const reads = byTool.read_file ?? 0;
  const listings = byTool.list_dir ?? 0;
  const scans = byTool.glob ?? 0;
  const searches = (byTool.search_code ?? 0) + (byTool.grep ?? 0);
  const details = [
    reads ? plural(reads, 'read') : null,
    listings ? plural(listings, 'listing') : null,
    scans ? plural(scans, 'file scan') : null,
    searches ? plural(searches, 'search', 'searches') : null,
  ].filter(Boolean);
  return `${verb} ${plural(calls, 'item')}${details.length ? ` — ${details.join(' · ')}` : ''}`;
}
