import {
	parseBackground,
	parseColor,
	parseColorRaw,
	parseRadii,
	parseShadows,
} from "./css.js";
import type {
	Effect,
	NodeIR,
	RawNode,
	RGBA,
	SlideIR,
	StrokeIR,
	TextRun,
} from "./types.js";

type Style = Record<string, string>;

const isNone = (v: string | undefined) => !v || v === "none";

/** CSS blur(Npx) is a standard deviation; Figma's blur radius is twice that. */
function backdropBlur(s: Style): number {
	const m = /blur\(\s*([\d.]+)px\s*\)/.exec(s.backdropFilter ?? "");
	return m ? Number.parseFloat(m[1]) * 2 : 0;
}

/** True for a matrix with a rotation or skew part (b or c set); translate and scale draw correctly. */
function rotates(transform: string | undefined): boolean {
	const m = /^matrix(3d)?\(([^)]*)\)$/.exec((transform ?? "").trim());
	if (!m) return false;
	const v = m[2].split(",").map((x) => Number.parseFloat(x));
	const [b, c] = m[1] ? [v[1], v[4]] : [v[1], v[2]]; // matrix3d is column-major: m12, m21
	return Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6;
}

/** Features the IR cannot carry, so the report can name them. */
function flagsOf(s: Style): string[] {
	const f: string[] = [];
	if (rotates(s.transform)) f.push("unsupported:transform-rotate");
	if (!isNone(s.clipPath)) f.push("unsupported:clip-path");
	if (!isNone(s.maskImage)) f.push("unsupported:mask-image");
	if (s.mixBlendMode && s.mixBlendMode !== "normal")
		f.push("unsupported:mix-blend-mode");
	if (!isNone(s.filter)) f.push("unsupported:filter");
	if (!isNone(s.backdropFilter))
		f.push(
			backdropBlur(s)
				? "approx:backdrop-filter"
				: "unsupported:backdrop-filter",
		);
	// parseBackground skips url() layers, so they would vanish silently.
	if (s.backgroundImage?.includes("url("))
		f.push("unsupported:background-image");
	return f;
}

/** Per-side widths [top,right,bottom,left]; sides with a transparent color draw nothing. */
function strokesOf(s: Style): StrokeIR | null {
	const sides = ["Top", "Right", "Bottom", "Left"].map((k) => ({
		w: Number.parseFloat(s[`border${k}Width`]) || 0,
		c: parseColor(s[`border${k}Color`] ?? ""),
	}));
	const color = sides.find((x) => x.w > 0 && x.c)?.c;
	if (!color) return null;
	return {
		color,
		weights: sides.map((x) => (x.c ? x.w : 0)) as StrokeIR["weights"],
		dashed: /dashed|dotted/.test(s.borderStyle ?? ""),
	};
}

/** Elements the walker keeps as leaves but the IR has no node for. */
const UNSUPPORTED_LEAF = /^(canvas|video|iframe|object|embed|audio)$/;

const clipsText = (s: Style) =>
	/\btext\b/.test(`${s.backgroundClip ?? ""} ${s.webkitBackgroundClip ?? ""}`);

const isTransparent = (css: string) => parseColorRaw(css)?.a === 0;

/**
 * What a background-clip:text element shows through its glyphs, as one solid colour: the first visible
 * stop of its topmost gradient (Figma text takes a solid fill per run), else its background colour.
 */
function clipColor(s: Style): RGBA | null {
	const paints = parseBackground(s.backgroundColor ?? "", s.backgroundImage ?? "");
	const top = paints[paints.length - 1];
	if (!top) return null;
	return top.type === "SOLID"
		? top.color
		: (top.stops.find((x) => x.color.a > 0) ?? top.stops[0]).color;
}

const rgbaCss = (c: RGBA) =>
	`rgba(${[c.r, c.g, c.b].map((v) => Math.round(v * 255)).join(", ")}, ${Math.round(c.a * 1000) / 1000})`;

const ALIGN = {
	left: "LEFT",
	start: "LEFT",
	center: "CENTER",
	right: "RIGHT",
	end: "RIGHT",
	justify: "JUSTIFIED",
} as const;

