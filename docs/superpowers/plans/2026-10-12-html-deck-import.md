# HTML Deck → Figma Slides Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New local-mode MCP tools that import a Claude design artifact HTML zip into the open Figma Slides file as native layers, with entrance animations (Smart Animate pairs), loop GIFs, and a QA/fix loop driven by the chat agent.

**Architecture:** Node side: unzip → headless Chrome (puppeteer) renders each slide at 1:1, a page-side walker snapshots every rendered element (boxes + computed style + animations) → pure normalizer builds a slide IR → pure op builder turns IR into a flat list of ops → a fixed plugin-side runtime (sent via `executeCodeViaUI`) applies the ops in Figma. QA dumps the Figma slide back, lints it and compares it numerically to the IR; screenshots of both sides go back to the chat agent.

**Tech Stack:** TypeScript (ES2022 modules), `@modelcontextprotocol/sdk`, `zod`, jest + ts-jest. New deps: `puppeteer` (local Chrome), `fflate` (unzip), `gifenc` (GIF encode), `lucide-static@0.460.0` (icon SVGs), `pngjs` (decode screenshots for GIF frames).

**Spec:** `docs/superpowers/specs/2026-10-12-html-deck-import-design.md` — read it first. Section refs below (§) point there.

## Global Constraints

- Local mode only (`src/local.ts`). Do not register in cloud mode (`src/index.ts`).
- Never rasterize anything except bitmap `<img>` (zip or URL) and loop GIFs. Text is never rasterized or outlined. Unmatched CSS → native approximation + flag (§4).
- Slide size 1920×1080. Render with `<deck-stage noscale>` and `prefers-reduced-motion: no-preference` emulated.
- Slide transition curve must be one of `EASE_IN | EASE_OUT | EASE_IN_AND_OUT | LINEAR | GENTLE | QUICK | BOUNCY | SLOW`; `duration >= 0.01`.
- Entrance: one start-state copy per slide with entrances; all entrances collapse into one Smart Animate; duration = longest entrance, capped at 1.0s.
- Copy A name: `<slide name> · enter`. Every emitted Figma node's name ends with ` #<importId>`; pluginData key `importId` holds the same id.
- QA: up to 3 fix rounds per slide; tolerance 2px position/size; text line count exact; acceptance ≤ 10% flagged slides.
- Image slots without an image → empty frame named `Image slot · <placeholder>`, exempt from empty-frame lint.
- Loop GIF: 30fps, 2× scale, warn in report when > 5MB.
- Working dir per zip: `<zipDir>/<zipBaseName>.import/` holding `src/` (extracted), `shots/`, `state.json`, `report.html`.
- Imports need network (web `<img>` + Google Fonts).
- Follow the existing tool style in `src/core/slides-tools.ts` (try/catch, JSON text content, `isError` + `hint`).

## Review Focus

- A CSS font weight Figma doesn't have (e.g. 650) or a fallback family → nearest available weight of the same family, and a flag; never a silent Inter. Test: Task 2 `mapFontWeight`.
- A big image or GIF (several MB) → upload in chunks under the bridge timeout, not one giant `EXECUTE_CODE`. Test: Task 7 `chunkBase64`.
- Bridge disconnects mid-run → re-running `deck_import` skips slides already `passed` in `state.json` and continues. Test: Task 9 resume.
- Text with emoji, `&nbsp;`, `<br>`, and mixed inline styles → characters preserved exactly, ranges styled. Test: Task 4.
- Hidden or off-slide elements (`display:none`, `visibility:hidden`, zero size, entirely outside 0..1920×0..1080) → not emitted. Test: Task 4.

---

## File Structure

All new code lives in `src/core/deck-import/`:

| File | Responsibility |
|---|---|
| `types.ts` | Shared types: `RawNode`, `RawAnim`, `NodeIR`, `SlideIR`, `EntranceIR`, `Op`, `FigmaDumpNode`, `QaResult`, `ImportState` |
| `css.ts` | Pure CSS → Figma value conversion (colors, gradients, shadows, radii, letter spacing, font weight, easing) |
| `zip.ts` | Extract zip into the working dir, list decks |
| `capture.ts` | Puppeteer session: open deck, go to slide, finish entrances, run walker, screenshot |
| `walker.page.ts` | Function executed in the page (serialized via `page.evaluate`) producing `RawNode[]` + `RawAnim[]` |
| `normalize.ts` | Pure `RawNode[]` → `NodeIR` tree (drop non-drawing wrappers, hoist, classify) |
| `entrance.ts` | Pure `RawAnim[]` → `EntranceIR` |
| `assets.ts` | Image bytes from zip path / URL / data URI; Lucide class → SVG string |
| `gif.ts` | Record a loop region to GIF bytes |
| `ops.ts` | Pure `SlideIR` → `Op[]` |
| `runtime.plugin.js` | Plugin-side runtime that applies `Op[]` and dumps slides (plain JS string, runs in Figma) |
| `figma.ts` | Node-side wrapper: upload images, run ops, dump, screenshot via the connector |
| `qa.ts` | Pure lint + numeric compare over a `FigmaDumpNode` tree vs `SlideIR` |
| `state.ts` | `state.json` read/write + `report.html` writer |
| `tools.ts` | `registerDeckImportTools(server, getDesktopConnector)` |

