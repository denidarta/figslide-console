import {
	letterSpacingPercent,
	mapEasing,
	mapFontWeight,
	parseBackground,
	parseColor,
	parseRadii,
	parseShadows,
} from "../../src/core/deck-import/css.js";

describe("deck-import css", () => {
	describe("parseColor", () => {
		it("parses rgb/rgba to 0..1", () => {
			expect(parseColor("rgba(0, 0, 0, 0.5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
			expect(parseColor("rgb(255, 0, 51)")).toEqual({ r: 1, g: 0, b: 0.2, a: 1 });
		});
		it("parses space-separated rgb with slash alpha", () => {
			expect(parseColor("rgb(255 255 255 / 50%)")).toEqual({ r: 1, g: 1, b: 1, a: 0.5 });
		});
		it("parses hex (3/4/6/8 digits)", () => {
			expect(parseColor("#f00")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
			expect(parseColor("#00ff0080")?.a).toBeCloseTo(128 / 255);
			expect(parseColor("#0000ff")).toEqual({ r: 0, g: 0, b: 1, a: 1 });
		});
		it("returns null for transparent / fully transparent / garbage", () => {
			expect(parseColor("transparent")).toBeNull();
			expect(parseColor("rgba(0, 0, 0, 0)")).toBeNull();
			expect(parseColor("")).toBeNull();
			expect(parseColor("none")).toBeNull();
		});
	});

	describe("parseBackground", () => {
		it("returns a solid fill for a background color", () => {
			expect(parseBackground("rgb(255, 255, 255)", "none")).toEqual([
				{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } },
			]);
		});
		it("parses a linear-gradient", () => {
			expect(
				parseBackground(
					"rgba(0, 0, 0, 0)",
					"linear-gradient(90deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)",
				),
			).toEqual([
				{
					type: "GRADIENT_LINEAR",
					angleDeg: 90,
					stops: [
						{ pos: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
						{ pos: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
					],
				},
			]);
		});
		it("defaults to 180deg, handles `to right`, distributes missing stop positions", () => {
			const [def] = parseBackground(
				"rgba(0, 0, 0, 0)",
				"linear-gradient(rgb(255, 0, 0), rgb(0, 255, 0), rgb(0, 0, 255))",
			) as any[];
			expect(def.angleDeg).toBe(180);
			expect(def.stops.map((s: any) => s.pos)).toEqual([0, 0.5, 1]);
			const [right] = parseBackground(
				"rgba(0, 0, 0, 0)",
				"linear-gradient(to right, rgb(0, 0, 0), rgb(255, 255, 255))",
			) as any[];
			expect(right.angleDeg).toBe(90);
		});
		it("keeps fully transparent gradient stops", () => {
			const [g] = parseBackground(
				"rgba(0, 0, 0, 0)",
				"linear-gradient(rgba(255, 255, 255, 0) 0%, rgb(255, 255, 255) 100%)",
			) as any[];
			expect(g.stops[0].color).toEqual({ r: 1, g: 1, b: 1, a: 0 });
		});
		it("parses radial-gradient, skipping the shape/position prelude", () => {
			const [g] = parseBackground(
				"rgba(0, 0, 0, 0)",
				"radial-gradient(circle at 50% 50%, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)",
			) as any[];
			expect(g.type).toBe("GRADIENT_RADIAL");
			expect(g.stops).toHaveLength(2);
		});
		it("ignores url() layers; stacks color under gradients, top CSS layer last", () => {
			expect(parseBackground("rgba(0, 0, 0, 0)", 'url("a.png")')).toEqual([]);
			const fills = parseBackground(
				"rgb(0, 0, 0)",
				"linear-gradient(rgb(255, 0, 0), rgb(0, 255, 0)), radial-gradient(rgb(0, 0, 255), rgb(255, 255, 255))",
			);
			expect(fills.map((f) => f.type)).toEqual(["SOLID", "GRADIENT_RADIAL", "GRADIENT_LINEAR"]);
		});
	});

	describe("parseShadows", () => {
		it("parses a comma list in Chrome computed order (color first)", () => {
			expect(
				parseShadows(
					"rgba(0, 0, 0, 0.1) 0px 8px 24px 0px, rgba(0, 0, 0, 0.2) 0px 1px 2px 0px inset",
				),
			).toHaveLength(2);
		});
		it("maps inset to INNER_SHADOW and reads offsets/blur/spread", () => {
			const [e] = parseShadows("rgba(0, 0, 0, 0.2) 0px 1px 2px 0px inset");
			expect(e.type).toBe("INNER_SHADOW");
			const [d] = parseShadows("rgba(10, 20, 30, 0.1) 1px 8px 24px 3px");
			expect(d).toEqual({
				type: "DROP_SHADOW",
				color: { r: 10 / 255, g: 20 / 255, b: 30 / 255, a: 0.1 },
				x: 1,
				y: 8,
				blur: 24,
				spread: 3,
			});
		});
		it("returns [] for none/empty", () => {
			expect(parseShadows("none")).toEqual([]);
			expect(parseShadows("")).toEqual([]);
		});
	});

	describe("parseRadii", () => {
		const box = { x: 0, y: 0, w: 200, h: 100 };
		it("reads four corners as [tl, tr, br, bl]", () => {
			expect(
				parseRadii(
					{
						borderTopLeftRadius: "1px",
						borderTopRightRadius: "2px",
						borderBottomRightRadius: "3px",
						borderBottomLeftRadius: "4px",
					},
					box,
				),
			).toEqual([1, 2, 3, 4]);
		});
		it("resolves % against the box and clamps to min(w,h)/2", () => {
			expect(parseRadii({ borderTopLeftRadius: "50%" }, box)).toEqual([50, 0, 0, 0]);
			expect(parseRadii({ borderTopLeftRadius: "10%" }, box)).toEqual([10, 0, 0, 0]);
			expect(parseRadii({ borderTopLeftRadius: "999px" }, box)).toEqual([50, 0, 0, 0]);
		});
		it("handles elliptical `h v` values and missing keys", () => {
			expect(parseRadii({ borderTopLeftRadius: "20px 8px" }, box)).toEqual([8, 0, 0, 0]);
			expect(parseRadii({}, box)).toEqual([0, 0, 0, 0]);
		});
	});

	describe("letterSpacingPercent", () => {
		it("normal -> 0, px and em", () => {
			expect(letterSpacingPercent("normal", 48)).toBe(0);
			expect(letterSpacingPercent("-0.96px", 48)).toBeCloseTo(-2);
			expect(letterSpacingPercent("0.05em", 16)).toBeCloseTo(5);
			expect(letterSpacingPercent("0px", 0)).toBe(0);
		});
	});

	describe("mapFontWeight", () => {
		const avail = ["Regular", "Medium", "SemiBold", "Bold"];
		it("picks nearest (ties to lighter) and flags non-exact", () => {
			expect(mapFontWeight("Geist", 650, avail)).toEqual({ style: "SemiBold", exact: false });
			expect(mapFontWeight("Geist", 500, ["Regular", "Medium"])).toEqual({
				style: "Medium",
				exact: true,
			});
			expect(mapFontWeight("Geist", 900, avail)).toEqual({ style: "Bold", exact: false });
		});
		it("matches style names loosely", () => {
			expect(mapFontWeight("Inter", 600, ["Regular", "Semi Bold"])).toEqual({
				style: "Semi Bold",
				exact: true,
			});
		});
		it("handles italic", () => {
			const withItalic = ["Regular", "Italic", "Bold", "Bold Italic"];
			expect(mapFontWeight("Inter", 400, withItalic, true)).toEqual({
				style: "Italic",
				exact: true,
			});
			expect(mapFontWeight("Inter", 700, withItalic, true)).toEqual({
				style: "Bold Italic",
				exact: true,
			});
			// no italic face -> nearest upright, flagged non-exact
			expect(mapFontWeight("Inter", 700, avail, true)).toEqual({ style: "Bold", exact: false });
		});
		it("falls back to the canonical name when nothing is available", () => {
			expect(mapFontWeight("X", 700, [])).toEqual({ style: "Bold", exact: false });
			expect(mapFontWeight("X", 400, [], true)).toEqual({ style: "Italic", exact: false });
		});
	});

	describe("mapEasing", () => {
		it("maps beziers and keywords", () => {
			expect(mapEasing("cubic-bezier(0.65, 0, 0.35, 1)")).toBe("EASE_IN_AND_OUT");
			expect(mapEasing("cubic-bezier(0.2, 0.7, 0.2, 1)")).toBe("EASE_OUT");
			expect(mapEasing("linear")).toBe("LINEAR");
			expect(mapEasing("ease-in")).toBe("EASE_IN");
			expect(mapEasing("ease-out")).toBe("EASE_OUT");
			expect(mapEasing("ease-in-out")).toBe("EASE_IN_AND_OUT");
			expect(mapEasing("ease")).toBe("EASE_IN_AND_OUT");
			expect(mapEasing("cubic-bezier(0.3, 0.3, 0.7, 0.7)")).toBe("LINEAR");
		});
		it("defaults unknown/steps to EASE_IN_AND_OUT and takes the first of a list", () => {
			expect(mapEasing("steps(4, end)")).toBe("EASE_IN_AND_OUT");
			expect(mapEasing("")).toBe("EASE_IN_AND_OUT");
			expect(mapEasing("ease-in, linear")).toBe("EASE_IN");
		});
	});
});
