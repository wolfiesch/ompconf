import { describe, expect, test } from "bun:test";
import {
	blessedToneTag,
	statusMarker,
	statusTone,
	tuiTheme,
	type TuiTone,
} from "../src/tui/theme";

const expectedTones: Array<[string, TuiTone]> = [
	["enabled", "good"],
	["valid", "good"],
	["saved", "good"],
	["package", "info"],
	["lock", "info"],
	["disabled", "bad"],
	["invalid", "bad"],
	["error", "bad"],
	["warning", "warn"],
	["something-new", "muted"],
];

const expectedMarkers: Array<[string, string]> = [
	["enabled", "✓"],
	["valid", "✓"],
	["saved", "✓"],
	["package", "i"],
	["lock", "i"],
	["disabled", "✕"],
	["invalid", "✕"],
	["error", "✕"],
	["warning", "!"],
	["something-new", "·"],
];

describe("TUI theme contract", () => {
	test("maps CLI statuses to public tones", () => {
		for (const [status, tone] of expectedTones) {
			expect(statusTone(status)).toBe(tone);
		}
	});

	test("maps CLI statuses to stable display markers", () => {
		for (const [status, marker] of expectedMarkers) {
			expect(statusMarker(status)).toBe(marker);
		}
	});

	test("exposes blessed color tag segments for every public tone", () => {
		for (const tone of Object.keys(tuiTheme.tones) as TuiTone[]) {
			const tag = blessedToneTag(tone);
			expect(tag).toEndWith("-fg");
			expect(tag).not.toContain("{");
			expect(tag).not.toContain("}");
		}
	});
});
