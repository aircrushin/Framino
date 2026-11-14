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
import { useLanguage } from '@/i18n';
import { studioHost } from '@/lib/host';
import type { ProjectFilm } from '@/api';

type ActivityKind = 'film' | 'export' | 'files' | 'canvas' | 'history';
type Activity = { id: number; at: number; kind: ActivityKind; text: string };

const EXAMPLES = [
  'Replace the opening shot.',
  'Shorten shot 02 by 2 seconds.',
  'Rewrite the subtitles to sound more natural.',
  'Generate another version of this scene.',
  'Make the transition between shot 03 and shot 04 smoother.',
];

type Words = {
  title: string; project: string; status: string; compose: string; tasks: string; record: string;
  stage: string; tracks: string; clips: string; revision: string; source: string;
  browserHint: string; desktopHint: string; openChat: string; copyInstruction: string; copied: string;
  run: string; runDisabled: string; noTasks: string; noRecord: string; cli: string; copyCli: string;
  examples: string; placeholder: string; close: string; projectName: string;
};

const WORDS: Record<string, Words> = {
  en: {
    title: 'AGENT', project: 'PROJECT CONTEXT', status: 'CONNECTION', compose: 'INSTRUCTION',
    tasks: 'RUNNING TASKS', record: 'CHANGE LOG', stage: 'Stage', tracks: 'Tracks', clips: 'Clips',
    revision: 'Revision', source: 'Project file', browserHint:
      'The browser Studio has no Agent conversation of its own. Use your own coding agent with the CLI below, or the Framino desktop app. Instructions composed here are only copied, never executed.',
    desktopHint: 'The desktop app provides the real Agent chat. Open it to send a turn; this panel only shows the shared project state.',
    openChat: 'Open Agent chat', copyInstruction: 'Copy instruction', copied: 'Copied', run: 'Run',
    runDisabled: 'Not connected in browser Studio', noTasks: 'No running tasks', noRecord: 'No changes yet',
    cli: 'Run this in your coding agent', copyCli: 'Copy command', examples: 'EXAMPLES',
    placeholder: 'Describe the change you want the Agent to make…', close: 'Close Agent panel', projectName: 'Project',
  },
  'zh-CN': {
    title: 'AGENT', project: '当前项目上下文', status: '接入状态', compose: '指令输入',
    tasks: '正在执行的任务', record: '生成与修改记录', stage: '画布', tracks: '轨道', clips: '片段',
    revision: '版本', source: '项目文件', browserHint:
      '浏览器版 Studio 未内置 Agent 对话。请使用你自己的 coding agent 运行下方 CLI 命令，或使用 Framino 桌面端。此处编写的指令只能复制，不会伪装成已执行。',
    desktopHint: '真实 Agent 对话由桌面端提供。请打开对话栏发送指令；本面板只展示同一份项目状态。',
    openChat: '打开 Agent 对话栏', copyInstruction: '复制指令', copied: '已复制', run: '执行',
    runDisabled: '浏览器 Studio 暂未接入', noTasks: '当前没有运行中的任务', noRecord: '暂无变更记录',
    cli: '在你的 coding agent 中运行', copyCli: '复制命令', examples: '示例指令',
    placeholder: '描述你希望 Agent 对项目做的修改…', close: '关闭 Agent 面板', projectName: '项目',
  },
};

const wordsFor = (language: string): Words => WORDS[language] ?? WORDS.en!;

let activitySeq = 0;