// TextRun carries no text-transform, so the characters must already be what renders.
// ponytail: transform comes from the text block's owner; an inline child with its own transform is ignored.
function transformRuns(runs: TextRun[], mode: string | undefined): TextRun[] {
	const map = (f: (c: string) => string) =>
		runs.map((r) => ({ ...r, chars: f(r.chars) }));
	if (mode === "uppercase") return map((c) => c.toUpperCase());
	if (mode === "lowercase") return map((c) => c.toLowerCase());
	if (mode !== "capitalize") return runs;
	let wordStart = true; // carried across runs so a mid-word run boundary does not restart a word
	return map((chars) =>
		[...chars]
			.map((ch) => {
				const out = wordStart ? ch.toUpperCase() : ch;
				wordStart = /\s/.test(ch);
				return out;
			})
			.join(""),
	);
}

// [scaleMode, approximate]: `none` and `scale-down` have no exact Figma scale mode.
const OBJECT_FIT: Record<string, ["FILL" | "FIT", boolean]> = {
	cover: ["FILL", false],
	contain: ["FIT", false],
	fill: ["FILL", true],
	none: ["FILL", true],
	"scale-down": ["FIT", true],
};

function eachIR(list: NodeIR[], visit: (n: NodeIR) => void) {
	for (const n of list) {
		visit(n);
		if (n.kind === "frame") eachIR(n.children, visit);
	}
}

/** Ids of every emitted IR node except gifs (a gif is one opaque loop, never entrance-animated). */
export function emittedIds(root: NodeIR[]): Set<string> {
	const ids = new Set<string>();
	eachIR(root, (n) => {
		if (n.kind !== "gif") ids.add(n.id);
	});
	return ids;
}

/**
 * Maps a raw node id to the emitted IR nodes that carry it: the node itself if emitted; else its topmost
 * emitted descendants in document order (a non-drawing element's own `#text-block` is one of them).
 * Gifs and anything inside one never count, and hidden subtrees are dropped by normalizeSlide, so both
 * yield []. An ancestor is never a fallback: animating it would move unrelated siblings.
 */
export function ownerMap(
	nodes: RawNode[],
	root: NodeIR[],
): (rawId: string) => string[] {
	const emitted = new Map<string, NodeIR>();
	eachIR(root, (n) => emitted.set(n.id, n));
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const kids = new Map<string, RawNode[]>();
	for (const n of nodes) {
		if (n.parentId === null) continue;
		const list = kids.get(n.parentId);
		if (list) list.push(n);
		else kids.set(n.parentId, [n]);
	}
	const down = (n: RawNode): string[] => {
		if (emitted.has(n.id))
			return emitted.get(n.id)?.kind === "gif" ? [] : [n.id];
		return n.hidden ? [] : (kids.get(n.id) ?? []).flatMap(down);
	};
	return (rawId) => {
		const n = byId.get(rawId);
		return n ? down(n) : [];
	};
}

