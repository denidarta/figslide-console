import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { PACKAGE_ROOT } from "../resolve-package-root.js";

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
	throw new Error("unsupported image type (unrecognized bytes)");
}

function done(bytes: Uint8Array): ImageBytes {
	return { bytes, sha1: sha1Hex(bytes), mime: sniffMime(bytes) };
}

function decodeDataUri(src: string): Uint8Array {
	const comma = src.indexOf(",");
	if (comma < 0) throw new Error("malformed data URI");
	const payload = src.slice(comma + 1);
	return /;base64$/i.test(src.slice(0, comma))
		? Buffer.from(payload, "base64")
		: Buffer.from(decodeURIComponent(payload), "latin1");
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
	const res = await fetch(url);
	if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	await fs.mkdir(cacheDir, { recursive: true });
	await fs.writeFile(file, bytes);
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
