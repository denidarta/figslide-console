import type { Box, Curve, Effect, Paint, RGBA } from "./types.js";

/** Split on commas that are not inside parentheses. */
function splitTop(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "(") depth++;
		else if (c === ")") depth--;
		else if (c === "," && depth === 0) {
			out.push(s.slice(start, i));
			start = i + 1;
		}
	}
	out.push(s.slice(start));
	return out.map((p) => p.trim()).filter(Boolean);
}

/** One `rgb()/rgba()/#hex/transparent` token, alpha 0 kept. Named colors are unsupported (computed style never has them). */
export function parseColorRaw(css: string): RGBA | null {
	const s = css.trim().toLowerCase();
	if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
	const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
	if (hex) {
		let h = hex[1];
		if (h.length <= 4) h = [...h].map((c) => c + c).join("");
		const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16) / 255;
		return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
	}
	const fn = /^rgba?\(([^)]+)\)$/.exec(s);
	if (!fn) return null;
	const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
	if (parts.length < 3 || parts.length > 4) return null;
	const chan = (p: string) =>
		(p.endsWith("%") ? Number.parseFloat(p) * 2.55 : Number.parseFloat(p)) /
		255;
	const [r, g, b] = parts.slice(0, 3).map(chan);
	const a =
		parts.length === 4
			? parts[3].endsWith("%")
				? Number.parseFloat(parts[3]) / 100
				: Number.parseFloat(parts[3])
			: 1;
	if ([r, g, b, a].some((v) => Number.isNaN(v))) return null;
	return { r, g, b, a };
}

/** `rgb/rgba/hex` -> RGBA (0..1). `transparent` and alpha 0 return null. */
export function parseColor(css: string): RGBA | null {
	const c = parseColorRaw(css);
	return c && c.a > 0 ? c : null;
}

function parseAngle(s: string): number {
	const t = s.trim().toLowerCase();
	const norm = (v: number) => ((v % 360) + 360) % 360;
	const m = /^(-?[\d.]+)(deg|grad|rad|turn)?$/.exec(t);
	if (m) {
		const k = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }[
			m[2] ?? "deg"
		] as number;
		return norm(Number.parseFloat(m[1]) * k);
	}
	const words = t.replace(/^to\s+/, "").split(/\s+/);
	const has = (w: string) => words.includes(w);
	// ponytail: corner keywords use fixed 45deg diagonals; CSS derives them from the box aspect ratio.
	if (has("top") && has("right")) return 45;
	if (has("bottom") && has("right")) return 135;
	if (has("bottom") && has("left")) return 225;
	if (has("top") && has("left")) return 315;
	if (has("top")) return 0;
	if (has("right")) return 90;
	if (has("left")) return 270;
	return 180;
}

/** Evenly distribute stops that have no `%` position, keeping positions monotonic. */
function fillPositions(raw: { color: RGBA; pos: number | null }[]) {
	const n = raw.length;
	if (raw[0].pos === null) raw[0].pos = 0;
	if (raw[n - 1].pos === null) raw[n - 1].pos = 1;
	let prev = 0;
	for (const s of raw) {
		if (s.pos !== null) {
			s.pos = Math.min(Math.max(s.pos, prev), 1);
			prev = s.pos;
		}
	}
	for (let i = 1; i < n - 1; i++) {
		if (raw[i].pos !== null) continue;
		let j = i;
		while (raw[j].pos === null) j++;
		const a = raw[i - 1].pos as number;
		const b = raw[j].pos as number;
		for (let k = i; k < j; k++)
			raw[k].pos = a + ((b - a) * (k - i + 1)) / (j - i + 1);
	}
	return raw.map((s) => ({ pos: s.pos as number, color: s.color }));
}