Tests: `tests/deck-import/*.test.ts`. Fixture: `tests/fixtures/deck-import/mini/` (a 3-slide deck, see Task 3).

---

### Task 1: Dependencies, types, and zip/deck listing

**Files:**
- Modify: `package.json` (add `puppeteer`, `fflate`, `gifenc`, `lucide-static@0.460.0`, `pngjs`, `@types/pngjs` dev)
- Create: `src/core/deck-import/types.ts`, `src/core/deck-import/zip.ts`
- Test: `tests/deck-import/zip.test.ts`

**Interfaces:**
- Produces (`types.ts`, used by every later task):

```ts
export type Box = { x: number; y: number; w: number; h: number };

export interface RawNode {            // one rendered element, from the page walker
  id: string;                          // importId, e.g. "s3-n42"; stable per (slideIndex, DOM order)
  parentId: string | null;
  tag: string;                         // lowercased; "#text-block" for text blocks
  box: Box;                            // slide-relative, unscaled
  style: Record<string, string>;       // computed style subset (see Task 3)
  text?: { runs: TextRun[]; lineCount: number };
  svg?: string;                        // outerHTML for inline <svg>
  img?: { src: string; naturalW: number; naturalH: number; objectFit: string };
  iconClass?: string;                  // e.g. "icon-phone" for Lucide font icons
  slot?: { placeholder: string; shape: string; src?: string };
  loop?: boolean;                      // has infinite/JS-driven animation in subtree root
  hidden?: boolean;
}
export interface TextRun { chars: string; fontFamily: string; fontWeight: number; fontStyle: string; fontSize: number; color: string; letterSpacing: string; lineHeight: string; textDecoration: string }
export interface RawAnim { nodeId: string; name: string; iterations: number; delayMs: number; durationMs: number; easing: string; firstKeyframe: Record<string, string> }

export type NodeIR =
  | { kind: 'frame'; id: string; box: Box; fills: Paint[]; strokes: StrokeIR | null; radii: [number, number, number, number]; effects: Effect[]; clip: boolean; opacity: number; children: NodeIR[]; flags: string[] }
  | { kind: 'text'; id: string; box: Box; runs: TextRun[]; lineCount: number; align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'; opacity: number; flags: string[] }
  | { kind: 'image'; id: string; box: Box; src: string; scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE'; radii: [number, number, number, number]; opacity: number; flags: string[] }
  | { kind: 'vector'; id: string; box: Box; svg: string; opacity: number; flags: string[] }
  | { kind: 'slot'; id: string; box: Box; name: string; radii: [number, number, number, number]; flags: string[] }
  | { kind: 'gif'; id: string; box: Box; gifKey: string; flags: string[] };
export interface StrokeIR { color: RGBA; weights: [number, number, number, number]; dashed: boolean }  // top,right,bottom,left
export type RGBA = { r: number; g: number; b: number; a: number };      // 0..1
export type Paint = { type: 'SOLID'; color: RGBA } | { type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'; stops: { pos: number; color: RGBA }[]; angleDeg: number };
export type Effect = { type: 'DROP_SHADOW' | 'INNER_SHADOW'; color: RGBA; x: number; y: number; blur: number; spread: number } | { type: 'BACKGROUND_BLUR' | 'LAYER_BLUR'; radius: number };

export interface EntranceIR { durationS: number; curve: Curve; start: Record<string, { opacity?: number; dx?: number; dy?: number; scale?: number }> }
export type Curve = 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_AND_OUT' | 'LINEAR' | 'GENTLE' | 'QUICK' | 'BOUNCY' | 'SLOW';
export interface FigmaDumpNode { id: string; importId: string | null; type: string; name: string; box: Box; visible: boolean; fills: { type: string; hasImage: boolean }[]; strokes: number; effects: number; clips: boolean; text?: { chars: string; lineCount: number; fonts: string[] }; children: FigmaDumpNode[] }
export interface SlideIR { index: number; name: string; background: Paint[]; skipped: boolean; notes: string; root: NodeIR[]; entrance: EntranceIR | null; flags: string[] }
```

- Produces (`zip.ts`):
  - `workDirFor(zipPath: string): string` → `<zipDir>/<zipBaseName>.import`
  - `extractZip(zipPath: string): Promise<string>` → returns `<workDir>/src`; idempotent (skips if already extracted and zip mtime unchanged)
  - `listDecks(srcDir: string): Promise<{ file: string; slideCount: number }[]>` → every `*.dc.html` at the zip root; `slideCount` = number of top-level `<section` children of `<deck-stage` or `<x-import component-from-global-scope="deck-stage"` (regex count is fine)

- [ ] **Step 1: Install deps**

Run: `npm i puppeteer fflate gifenc lucide-static@0.460.0 pngjs && npm i -D @types/pngjs`
Expected: installs; `npx puppeteer browsers installed` lists a Chrome.

