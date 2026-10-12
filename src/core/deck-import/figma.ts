import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chunkBase64 } from "./gif.js";
import { SLIDE_SIZE, buildOps, figmaPaints } from "./ops.js";
import { RUNTIME_SOURCE } from "./runtime.plugin.js";
import type { FigmaDumpNode, SlideIR } from "./types.js";

const TIMEOUT_MS = 60_000;

/** The plugin's EXECUTE_CODE wraps failures as "Error: message". */
const clean = (m: string) => m.replace(/^\w*Error: /, "");

/**
 * Drives the deck-import runtime inside the Figma Desktop Bridge plugin. `connector` is the
 * FigmaConnector (only executeCodeViaUI and captureScreenshot are used).
 */
export class FigmaDeck {
	private uploaded = new Map<string, string>(); // sha1 of the bytes -> Figma image hash
	private chunkSize?: number;

	constructor(
		// biome-ignore lint/suspicious/noExplicitAny: structural connector, also faked in tests
		private connector: any,
		opts: { chunkSize?: number } = {},
	) {
		this.chunkSize = opts.chunkSize;
	}

	// biome-ignore lint/suspicious/noExplicitAny: result shape depends on the command
	private async run(cmd: object): Promise<any> {
		// JSON is valid JS except for these two line terminators, which older engines reject in string literals.
		const arg = JSON.stringify(cmd)
			.replaceAll(String.fromCharCode(0x2028), "\\u2028")
			.replaceAll(String.fromCharCode(0x2029), "\\u2029");
		const res = await this.connector.executeCodeViaUI(
			`${RUNTIME_SOURCE}\nreturn await __deckImport(${arg})`,
			TIMEOUT_MS,
		);
		if (!res?.success)
			throw new Error(clean(String(res?.error ?? "Figma execution failed")));
		return res.result;
	}

	/** Uploads an image once per distinct content; returns its Figma image hash. */
	async uploadImage(key: string, bytes: Uint8Array): Promise<string> {
		if (bytes.length === 0)
			throw new Error(`Cannot upload empty image: ${key}`);
		const sha = createHash("sha1").update(bytes).digest("hex");
		const known = this.uploaded.get(sha);
		if (known) return known;

		const parts = chunkBase64(bytes, this.chunkSize);
		let hash: string | undefined;
		for (let i = 0; i < parts.length; i++) {
			const r = await this.run({
				cmd: "uploadChunk",
				key,
				index: i,
				total: parts.length,
				b64: parts[i],
			});
			if (r?.error === "chunks lost") {
				// The plugin context did not keep the earlier chunks: send everything in one call.
				// (Every piece but the last is a multiple of 3 bytes, so the pieces join into valid base64.)
				const whole = await this.run({
					cmd: "uploadChunk",
					key,
					index: 0,
					total: 1,
					b64: parts.join(""),
				});
				hash = whole.hash;
				break;
			}
			hash = r.hash;
		}
		if (!hash) throw new Error(`Figma did not return a hash for ${key}`);
		this.uploaded.set(sha, hash);
		return hash;
	}

	/**
	 * Builds the slide (and, when it has entrances, its start-state copy placed before it). `hashes` maps
	 * image src / gifKey to Figma image hashes. With `replaceIds` the slide takes the first replaced slide's
	 * place and the replaced slides are removed. Once the slide exists this never throws: a failed entrance
	 * comes back as an `entrance-failed` warning without `enterSlideId`.
	 */
	async buildSlide(
		slide: SlideIR,
		hashes: Map<string, string>,
		replaceIds?: string[],
	): Promise<{ slideId: string; enterSlideId?: string; warnings: string[] }> {
		const built = await this.run({
			cmd: "buildSlide",
			slide: {
				name: slide.name,
				background: figmaPaints(slide.background, SLIDE_SIZE),
				skipped: slide.skipped,
				notes: slide.notes,
			},
			ops: buildOps(slide, hashes),
			replaceIds,
		});
		const warnings: string[] = built.warnings ?? [];
		if (!slide.entrance) return { slideId: built.slideId, warnings };
		const { start, durationS, curve } = slide.entrance;
		// The slide exists now, so an entrance failure is a warning, not an error (the runtime removes
		// a half-made start copy itself).
		try {
			const entered = await this.run({
				cmd: "makeEntrance",
				slideId: built.slideId,
				start,
				transition: { duration: durationS, curve },
			});
			return {
				slideId: built.slideId,
				enterSlideId: entered.enterSlideId,
				warnings,
			};
		} catch (e) {
			warnings.push(
				`entrance-failed: ${e instanceof Error ? e.message : String(e)}`,
			);
			return { slideId: built.slideId, warnings };
		}
	}

	async dump(slideId: string): Promise<FigmaDumpNode> {
		return this.run({ cmd: "dump", slideId });
	}

	/** Saves a PNG of the slide. The bridge caps the export at 1568px on the longest side. */
	async screenshot(slideId: string, outPath: string): Promise<void> {
		const res = await this.connector.captureScreenshot(slideId, {
			format: "PNG",
			scale: 1,
		});
		const b64 = (res?.image ?? res)?.base64;
		if (res?.success === false || !b64)
			throw new Error(res?.error ?? "Screenshot returned no image");
		await fs.mkdir(path.dirname(outPath), { recursive: true });
		await fs.writeFile(outPath, Buffer.from(b64, "base64"));
	}

	async patch(nodeId: string, props: Record<string, unknown>): Promise<void> {
		await this.run({ cmd: "patch", nodeId, props });
	}
}
