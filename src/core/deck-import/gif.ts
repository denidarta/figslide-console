import gifenc from "gifenc";
import { PNG } from "pngjs";
import type { DeckSession } from "./capture.js";
import { SLIDE_SIZE } from "./ops.js";
import type { Box } from "./types.js";
import { pauseForRecording, seekLoops, settleSlide } from "./walker.page.js";

const FPS = 30;
const SLOW_FPS = 15;
const MAX_FRAMES = 150;
const MAX_CYCLE_MS = 10_000;
const SCALE = 2;
/** Above this area (a quarter of the slide) a 2x recording is too heavy: record at 1x. */
const BIG_AREA = SLIDE_SIZE.w * SLIDE_SIZE.h * 0.25;
const BIG_BYTES = 5 * 1024 * 1024;
/** Frames and pixels per frame the shared palette is quantized from. */
const SAMPLE_FRAMES = 8;
const SAMPLE_PIXELS = 100_000;

/**
 * How a loop is recorded, bounded in cost: 30fps while the cycle fits 150 frames, else 15fps; a cycle
 * that still needs more is cut at 10s (`truncated`); a region over a quarter of the slide is recorded
 * at 1x instead of 2x.
 */
export function planLoop(
	box: Box,
	cycleMs: number,
): { fps: number; cycleMs: number; scale: number; truncated: boolean } {
	const frames = (fps: number, ms: number) => Math.ceil((ms * fps) / 1000);
	const fps = frames(FPS, cycleMs) > MAX_FRAMES ? SLOW_FPS : FPS;
	const truncated = frames(fps, cycleMs) > MAX_FRAMES;
	return {
		fps,
		cycleMs: truncated ? MAX_CYCLE_MS : cycleMs,
		scale: box.w * box.h > BIG_AREA ? 1 : SCALE,
		truncated,
	};
}

/**
 * One palette for the whole GIF: quantized from a strided sample of a few frames spread over the
 * cycle, so frames do not shimmer between per-frame palettes and the file carries one colour table.
 * ponytail: strided sampling can skip 1px detail; it still maps to the nearest palette colour.
 */
function sharedPalette(
	count: number,
	rgbaOf: (i: number) => Uint8Array,
): number[][] {
	const m = Math.min(SAMPLE_FRAMES, count);
	const picks = new Set<number>();
	for (let k = 0; k < m; k++)
		picks.add(Math.round((k * (count - 1)) / Math.max(1, m - 1)));
	const parts: Uint8Array[] = [];
	for (const i of picks) {
		const px = rgbaOf(i);
		const step = Math.max(1, Math.ceil(px.length / 4 / SAMPLE_PIXELS));
		const part = new Uint8Array(Math.ceil(px.length / 4 / step) * 4);
		for (let s = 0, d = 0; s < px.length; s += 4 * step, d += 4)
			part.set(px.subarray(s, s + 4), d);
		parts.push(part);
	}
	const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		all.set(p, at);
		at += p.length;
	}
	return gifenc.quantize(all, 256);
}

/**
 * Records `box` (slide-relative) of `slideIndex` for one `cycleMs` loop as a GIF that repeats
 * forever, within the cost bounds of planLoop. CSS/Web-animation loops are seeked frame by frame
 * (deterministic, on the loop's own timeline); JS/SMIL loops are recorded in real time at whatever
 * rate screenshots allow, each frame held for the time it actually took. The page stays on that
 * slide with animations paused; the next capture()/screenshot() re-settles it.
 * ponytail: the PNG of every frame is held until the palette exists (<= 150 frames, small regions).
 */
export async function recordLoop(
	session: DeckSession,
	slideIndex: number,
	box: Box,
	cycleMs: number,
): Promise<{
	bytes: Uint8Array;
	frames: number;
	warnBig: boolean;
	scale: number;
	truncated: boolean;
}> {
	if (!(cycleMs > 0))
		throw new Error(`recordLoop: cycleMs must be positive, got ${cycleMs}`);
	const plan = planLoop(box, cycleMs);
	const { page } = session;
	await page.evaluate(settleSlide, slideIndex);
	const { x, y, seekable } = await page.evaluate(
		pauseForRecording,
		slideIndex,
		box,
	);
	const clip = {
		x: x + box.x,
		y: y + box.y,
		width: box.w,
		height: box.h,
		scale: plan.scale,
	};

	const shots: { png: Buffer; at: number }[] = [];
	const start = Date.now();
	for (let i = 0; ; i++) {
		const at = seekable ? (i * 1000) / plan.fps : Date.now() - start;
		if (at >= plan.cycleMs) break;
		if (seekable) await page.evaluate(seekLoops, at);
		shots.push({
			png: Buffer.from(await page.screenshot({ type: "png", clip })),
			at,
		});
	}

	const palette = sharedPalette(
		shots.length,
		(i) => PNG.sync.read(shots[i].png).data,
	);
	const gif = gifenc.GIFEncoder();
	// GIF delays are whole centiseconds (33.3ms -> 30ms would run the loop 10% fast), so round the
	// frame boundaries rather than the gaps: the delays sum to the cycle. Under 2cs browsers
	// substitute 100ms. A frame is held until the next one starts.
	shots.forEach((shot, i) => {
		const frame = PNG.sync.read(shot.png);
		const until = i + 1 < shots.length ? shots[i + 1].at : plan.cycleMs;
		const cs = Math.max(2, Math.round(until / 10) - Math.round(shot.at / 10));
		gif.writeFrame(
			gifenc.applyPalette(frame.data, palette),
			frame.width,
			frame.height,
			{ palette: i === 0 ? palette : undefined, delay: cs * 10, repeat: 0 },
		);
	});
	gif.finish();
	const bytes = gif.bytes();
	return {
		bytes,
		frames: shots.length,
		warnBig: bytes.length > BIG_BYTES,
		scale: plan.scale,
		truncated: plan.truncated,
	};
}

/**
 * Base64 pieces of `bytes`, `chunkSize` input bytes each (rounded down to a multiple of 3 so no
 * piece is padded: they decode one by one or concatenated, to the same bytes).
 */
export function chunkBase64(
	bytes: Uint8Array,
	chunkSize = 512 * 1024,
): string[] {
	const step = Math.max(3, chunkSize - (chunkSize % 3));
	const out: string[] = [];
	for (let i = 0; i < bytes.length; i += step) {
		const n = Math.min(step, bytes.length - i);
		out.push(
			Buffer.from(bytes.buffer, bytes.byteOffset + i, n).toString("base64"),
		);
	}
	return out;
}
