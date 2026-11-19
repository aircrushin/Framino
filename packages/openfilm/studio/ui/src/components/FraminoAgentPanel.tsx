/**
 * Framino's Agent side panel (phase one).
 *
 * It is deliberately honest about what exists: the browser Studio has no conversation of its own — the real chat
 * lives in the desktop app (apps/desktop/chat), and Agent edits arrive as writes to the same film.html through the
 * CLI/Skills. So this panel never invents a turn, a reply or a "generated" result. It shows:
 *
 *   · the current project's real state, read from GET /api/projects/:id (film.html on disk);
 *   · real project events from the WebSocket (film revisions, files, exports, canvas, history);
 *   · a compose box whose only action is to copy an instruction to the clipboard, plus the real CLI to run it;
 *   · a clearly disabled "run" control with the reason, or a button that opens the desktop host's real chat.
 *
 * Nothing here writes a second copy of the project. Agent and Studio keep sharing film.html.
 */
import * as React from 'react';
import { Copy, Check, Terminal, X } from 'lucide-react';
import { api, projectEvents } from '@/api';
import { useLanguage, useT } from '@/i18n';
import { studioHost } from '@/lib/host';
import type { ExportJobStatus } from '@/lib/export-jobs';
import type { ProjectFilm } from '@/api';

type ActivityKind = 'film' | 'export' | 'files' | 'canvas' | 'history';
/** `status`: an export's state, which the running list reads (its words are translated, so it cannot be read from `text`) */
type Activity = { id: number; at: number; kind: ActivityKind; text: string; status?: ExportJobStatus };

/** The sample instructions offered under EXAMPLES: each fills the compose box, so each is in the person's language. */
const EXAMPLES = [
  'agentPanel.example1',
  'agentPanel.example2',
  'agentPanel.example3',
  'agentPanel.example4',
  'agentPanel.example5',
];

let activitySeq = 0;

