# HTML Deck → Figma Slides Importer — Remaining Tasks

Updated: 2026-10-13
Repo: `C:\Users\Dolphin\Repo\figslide-console` (main @ `8bc7b02`, PRs #1 and #2 merged)
Spec: `docs/superpowers/specs/2026-10-12-html-deck-import-design.md`
Plan: `docs/superpowers/plans/2026-10-12-html-deck-import.md`
Progress ledger and rulings (R1–R33): `.superpowers/sdd/2026-10-12-html-deck-import/progress.md` (git-ignored)

## Done

- [x] Tasks 1–10 implemented and reviewed (302 deck-import tests passing)
- [x] Final whole-branch review and fix wave (13 items)
- [x] Icon glyphs no longer flagged as pseudo-elements (PR #2)
- [x] `docs/setup.md` Node version check updated to 22.12+ (PR #2)
- [x] Local `main` pulled and built (`dist/local.js`)

## Setup before the live run

- [ ] Register the MCP server for your user (the existing registration is local-scoped to `C:\Users\Dolphin` only, so it doesn't load in other project folders):
  ```bash
  claude mcp add -s user figslide-console -- node C:/Users/Dolphin/Repo/figslide-console/dist/local.js
  ```
- [ ] Restart the Claude session so the `deck_*` tools load
- [ ] In Figma desktop, open a new Figma Slides file and add one blank slide (the importer can't create the first slide in an empty deck; that slide stays as a leftover)
- [ ] Re-import the Desktop Bridge plugin from `figslide-console/figma-desktop-bridge/manifest.json` and run it

## Live acceptance run (Task 11)

- [ ] `deck_list` on `C:\Users\Dolphin\Downloads\WhatsApp Call Product Launch.zip` should show 6 decks, with `WhatsApp Call Deck - Main.dc.html` at 68 slides. Any other count means the slide counter is wrong.
- [ ] Import slides 1–5 and check:
  - [ ] Single-line text keeps its width and doesn't wrap (`WIDTH_AND_HEIGHT` plus 2px slack)
  - [ ] The start copy's `NONE` / `ON_CLICK` transition is accepted (the spike only validated `SMART_ANIMATE`)
  - [ ] Entrances play once in presentation mode
  - [ ] Loop GIFs play, recording time is acceptable, and file size is reasonable
  - [ ] Fonts are Geist, not Inter
  - [ ] `createSlide()` behaviour in a non-empty deck, and slide placement via `setSlideGrid`
  - [ ] `exportAsync` screenshots of SLIDE nodes work
  - [ ] No warning shows up on every slide; if one does, it turns into a flag on all of them and distorts the flagged percentage
- [ ] Import the rest in batches (default `limit` 8; use the `next` value each response returns)
- [ ] For each slide: `deck_slide_view` → `deck_patch` or re-import (at most 3 rounds) → `deck_mark`
- [ ] `deck_report`: target is at most 7 of 68 slides flagged, no raster images except bitmaps and loop GIFs, and exactly one `· enter` copy per animated slide
- [ ] Every bug found: write a failing test first, then fix and commit

## Known gaps (fix when they show up in the live run)

- [ ] `deck_mark` and `next` check slide numbers against the HTML source count, not the rendered DOM count
- [ ] `::before`/`::after` marks inside loop-GIF regions still raise a slide flag, even though the GIF captures them
- [ ] Outline-only text (`-webkit-text-fill-color: transparent` plus `-webkit-text-stroke`) imports invisible and isn't flagged
- [ ] 180° rotations, mirrored elements and 3D rotations aren't flagged; a rotated parent doesn't flag the text under it
- [ ] An `entrance-failed` flag stays after a later successful entrance rebuild
- [ ] Border, shadow and background on `img`, `svg` and icon elements are dropped (R14)
- [ ] SVG files that start with a comment or `<!DOCTYPE>` aren't recognized as SVG
- [ ] Text with mixed font sizes on different lines is measured too tall (max line height × line count), which can flag heading-plus-subtitle blocks
- [ ] QA has no numeric comparison of fills, strokes, radii or shadows; only the visual check covers them
- [ ] JS timer loops slower than 300ms aren't detected as loops
- [ ] Inline SVG styled by external CSS (classes, `var()`, `<use>`) loses that styling; only `currentColor` is handled

## Housekeeping

- [ ] `tests/component-doc-report-3.test.ts`: 2 failures on Windows from `/` vs `\` path separators (predate this feature)
- [ ] CI: `npm test` now runs real-Chrome suites (capture and GIF), so CI needs Chrome and network, or those suites need to be skipped there
- [ ] Update the "121 tools" count in README and docs (6 `deck_*` tools added)
- [ ] Normalize mixed line endings in the working tree (`biome format`)
- [ ] Delete `.superpowers/sdd/2026-10-12-html-deck-import/` after the live run

## Live run status (paused 2026-10-13)

- Setup done; `deck_list` OK: Main = 68 slides. Found 7 decks, not 6; `Collection Case` and `Core Value Badge Options` show 0 slides (check if they are real decks).
- Figma pauses plugin timers and `exportAsync` while its window is hidden or minimized. Screenshots then time out (`CAPTURE_SCREENSHOT timed out`). Keep Figma visible during the run.
- Slides 1–5 imported once (before the fixes below), not yet marked.
- Fixes made, uncommitted, tests written first (full deck-import suite green: 309 tests):
  - `speakerNotes` doesn't exist in the live plugin API, so the setter threw on every slide (`slide-meta: object is not extensible`); notes are now best effort
  - PNGs over 4096px are downscaled before upload (`createImage: Image is too large`; logo, trust-phone-call)
  - `object-fit: fill` is no longer flagged when the box keeps the image's aspect ratio
  - text slack is now max(2px, 1.5% of width) (Figma's Geist runs ~0.7% wider and wrapped the last word)
  - vertical `writing-mode` text (54 "core value" badges) is captured as rotated text: walker, IR `rotation`, ops, runtime rotation, rotated dump bounds, QA slack on y
- Next: `npm run build:local`, commit, reconnect the MCP server (`/mcp`), re-import slides 1–5 with `force`, then view each slide and mark it.
- Open from slide 5: the badge's `rotate(180deg)` radii aren't swapped and its icon isn't turned; 180° rotation is still unflagged.
