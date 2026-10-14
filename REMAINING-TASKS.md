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

## Known gaps

All closed on branch `claude/project-thread-7zxam3`, each with tests (unit, plus a real-Chrome fixture deck `tests/fixtures/deck-import/mini/Gaps.dc.html`):

- [x] `deck_mark` and `next` now use the rendered slide count, stored in `state.json` as `rendered`
- [x] `::before`/`::after` marks inside loop-GIF regions no longer raise a slide flag
- [x] Outline-only text (`-webkit-text-fill-color: transparent` plus `-webkit-text-stroke`) imports with a centred text stroke; a stroke on only some runs is flagged `approx:text-stroke-mixed`
- [x] 180° rotations (`unsupported:transform-rotate`), mirrors (`unsupported:transform-mirror`) and 3D tilts (`unsupported:transform-3d`) are flagged; text under a turned ancestor is flagged `unsupported:rotated-parent` (vertical text excepted, it folds the turn into its own rotation). An exact 180° turn (`rotate(180deg)`) is now drawn: corner radii swap and SVG/icon children turn 180°. It is no longer flagged. Horizontal text under it is still flagged `unsupported:rotated-parent`. Live check of the slide-5 badge is tracked in issue #7.
- [x] A successful entrance rebuild in `deck_patch` clears an earlier `entrance-failed` flag
- [x] Border, shadow and background on `img`, `svg` and icon elements go on a frame around the content; the content sits inside border and padding (R14)
- [x] SVG files that start with a BOM, XML declaration, comments or `<!DOCTYPE>` are recognized, and Figma gets the `<svg>` element without the prolog
- [x] Text with mixed font sizes on different lines is measured as the sum of per-line line heights; QA checks its height instead of the line count
- [x] QA compares fills (type, solid colour with alpha), stroke presence and weights, corner radii and effects (type, offset, blur, spread) against the dump. A `deck_patch` that deliberately changes a paint away from the IR will now show as a QA issue; mark such a slide by eye.
- [x] JS timer loops slower than 300ms are caught: capture watches one tick of the slowest live `setInterval` or `setTimeout` chain, up to 3s. A deck with such a timer pays that wait on every slide.
- [x] Inline SVG styled by page CSS (classes, `var()`, `currentColor`, `<style>`, `display:none`, `<use>` of a symbol or element) is written out as attributes before import

## Housekeeping

- [x] `tests/component-doc-report-3.test.ts`: 2 failures on Windows from `/` vs `\` path separators. `displayPath` now returns `/`; `tests/display-path-windows.test.ts` runs it under win32 path rules on any OS.
- [ ] CI: `npm test` now runs real-Chrome suites (capture and GIF), so CI needs Chrome and network, or those suites need to be skipped there. Chrome now starts as root (`--no-sandbox` is added when running as uid 0), so a container with Chromium and `DECK_IMPORT_CHROME_PATH` set can run them.
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
