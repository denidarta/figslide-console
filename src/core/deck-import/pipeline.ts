import * as fs from "node:fs";
import * as path from "node:path";
import { createChildLogger } from "../logger.js";
import { loadImageBytes, lucideSvg } from "./assets.js";
import type { DeckSession } from "./capture.js";
import { parseColorRaw } from "./css.js";
import { buildEntrance } from "./entrance.js";
import type { FigmaDeck } from "./figma.js";
import { recordLoop } from "./gif.js";
import { emittedIds, normalizeSlide, ownerMap } from "./normalize.js";
import { buildOps, SLIDE_SIZE } from "./ops.js";
import { checkSlide } from "./qa.js";
import type {
	Box,
	FigmaDumpNode,
	NodeIR,
	QaResult,
	RawAnim,
	RawNode,
	SlideIR,
} from "./types.js";
import { pauseForRecording, seekLoops, walkSlide } from "./walker.page.js";

const logger = createChildLogger({ component: "deck-import" });

const BLACK = "rgb(0, 0, 0)";
const DEFAULT_CYCLE_MS = 3000;
const BIG_LOOP_AREA = SLIDE_SIZE.w * SLIDE_SIZE.h * 0.5;
const BIG_LOOP_MS = 10_000;
const MAX_FLAG_SRC = 80;

type GifNode = Extract<NodeIR, { kind: "gif" }>;

export interface PipelineEnv {
	session: DeckSession;
	figma: FigmaDeck;
	srcDir: string;
	workDir: string;
	/** Called with `[enterSlideId?, slideId]` as soon as the slide exists, before anything after it can fail. */
	onBuilt?: (figmaIds: string[]) => void;
}

/** What was sent to Figma for a slide, kept so view / patch can re-check against the same IR. */
export interface Built {
	ir: SlideIR;
	/** Op ids buildOps emitted: the only ones QA may report as missing. */
	expected: string[];
	qa: QaResult | null;
}

// ---- stored IR (<workDir>/ir/<n>.json) ----------------------------------------------------------

const builtFile = (workDir: string, n: number) =>
	path.join(workDir, "ir", `${n}.json`);

export function saveBuilt(workDir: string, n: number, b: Built): void {
	const file = builtFile(workDir, n);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(b));
}