export function FraminoAgentPanel({ open, onClose, projectId }: {
  open: boolean;
  onClose: () => void;
  projectId: string;
}) {
  const language = useLanguage();
  const w = wordsFor(language);
  const [film, setFilm] = React.useState<ProjectFilm | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [activity, setActivity] = React.useState<Activity[]>([]);
  const [draft, setDraft] = React.useState('');
  const [copied, setCopied] = React.useState<string | null>(null);

  const push = React.useCallback((kind: ActivityKind, text: string) => {
    setActivity(previous => [{ id: ++activitySeq, at: Date.now(), kind, text }, ...previous].slice(0, 40));
  }, []);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    api.film(projectId)
      .then(next => { if (live) setFilm(next); })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    const stop = projectEvents(projectId, (event) => {
      if (event.type === 'film') push('film', `${w.source} · rev ${event.rev.slice(0, 10)}`);
      else if (event.type === 'export') push('export', `Export ${event.job.status}`);
      else if (event.type === 'files') push('files', `Files · ${event.paths?.length ?? 0}`);
      else if (event.type === 'history') push('history', 'History');
      else if (event.type === 'canvas') push('canvas', 'Canvas');
      else if (event.type === 'film-missing') push('film', `${w.source} · missing`);
    });
    return () => { live = false; stop(); };
  }, [open, projectId, push, w.source]);

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
  const running = activity.filter(row => row.kind === 'export' && /running|waiting/i.test(row.text));
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
      aria-label={w.title}
      className="framino-agent-panel framino-surface fixed right-0 bottom-0 z-[8500] flex w-[320px] max-w-[92vw] flex-col overflow-hidden"
      style={{ top: 32 }}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--studio-border)] px-3">
        <span className="flex items-center gap-2">
          <Terminal size={14} className="text-[var(--studio-accent)]" />
          <span className="framino-pane-title !text-[11px]">{w.title}</span>
        </span>
        <button type="button" aria-label={w.close} onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-[3px] text-[var(--studio-text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {/* real project state, read from film.html on disk */}
        <p className={section}>{w.project}</p>
        <div className="mt-2">
          <div className={fact}><span className="text-[var(--studio-text-muted)]">{w.projectName}</span><span className="framino-numeric truncate text-[var(--text)]">{film?.project.name ?? '—'}</span></div>
          <div className={fact}><span className="text-[var(--studio-text-muted)]">{w.stage}</span><span className="framino-numeric text-[var(--text)]">{stage ? `${stage.w} × ${stage.h}` : '1920 × 1080'}</span></div>
          <div className={fact}><span className="text-[var(--studio-text-muted)]">{w.tracks}</span><span className="framino-numeric text-[var(--text)]">{tracks.length}</span></div>
          <div className={fact}><span className="text-[var(--studio-text-muted)]">{w.clips}</span><span className="framino-numeric text-[var(--text)]">{clipCount}</span></div>
          <div className={fact}><span className="text-[var(--studio-text-muted)]">{w.revision}</span><span className="framino-numeric text-[var(--text)]">{film?.rev.slice(0, 10) ?? '—'}</span></div>
          {error ? <p className="mt-2 text-[11px] text-[var(--state-error)]">{error}</p> : null}
        </div>

        <p className={`${section} mt-5`}>{w.status}</p>
        <div className="mt-2 border border-[var(--studio-border)] bg-[var(--bg-field)] p-2 text-[11px] leading-relaxed text-[var(--studio-text-secondary)]">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: hostAgents ? 'var(--state-success)' : 'var(--state-warning)' }} />
          {hostAgents ? w.desktopHint : w.browserHint}
        </div>
        {hostChat ? (
          <button type="button" className={`${ghost} mt-2`} onClick={() => hostChat.setOpen(true)}>{w.openChat}</button>
        ) : null}

        <p className={`${section} mt-5`}>{w.compose}</p>
        <textarea
          aria-label={w.compose}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder={w.placeholder}
          rows={3}
          className="mt-2 w-full resize-none border border-[var(--studio-border)] bg-[var(--bg-app)] p-2 text-[11px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--studio-text-muted)] focus:border-[var(--studio-accent)]"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" className={ghost} disabled={!draft.trim()} onClick={() => void copy(draft.trim(), 'draft')}>
            {copied === 'draft' ? <Check size={12} /> : <Copy size={12} />}{copied === 'draft' ? w.copied : w.copyInstruction}
          </button>
          <button type="button" className={ghost} disabled title={w.runDisabled}>{w.run}</button>
        </div>
        <p className="mt-1.5 text-[10px] text-[var(--studio-text-muted)]">{w.runDisabled}</p>

        <p className={`${section} mt-5`}>{w.examples}</p>
        <div className="mt-2 flex flex-col gap-1">
          {EXAMPLES.map(example => (
            <button key={example} type="button" onClick={() => setDraft(example)}
              className="truncate border-l-2 border-[var(--studio-border)] px-2 py-1 text-left text-[11px] text-[var(--studio-text-secondary)] transition hover:border-[var(--studio-accent)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
              {example}
            </button>
          ))}
        </div>

        <p className={`${section} mt-5`}>{w.cli}</p>
        <div className="mt-2 flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate border border-[var(--studio-border)] bg-[var(--bg-app)] px-2 py-1.5 font-mono text-[10px] text-[var(--studio-text-secondary)]">{cli}</code>
          <button type="button" className={ghost} onClick={() => void copy(cli, 'cli')}>
            {copied === 'cli' ? <Check size={12} /> : <Copy size={12} />}{copied === 'cli' ? w.copied : w.copyCli}
          </button>
        </div>

        <p className={`${section} mt-5`}>{w.tasks}</p>
        {running.length ? (
          <ul className="mt-2 space-y-1">
            {running.map(row => <li key={row.id} className="framino-numeric text-[11px] text-[var(--state-warning)]">{row.text}</li>)}
          </ul>
        ) : <p className="mt-2 text-[11px] text-[var(--studio-text-muted)]">{w.noTasks}</p>}

        <p className={`${section} mt-5`}>{w.record}</p>
        {activity.length ? (
          <ul className="mt-2 space-y-1">
            {activity.map(row => (
              <li key={row.id} className="flex items-start gap-2 text-[11px] text-[var(--studio-text-secondary)]">
                <span className="framino-numeric shrink-0 text-[var(--studio-text-muted)]">{new Date(row.at).toLocaleTimeString()}</span>
                <span className="min-w-0 break-words">{row.text}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-[11px] text-[var(--studio-text-muted)]">{w.noRecord}</p>}
      </div>
    </aside>
  );
}