- [ ] **Step 2: Write failing tests** in `tests/deck-import/zip.test.ts` (build a zip in-test with `fflate.zipSync` into `os.tmpdir()`):
  - `workDirFor("C:/a/My Deck.zip")` ends with `My Deck.import`.
  - `extractZip` writes `src/A.dc.html` and `src/assets/x.png`; a second call does not rewrite (mtime of the extracted file is unchanged).
  - `listDecks` returns `[{file:'A.dc.html', slideCount:2}, {file:'B.dc.html', slideCount:1}]` sorted by file, and ignores `sub/C.dc.html`.

- [ ] **Step 3: Run** `npx jest tests/deck-import/zip.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 4: Implement** `types.ts` and `zip.ts` (use `fflate.unzipSync`; reject entries with `..` or absolute paths).
- [ ] **Step 5: Run** the same command — Expected: PASS. Also `npm run type-check` passes.
- [ ] **Step 6: Commit** `feat(deck-import): types, zip extraction, deck listing`

---

### Task 2: CSS → Figma value conversion

**Files:**
- Create: `src/core/deck-import/css.ts`
- Test: `tests/deck-import/css.test.ts`

**Interfaces:**
- Produces:
  - `parseColor(css: string): RGBA | null` (rgb/rgba/hex/`transparent`)
  - `parseBackground(bgColor: string, bgImage: string): Paint[]` (solid + `linear-gradient`/`radial-gradient`; `url(...)` ignored here)
  - `parseShadows(boxShadow: string): Effect[]`
  - `parseRadii(style: Record<string,string>, box: Box): [number,number,number,number]` (`%` resolves against box; clamp to min(w,h)/2)
  - `letterSpacingPercent(letterSpacing: string, fontSizePx: number): number` (`normal`→0; px → px/fontSize*100; em → em*100)
  - `mapFontWeight(family: string, weight: number, available: string[]): { style: string; exact: boolean }` — `available` is Figma style names like `"SemiBold"`; maps 100..900 to Thin, ExtraLight, Light, Regular, Medium, SemiBold, Bold, ExtraBold, Black; non-exact → nearest; adds `Italic` suffix when requested by caller-provided style
  - `mapEasing(css: string): Curve`

- [ ] **Step 1: Write failing tests:**

```ts
expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
expect(parseColor('transparent')).toBeNull();
expect(parseBackground('rgba(0, 0, 0, 0)', 'linear-gradient(90deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)'))
  .toEqual([{ type: 'GRADIENT_LINEAR', angleDeg: 90, stops: [{ pos: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { pos: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] }]);
expect(parseShadows('rgba(0, 0, 0, 0.1) 0px 8px 24px 0px, rgba(0, 0, 0, 0.2) 0px 1px 2px 0px inset')).toHaveLength(2);
expect(parseShadows('rgba(0, 0, 0, 0.2) 0px 1px 2px 0px inset')[0].type).toBe('INNER_SHADOW');
expect(letterSpacingPercent('-0.96px', 48)).toBeCloseTo(-2);
expect(mapFontWeight('Geist', 650, ['Regular','Medium','SemiBold','Bold'])).toEqual({ style: 'SemiBold', exact: false });
expect(mapFontWeight('Geist', 500, ['Regular','Medium'])).toEqual({ style: 'Medium', exact: true });
expect(mapEasing('cubic-bezier(0.65, 0, 0.35, 1)')).toBe('EASE_IN_AND_OUT');
expect(mapEasing('cubic-bezier(0.2, 0.7, 0.2, 1)')).toBe('EASE_OUT');
expect(mapEasing('linear')).toBe('LINEAR');
expect(mapEasing('ease-in')).toBe('EASE_IN');
```

- [ ] **Step 2: Run** `npx jest tests/deck-import/css.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `mapEasing` rule: parse to (x1,y1,x2,y2) (keywords → their standard beziers); `linear` or x1≈y1 and x2≈y2 → `LINEAR`; y1 small and y2≈1 with x1 ≥ 0.4 → `EASE_IN_AND_OUT`; x1 < 0.4 and y1 > 0.3 → `EASE_OUT`; x2 > 0.6 and y2 < 0.7 → `EASE_IN`; else `EASE_IN_AND_OUT`. Gradient angle: CSS `deg`, `to right`=90, default 180.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(deck-import): CSS to Figma value conversion`

---

### Task 3: Page capture (puppeteer + in-page walker)

**Files:**
- Create: `src/core/deck-import/capture.ts`, `src/core/deck-import/walker.page.ts`
- Create fixture: `tests/fixtures/deck-import/mini/` — copy `support.js`, `deck-stage.js`, `image-slot.js` from the sample zip (`C:\Users\Dolphin\Downloads\WhatsApp Call Product Launch.zip`), plus `assets/dot.png` (any small png) and `Mini.dc.html` following the `<x-dc><helmet>…</helmet><x-import component-from-global-scope="deck-stage" from="./deck-stage.js" width="1920" height="1080">` pattern of `WhatsApp Call Deck - Main.dc.html`, with 3 sections:
  1. A card div (white bg, radius 24px, box-shadow) wrapping a no-style div wrapping an `<h1>` in Geist 600 72px with a `<b>` span; card has `data-np` entrance `npCard .6s cubic-bezier(.65,0,.35,1) 1s both` gated on `[data-deck-active]`.
  2. `<img src="assets/dot.png">`, an inline `<svg>` circle, a Lucide `<i class="icon-phone">`, an `<image-slot placeholder="Photo: test" shape="rect">`, a `display:none` div, and a div at `left:2400px`.
  3. A div with `animation: mdFloat 2s infinite` containing text, next to static text.
- Test: `tests/deck-import/capture.test.ts` (uses real Chrome; ~20s)

**Interfaces:**
- Consumes: `RawNode`, `RawAnim` (Task 1).
- Produces:
  - `class DeckSession { static open(srcDir: string, deckFile: string): Promise<DeckSession>; slideCount(): number; slideMeta(i: number): Promise<{ name: string; skipped: boolean; notes: string }>; capture(i: number): Promise<{ nodes: RawNode[]; anims: RawAnim[] }>; screenshot(i: number, outPath: string): Promise<void>; page: Page; close(): Promise<void> }`
  - `walkSlide(slideIndex: number): { nodes: RawNode[]; anims: RawAnim[] }` in `walker.page.ts` — self-contained (no imports), passed to `page.evaluate`.

Capture algorithm (in `capture(i)`): `deckStage.goTo(i)` → wait 2 animation frames → collect `document.getAnimations()` for elements inside the active section into `RawAnim` (before finishing; `firstKeyframe` = `effect.getKeyframes()[0]` minus `offset/easing/composite`) → call `.finish()` on every animation whose `effect.getTiming().iterations` is finite → wait 1 frame → walk.

Walker rules: recurse light DOM **and** open shadow roots (`image-slot` has one, but treat `image-slot` as a leaf: emit `slot` from its attributes); boxes relative to the active section's `getBoundingClientRect()`; mark `hidden` for `display:none`, `visibility:hidden`, zero area, or box fully outside 0..1920×0..1080; a "text block" is the nearest element whose direct children include non-whitespace text nodes — emit it as one `#text-block` RawNode with `runs` (one run per contiguous style, `<br>` → `\n`, `&nbsp;` → U+00A0) and `lineCount` from `Range.getClientRects()` distinct tops; `loop: true` on an element when any `getAnimations()` on it or descendants has `iterations === Infinity` (JS timers: also true when the element's own attributes/children mutate during a 300ms `MutationObserver` window started after `.finish()`; mark the outermost mutating element inside the section). Style subset to copy: `backgroundColor, backgroundImage, borderTop/Right/Bottom/LeftWidth, borderTopColor, borderStyle, borderRadius corners, boxShadow, opacity, overflow, transform, backdropFilter, filter, clipPath, mixBlendMode, maskImage, textAlign, objectFit, color, fontFamily, fontWeight, fontStyle, fontSize, lineHeight, letterSpacing, textDecorationLine, textTransform`.

Session setup: `puppeteer.launch({ headless: true })`, viewport 1920×1080 dpr 1, `page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])`, serve `srcDir` via `file://`, set `noscale` on `deck-stage` once defined, `await document.fonts.ready`.

- [ ] **Step 1: Write failing tests** (one `DeckSession` for the file, `afterAll` close):
  - `slideCount()` is 3.
  - Slide 0: a `#text-block` with `runs.map(r=>r.chars).join('')` === the h1 text and one run with `fontWeight` 700 (the `<b>`); `anims` has one entry named `npCard` with `delayMs` 1000, `durationMs` 600, `iterations` 1, `firstKeyframe.opacity === '0'`; after capture the card's `style.opacity` is `'1'` (end state).
  - Slide 1: nodes include one `img`, one with `svg`, one with `iconClass === 'icon-phone'`, one with `slot.placeholder === 'Photo: test'`; the `display:none` div and the off-slide div have `hidden: true`.
  - Slide 2: the floating div has `loop: true`; `anims` entry for `mdFloat` has `iterations` Infinity.
  - `screenshot(0, tmp)` writes a 1920×1080 PNG.
- [ ] **Step 2: Run** `npx jest tests/deck-import/capture.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `capture.ts` and `walker.page.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(deck-import): headless capture of deck slides`

---

### Task 4: Normalize raw nodes to slide IR

**Files:**
- Create: `src/core/deck-import/normalize.ts`
- Test: `tests/deck-import/normalize.test.ts` (pure; hand-built `RawNode[]`)

**Interfaces:**
- Consumes: Task 1 types, Task 2 `css.ts`.
- Produces: `normalizeSlide(nodes: RawNode[], meta: { index: number; name: string; skipped: boolean; notes: string }): Omit<SlideIR, 'entrance'>`

Rules (§6.1):
- Drop `hidden` nodes and their subtrees.
- The section's own background → `SlideIR.background`.
- A node becomes `frame` only if it draws (any fill, any border > 0, any shadow/blur effect, or `overflow` ≠ visible **with** children). Otherwise it is not emitted and its children are hoisted to the nearest emitted ancestor (boxes are already absolute, so no coordinate math).
- Only non-drawing nodes are removed; a drawing node is always kept, even with a single child.
- `img` → `image` (`object-fit` cover→FILL, contain→FIT, fill→FILL with flag `object-fit:fill`); `svg` → `vector`; `iconClass` → `vector` with `svg: ''` and the class kept in `name` for Task 6 to fill; `slot` without `src` → `slot` named `Image slot · <placeholder>`; with `src` → `image`; `loop` → `gif` with `gifKey = id`, subtree discarded.
- Flags: add `unsupported:<prop>` for non-`none` `clipPath`, `maskImage`, `mixBlendMode` ≠ normal, `filter` ≠ none; `backdropFilter: blur(Npx)` → `BACKGROUND_BLUR` effect plus flag `approx:backdrop-filter`.

- [ ] **Step 1: Write failing tests:**
  - wrapper chain `div(no style) > div(no style) > text` → root contains just the `text` node.
  - `div(bg white, radius 24) > div(no style) > text` → one `frame` with one `text` child.
  - text run chars `'Hi 👋\u00A0there\nnext'` survive unchanged.
  - hidden node with visible children → none emitted.
  - loop node with 5 descendants → a single `gif` node, no descendants anywhere.
  - slot without src → `{ kind: 'slot', name: 'Image slot · Photo: test' }`.
  - `clip-path: circle(50%)` → frame with flag `unsupported:clip-path`.
- [ ] **Step 2: Run** `npx jest tests/deck-import/normalize.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(deck-import): normalize captured DOM into slide IR`

---

### Task 5: Entrance extraction

**Files:**
- Create: `src/core/deck-import/entrance.ts`
- Test: `tests/deck-import/entrance.test.ts`

**Interfaces:**
- Consumes: `RawAnim`, `EntranceIR`, `mapEasing`.
- Produces: `buildEntrance(anims: RawAnim[], emittedIds: Set<string>, idOwner: (rawId: string) => string | null): EntranceIR | null`
  - `idOwner` maps an animated raw node id to the emitted IR node that represents it (itself, or nearest emitted ancestor/descendant chosen by Task 4; export a helper `ownerMap(nodes, root)` from `normalize.ts` if needed — add it there, not here).

Rules (§6.2): only `iterations` finite and > 0; ignore anims whose owner is a `gif`. Start state from `firstKeyframe`: `opacity` → number; `transform` `translate(X,Y)`/`translateX/Y`/`translate(-50%, 16px)` → dx/dy in px (ignore % parts, which are static centering); `scale(N)` → scale; `scaleX(0)` → `opacity: 0` + flag-free; `height`/`max-height`/`padding` start → `{ opacity: 0, dy: 24 }`; `stroke-dashoffset` → `{ opacity: 0 }`. `durationS = min(1.0, max(durationMs)/1000)`, floor 0.01. `curve` = `mapEasing` of the longest anim's easing. Return `null` when no qualifying anims.

- [ ] **Step 1: Write failing tests:**
  - `npCard` (opacity 0, translateY(24px), 600ms, cubic-bezier(.65,0,.35,1)) → `{ durationS: 0.6, curve: 'EASE_IN_AND_OUT', start: { [id]: { opacity: 0, dy: 24 } } }`.
  - `npIn` `translate(-50%,16px)` → `dy: 16`, no `dx`.
  - `stairUp` height-from-0 → `{ opacity: 0, dy: 24 }`.
  - a 1400ms anim → `durationS` 1.
  - only infinite anims → `null`.
- [ ] **Step 2: Run** `npx jest tests/deck-import/entrance.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(deck-import): collapse CSS entrances into one Smart Animate step`

---

### Task 6: Assets (images, Lucide icons)

**Files:**
- Create: `src/core/deck-import/assets.ts`
- Test: `tests/deck-import/assets.test.ts`

**Interfaces:**
- Produces:
  - `loadImageBytes(src: string, srcDir: string, cacheDir: string): Promise<{ bytes: Uint8Array; sha1: string; mime: string }>` — relative path (resolved against `srcDir`, must stay inside it), `data:` URI, or `http(s)` URL (fetched once, cached in `cacheDir` by sha1 of the URL). Figma `createImage` takes PNG/JPG/GIF only: for a `.webp` path, use a `.png` or `.jpg` sibling with the same basename when it exists (the sample ships both); otherwise throw `Error('unsupported image type webp')`.
  - `lucideSvg(iconClass: string): string | null` — reads `node_modules/lucide-static/icons/<name>.svg` where `name` = class without `icon-` prefix.

- [ ] **Step 1: Write failing tests:** relative path returns the fixture png bytes + sha1; `../../etc/passwd` throws; `data:image/png;base64,…` decodes; `lucideSvg('icon-phone')` starts with `<svg`; `lucideSvg('icon-nope')` is null; `x.webp` with `x.png` beside it returns the png bytes; lone `y.webp` throws `unsupported image type webp`. (URL fetch: mock `global.fetch`.)
- [ ] **Step 2: Run** `npx jest tests/deck-import/assets.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(deck-import): image and icon asset loading`

---

### Task 7: Loop GIF recorder

**Files:**
- Create: `src/core/deck-import/gif.ts`
- Test: `tests/deck-import/gif.test.ts` (uses Task 3 fixture slide 2)

**Interfaces:**
- Consumes: `DeckSession` (Task 3).
- Produces:
  - `recordLoop(session: DeckSession, slideIndex: number, box: Box, cycleMs: number): Promise<{ bytes: Uint8Array; frames: number; warnBig: boolean }>` — pause all animations in the page (`getAnimations().forEach(a => a.pause())`), then for t in 0..cycleMs step 1000/30: set each infinite animation's `currentTime = t` (CSS loops are deterministic this way; JS-timer loops fall back to real-time capture at 30fps for `cycleMs`), screenshot the clip at `deviceScaleFactor` 2, decode with `pngjs`, quantize + encode with `gifenc` (loop forever, delay 33ms). `cycleMs` = longest infinite anim `durationMs` inside the box, or 3000 for JS-only loops. `warnBig` = bytes > 5 * 1024 * 1024.
  - `chunkBase64(bytes: Uint8Array, chunkSize = 512 * 1024): string[]` (used by Task 8 uploads; lives here only because GIFs are the biggest payload — export it).

- [ ] **Step 1: Write failing tests:** fixture slide 2 float region → `frames` = 60 (2s × 30), bytes start with `GIF89a`, decoded width = 2× box width; `chunkBase64(new Uint8Array(1_200_000))` → 3+ chunks whose joined decode equals the input.
- [ ] **Step 2: Run** `npx jest tests/deck-import/gif.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(deck-import): record looping regions as GIFs`

---

### Task 8: Ops, plugin runtime, and Figma wrapper

**Files:**
- Create: `src/core/deck-import/ops.ts`, `src/core/deck-import/runtime.plugin.js`, `src/core/deck-import/figma.ts`
- Test: `tests/deck-import/ops.test.ts`, `tests/deck-import/runtime.test.ts` (runs the runtime in `node:vm` against a fake `figma`)

**Interfaces:**
- Consumes: `SlideIR`, `NodeIR`, `EntranceIR`; connector `executeCodeViaUI(code, timeoutMs)` and `captureScreenshot(nodeId, { format: 'PNG', scale: 1 })` from `src/core/figma-connector.ts`.
- Produces:
  - `type Op = { op: 'frame' | 'text' | 'image' | 'vector' | 'slot'; id: string; parent: string | null; name: string; props: Record<string, unknown> }` — `parent` is another op's `id` or `null` for the slide; `image.props.hash` is a Figma image hash.
  - `buildOps(slide: SlideIR, hashes: Map<string, string>): Op[]` (`hashes`: image src or gifKey → Figma image hash; icon vectors already have `svg` filled).
  - `RUNTIME_SOURCE: string` — `runtime.plugin.js` read at build/test time; exposes when evaluated `async function __deckImport(cmd)` with commands:
    - `{ cmd: 'uploadChunk', key, index, total, b64 }` → when last chunk arrives, `figma.createImage(bytes)`; returns `{ hash }`. Chunks are held in `figma.root.setSharedPluginData`-free memory: a global `__chunks[key]` (the plugin context persists between `EXECUTE_CODE` calls; if it doesn't, the call returns `{ error: 'chunks lost' }` and the wrapper re-sends all chunks in one call).
    - `{ cmd: 'buildSlide', slide: { name, background, skipped, notes, transition }, ops, replaceIds?: string[], afterId?: string }` → creates the slide, applies ops, returns `{ slideId }`. Slide creation path: try `figma.createSlide()`; on throw, `clone()` the last existing `SLIDE` and remove its children; if no slide exists, throw `'Add one blank slide to the deck, then retry'`. With `replaceIds`, insert at the first replaced slide's grid position (mirror how `figma_reorder_slides` moves slides in `figma-desktop-bridge/code.js`) and remove the replaced slides.
    - `{ cmd: 'makeEntrance', slideId, start, transition }` → `clone()` the slide, name it `<name> · enter`, place it before the original, apply `start` to nodes found by pluginData `importId` (opacity, `x += dx`, `y += dy`, scale about center), set copy A transition `{ style:'NONE', duration:0.01, curve:'EASE_OUT', timing:{ type:'ON_CLICK' } }` and original `{ style:'SMART_ANIMATE', duration, curve, timing:{ type:'AFTER_DELAY', delay:0 } }`; returns `{ enterSlideId }`.
    - `{ cmd: 'dump', slideId }` → `FigmaDumpNode` tree (type in Task 1): walk the slide, `importId` from pluginData, `lineCount = Math.round(node.height / lineHeightPx)` using the px line height set at build time (store it in pluginData `lineHeightPx`).
    - `{ cmd: 'patch', nodeId, props }` → applies the same prop setters used by ops to one node (used by the chat agent's fix loop).
  - Text in runtime: `loadFontAsync` every `{family, style}` in runs first; fixed width = box.w, `textAutoResize: 'HEIGHT'`, ranges via `setRangeFontName/FontSize/Fills/LetterSpacing/LineHeight/TextDecoration`.
  - `figma.ts`: `class FigmaDeck { constructor(connector: any); uploadImage(key: string, bytes: Uint8Array): Promise<string>; buildSlide(slide: SlideIR, hashes: Map<string,string>, replaceIds?: string[]): Promise<{ slideId: string; enterSlideId?: string }>; dump(slideId: string): Promise<FigmaDumpNode>; screenshot(slideId: string, outPath: string): Promise<void>; patch(nodeId: string, props: Record<string, unknown>): Promise<void> }` — each call sends `RUNTIME_SOURCE + '\nreturn await __deckImport(' + JSON.stringify(cmd) + ')'` with timeout 60000; uploads use `chunkBase64` (Task 7) and dedupe by sha1 within a run.

- [ ] **Step 1: Write failing tests** (`ops.test.ts`): frame with a text child → 2 ops, text op `parent` = frame op `id`; every op `name` ends with ` #<id>`; image op carries the hash from the map; gif op becomes `image` with `scaleMode: 'FILL'`; slot op has no fills.
- [ ] **Step 2: Write failing tests** (`runtime.test.ts`, fake `figma` with `createFrame/createText/createRectangle/createNodeFromSvg/createImage/loadFontAsync/createSlide (throws)/currentPage.findAll`, nodes recording assigned props): `buildSlide` with `createSlide` throwing and one existing slide → clones it, empties children, applies ops; with zero slides → error text `Add one blank slide to the deck, then retry`; `makeEntrance` → copy named `Title · enter`, node `#s0-n3` opacity 0 and `y` +24 on the copy, original has `SMART_ANIMATE` transition with `AFTER_DELAY` 0; `uploadChunk` ×3 → one `createImage` with the concatenated bytes; `dump` returns `importId` from pluginData and nested children.
- [ ] **Step 3: Run** `npx jest tests/deck-import/ops.test.ts tests/deck-import/runtime.test.ts` — Expected: FAIL.
- [ ] **Step 4: Implement** `ops.ts`, `runtime.plugin.js`, `figma.ts`. Ship `runtime.plugin.js` as a string: add it to the build by importing via `fs.readFileSync(new URL('./runtime.plugin.js', import.meta.url))` and add a copy step to `build:local` (or inline it as a `.ts` exporting a template string — implementer's choice; tests must read the same source).
- [ ] **Step 5: Run** — Expected: PASS.
- [ ] **Step 6: Commit** `feat(deck-import): plugin runtime that builds slides and entrance pairs`

---

### Task 9: QA checks, state and report

**Files:**
- Create: `src/core/deck-import/qa.ts`, `src/core/deck-import/state.ts`
- Test: `tests/deck-import/qa.test.ts`, `tests/deck-import/state.test.ts`

**Interfaces:**
- Consumes: `FigmaDumpNode`, `SlideIR` (Task 1).
- Produces (add to `types.ts`):

```ts
export interface QaIssue { kind: 'empty' | 'passthrough' | 'raster' | 'text-not-text' | 'box' | 'lines' | 'missing' | 'font'; importId: string | null; figmaId: string; detail: string }
export interface QaResult { pass: boolean; issues: QaIssue[] }
export type SlideStatus = 'pending' | 'imported' | 'passed' | 'flagged';
export interface ImportState { zip: string; deck: string; slides: Record<number, { status: SlideStatus; figmaIds: string[]; rounds: number; flags: string[]; reason?: string }> }
```

  - `checkSlide(ir: SlideIR, dump: FigmaDumpNode): QaResult` — lint (§7.1): `empty` = FRAME/RECTANGLE with no visible fill/stroke/effect and no children, except names starting `Image slot · `; `passthrough` = FRAME with one child and no fill/stroke/effect/clip; `raster` = image fill on a node whose IR kind is not `image`/`gif`; `text-not-text` = IR text whose Figma node is not `TEXT`. Numeric (§7.2): `box` when any edge differs > 2px; `lines` when `lineCount` differs; `missing` when an IR id has no dump node; `font` when a run's family is absent from the node's fonts.
  - `loadState(workDir: string, zip: string, deck: string): ImportState`, `saveState(workDir: string, s: ImportState): void` (write to temp file then rename).
  - `writeReport(workDir: string, s: ImportState): string` — `report.html` with per-slide status, rounds, flags/reason, and `<img>` of `shots/<n>-html.png` and `shots/<n>-figma.png`; header shows passed/flagged counts, flagged % with a red marker when > 10%, and counts of each issue kind seen across the run (recurring fix types, §7.4); returns the path.

- [ ] **Step 1: Write failing tests:** each lint/numeric kind triggered by a minimal dump; an `Image slot · x` empty frame does not trigger `empty`; a 1px offset passes and a 3px offset fails; `saveState` then `loadState` round-trips; a state with slide 1 `passed` and slide 2 `imported` is what Task 10 resume reads (assert `pendingSlides(state, total)` → `[2,3,…]`; export `pendingSlides(s: ImportState, total: number): number[]` from `state.ts`); report for 10 slides with 2 flagged contains `20%` and the over-limit marker.
- [ ] **Step 2: Run** `npx jest tests/deck-import/qa.test.ts tests/deck-import/state.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(deck-import): QA lint, numeric checks, resumable state, report`

---

### Task 10: MCP tools and wiring

**Files:**
- Create: `src/core/deck-import/tools.ts`
- Modify: `src/local.ts` (import + call `registerDeckImportTools(this.server, () => this.getDesktopConnector())` next to `registerSlidesTools` at ~line 3247)
- Modify: `docs/tools.md` (one section listing the five tools)
- Test: `tests/deck-import/tools.test.ts` (mock server + mock connector, pattern from `tests/figjam-tools.test.ts`; mock `DeckSession`/`FigmaDeck` via `jest.mock`)

**Interfaces:**
- Consumes: everything above.
- Produces — tool names and zod params:
  - `deck_list({ zipPath })` → `{ workDir, decks: [{ file, slideCount }] }`
  - `deck_import({ zipPath, deck, slides?: string /* "1-10" or "7", 1-based */, force?: boolean })` → for each requested slide not already `passed` (unless `force`, or it was named explicitly): capture → normalize → entrance → assets/GIFs → upload → build (replacing `figmaIds` from state if present) → screenshot both sides into `shots/` → dump → `checkSlide`; status `passed` if `pass` else `imported`, `rounds += 1`. Returns compact `{ slides: [{ n, status, figmaIds, issues: QaIssue[] (max 10), flags }] }`. Opens one `DeckSession` per call, closes it in `finally`.
  - `deck_slide_view({ zipPath, deck, slide })` → MCP content: two `image` items (html PNG, figma PNG, base64) + a text item with the current `QaResult` and the IR summary (ids, kinds, boxes) so the agent can map regions to import ids.
  - `deck_patch({ zipPath, deck, slide, importId, props })` → finds the Figma node by importId in the slide, calls `FigmaDeck.patch`, re-dumps, re-checks, updates state (`passed` when clean), returns the new `QaResult`.
  - `deck_mark({ zipPath, deck, slide, status: 'passed' | 'flagged', reason?: string })` → for the agent's visual verdict; writes state.
  - `deck_report({ zipPath, deck })` → writes and returns the report path plus counts.
  - Every tool description states the loop: import → view → patch/re-import (≤ 3 rounds) → mark → report, and that rasterizing is never an allowed fix.

- [ ] **Step 1: Write failing tests:** all five tools registered; `deck_import` with state slide 1 `passed` and `slides` omitted processes only slides 2..N; `deck_import` with `slides: "1"` re-processes slide 1 and passes `replaceIds` = its stored `figmaIds`; connector failure returns `isError: true` with a `hint` mentioning the Desktop Bridge; `deck_mark` flagged with reason persists.
- [ ] **Step 2: Run** `npx jest tests/deck-import/tools.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `tools.ts`, wire into `src/local.ts`, update `docs/tools.md`.
- [ ] **Step 4: Run** `npx jest tests/deck-import && npm run type-check && npm run build:local` — Expected: all PASS, build succeeds.
- [ ] **Step 5: Commit** `feat(deck-import): MCP tools for import, review, patch and report`

---

### Task 11: Acceptance run on the real deck (manual, with Figma)

**Files:** none new, except fixes found along the way (each fix: failing test first in the owning module's test file, then fix, then commit).

- [ ] **Step 1:** Add the local server to Claude Code: `claude mcp add figslide-console -- node C:/Users/Dolphin/Repo/figslide-console/dist/local.js`; restart the session; open a new Figma Slides file with one blank slide; run the Desktop Bridge plugin.
- [ ] **Step 2:** `deck_list` on `C:\Users\Dolphin\Downloads\WhatsApp Call Product Launch.zip` → 6 decks; `WhatsApp Call Deck - Main.dc.html` shows 68 slides.
- [ ] **Step 3:** `deck_import` slides `1-5`; run the loop (`deck_slide_view` → `deck_patch`/re-import ≤ 3 rounds → `deck_mark`). Fix converter bugs found (test-first) before continuing.
- [ ] **Step 4:** Import the remaining slides in batches of ~10 with the same loop.
- [ ] **Step 5:** `deck_report` → verify against spec §8: 68 source slides imported; one `· enter` copy per slide with entrances and no more; zero lint issues; flagged ≤ 7; no raster images except bitmaps and GIFs (spot-check with `dump`); present the deck in Figma and confirm entrances fade/slide in once and loop GIFs play.
- [ ] **Step 6:** Commit any fixes; note recurring fix types from the report header in the PR description.
