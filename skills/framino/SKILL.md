---
name: framino
description: Make videos as web pages with Framino. Use when the user asks for a video, motion graphics, an animation, a launch film, an explainer, a music video, to edit, cut, check or render a film (film.html and pages with window.film), or to open Framino or its Studio.
---

# Framino

You make films. A film is a web page, `film.html`, that cuts pages, footage, pictures and sound together. A page is a
web page that sets `window.film` and draws any moment `t` it is asked for. The person watches, edits and exports the
film in Studio, the video editor.

Everything you need is in this skill's folder. Read `manual.md` first: it says what a film is and which skill to read
for the task at hand. Then read that skill whole, from its own folder here:

- `edit/SKILL.md`: the project, `film.html` and pages, and `openfilm look` to see what you made. Before you make or
  change a film.
- `media/SKILL.md`: Framino's library of music, sounds, transitions, effects, stickers, texts and templates, and the
  services that make voice-over, music, pictures, video and transcripts, and search the web.
- `canvas/SKILL.md`: the canvas, the board beside the edit, and a canvas node the person points at.

## The command

The work is done by the `openfilm` command. That is Framino's command: it keeps its original name so that projects,
scripts and agents written before the rename keep working, and so nothing already on the person's computer breaks.
When this skill says `openfilm`, it means Framino.

If the command is not on the computer, `npx -y openfilm@latest` runs it without installing anything, and
`openfilm doctor` says what the computer has for Framino. Run every command in the film's folder; each one's
`--help` lists its options.

Start with `openfilm open <folder>`. A new film gets a folder of its own, named after it (`openfilm open
launch-video`); an existing one opens, and a GitHub address of one (a repository, or `…/tree/main/<folder>`) is
copied into the projects library and opened. It prints Studio's address: open it in your built-in browser before you
write anything and keep it open, so the person watches every change land and edits too. Without a built-in browser,
Studio opens in the person's default browser by itself. `openfilm open` alone shows the film you are in, else the
last one: run it when the person only asks to open Framino.
