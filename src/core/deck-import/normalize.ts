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

/**
 * What a computed transform does that the IR cannot draw: a 3D turn (z parts set), a mirror (negative
 * determinant), or a rotation / skew (b or c set, or a 180deg turn, which flips both axes). Translate and
 * scale draw correctly. null when none.
 */
function transformFlag(transform: string | undefined): string | null {
	const m = /^matrix(3d)?\(([^)]*)\)$/.exec((transform ?? "").trim());
	if (!m) return null;
	const v = m[2].split(",").map((x) => Number.parseFloat(x));
	const set = (x: number) => Math.abs(x) > 1e-6;
	// matrix3d is column-major: m13, m23, m31, m32 tilt the plane out of the screen
	if (m[1] && [v[2], v[6], v[8], v[9]].some(set))
		return "unsupported:transform-3d";
	const [a, b, c, d] = m[1] ? [v[0], v[1], v[4], v[5]] : v;
	if (a * d - b * c < 0) return "unsupported:transform-mirror";
	if (set(b) || set(c) || a < 0) return "unsupported:transform-rotate";
	return null;
}

/** An exact half turn (rotate(180deg), possibly scaled): both axes flip, nothing skews. The IR can draw it. */
function isHalfTurn(transform: string | undefined): boolean {
	const m = /^matrix\(([^)]*)\)$/.exec((transform ?? "").trim());
	if (!m) return false;
	const [a, b, c, d] = m[1].split(",").map((x) => Number.parseFloat(x));
	return Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && a < 0 && d < 0;
}

/** Corner radii of a box seen after a half turn: top-left swaps with bottom-right, top-right with bottom-left. */
const halfTurnRadii = (r: [number, number, number, number]): typeof r => [r[2], r[3], r[0], r[1]];