function parseGradient(layer: string): Paint | null {
	const m = /^(linear|radial)-gradient\((.*)\)$/s.exec(layer);
	if (!m) return null;
	const args = splitTop(m[2]);
	const startsWithColor = (a: string) => {
		const tok = /^(rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+)/i.exec(a)?.[0];
		return !!tok && parseColorRaw(tok) !== null;
	};
	let angleDeg = m[1] === "linear" ? 180 : 0;
	if (args.length && !startsWithColor(args[0])) {
		const prelude = args.shift() as string;
		if (m[1] === "linear") angleDeg = parseAngle(prelude);
	}
	const raw: { color: RGBA; pos: number | null }[] = [];
	for (const a of args) {
		const sm = /^(rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+)\s*(.*)$/i.exec(a);
		const color = sm && parseColorRaw(sm[1]);
		if (!sm || !color) continue; // color hints / unsupported tokens
		// ponytail: only `%` positions; px/em positions are treated as unspecified (no box here).
		const pcts = sm[2]
			.split(/\s+/)
			.filter((p) => p.endsWith("%"))
			.map((p) => Number.parseFloat(p) / 100);
		if (pcts.length === 0) raw.push({ color, pos: null });
		for (const pos of pcts.slice(0, 2)) raw.push({ color, pos });
	}
	if (raw.length < 2) return null;
	return {
		type: m[1] === "linear" ? "GRADIENT_LINEAR" : "GRADIENT_RADIAL",
		angleDeg,
		stops: fillPositions(raw),
	};
}

/** Figma fills are bottom-to-top: background-color first, then CSS layers reversed (CSS lists the top layer first). `url()` layers are ignored. */
export function parseBackground(bgColor: string, bgImage: string): Paint[] {
	const fills: Paint[] = [];
	const color = parseColor(bgColor);
	if (color) fills.push({ type: "SOLID", color });
	for (const layer of splitTop(bgImage).reverse()) {
		const g = parseGradient(layer);
		if (g) fills.push(g);
	}
	return fills;
}

/** Chrome computed order: `<color> <x> <y> <blur> <spread> [inset]`, comma separated. */
export function parseShadows(boxShadow: string): Effect[] {
	const s = boxShadow.trim();
	if (!s || s === "none") return [];
	return splitTop(s).flatMap((part): Effect[] => {
		const cm = /rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/i.exec(part);
		const color = cm && parseColorRaw(cm[0]);
		if (!cm || !color) return [];
		const [x = 0, y = 0, blur = 0, spread = 0] = part
			.replace(cm[0], "")
			.replace(/\binset\b/i, "")
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map((n) => Number.parseFloat(n) || 0);
		const type = /\binset\b/i.test(part) ? "INNER_SHADOW" : "DROP_SHADOW";
		return [{ type, color, x, y, blur, spread }];
	});
}

const RADIUS_KEYS = [
	"borderTopLeftRadius",
	"borderTopRightRadius",
	"borderBottomRightRadius",
	"borderBottomLeftRadius",
] as const;

/** [topLeft, topRight, bottomRight, bottomLeft]. `%` resolves against the box; elliptical `h v` collapses to the smaller; clamped to min(w,h)/2. */
export function parseRadii(
	style: Record<string, string>,
	box: Box,
): [number, number, number, number] {
	const max = Math.min(box.w, box.h) / 2;
	const len = (tok: string, ref: number) =>
		tok.endsWith("%")
			? (Number.parseFloat(tok) / 100) * ref
			: Number.parseFloat(tok);
	return RADIUS_KEYS.map((k) => {
		const [h, v = h] = (style[k] ?? "").trim().split(/\s+/);
		if (!h) return 0;
		const r = Math.min(len(h, box.w), len(v, box.h));
		return Number.isFinite(r) ? Math.min(Math.max(r, 0), max) : 0;
	}) as [number, number, number, number];
}

/** Figma letter spacing is a percent of the font size. */
export function letterSpacingPercent(
	letterSpacing: string,
	fontSizePx: number,
): number {
	const m = /^(-?[\d.]+)(px|em)$/.exec(letterSpacing.trim());
	if (!m) return 0; // `normal` and anything unparseable
	const v = Number.parseFloat(m[1]);
	if (m[2] === "em") return v * 100;
	return fontSizePx > 0 ? (v / fontSizePx) * 100 : 0;
}

