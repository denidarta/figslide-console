export type Box = { x: number; y: number; w: number; h: number };

export interface RawNode {
	// one rendered element, from the page walker
	id: string; // importId, e.g. "s3-n42"; stable per (slideIndex, DOM order)
	parentId: string | null;
	tag: string; // lowercased; "#text-block" for text blocks
	box: Box; // slide-relative, unscaled
	style: Record<string, string>; // computed style subset (see Task 3)
	text?: { runs: TextRun[]; lineCount: number };
	svg?: string; // outerHTML for inline <svg>
	img?: { src: string; naturalW: number; naturalH: number; objectFit: string };
	iconClass?: string; // e.g. "icon-phone" for Lucide font icons
	slot?: { placeholder: string; shape: string; src?: string };
	loop?: boolean; // has infinite/JS-driven animation in subtree root
	hidden?: boolean;
}
export interface TextRun {
	chars: string;
	fontFamily: string;
	fontWeight: number;
	fontStyle: string;
	fontSize: number;
	color: string;
	letterSpacing: string;
	lineHeight: string;
	textDecoration: string;
}
export interface RawAnim {
	nodeId: string;
	name: string;
	iterations: number;
	delayMs: number;
	durationMs: number;
	easing: string;
	firstKeyframe: Record<string, string>;
}

export type NodeIR =
	| {
			kind: "frame";
			id: string;
			box: Box;
			fills: Paint[];
			strokes: StrokeIR | null;
			radii: [number, number, number, number];
			effects: Effect[];
			clip: boolean;
			opacity: number;
			children: NodeIR[];
			flags: string[];
	  }
	| {
			kind: "text";
			id: string;
			box: Box;
			runs: TextRun[];
			lineCount: number;
			align: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
			opacity: number;
			flags: string[];
	  }
	| {
			kind: "image";
			id: string;
			box: Box;
			src: string;
			scaleMode: "FILL" | "FIT" | "CROP" | "TILE";
			radii: [number, number, number, number];
			opacity: number;
			flags: string[];
	  }
	| {
			kind: "vector";
			id: string;
			box: Box;
			svg: string;
			opacity: number;
			flags: string[];
	  }
	| {
			kind: "slot";
			id: string;
			box: Box;
			name: string;
			radii: [number, number, number, number];
			flags: string[];
	  }
	| { kind: "gif"; id: string; box: Box; gifKey: string; flags: string[] };
export interface StrokeIR {
	color: RGBA;
	weights: [number, number, number, number];
	dashed: boolean;
} // top,right,bottom,left
export type RGBA = { r: number; g: number; b: number; a: number }; // 0..1
export type Paint =
	| { type: "SOLID"; color: RGBA }
	| {
			type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL";
			stops: { pos: number; color: RGBA }[];
			angleDeg: number;
	  };
export type Effect =
	| {
			type: "DROP_SHADOW" | "INNER_SHADOW";
			color: RGBA;
			x: number;
			y: number;
			blur: number;
			spread: number;
	  }
	| { type: "BACKGROUND_BLUR" | "LAYER_BLUR"; radius: number };

export interface EntranceIR {
	durationS: number;
	curve: Curve;
	start: Record<
		string,
		{ opacity?: number; dx?: number; dy?: number; scale?: number }
	>;
}
export type Curve =
	| "EASE_IN"
	| "EASE_OUT"
	| "EASE_IN_AND_OUT"
	| "LINEAR"
	| "GENTLE"
	| "QUICK"
	| "BOUNCY"
	| "SLOW";
export interface FigmaDumpNode {
	id: string;
	importId: string | null;
	type: string;
	name: string;
	box: Box;
	visible: boolean;
	fills: { type: string; hasImage: boolean }[];
	strokes: number;
	effects: number;
	clips: boolean;
	text?: { chars: string; lineCount: number; fonts: string[] };
	children: FigmaDumpNode[];
}
export interface SlideIR {
	index: number;
	name: string;
	background: Paint[];
	skipped: boolean;
	notes: string;
	root: NodeIR[];
	entrance: EntranceIR | null;
	flags: string[];
}
