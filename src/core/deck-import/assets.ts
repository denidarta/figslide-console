import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { PNG } from "pngjs";
import { PACKAGE_ROOT } from "../resolve-package-root.js";

const FETCH_TIMEOUT_MS = 30_000;

type ImageBytes = { bytes: Uint8Array; sha1: string; mime: string };

const sha1Hex = (b: Uint8Array | string) =>
	createHash("sha1").update(b).digest("hex");

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
	sig.every((v, i) => b[at + i] === v);

/** Sniffs PNG/JPEG/GIF/WEBP from magic bytes; Figma createImage only takes the first three. */
function sniffMime(b: Uint8Array): string {
	if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
	if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
	if (
		startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
		startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)
	) {
		throw new Error("unsupported image type webp");
	}
	// SVG isn't a createImage type; report it so the caller can build vector nodes instead.
	if (
		/^\s*<(?:svg\b|\?xml\b)/i.test(new TextDecoder().decode(b.subarray(0, 512)))
	) {
		return "image/svg+xml";
	}
	throw new Error("unsupported image type (unrecognized bytes)");
}

// figma.createImage throws "Image is too large" past this on either side.
const FIGMA_MAX_PX = 4096;

/** Box-filters a PNG down to fit FIGMA_MAX_PX. ponytail: PNG only; an oversize JPEG still fails upload (flagged). */
function fitPng(bytes: Uint8Array): Uint8Array {
	const b = Buffer.from(bytes);
	const w = b.readUInt32BE(16);
	const h = b.readUInt32BE(20);
	if (Math.max(w, h) <= FIGMA_MAX_PX) return bytes;
	const s = Math.max(w, h) / FIGMA_MAX_PX;
	const src = PNG.sync.read(b);
	const out = new PNG({
		width: Math.max(1, Math.round(w / s)),
		height: Math.max(1, Math.round(h / s)),
	});
	for (let y = 0; y < out.height; y++) {
		const y0 = Math.floor(y * s);
		const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * s)));
		for (let x = 0; x < out.width; x++) {
			const x0 = Math.floor(x * s);
			const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * s)));
			const sum = [0, 0, 0, 0];
			for (let sy = y0; sy < y1; sy++)
				for (let sx = x0; sx < x1; sx++)
					for (let c = 0; c < 4; c++) sum[c] += src.data[(sy * w + sx) * 4 + c];
			const n = (y1 - y0) * (x1 - x0);
			for (let c = 0; c < 4; c++)
				out.data[(y * out.width + x) * 4 + c] = Math.round(sum[c] / n);
		}
	}
	return PNG.sync.write(out);
}

function done(raw: Uint8Array): ImageBytes {
	const mime = sniffMime(raw);
	const bytes = mime === "image/png" ? fitPng(raw) : raw;
	return { bytes, sha1: sha1Hex(bytes), mime };
}

function decodeDataUri(src: string): Uint8Array {
	const comma = src.indexOf(",");
	if (comma < 0) throw new Error("malformed data URI");
	const payload = src.slice(comma + 1);
	if (/;base64$/i.test(src.slice(0, comma)))
		return Buffer.from(payload, "base64");
	// Byte-wise: decodeURIComponent would treat %c3%a9 as one UTF-8 char and throw on %89.
	return Buffer.from(
		payload.replace(/%([0-9a-f]{2})/gi, (_, h) =>
			String.fromCharCode(Number.parseInt(h, 16)),
		),
		"latin1",
	);
}

function resolveInside(src: string, srcDir: string): string {
	const outside = () => new Error(`image path is outside srcDir: ${src}`);
	if (path.isAbsolute(src) || /^[A-Za-z]:|^[/\\]/.test(src)) throw outside();
	const abs = path.resolve(srcDir, src);
	const rel = path.relative(path.resolve(srcDir), abs);
	if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
		throw outside();
	return abs;
}

async function readRelative(src: string, srcDir: string): Promise<Uint8Array> {
	const abs = resolveInside(src, srcDir);
	if (!/\.webp$/i.test(abs)) return fs.readFile(abs);
	// Figma can't take webp; the sample ships a .png/.jpg twin beside each .webp.
	for (const ext of [".png", ".jpg", ".jpeg"]) {
		try {
			return await fs.readFile(abs.replace(/\.webp$/i, ext));
		} catch {}
	}
	throw new Error("unsupported image type webp");
}

async function fetchCached(url: string, cacheDir: string): Promise<Uint8Array> {
	const file = path.join(cacheDir, sha1Hex(url));
	try {
		return await fs.readFile(file);
	} catch {}
	let bytes: Uint8Array;
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(String(res.status));
		bytes = new Uint8Array(await res.arrayBuffer());
	} catch (e) {
		throw new Error(
			`fetch ${url} failed: ${e instanceof Error ? e.message : e}`,
		);
	}
	sniffMime(bytes); // don't cache a 200 HTML error page as if it were an image
	await fs.mkdir(cacheDir, { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		await fs.writeFile(tmp, bytes);
		await fs.rename(tmp, file);
	} catch (e) {
		await fs.rm(tmp, { force: true });
		throw e;
	}
	return bytes;
}

/** `src` is a srcDir-relative path (must stay inside srcDir), a `data:` URI, or an http(s) URL (cached by sha1 of the URL). */
export async function loadImageBytes(
	src: string,
	srcDir: string,
	cacheDir: string,
): Promise<ImageBytes> {
	if (/^data:/i.test(src)) return done(decodeDataUri(src));
	if (/^https?:\/\//i.test(src)) return done(await fetchCached(src, cacheDir));
	return done(await readRelative(src, srcDir));
}

let iconsDir: string | undefined;

/** Lucide SVG markup for a class like `icon-phone`, or null when there is no such icon. */
export function lucideSvg(iconClass: string): string | null {
	const name = iconClass.replace(/^icon-/, "");
	if (!/^[a-z0-9-]+$/.test(name)) return null;
	iconsDir ??= path.join(
		path.dirname(
			createRequire(path.join(PACKAGE_ROOT, "package.json")).resolve(
				"lucide-static/package.json",
			),
		),
		"icons",
	);
	try {
		// Files start with a license comment; callers want the bare <svg>.
		return readFileSync(path.join(iconsDir, `${name}.svg`), "utf8").replace(
			/^<!--[\s\S]*?-->\s*/,
			"",
		);
	} catch {
		return null;
	}
}