export function normalizeSlide(
	nodes: RawNode[],
	meta: { index: number; name: string; skipped: boolean; notes: string },
): Omit<SlideIR, "entrance"> {
	const kids = new Map<string, RawNode[]>();
	for (const n of nodes) {
		if (n.parentId === null) continue;
		const list = kids.get(n.parentId);
		if (list) list.push(n);
		else kids.set(n.parentId, [n]);
	}

	const byId = new Map(nodes.map((n) => [n.id, n]));
	/** Nearest ancestor (not the node itself) that paints its background through the text. */
	const clipAncestor = (n: RawNode): RawNode | undefined => {
		for (let p = n.parentId ? byId.get(n.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined)
			if (clipsText(p.style)) return p;
		return undefined;
	};

	const root = nodes.find((n) => n.parentId === null);
	// Dropped silently otherwise: a visible ::before/::after has no node of its own to carry a flag.
	const slideFlags = new Set(root ? flagsOf(root.style) : []);
	for (const n of nodes)
		if (n.pseudo && !n.hidden) slideFlags.add("unsupported:pseudo-element");

	const build = (n: RawNode): NodeIR[] => {
		// A loop owner is measured at t=0 and may look hidden (e.g. collapsed); it is still a gif.
		if (n.hidden && !n.loop) return [];
		const s = n.style;
		const flags = flagsOf(s);
		const { id, box } = n;
		if (n.loop)
			return [
				{ kind: "gif", id, box, gifKey: id, radii: parseRadii(s, box), flags },
			];
		if (UNSUPPORTED_LEAF.test(n.tag)) slideFlags.add(`unsupported:${n.tag}`);

		const opacity = Number.parseFloat(s.opacity ?? "1");
		const alpha = Number.isNaN(opacity) ? 1 : opacity;
		if (n.tag === "#text-block") {
			if (!n.text) return [];
			let runs = transformRuns(n.text.runs, s.textTransform);
			// background-clip:text leaves the glyphs transparent and shows the background through them.
			if (runs.some((r) => isTransparent(r.color)) && clipAncestor(n)) {
				const c = clipColor((clipAncestor(n) as RawNode).style);
				if (c) {
					runs = runs.map((r) =>
						isTransparent(r.color) ? { ...r, color: rgbaCss(c) } : r,
					);
					flags.push("approx:background-clip-text");
				} else flags.push("unsupported:background-clip-text");
			}
			return [
				{
					kind: "text",
					id,
					box,
					runs,
					lineCount: n.text.lineCount,
					...(n.text.rotation ? { rotation: n.text.rotation } : {}),
					align: ALIGN[s.textAlign as keyof typeof ALIGN] ?? "LEFT",
					opacity: alpha,
					flags,
				},
			];
		}

		const radii = parseRadii(s, box);
		if (n.img || n.slot?.src) {
			const fit = n.img?.objectFit ?? "";
			const [scaleMode, approx] = OBJECT_FIT[fit] ?? ["FILL", false];
			// fill (the <img> default) only stretches when the box changes the aspect ratio; under 1% Figma's crop is invisible.
			const im = n.img;
			const keepsAspect =
				fit === "fill" &&
				!!im?.naturalW &&
				!!im.naturalH &&
				Math.abs((box.w * im.naturalH) / (box.h * im.naturalW) - 1) < 0.01;
			if (approx && !keepsAspect) flags.push(`object-fit:${fit}`);
			const src = (n.img?.src ?? n.slot?.src) as string;
			return [
				{
					kind: "image",
					id,
					box,
					src,
					scaleMode,
					radii,
					opacity: alpha,
					flags,
				},
			];
		}
		if (n.slot) {
			const name = `Image slot · ${n.slot.placeholder}`;
			return [{ kind: "slot", id, box, name, radii, flags }];
		}
		if (n.svg !== undefined || n.iconClass) {
			// Lucide icons get their SVG filled in later, keyed by the flag.
			if (n.iconClass) flags.push(`icon:${n.iconClass}`);
			return [
				{ kind: "vector", id, box, svg: n.svg ?? "", opacity: alpha, flags },
			];
		}

		const children = (kids.get(id) ?? []).flatMap(build);
		// The background of a background-clip:text element shows only through its glyphs, not as a box.
		const fills = clipsText(s)
			? []
			: parseBackground(s.backgroundColor ?? "", s.backgroundImage ?? "");
		const strokes = strokesOf(s);
		const effects: Effect[] = parseShadows(s.boxShadow ?? "");
		const blur = backdropBlur(s);
		if (blur) effects.push({ type: "BACKGROUND_BLUR", radius: blur });
		const clip = (s.overflow ?? "visible")
			.split(/\s+/)
			.some((t) => t !== "visible");
		// Opacity and unsupported props also keep the node: dropping the wrapper would lose them.
		const draws =
			fills.length > 0 ||
			strokes !== null ||
			effects.length > 0 ||
			(clip && children.length > 0) ||
			alpha < 1 ||
			flags.length > 0;
		if (!draws) return children;
		return [
			{
				kind: "frame",
				id,
				box,
				fills,
				strokes,
				radii,
				effects,
				clip,
				opacity: alpha,
				children,
				flags,
			},
		];
	};

	// build() adds the unsupported-leaf flags as it goes, so run it before the flags are read.
	const tree = root ? (kids.get(root.id) ?? []).flatMap(build) : [];
	return {
		index: meta.index,
		name: meta.name,
		background: root
			? parseBackground(
					root.style.backgroundColor ?? "",
					root.style.backgroundImage ?? "",
				)
			: [],
		skipped: meta.skipped,
		notes: meta.notes,
		root: tree,
		flags: [...slideFlags],
	};
}
