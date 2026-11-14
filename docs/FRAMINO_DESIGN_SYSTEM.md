# Framino — Design System

> Framino is an AI Video Production Studio. The interface is a **professional dark editorial studio**, not an AI
> SaaS dashboard: precise, restrained, dense with useful information, and built around the picture and the timeline.

This document describes the tokens and rules that actually ship in the code. Every value below exists in
`packages/openfilm/studio/ui/src/globals.css`, and every component reads a token — no component owns a color.

---

## 1. Two families of token

Framino separates **identity** from **the editing room**, on purpose.

| Family | Where it is used | Never used for |
| --- | --- | --- |
| `--brand-*` sage / forest / mint / cream | launcher, project browser, settings, about, empty states, documentation, marketing | large fills inside the editing workspace |
| `--studio-*` grey-black surfaces + one sage accent | the editor: toolbar, panels, monitor, inspector, timeline | decorative gradients, glows |

The editor does not become "a green app". Green appears only where it carries meaning: selection, the active
control, the playhead, the primary action.

---

## 2. Brand identity

```
Name        Framino
Category    AI Video Production Studio
Tagline     Make more. Create freely.
Wordmark    framino   (lowercase, tight tracking, never a decorative graphic)
```

### Wordmark

- Lowercase `framino`, set in the UI sans (Inter). No swoosh, no robot, no wand, no sparkle, no brain.
- The mark is an `f` drawn as a stroke, not a filled bitmap, so it survives on any surface
  (`docs/logo-light.svg`, `docs/logo-dark.svg`, `components/BrandLogo.tsx`).
- The brand is quiet in the toolbar: one wordmark, one 1px rule, no box behind it.

### Typography

| Role | Token | Value |
| --- | --- | --- |
| Latin UI | `--font-sans` | `Inter Variable`, Inter, system stack |
| Chinese UI | `--font-cjk-sans` | PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, Source Han Sans SC |
| Numbers, timecode, revisions | `--font-mono` / `--studio-timecode-font` | ui-monospace, SF Mono, Menlo, Consolas |

No webfont was added: `@fontsource-variable/inter` is already a repository dependency, and CJK falls back to the
system stack as the original project does.

Editor type scale (all small; a production tool is read at a glance):

| Use | Size | Weight | Notes |
| --- | --- | --- | --- |
| Panel title | 11–12 px | 500 | `.framino-pane-title`, uppercase tracking only for Latin |
| Section label | 10 px | 600 | `tracking: 0.11em` Latin, `0.06em` CJK — never `uppercase` in Chinese |
| Body / rows | 11–12 px | 400 | `--studio-text-secondary` |
| Field value | 11–12 px | 400 | `.framino-numeric` (tabular) |
| Toolbar label | 12 px | 500 | Export is the only filled button |

---

## 3. Color tokens

### Surfaces (dark — the editing room)

| Token | Value | Used for |
| --- | --- | --- |
| `--studio-bg` | `#181a19` | the window ground, the seam between panes |
| `--studio-panel` | `#202321` | panel interiors, toolbars |
| `--studio-elevated` | `#282c29` | popovers, menus, dialogs, tooltips |
| `--studio-border` | `#353a36` | 1 px rules between panels and rows |
| `--bg-viewer` | `#141614` | the well around the picture — darkest, still not pure black |

Hairlines carry the structure. Panels are told apart by one step of brightness, not by shadow or radius.

### Text

| Token | Value | Used for |
| --- | --- | --- |
| `--studio-text-primary` | `#e5e8e4` | clip names, values, headings |
| `--studio-text-secondary` | `#a0a7a1` | labels, hints, secondary rows |
| `--studio-text-muted` | `#707a72` | section labels, placeholders, idle icons |

Never `#fff` on `#000`: pure white on pure black is the fastest way to look like a demo.

### Accent and state

| Token | Value | Used for |
| --- | --- | --- |
| `--studio-accent` | `#8ba58e` | active control, focus ring, the Agent button when open |
| `--studio-accent-active` | `#a5bfa6` | playhead, selected clip frame, hover of the accent |
| `--studio-selection` | `#344b39` | selected rows in lists |
| `--state-success` | `#79a98a` | saved indicator, completed job |
| `--state-warning` | `#d2a66f` | unsupported / not connected, pending |
| `--state-error` | `#d47777` | failures, unreadable media |

### Tracks (timeline)

Low saturation, one lightness, white words on top.

| Token | Value | Track |
| --- | --- | --- |
| `--track-video` | `#557d69` | video |
| `--track-audio` | `#9b835c` | audio |
| `--track-text` | `#718ba5` | text, subtitles |
| `--track-image` | `#8b79a2` | images, stickers |
| `--clip-page` | `#6b7c86` | animated web page |

Playhead is `--studio-accent-active`; a selected clip takes the same color as a 1 px frame — the timeline never uses
a second highlight color.

---

## 4. Geometry