/** Features the IR cannot carry, so the report can name them. */
function flagsOf(s: Style): string[] {
	const f: string[] = [];
	const turn = transformFlag(s.transform);
	if (turn) f.push(turn);
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

/** Id suffix of an img / svg / icon drawn inside the frame that carries its box styling. */
export const CONTENT_SUFFIX = "-c";

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
	/** True when `n` or an ancestor is a loop owner: its whole subtree is recorded into the gif. */
	const inLoop = (n: RawNode): boolean => {
		for (let p: RawNode | undefined = n; p; p = p.parentId ? byId.get(p.parentId) : undefined)
			if (p.loop) return true;
		return false;
	};
	// Dropped silently otherwise: a visible ::before/::after has no node of its own to carry a flag.
	// One inside a loop region is drawn into its gif, so it is not lost.
	const slideFlags = new Set(root ? flagsOf(root.style) : []);
	for (const n of nodes)
		if (n.pseudo && !n.hidden && !inLoop(n))
			slideFlags.add("unsupported:pseudo-element");

	/**
	 * `turned`: an ancestor rotates, mirrors or tilts, which the IR draws upright.
	 * `half`: the element sits under an odd number of exact half turns. Corner radii swap and
	 * vectors turn; those are the parts the IR can draw, so a half turn itself is not flagged.
	 */
	const build = (n: RawNode, turned: boolean, halfAbove = false): NodeIR[] => {
		// A loop owner is measured at t=0 and may look hidden (e.g. collapsed); it is still a gif.
		if (n.hidden && !n.loop) return [];
		const s = n.style;
		const flags = flagsOf(s);
		const ownHalf = isHalfTurn(s.transform);
		if (ownHalf) flags.splice(flags.indexOf("unsupported:transform-rotate"), 1);
		const half = halfAbove !== ownHalf;
		const { id, box } = n;
		const cornerRadii = () => {
			const r = parseRadii(s, box);
			return half ? halfTurnRadii(r) : r;
		};
		if (n.loop)
			return [{ kind: "gif", id, box, gifKey: id, radii: cornerRadii(), flags }];
		if (UNSUPPORTED_LEAF.test(n.tag)) slideFlags.add(`unsupported:${n.tag}`);

		const opacity = Number.parseFloat(s.opacity ?? "1");
		const alpha = Number.isNaN(opacity) ? 1 : opacity;
		if (n.tag === "#text-block") {
			if (!n.text) return [];
			// Vertical text already folds its ancestors' turns into its own rotation (walker).
			if (turned && !n.text.rotation) flags.push("unsupported:rotated-parent");
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
			// -webkit-text-stroke: Figma strokes a whole text node, so one stroke serves every run.
			const stroked = runs.filter((r) => r.strokeWidth && r.strokeColor);
			const strokeColor = stroked[0] && parseColor(stroked[0].strokeColor as string);
			const stroke = strokeColor
				? { color: strokeColor, weight: stroked[0].strokeWidth as number }
				: undefined;
			if (
				stroke &&
				runs.some(
					(r) =>
						r.chars.trim() &&
						(r.strokeWidth !== stroke.weight ||
							r.strokeColor !== stroked[0].strokeColor),
				)
			)
				flags.push("approx:text-stroke-mixed");
			return [
				{
					kind: "text",
					id,
					box,
					runs,
					lineCount: n.text.lineCount,
					...(n.text.rotation ? { rotation: n.text.rotation } : {}),
					...(n.text.lineHeights ? { lineHeights: n.text.lineHeights } : {}),
					...(stroke ? { stroke } : {}),
					align: ALIGN[s.textAlign as keyof typeof ALIGN] ?? "LEFT",
					opacity: alpha,
					flags,
				},
			];
		}

		const radii = cornerRadii();
		/**
		 * img / svg / icon leaves draw their own content; a background, border or shadow on the element
		 * goes on a frame around it, and the content sits in the content box (inside border and padding).
		 */
		const leaf = (
			content: NodeIR & { kind: "image" | "vector" },
			own: string[],
		): NodeIR[] => {
			const px = (k: string) => Number.parseFloat(s[k] ?? "") || 0;
			const inset = ["Top", "Right", "Bottom", "Left"].map(
				(k) => px(`border${k}Width`) + px(`padding${k}`),
			);
			const inner = {
				x: box.x + inset[3],
				y: box.y + inset[0],
				w: Math.max(0, box.w - inset[1] - inset[3]),
				h: Math.max(0, box.h - inset[0] - inset[2]),
			};
			const moved = inset.some((v) => v > 0) ? inner : box;
			// Inner corners shrink by the inset on either side (CSS clamps them at 0).
			const innerRadii = radii.map((r, i) =>
				Math.max(0, r - Math.max(inset[i], inset[(i + 3) % 4])),
			) as typeof radii;
			const fills = parseBackground(
				s.backgroundColor ?? "",
				s.backgroundImage ?? "",
			);
			const strokes = strokesOf(s);
			const effects = parseShadows(s.boxShadow ?? "");
			if (!fills.length && !strokes && !effects.length)
				return [
					{
						...content,
						box: moved,
						...(content.kind === "image" ? { radii: innerRadii } : {}),
						flags: [...flags, ...own],
					},
				];
			return [
				{
					kind: "frame",
					id,
					box,
					fills,
					strokes,
					radii,
					effects,
					clip: false,
					opacity: alpha,
					children: [
						{
							...content,
							id: `${id}${CONTENT_SUFFIX}`,
							box: moved,
							...(content.kind === "image" ? { radii: innerRadii } : {}),
							opacity: 1,
							flags: own,
						},
					],
					flags,
				},
			];
		};
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
			const src = (n.img?.src ?? n.slot?.src) as string;
			return leaf(
				{
					kind: "image",
					id,
					box,
					src,
					scaleMode,
					radii,
					opacity: alpha,
					flags: [],
				},
				approx && !keepsAspect ? [`object-fit:${fit}`] : [],
			);
		}
		if (n.slot) {
			const name = `Image slot · ${n.slot.placeholder}`;
			return [{ kind: "slot", id, box, name, radii, flags }];
		}
		if (n.svg !== undefined || n.iconClass) {
			// Lucide icons get their SVG filled in later, keyed by the flag.
			return leaf(
				{
					kind: "vector",
					id,
					box,
					svg: n.svg ?? "",
					opacity: alpha,
					...(half ? { rotation: 180 } : {}),
					flags: [],
				},
				n.iconClass ? [`icon:${n.iconClass}`] : [],
			);
		}

		const turns =
			turned || ownHalf || flags.some((f) => f.startsWith("unsupported:transform-"));
		const children = (kids.get(id) ?? []).flatMap((c) => build(c, turns, half));
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
	const rootTurns = !!root && transformFlag(root.style.transform) !== null;
	const tree = root
		? (kids.get(root.id) ?? []).flatMap((c) => build(c, rootTurns))
		: [];
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
