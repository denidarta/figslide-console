// gifenc ships no types. It is a CommonJS bundle, so only the default import carries its API
// under Node ESM (named imports are not detected).
declare module "gifenc" {
	type Palette = number[][];
	const gifenc: {
		GIFEncoder(): {
			writeFrame(
				index: Uint8Array,
				width: number,
				height: number,
				opts?: { palette?: Palette; delay?: number; repeat?: number },
			): void;
			finish(): void;
			bytes(): Uint8Array;
		};
		quantize(rgba: Uint8Array, maxColors: number): Palette;
		applyPalette(rgba: Uint8Array, palette: Palette): Uint8Array;
	};
	export default gifenc;
}