| Token | Value | Rule |
| --- | --- | --- |
| `--studio-radius` | `3px` | controls, fields, clip corners |
| `--radius-lg` | `6px` | dialogs and popovers only |
| `--studio-hairline` | `1px solid var(--studio-border)` | every separation |

- No card shadows inside the editor; depth comes from one brightness step plus a hairline.
- No 16 px+ radii in the workspace, no pill buttons, no floating glass panels.
- Spacing is on a 2 px grid; row height 24–28 px, panel headers 40 px, toolbar 32 px (the project's existing
  titlebar height, kept so workspace geometry, desktop window controls and layout presets stay valid).

### Workspace proportions

```
┌──────────────────────────────────────────────────────────────┐
│ toolbar 32px — wordmark · project · save state · undo/redo ·  │
│              Agent · layout · versions · Export              │
├──────────────┬────────────────────────────┬──────────────────┤
│ Media        │                            │ Inspector        │
│ Library      │      Preview Monitor       │ 260–300px        │
│ 220–320px    │   (picture never cropped)  │                  │
├──────────────┴────────────────────────────┴──────────────────┤
│ Timeline — ruler, tracks, clips, zoom; 200px, grows with      │
│ tracks                                                       │
└──────────────────────────────────────────────────────────────┘
```

Widths come from the existing workspace model (`lib/workspaces.ts`), which the user can drag, save as a named
layout, or reset. Framino sets a *first-run* profile (library left at 248 px, inspector 300 px) and then leaves the
layout to the person — it never overrides a saved layout.

---

## 5. Component rules

### Toolbar

- Left: mark + wordmark, project name, save state (a real revision from `film.html`, not a timer).
- Middle: nothing decorative — the workspace is the content.
- Right: undo, redo, Agent, layout, versions, **Export** (the only filled control), mode switch.
- All buttons are 26 px tall, 1 px hairlines, icon-only with tooltips and shortcut hints.

### Media library

- Compact rows and thumbnails; filename, duration, kind.
- The library keeps its original UI and behaviour (`components/library/LibraryDrawer.tsx`): search, tabs, drag to
  timeline. Framino only docks it on the left at first run and gives it a quiet header.

### Preview monitor

- The picture is fitted inside the well: never stretched, never cropped, any aspect ratio.
- Toolbar-free around the picture; timecode is monospaced and secondary, transport controls are monochrome.
- No glow, no gradient, no "AI" ornament.

### Inspector

- Groups are collapsed unless relevant; the empty state explains what to select.
- Numbers are exact inputs; a slider and its field edit the same value.
- A control exists only when the project model has the property. Nothing is faked, nothing is disabled without a
  reason shown.

### Timeline

- Ruler with adaptive ticks; clip labels include name and duration; waveforms where the source has audio.
- Hover is a subtle brightness change; selection is the accent frame; the playhead is the accent line.
- All interaction is the original implementation (drag, trim, reorder, zoom, multi-select, shortcuts) — restyled,
  never reimplemented.

### Agent panel

- A 320 px overlay on the right; it does not reflow the workspace, so it can never break a saved layout.
- Shows the real project state (tracks, clips, revision read from `film.html`), the real event stream (film writes,
  exports, files, canvas, history), and an honest connection state.
- Composing an instruction copies it; it is never presented as executed. When the browser Studio has no chat, the
  panel says so and offers the desktop chat or the CLI.

---

## 6. Motion and interaction

| Event | Duration | Curve |
| --- | --- | --- |
| Hover / pressed | 90–120 ms | ease-out |
| Panel open, popover | 140 ms | ease-out |
| Toast | 160 ms | ease-out |

No springs, no bounces, no parallax. Focus is visible: `outline` on `:focus-visible` with the accent, 1 px, offset 1.

---

## 7. Accessibility

- Text contrast: primary ≥ 12:1, secondary ≥ 6:1, muted ≥ 4.5:1 against `--studio-panel`.
- Every icon-only control has `aria-label`; toggles carry `aria-expanded`.
- The library pane is `inert` when hidden, and its resize separator is keyboard-operable (arrows, shift for larger
  steps, double-click to reset).
- Panel resizing is pointer- and keyboard-driven; no drag is required to reach any function.

---

## 8. Where to change what

| To change | Edit |
| --- | --- |
| Any color, radius, font | `studio/ui/src/globals.css` (tokens only) |
| Wordmark and mark | `studio/ui/src/components/BrandLogo.tsx`, `docs/logo-*.svg`, `index.html` favicon |
| Toolbar composition | `studio/ui/src/components/ProjectView.tsx` (titlebar block) |
| Panel headers | `studio/ui/src/components/dock-pane-bar.ts` |
| Agent panel | `studio/ui/src/components/FraminoAgentPanel.tsx` |
| First-run workspace profile | `studio/ui/src/lib/use-workspaces.ts` |

Legacy tokens (`--bg-*`, `--text-*`, `--accent`, `--clip-*`, `--tl-*`, `--cv-*`) remain and are aliased to the
`--studio-*` values. That is why the original components — and their layout calculations — needed no rewrite.