export function loadBuilt(workDir: string, n: number): Built | null {
	try {
		return JSON.parse(fs.readFileSync(builtFile(workDir, n), "utf8")) as Built;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

// ---- small helpers ------------------------------------------------------------------------------

/** data: URIs and long URLs would swamp a flag. */
const short = (s: string) =>
	s.length > MAX_FLAG_SRC ? `${s.slice(0, MAX_FLAG_SRC - 3)}...` : s;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function visit(list: NodeIR[], fn: (n: NodeIR) => void): void {
	for (const n of list) {
		fn(n);
		if (n.kind === "frame") visit(n.children, fn);
	}
}

/** Rebuilds the tree top-down: `fn` may replace a node or drop it (null); frame children follow the result. */
async function mapTree(
	list: NodeIR[],
	fn: (n: NodeIR) => Promise<NodeIR | null>,
): Promise<NodeIR[]> {
	const out: NodeIR[] = [];
	for (const n of list) {
		const r = await fn(n);
		if (!r) continue;
		out.push(
			r.kind === "frame"
				? { ...r, children: await mapTree(r.children, fn) }
				: r,
		);
	}
	return out;
}

/** True when `id` is `ownerId` or inside its subtree. */
function inside(
	id: string,
	ownerId: string,
	byId: Map<string, RawNode>,
): boolean {
	for (
		let n = byId.get(id);
		n;
		n = n.parentId ? byId.get(n.parentId) : undefined
	) {
		if (n.id === ownerId) return true;
	}
	return false;
}

/** Distinct QA issue kinds that went away: recorded as `fixed:<kind>` so the report counts recurring fixes. */
export function fixedFlags(
	before: QaResult | null | undefined,
	after: QaResult,
): string[] {
	if (!after.pass || !before) return [];
	return [...new Set(before.issues.map((i) => `fixed:${i.kind}`))];
}

// ---- vectors and images -------------------------------------------------------------------------

interface Ctx {
	raw: Map<string, RawNode>;
	srcDir: string;
	cacheDir: string;
	figma: FigmaDeck;
	hashes: Map<string, string>;
	flags: Set<string>;
}

/** The node's computed text color, else the nearest ancestor's, else black. */
function colorOf(raw: Map<string, RawNode>, id: string): string {
	for (
		let n = raw.get(id);
		n;
		n = n.parentId ? raw.get(n.parentId) : undefined
	) {
		if (n.style.color) return n.style.color;
	}
	return BLACK;
}

/** `currentColor` -> hex; the color's alpha comes back separately (SVG attributes only take opaque hex safely). */
function withColor(svg: string, css: string): { svg: string; alpha: number } {
	if (!/currentColor/i.test(svg)) return { svg, alpha: 1 };
	const c = parseColorRaw(css) ?? { r: 0, g: 0, b: 0, a: 1 };
	const hex = [c.r, c.g, c.b]
		.map((v) =>
			Math.round(v * 255)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("");
	return { svg: svg.replace(/currentColor/gi, `#${hex}`), alpha: c.a };
}

async function resolveNode(n: NodeIR, ctx: Ctx): Promise<NodeIR | null> {
	if (n.kind === "vector") {
		const icon = n.flags.find((f) => f.startsWith("icon:"))?.slice(5);
		let svg = n.svg;
		if (!svg && icon) {
			svg = lucideSvg(icon) ?? "";
			if (!svg) {
				ctx.flags.add(`missing-icon:${icon}`);
				return null;
			}
		}
		const filled = withColor(svg, colorOf(ctx.raw, n.id));
		return {
			...n,
			svg: filled.svg,
			opacity: n.opacity * filled.alpha,
			flags: n.flags.filter((f) => !f.startsWith("icon:")),
		};
	}
	if (n.kind !== "image") return n;

	let img: Awaited<ReturnType<typeof loadImageBytes>>;
	try {
		img = await loadImageBytes(n.src, ctx.srcDir, ctx.cacheDir);
	} catch (e) {
		logger.warn(
			{ src: short(n.src), error: errMsg(e) },
			"image not importable",
		);
		ctx.flags.add(`image-unsupported:${short(n.src)}`);
		return null;
	}
	if (img.mime === "image/svg+xml") {
		// Never rasterize: an <img> svg is vector artwork. It renders in its own document, so currentColor is black.
		const { svg } = withColor(new TextDecoder().decode(img.bytes), BLACK);
		return {
			kind: "vector",
			id: n.id,
			box: n.box,
			svg,
			opacity: n.opacity,
			flags: n.flags,
		};
	}
	if (!ctx.hashes.has(n.src)) {
		try {
			ctx.hashes.set(n.src, await ctx.figma.uploadImage(n.src, img.bytes));
		} catch (e) {
			// Flagged as image-missing once buildOps shows the node was left out.
			logger.warn(
				{ src: short(n.src), error: errMsg(e) },
				"image upload failed",
			);
		}
	}
	return n;
}

// ---- loop GIFs ----------------------------------------------------------------------------------

/**
 * The loop owner's region as the union of its subtree's boxes sampled over the cycle (the captured
 * box is measured at t=0 and can be zero or stale), rounded outward and clamped to the slide.
 * ponytail: four samples; JS/SMIL loops cannot be seeked, so they only get the captured box.
 */
async function measureLoop(
	session: DeckSession,
	slideIndex: number,
	ownerId: string,
	seed: Box,
	cycleMs: number,
): Promise<Box | null> {
	let [x0, y0, x1, y1] = [
		Number.POSITIVE_INFINITY,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	];
	const grow = (b: Box) => {
		if (!(b.w > 0 && b.h > 0)) return;
		x0 = Math.min(x0, b.x);
		y0 = Math.min(y0, b.y);
		x1 = Math.max(x1, b.x + b.w);
		y1 = Math.max(y1, b.y + b.h);
	};
	grow(seed);

	const { page } = session;
	const { seekable } = await page.evaluate(pauseForRecording, slideIndex, {
		x: 0,
		y: 0,
		w: SLIDE_SIZE.w,
		h: SLIDE_SIZE.h,
	});
	if (seekable) {
		for (const f of [0, 0.25, 0.5, 0.75]) {
			await page.evaluate(seekLoops, f * cycleMs);
			const { nodes } = await page.evaluate(walkSlide, slideIndex);
			const byId = new Map(nodes.map((n) => [n.id, n]));
			// Ids follow DOM order; if script rewrote the DOM mid-cycle they no longer mean the same element.
			if (!byId.get(ownerId)?.loop) continue;
			for (const n of nodes) {
				if (!n.hidden && inside(n.id, ownerId, byId)) grow(n.box);
			}
		}
	}

	const [l, t] = [Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0))];
	const [r, b] = [
		Math.min(SLIDE_SIZE.w, Math.ceil(x1)),
		Math.min(SLIDE_SIZE.h, Math.ceil(y1)),
	];
	return r > l && b > t ? { x: l, y: t, w: r - l, h: b - t } : null;
}

async function recordGif(
	n: GifNode,
	slideIndex: number,
	env: PipelineEnv,
	ctx: Ctx,
	anims: RawAnim[],
): Promise<NodeIR> {
	const infinite = anims.filter(
		(a) =>
			!Number.isFinite(a.iterations) &&
			a.durationMs > 0 &&
			inside(a.nodeId, n.id, ctx.raw),
	);
	const cycleMs = infinite.length
		? Math.max(...infinite.map((a) => a.durationMs))
		: DEFAULT_CYCLE_MS;
	try {
		const box = await measureLoop(
			env.session,
			slideIndex,
			n.id,
			n.box,
			cycleMs,
		);
		if (!box) throw new Error("loop has no visible area");
		// Heavy, but still the faithful result: record it and say so.
		if (box.w * box.h > BIG_LOOP_AREA || cycleMs > BIG_LOOP_MS)
			ctx.flags.add(`big-loop:${n.id}`);
		const rec = await recordLoop(env.session, slideIndex, box, cycleMs);
		if (rec.warnBig) ctx.flags.add(`gif-over-5mb:${n.id}`);
		ctx.hashes.set(n.gifKey, await env.figma.uploadImage(n.gifKey, rec.bytes));
		return { ...n, box }; // a new object: IR boxes alias the captured RawNode boxes
	} catch (e) {
		logger.warn({ id: n.id, error: errMsg(e) }, "loop gif failed");
		ctx.flags.add(`gif-failed:${n.id}`);
		return n; // no hash: buildOps leaves it out and it is flagged image-missing below
	}
}

// ---- the per-slide pipeline ---------------------------------------------------------------------

/**
 * Imports slide `n` (1-based): capture -> normalize -> entrance -> assets / GIFs -> upload -> build
 * (replacing `replaceIds`) -> screenshots in `<workDir>/shots` -> dump -> QA. Persists the IR for
 * view / patch. `flags` is everything the report should say about the slide.
 */
export async function importSlide(
	env: PipelineEnv,
	n: number,
	replaceIds?: string[],
): Promise<{ figmaIds: string[]; flags: string[]; qa: QaResult }> {
	const { session, figma, workDir } = env;
	const index = n - 1;
	const flags = new Set<string>();

	const meta = await session.slideMeta(index);
	const { nodes, anims } = await session.capture(index);
	const norm = normalizeSlide(nodes, { index, ...meta });
	for (const f of norm.flags) flags.add(f);

	const ctx: Ctx = {
		raw: new Map(nodes.map((r) => [r.id, r])),
		srcDir: env.srcDir,
		cacheDir: path.join(workDir, "cache"),
		figma,
		hashes: new Map(),
		flags,
	};
	let root = await mapTree(norm.root, (node) => resolveNode(node, ctx));
	// After resolving, so entrance owners only name nodes that really exist.
	const entrance = buildEntrance(
		anims,
		emittedIds(root),
		ownerMap(nodes, root),
	);
	root = await mapTree(root, async (node) =>
		node.kind === "gif" ? recordGif(node, index, env, ctx, anims) : node,
	);
	const ir: SlideIR = { ...norm, root, entrance };

	const expected = new Set(buildOps(ir, ctx.hashes).map((o) => o.id));
	visit(root, (node) => {
		for (const f of node.flags) if (!f.startsWith("icon:")) flags.add(f);
		if (node.kind === "image" && !expected.has(node.id))
			flags.add(`image-missing:${short(node.src)}`);
		if (node.kind === "gif" && !expected.has(node.id))
			flags.add(`image-missing:${short(node.gifKey)}`);
	});

	const prev = loadBuilt(workDir, n);
	const built = await figma.buildSlide(ir, ctx.hashes, replaceIds);
	const figmaIds = [built.enterSlideId, built.slideId].filter(
		(id): id is string => !!id,
	);
	const stored = { ir, expected: [...expected] };
	saveBuilt(workDir, n, { ...stored, qa: null });
	env.onBuilt?.(figmaIds);
	for (const w of built.warnings) flags.add(w);

	const shots = path.join(workDir, "shots");
	fs.mkdirSync(shots, { recursive: true });
	await session.screenshot(index, path.join(shots, `${n}-html.png`));
	await figma.screenshot(built.slideId, path.join(shots, `${n}-figma.png`));
	const qa = checkSlide(ir, await figma.dump(built.slideId), expected);
	saveBuilt(workDir, n, { ...stored, qa });
	for (const f of fixedFlags(prev?.qa, qa)) flags.add(f);
	return { figmaIds, flags: [...flags], qa };
}

// ---- re-checking an imported slide --------------------------------------------------------------

/** Dumps the slide from Figma and checks it against the stored IR; the result is stored too. */
export async function recheck(
	figma: FigmaDeck,
	workDir: string,
	n: number,
	slideId: string,
): Promise<{ built: Built; dump: FigmaDumpNode; qa: QaResult }> {
	const built = loadBuilt(workDir, n);
	if (!built)
		throw new Error(`Slide ${n} has no stored import. Run deck_import first.`);
	const dump = await figma.dump(slideId);
	const qa = checkSlide(built.ir, dump, new Set(built.expected));
	saveBuilt(workDir, n, { ...built, qa });
	return { built, dump, qa };
}

export function findByImportId(
	dump: FigmaDumpNode,
	importId: string,
): FigmaDumpNode | null {
	if (dump.importId === importId) return dump;
	for (const c of dump.children) {
		const hit = findByImportId(c, importId);
		if (hit) return hit;
	}
	return null;
}

/** Flat id / kind / box list, so a region seen in a screenshot maps to an import id. Boxes are [x, y, w, h] in slide px. */
export function irSummary(ir: SlideIR) {
	const r = (v: number) => Math.round(v * 10) / 10;
	const out: {
		id: string;
		kind: NodeIR["kind"];
		parent: string | null;
		box: number[];
		text?: string;
		src?: string;
	}[] = [];
	const walk = (list: NodeIR[], parent: string | null) => {
		for (const n of list) {
			out.push({
				id: n.id,
				kind: n.kind,
				parent,
				box: [n.box.x, n.box.y, n.box.w, n.box.h].map(r),
				...(n.kind === "text"
					? {
							text: n.runs
								.map((x) => x.chars)
								.join("")
								.slice(0, 60),
						}
					: n.kind === "image"
						? { src: short(n.src) }
						: {}),
			});
			if (n.kind === "frame") walk(n.children, n.id);
		}
	};
	walk(ir.root, null);
	return out;
}