export function FraminoAgentPanel({ open, onClose, projectId }: {
  open: boolean;
  onClose: () => void;
  projectId: string;
}) {
  const language = useLanguage();
  const t = useT();
  const [film, setFilm] = React.useState<ProjectFilm | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [activity, setActivity] = React.useState<Activity[]>([]);
  const [draft, setDraft] = React.useState('');
  const [copied, setCopied] = React.useState<string | null>(null);

  const push = React.useCallback((kind: ActivityKind, text: string, status?: ExportJobStatus) => {
    setActivity(previous => [{ id: ++activitySeq, at: Date.now(), kind, text, status }, ...previous].slice(0, 40));
  }, []);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    api.film(projectId)
      .then(next => { if (live) setFilm(next); })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    const stop = projectEvents(projectId, (event) => {
      if (event.type === 'film') push('film', `${t('agentPanel.source')} · rev ${event.rev.slice(0, 10)}`);
      else if (event.type === 'export') push('export', t('agentPanel.log.export').replace('{status}', t(`agentPanel.job.${event.job.status}`)), event.job.status);
      else if (event.type === 'files') push('files', t('agentPanel.log.files').replace('{n}', String(event.paths?.length ?? 0)));
      else if (event.type === 'history') push('history', t('agentPanel.log.history'));
      else if (event.type === 'canvas') push('canvas', t('agentPanel.log.canvas'));
      else if (event.type === 'film-missing') push('film', `${t('agentPanel.source')} · ${t('agentPanel.log.missing')}`);
    });
    return () => { live = false; stop(); };
  }, [open, projectId, push, t]);

  const copy = React.useCallback(async (text: string, key: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1600);
    } catch { /* clipboard is unavailable in an insecure context; nothing was executed */ }
  }, []);

  const hostAgents = Boolean(studioHost?.agents);
  const hostChat = studioHost?.panel ?? null;
  const tracks = film?.value?.tracks ?? [];
  const clipCount = tracks.reduce((count, track) => count + track.clips.length, 0);
  const stage = film?.value?.stage;
  const running = activity.filter(row => row.kind === 'export' && (row.status === 'running' || row.status === 'waiting'));
  const cli = film ? `openfilm open "${film.project.path}"` : 'openfilm';

  if (!open) return null;

  /* letterspaced small caps read as a label in Latin scripts; in CJK they only add air between glyphs */
  const latin = !/^(zh|ja|ko)/.test(language);
  const section = `text-[10px] font-semibold ${latin ? 'uppercase tracking-[0.11em]' : 'tracking-[0.06em]'} text-[var(--studio-text-muted)]`;
  const fact = 'flex items-center justify-between gap-2 border-b border-[var(--border)] py-1.5 text-[11px]';
  const ghost = 'flex h-6 items-center gap-1.5 rounded-[3px] border border-[var(--studio-border)] px-2 text-[11px] text-[var(--studio-text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40';

  return (
    <aside
      role="complementary"
      aria-label={t('agentPanel.title')}
      className="framino-agent-panel framino-surface fixed right-0 bottom-0 z-[8500] flex w-[320px] max-w-[92vw] flex-col overflow-hidden"
      style={{ top: 32 }}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--studio-border)] px-3">
        <span className="flex items-center gap-2">
          <Terminal size={14} className="text-[var(--studio-accent)]" />
          <span className="framino-pane-title !text-[11px]">{t('agentPanel.title')}</span>
        </span>
        <button type="button" aria-label={t('agentPanel.close')} onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-[3px] text-[var(--studio-text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {/* real project state, read from film.html on disk */}
        <p className={section}>{t('agentPanel.project')}</p>
        <div className="mt-2">
          <div className={fact}><span className="text-[var(--studio-text-muted)]">{t('agentPanel.projectName')}</span><span className="framino-numeric truncate text-[var(--text)]">{film?.project.name ?? '—'}</span></div>
          <div className={fact}><span className="text-[var(--studio-text-muted)]">{t('agentPanel.stage')}</span><span className="framino-numeric text-[var(--text)]">{stage ? `${stage.w} × ${stage.h}` : '1920 × 1080'}</span></div>
          <div className={fact}><span className="text-[var(--studio-text-muted)]">{t('agentPanel.tracks')}</span><span className="framino-numeric text-[var(--text)]">{tracks.length}</span></div>
          <div className={fact}><span className="text-[var(--studio-text-muted)]">{t('agentPanel.clips')}</span><span className="framino-numeric text-[var(--text)]">{clipCount}</span></div>
          <div className={fact}><span className="text-[var(--studio-text-muted)]">{t('agentPanel.revision')}</span><span className="framino-numeric text-[var(--text)]">{film?.rev.slice(0, 10) ?? '—'}</span></div>
          {error ? <p className="mt-2 text-[11px] text-[var(--state-error)]">{error}</p> : null}
        </div>

        <p className={`${section} mt-5`}>{t('agentPanel.connection')}</p>
        <div className="mt-2 border border-[var(--studio-border)] bg-[var(--bg-field)] p-2 text-[11px] leading-relaxed text-[var(--studio-text-secondary)]">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: hostAgents ? 'var(--state-success)' : 'var(--state-warning)' }} />
          {hostAgents ? t('agentPanel.desktopHint') : t('agentPanel.browserHint')}
        </div>
        {hostChat ? (
          <button type="button" className={`${ghost} mt-2`} onClick={() => hostChat.setOpen(true)}>{t('agentPanel.openChat')}</button>
        ) : null}

        <p className={`${section} mt-5`}>{t('agentPanel.compose')}</p>
        <textarea
          aria-label={t('agentPanel.compose')}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder={t('agentPanel.placeholder')}
          rows={3}
          className="mt-2 w-full resize-none border border-[var(--studio-border)] bg-[var(--bg-app)] p-2 text-[11px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--studio-text-muted)] focus:border-[var(--studio-accent)]"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" className={ghost} disabled={!draft.trim()} onClick={() => void copy(draft.trim(), 'draft')}>
            {copied === 'draft' ? <Check size={12} /> : <Copy size={12} />}{copied === 'draft' ? t('agentPanel.copied') : t('agentPanel.copyInstruction')}
          </button>
          <button type="button" className={ghost} disabled title={t('agentPanel.runDisabled')}>{t('agentPanel.run')}</button>
        </div>
        <p className="mt-1.5 text-[10px] text-[var(--studio-text-muted)]">{t('agentPanel.runDisabled')}</p>

        <p className={`${section} mt-5`}>{t('agentPanel.examples')}</p>
        <div className="mt-2 flex flex-col gap-1">
          {EXAMPLES.map(sample => (
            <button key={sample} type="button" onClick={() => setDraft(t(sample))}
              className="truncate border-l-2 border-[var(--studio-border)] px-2 py-1 text-left text-[11px] text-[var(--studio-text-secondary)] transition hover:border-[var(--studio-accent)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
              {t(sample)}
            </button>
          ))}
        </div>

        <p className={`${section} mt-5`}>{t('agentPanel.cli')}</p>
        <div className="mt-2 flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate border border-[var(--studio-border)] bg-[var(--bg-app)] px-2 py-1.5 font-mono text-[10px] text-[var(--studio-text-secondary)]">{cli}</code>
          <button type="button" className={ghost} onClick={() => void copy(cli, 'cli')}>
            {copied === 'cli' ? <Check size={12} /> : <Copy size={12} />}{copied === 'cli' ? t('agentPanel.copied') : t('agentPanel.copyCli')}
          </button>
        </div>

        <p className={`${section} mt-5`}>{t('agentPanel.tasks')}</p>
        {running.length ? (
          <ul className="mt-2 space-y-1">
            {running.map(row => <li key={row.id} className="framino-numeric text-[11px] text-[var(--state-warning)]">{row.text}</li>)}
          </ul>
        ) : <p className="mt-2 text-[11px] text-[var(--studio-text-muted)]">{t('agentPanel.noTasks')}</p>}

        <p className={`${section} mt-5`}>{t('agentPanel.record')}</p>
        {activity.length ? (
          <ul className="mt-2 space-y-1">
            {activity.map(row => (
              <li key={row.id} className="flex items-start gap-2 text-[11px] text-[var(--studio-text-secondary)]">
                <span className="framino-numeric shrink-0 text-[var(--studio-text-muted)]">{new Date(row.at).toLocaleTimeString()}</span>
                <span className="min-w-0 break-words">{row.text}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-[11px] text-[var(--studio-text-muted)]">{t('agentPanel.noRecord')}</p>}
      </div>
    </aside>
  );
}
