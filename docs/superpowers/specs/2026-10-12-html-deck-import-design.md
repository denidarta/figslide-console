# HTML Deck → Figma Slides Importer — Design

Date: 2026-10-12
Status: Draft for approval
Home: this repo (`figslide-console`, fork of southleft/figma-console-mcp), as new MCP tools in the local server.

## 1. Intent

The user drafts presentations as Claude design artifacts, exports them as an HTML zip, and today pushes them through Claude's presentation artifact → PPTX → Figma Slides' PPTX importer. The result is poor:

- Text renders wrong (wrapping, size, position).
- Almost every element is wrapped in a frame holding an empty rectangle (PPTX shape boxes).
- Things that were vectors arrive as images.
- Animations (entrances and loops) don't work.

The PPTX hop is lossy and unnecessary. The HTML is the source of truth. This tool imports the HTML zip **directly** into Figma Slides as **native, editable layers**, carries over entrance animations, and uses Claude as a QA loop that checks every slide and fixes it until it passes.

## 2. Goals

1. Import a Claude design artifact HTML zip into the currently open Figma Slides file, one Figma slide per `<section>` of the chosen deck.
2. Visual match with the browser render: text font, weight, size, wrapping and position match. Colors, radii, borders, shadows, images and positions match.
3. Clean layer structure: no empty rectangles, no wrapper frames that draw nothing.
4. Native everything. Text stays text, SVG/icons become vectors, boxes become frames. The only raster images allowed are (a) real bitmap photos/images, whether shipped in the zip or loaded by URL in the HTML, and (b) GIFs of looping animations (see §6.3).
5. One-time entrance animations reproduced natively (see §6.2).
6. Automated QA loop: every slide is checked (scripted structure checks plus Claude's visual comparison), failures are fixed and re-checked up to 3 times, and anything still failing is flagged in a report.

## 3. Non-goals

- PPTX import or export.
- Syncing Figma edits back to HTML, or re-syncing a deck after the HTML changes.
- Auto-layout. Fixed positions are fine as long as grouping is sensible.
- Faithful stagger timing for entrances (deliberately dropped, see §6.2).
- A button or UI inside Figma. The import is started from Claude chat.

## 4. Anti-goals (failure even if it "works")

- **Never rasterize to get a match.** If a CSS effect has no native Figma equivalent (e.g. `backdrop-filter` over content, complex masks or blend stacks), leave it native but imperfect and **flag it**. Never turn it into an image. Text is never rasterized or outlined.
- No empty rectangles or pass-through wrapper frames in the output.
- No slide-count explosion: at most one extra slide per slide with entrances.

## 5. Constraints and verified facts

### 5.1 Source format (from the sample `WhatsApp Call Product Launch.zip`)

- The zip holds several decks as `*.dc.html` (sample: 6, e.g. `WhatsApp Call Deck - Main.dc.html`, 68 slides), plus `support.js`, `deck-stage.js`, `image-slot.js`, `assets/` (png/jpg/webp/gif), and unrelated folders (`screenshots/`, `export/`, `srm/`).
- The deck is `<x-dc>` + `<deck-stage>` (a web component) containing inline-styled `<section>` siblings at 1920×1080. `deck-stage` supports a `noscale` attribute for 1:1 geometry, which the existing PPTX exporter uses for DOM capture.
- Fonts: Geist and Geist Mono (Google Fonts, used in about 450 places). Icons come from the Lucide icon font (`lucide-static@0.460.0`). 89 `<img>` and 22 inline `<svg>`.
- Animation: 122 `@keyframes` with about 200 `infinite` usages. Three kinds:
  1. **Entrances**: one-shot, triggered by `[data-deck-active]` when a slide becomes active (fade/translate/scale, `scaleX` bars, `max-height`/`height` reveals, staggered `animation-delay`).
  2. **Looping storyboards**: long multi-step phone-UI demos using percentage keyframes, `max-height`, and `stroke-dashoffset` line drawing.
  3. **Small loops**: float, pulse, ring.
  Plus a few JS-driven effects (`setTimeout`, `setInterval`, `.animate()`).
- Some `@media (prefers-reduced-motion)` and `@media print` rules set `animation:none !important`.

### 5.2 Figma side (verified by a spike on 2026-10-12 against a real Figma Slides file through the Desktop Bridge plugin)

- `figma.editorType === "slides"`. The deck is `SLIDE_GRID > SLIDE_ROW > SLIDE`.
- **No per-object animation API in Slides.** On nodes inside a slide, `manualKeyframeTracks`, `animationStyles`, `timelines` and `applyManualKeyframeTrack` are all `undefined`, and `figma.motion` is undefined. The Slides "Animate" panel has no plugin-API access.
- **Slide transitions work**: `slide.setSlideTransition({ style: 'SMART_ANIMATE', duration: 0.6, curve: 'EASE_IN_AND_OUT', timing: { type: 'AFTER_DELAY', delay: 0 } })`.
  - `curve` must be one of `EASE_IN | EASE_OUT | EASE_IN_AND_OUT | LINEAR | GENTLE | QUICK | BOUNCY | SLOW`. Custom cubic-bezier is rejected.
  - `duration` must be ≥ 0.01.
- **The Smart Animate entrance trick works.** The user confirmed it in presentation mode. Slide A held elements at opacity 0, shifted +24px. Slide B was a `clone()` of A with the final state and the transition above. It read as an element entrance, not a slide change.
- `figma.createSlide()` threw `Cannot create node with type SLIDE` in an empty deck (with and without `createSlideRow(0)` first). `slide.clone()` works once a slide exists. **The builder must establish a reliable slide-creation path** (e.g. require or seed one slide, then clone), and verify whether `createSlide` works once the deck is non-empty.
- **Animated GIF image fills play in presentation mode** (verified: `figma.createImage(gifBytes)` → `IMAGE` fill, user confirmed playback).
- Geist and Geist Mono are available in Figma in all weights the deck uses.
- The bridge protocol is a WebSocket on ports 9223–9232 with `/health`. The server sends `{id, method:'EXECUTE_CODE', params:{code, timeout}}` and the plugin replies `{id, result}`. Existing tools already use this (`figma_execute`, `figma_capture_screenshot`, the slide tools in `src/core/slides-tools.ts`).

## 6. Decisions

### 6.1 Conversion rules

Layout is **measured from a real browser render**, not re-computed. Load the deck in headless Chrome with `noscale`, activate each slide, let entrances finish (end state), and read computed styles plus `getBoundingClientRect` for every rendered element. Each DOM element gets a stable import ID. The matching Figma node stores the same ID (plugin data) and uses it as its layer name suffix, so QA and fixes can target single nodes, and so Smart Animate can pair layers across copies.

| Source | Figma output |
|---|---|
| Element that draws something (background, border, shadow, radius with clip, or `overflow:hidden` with children) | Frame with fills, strokes (per-side weights where needed), corner radii, effects, clip |
| Element that draws nothing | **Not emitted.** Children are hoisted into the nearest emitted ancestor. Sibling grouping may be kept as a Group when it helps editing (builder's judgment). |
| Text | One text node per text block, fixed width = browser width, auto-height. Inline spans become styled ranges, not separate nodes. Line height in px, `letter-spacing` em→%. Font family and weight exactly as the browser used. |
| `<img>` of a bitmap asset | Rectangle (or the element's frame) with an image fill, `object-fit` mapped to the fill scale mode, bytes taken from the zip |
| `<img>` loaded from the web (e.g. `images.unsplash.com`) | Downloaded at import time and treated exactly like a zip bitmap asset (allowed by lint) *(builder's call: imports need network access; fonts already load from Google Fonts)* |
| `<image-slot>` with no image (placeholder) | Empty frame with the slot's exact shape, size and corner radius, named after its caption (e.g. `Image slot · Photo: agent with headset on a live call`), ready for the user to drop a photo in. The placeholder's look (dashed box, caption text) is **not** reproduced. These frames are exempt from the empty-frame lint rule. If a slot does have an image (sidecar state or `src`), treat it as a bitmap. |
| Inline `<svg>` | `figma.createNodeFromSvg` vector |
| Lucide font icon (`<i class="icon-…">` or similar) | Vector from the matching `lucide-static` SVG, colored and sized as rendered |
| CSS gradient, shadow, radius, opacity, transform rotate/scale | Native equivalents |
| `backdrop-filter: blur` | Native `BACKGROUND_BLUR` effect (approximate). Flag if visually off. |
| Masks, `clip-path`, `mix-blend-mode` stacks, other no-equivalent CSS | Best native approximation, **flagged**. Never rasterized. |
| Speaker notes (`<script type="application/json" id="speaker-notes">`) | `slide.speakerNotes` *(builder's call: cheap and useful)* |

### 6.2 Entrance animations ("lean" mode)

- Detect entrances per slide: animations that run once on slide activation (finite iteration count). The Web Animations API (`element.getAnimations()`, `effect.getKeyframes()`, `getTiming()`) gives start keyframes, delay and duration without parsing CSS.
- For each slide with at least one entrance, emit **two** Figma slides:
  - **Copy A (start state)**: every entering element in its first-keyframe state (opacity, translate x/y, scale). Transition: none / on click.
  - **Copy B (the real slide, final state)**: transition `SMART_ANIMATE`, timing `AFTER_DELAY` 0.
- **All entrances on a slide collapse into one move.** Stagger and per-element delays are dropped, as the user chose. Duration = the longest single entrance duration on the slide, capped at about 1s *(builder's call)*.
- Easing: map the CSS curve to the nearest Figma preset. E.g. `cubic-bezier(.65,0,.35,1)` → `EASE_IN_AND_OUT`, decelerating curves → `EASE_OUT` *(builder's call)*.
- Properties Smart Animate can't tween from nothing (`height`/`max-height`/`padding` reveals such as `stairUp`, `stroke-dashoffset` draws): convert to fade + 16–24px slide-up *(builder's call)*.
- Name copy A clearly (e.g. `<slide name> · enter`) so the user can tell the pair apart.
- The Figma motion keyframe API is not usable in Slides (§5.2). Do not build on it.

### 6.3 Looping animations → GIF

- An element is a "loop" if it (or a descendant) has an `infinite` animation or is driven by JS timers. Take the outermost such element whose box contains the moving parts.
- Record one full cycle in headless Chrome (cycle length = the longest loop duration in that element; for JS-driven loops, a sensible fixed window), cropped to the element's box. Place the GIF as an image fill at the exact position and size. The element's subtree is **not** also emitted as native layers. Static content outside that box stays native.
- *Builder's call:* about 30fps capture, 2× resolution, and a warning in the report when a GIF exceeds about 5MB.
- The QA visual check compares against a frame of the browser render, so loops won't match pixel-exactly. QA checks placement and size of loop GIFs, not frame content.

### 6.4 How a run works (user flow)

1. Figma desktop is open on the target Figma Slides file, with the Desktop Bridge plugin running.
2. The user tells Claude: "import `<zip>` into Figma Slides."
3. If the zip has more than one `*.dc.html`, Claude lists them and asks which deck to import.
4. The importer runs slide by slide (optionally a slide range), appending to the open deck *(builder's call: append at end)*.
5. QA runs per slide (§7). Fixes are applied, up to 3 rounds per slide.
6. Claude reports pass/fail per slide and writes a report file next to the zip *(builder's call: HTML with side-by-side screenshots, failing layer names and reasons)*.

Re-importing a single slide (by slide number) replaces its Figma slide(s) in place. This is needed for the fix loop and for the user to retry.

**Who drives the loop:** the Claude in the chat session (decided in conversation). The MCP server never calls the Anthropic API itself. The server exposes small tools: import a slide or range, run the scripted checks, return the browser and Figma screenshots for a slide, and re-import a slide. The chat agent calls these in a loop and patches with `figma_execute`. *Builder's call:* work in batches (e.g. about 5–10 slides), keep scripted-check output compact so a 68-slide deck fits a session, and record progress (which slides passed) in a small state file next to the zip so a run can resume.

## 7. QA loop

A slide **passes** only when both halves pass.

### 7.1 Structure lint (scripted, deterministic)

Fails on:
- a rectangle or frame with no visible fill/stroke/effect and no children;
- a frame with a single child that adds no fill/stroke/effect/clip;
- an image fill whose source was not a bitmap asset or a loop GIF (e.g. SVG/icon/CSS arrived as an image);
- text converted to an image or vector.

### 7.2 Numeric checks (scripted)

For every node with an import ID, compare the Figma node's box against the browser box. For text, also compare the line count. *Builder's call:* tolerance about 2px on position/size, line count exact. Also compare fills, strokes, radii and shadows against computed CSS.

### 7.3 Visual check (Claude)

Claude compares the browser render of the slide (end state) with a Figma screenshot of copy B. It looks for wrong font, weight, size, wrapping, clipping, missing or shifted elements, and wrong colors. Antialiasing-level differences are ignored. When something is off, Claude names the region, the importer maps it to import IDs, and Claude patches those nodes.

### 7.4 Fix strategies (per failure type)

| Failure | Fix |
|---|---|
| Empty rect / pass-through wrapper | Delete or flatten. No retry round needed. |
| Vector arrived as image | Re-emit that node via `createNodeFromSvg`. |
| Text wraps or sits wrong | 1) ensure the exact font and weight loaded; 2) fixed width plus the browser's line height and letter spacing; 3) last resort: insert the browser's own line breaks. |
| Wrong color/gradient/shadow/radius | Re-apply from computed CSS. |
| Visual mismatch not caught by scripts | Claude patches the mapped nodes via `figma_execute`. |
| Still failing after 3 rounds, or no native equivalent | Leave native, **flag** in the report with both screenshots and the reason. |

Fixes that recur across slides or decks should become converter rules (code changes made during development), so the first pass gets them right next time. The report should make recurring fix types easy to spot (e.g. counts by fix type) *(builder's call)*.

## 8. Acceptance

Using `WhatsApp Call Deck - Main.dc.html` from the sample zip:
- All 68 slides import. Slides with entrances produce exactly one extra start-state copy.
- Zero structure-lint failures in the final output.
- Every slide either passes QA or is flagged with a stated reason. **At most 10% of slides flagged** (≤ 7 of 68).
- No raster images except zip bitmap assets and loop GIFs.
- Entrances play in presentation mode as a single fade/slide-in. Loop regions play as GIFs.

## 9. Left to the builder

- Module layout, tool names and signatures inside the server (e.g. separate tools for import, QA and single-slide re-import, vs one tool with modes).
- Headless browser choice for local mode. The repo has `@cloudflare/puppeteer` for Workers only, so a local `puppeteer`/`playwright` dependency is expected. Also the GIF encoder.
- Getting the end state for capture (e.g. `getAnimations().forEach(a => a.finish())` for finite animations, after setting `data-deck-active`).
- Chunking and transport of image bytes over the bridge (per-slide batches, EXECUTE_CODE timeouts).
- Lucide glyph → SVG lookup mechanism.
- Exact tolerances, easing mapping table, and the report format, within the guidance above.
- Local mode only. Cloud mode support is not required.

## 10. Spike leftovers

The 2026-10-12 spike used a throwaway WebSocket server in a temp scratchpad (not in this repo) and left test content (`spike-box`, `spike-title`, `spike-gif`, two slides, one empty slide row) in an untitled scratch Slides file. Nothing from the spike is kept.
