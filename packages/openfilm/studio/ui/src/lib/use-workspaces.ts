import React from 'react';
import { CURRENT_WORKSPACE_KEY, defaultWorkspace, readWorkspaceLayout, readWorkspaceProfiles, type WorkspaceLayout, type WorkspaceMode } from './workspaces';

/* Framino's professional studio opens with a persistent left Media Library, a monitor in the middle, an Inspector
   on the right and the timeline along the bottom. DEFAULT_WORKSPACE is left untouched: it is asserted by the
   layout tests and is the desktop host's chat-centric profile. This is applied once, only to a browser Studio
   with no saved layout, and the person can still change or reset it from the layout menu. */
const FRAMINO_FIRST_RUN_KEY = 'framino.studio.workspace.default.v1';
function initialProfiles() {
  const store = { getItem: (key: string) => localStorage.getItem(key) };
  const saved = readWorkspaceProfiles(store);
  if (store.getItem(CURRENT_WORKSPACE_KEY) !== null) return saved;
  /* a window that hosts a chat column keeps its own native panel arrangement */
  if ((globalThis as { openfilmHost?: { panel?: unknown } }).openfilmHost?.panel) return saved;
  try {
    if (localStorage.getItem(FRAMINO_FIRST_RUN_KEY)) return saved;
    localStorage.setItem(FRAMINO_FIRST_RUN_KEY, '1');
  } catch { return saved; }
  const edit = readWorkspaceLayout({ ...saved.edit, assets: true, layers: false, chat: false, libraryDock: 'left', assetsWidth: 248, inspectorWidth: 300 });
  return edit ? { ...saved, edit } : saved;
}

export function useWorkspaceLayouts(mode: WorkspaceMode) {
  const [profiles, setProfiles] = React.useState(initialProfiles);
  const modeRef = React.useRef(mode); modeRef.current = mode;
  const latest = React.useRef(profiles); latest.current = profiles;
  const [storageFailed, setStorageFailed] = React.useState(false);
  React.useEffect(() => {
    const save = () => { try { localStorage.setItem(CURRENT_WORKSPACE_KEY, JSON.stringify({ version: 2, ...profiles })); setStorageFailed(false); } catch { setStorageFailed(true); } };
    const timer = window.setTimeout(save, 100);
    return () => window.clearTimeout(timer);
  }, [profiles]);
  React.useEffect(() => {
    const flush = () => { try { localStorage.setItem(CURRENT_WORKSPACE_KEY, JSON.stringify({ version: 2, ...latest.current })); } catch { /* The mounted effect reports storage failures. */ } };
    const changed = (event: StorageEvent) => {
      if (event.key !== CURRENT_WORKSPACE_KEY) return;
      const next = readWorkspaceProfiles({ getItem: key => localStorage.getItem(key) });
      setProfiles(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('storage', changed);
    return () => { window.removeEventListener('pagehide', flush); window.removeEventListener('storage', changed); flush(); };
  }, []);
  const update = React.useCallback((patch: Partial<WorkspaceLayout>) => {
    setProfiles(previous => {
      const target = patch.mode ?? modeRef.current;
      const next = readWorkspaceLayout({ ...previous[target], ...patch, mode: target });
      if (!next || JSON.stringify(next) === JSON.stringify(previous[target])) return previous;
      return { ...previous, [target]: next };
    });
  }, []);
  const reset = React.useCallback(() => update(defaultWorkspace(modeRef.current)), [update]);
  const [viewport, setViewport] = React.useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  React.useEffect(() => { let frame = 0; const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setViewport({ width: window.innerWidth, height: window.innerHeight })); }; window.addEventListener('resize', resize); return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize); }; }, []);
  return { layout: profiles[mode], profiles, update, reset, viewport, storageFailed };
}

/** Layout editing is a transaction. Pointer previews never write preferences until Done. */
export function useWorkspaceDraft() {
  type Edit = { value: WorkspaceLayout; past: WorkspaceLayout[]; future: WorkspaceLayout[] };
  const [edit,setEdit] = React.useState<Edit|null>(null);
  const active = React.useRef(false); active.current = edit !== null;
  const begin = React.useCallback((value: WorkspaceLayout) => setEdit({value:structuredClone(value),past:[],future:[]}),[]);
  const update = React.useCallback((patch: Partial<WorkspaceLayout>) => setEdit(previous => {
    if (!previous) return previous;
    const value = readWorkspaceLayout({...previous.value,...patch,mode:previous.value.mode});
    return value && JSON.stringify(value)!==JSON.stringify(previous.value) ? {...previous,value} : previous;
  }),[]);
  const checkpoint = React.useCallback(() => setEdit(previous => !previous || JSON.stringify(previous.past.at(-1))===JSON.stringify(previous.value) ? previous : {...previous,past:[...previous.past,previous.value].slice(-40),future:[]}),[]);
  const change = React.useCallback((value: WorkspaceLayout) => setEdit(previous => !previous || JSON.stringify(value)===JSON.stringify(previous.value) ? previous : {value,past:[...previous.past,previous.value].slice(-40),future:[]}),[]);
  const undo = React.useCallback(() => setEdit(previous => !previous?.past.length ? previous : {value:previous.past.at(-1)!,past:previous.past.slice(0,-1),future:[previous.value,...previous.future]}),[]);
  const redo = React.useCallback(() => setEdit(previous => !previous?.future.length ? previous : {value:previous.future[0],past:[...previous.past,previous.value],future:previous.future.slice(1)}),[]);
  const close = React.useCallback(() => {active.current=false;setEdit(null);},[]);
  return { draft:edit?.value ?? null, active, begin, update, checkpoint, change, undo, redo, close, canUndo:!!edit?.past.length, canRedo:!!edit?.future.length };
}
