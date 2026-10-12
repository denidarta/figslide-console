import gifenc from "gifenc";
import { PNG } from "pngjs";
import type { DeckSession } from "./capture.js";
import type { Box } from "./types.js";
import { pauseForRecording, seekLoops, settleSlide } from "./walker.page.js";

const FPS = 30;
const SCALE = 2;
const BIG_BYTES = 5 * 1024 * 1024;

/**
 * Records `box` (slide-relative) of `slideIndex` for one `cycleMs` loop as a GIF that repeats
 * forever. CSS/Web-animation loops are seeked frame by frame (deterministic, 30fps on the loop's
 * own timeline); JS/SMIL loops are recorded in real time at whatever rate screenshots allow, each
 * frame held for the time it actually took. The page stays on that slide with animations paused;
 * the next capture()/screenshot() re-settles it.
 */
export async function recordLoop(
	session: DeckSession,
	slideIndex: number,
	box: Box,
	cycleMs: number,
): Promise<{ bytes: Uint8Array; frames: number; warnBig: boolean }> {
	if (!(cycleMs > 0))
		throw new Error(`recordLoop: cycleMs must be positive, got ${cycleMs}`);
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
		scale: SCALE,
	};

	const gif = gifenc.GIFEncoder();
	let frames = 0;
	// A frame is held for the gap to the next one, so it is written one step late.
	let held:
		| {
				index: Uint8Array;
				palette: number[][];
				w: number;
				h: number;
				at: number;
		  }
		| undefined;
	// GIF delays are whole centiseconds (33.3ms -> 30ms would run the loop 10% fast), so round the
	// frame boundaries rather than the gaps: the delays sum to the cycle. Under 2cs browsers
	// substitute 100ms.
	const flush = (until: number) => {
		if (!held) return;
		const cs = Math.max(2, Math.round(until / 10) - Math.round(held.at / 10));
		gif.writeFrame(held.index, held.w, held.h, {
			palette: held.palette,
			delay: cs * 10,
			repeat: 0,
		});
		frames++;
	};

	const start = Date.now();
	for (let i = 0; ; i++) {
		const at = seekable ? (i * 1000) / FPS : Date.now() - start;
		if (at >= cycleMs) break;
		if (seekable) await page.evaluate(seekLoops, at);
		const shot = PNG.sync.read(
			Buffer.from(await page.screenshot({ type: "png", clip })),
		);
		const rgba = shot.data;
		const palette = gifenc.quantize(rgba, 256);
		flush(at);
		held = {
			index: gifenc.applyPalette(rgba, palette),
			palette,
			w: shot.width,
			h: shot.height,
			at,
		};
	}
	flush(cycleMs);
	gif.finish();
	const bytes = gif.bytes();
	return { bytes, frames, warnBig: bytes.length > BIG_BYTES };
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