const WEIGHT_NAMES = [
	"Thin",
	"ExtraLight",
	"Light",
	"Regular",
	"Medium",
	"SemiBold",
	"Bold",
	"ExtraBold",
	"Black",
];
const WEIGHT_ALIASES: Record<string, number> = {
	thin: 100,
	hairline: 100,
	extralight: 200,
	ultralight: 200,
	light: 300,
	regular: 400,
	normal: 400,
	book: 400,
	medium: 500,
	semibold: 600,
	demibold: 600,
	bold: 700,
	extrabold: 800,
	ultrabold: 800,
	black: 900,
	heavy: 900,
};

function styleInfo(style: string): { weight: number; italic: boolean } | null {
	const italic = /italic|oblique/i.test(style);
	const key = style.toLowerCase().replace(/italic|oblique|[\s_-]/g, "");
	const weight = key === "" ? 400 : WEIGHT_ALIASES[key];
	return weight === undefined ? null : { weight, italic };
}

/**
 * Nearest available Figma style for a CSS weight (ties go to the lighter one); `exact` is true only on an
 * identical weight (and requested slant). Without any usable `available` entry returns the canonical name.
 * `_family` is reserved for per-family overrides.
 */
export function mapFontWeight(
	_family: string,
	weight: number,
	available: string[],
	italic = false,
): { style: string; exact: boolean } {
	const cands = available.flatMap((name) => {
		const info = styleInfo(name);
		return info ? [{ name, ...info }] : [];
	});
	// no italic face -> nearest upright, never exact
	const sameSlant = cands.filter((c) => c.italic === italic);
	const pool = sameSlant.length ? sameSlant : cands;
	if (pool.length) {
		let best = pool[0];
		for (const c of pool) {
			const d = Math.abs(c.weight - weight);
			const bd = Math.abs(best.weight - weight);
			if (d < bd || (d === bd && c.weight < best.weight)) best = c;
		}
		return {
			style: best.name,
			exact: sameSlant.length > 0 && best.weight === weight,
		};
	}
	const base =
		WEIGHT_NAMES[Math.min(Math.max(Math.ceil(weight / 100 - 0.5), 1), 9) - 1];
	return {
		style: italic ? (base === "Regular" ? "Italic" : `${base} Italic`) : base,
		exact: false,
	};
}

const BEZIERS = new Map<string, [number, number, number, number]>([
	["linear", [0, 0, 1, 1]],
	["ease", [0.25, 0.1, 0.25, 1]],
	["ease-in", [0.42, 0, 1, 1]],
	["ease-out", [0, 0, 0.58, 1]],
	["ease-in-out", [0.42, 0, 0.58, 1]],
]);

/**
 * Classify by how each control point sits against the diagonal: s = y1-x1 (> 0 fast start),
 * e = y2-x2 (> 0 slow end). Both ~0 -> LINEAR; fast/neutral start + slow end -> OUT;
 * slow start + fast end -> IN; anything else (incl. `ease`, steps, unparseable) -> IN_AND_OUT.
 */
export function mapEasing(css: string): Curve {
	const first =
		/^cubic-bezier\([^)]*\)|^[a-z-]+/.exec(css.trim().toLowerCase())?.[0] ?? "";
	let p = BEZIERS.get(first);
	if (!p) {
		const n = /^cubic-bezier\(([^)]*)\)$/
			.exec(first)?.[1]
			.split(",")
			.map(Number.parseFloat);
		if (n?.length === 4 && n.every(Number.isFinite))
			p = n as [number, number, number, number];
	}
	if (!p) return "EASE_IN_AND_OUT";
	const [x1, y1, x2, y2] = p;
	const s = y1 - x1;
	const e = y2 - x2;
	if (Math.abs(s) < 0.05 && Math.abs(e) < 0.05) return "LINEAR";
	if (s >= -0.1 && e > 0.2) return "EASE_OUT";
	if (s < -0.1 && e <= 0.2) return "EASE_IN";
	return "EASE_IN_AND_OUT";
}
