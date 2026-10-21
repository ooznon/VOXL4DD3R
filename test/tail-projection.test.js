import assert from "node:assert/strict";
import test from "node:test";
import { convertKsonToVox } from "../src/converter.js";
import { projectTailDecorations } from "../src/tail-projection.js";

// Synthetic chart mirroring the real-world tail pattern (Arghena): a rewind
// in scroll_speed drops the tail's accumulated distance back into an earlier
// forward-scroll gap; the tail section sits on a 1-pulse stop and starts with
// an out-of-range pseudo slam (-1 / 2). Judged laser sets lastPlayable=60.
const judged = [0, [[0, 0], [60, 1]]];
const tailMoving = [2000, [[0, -1], [1, 0.5], [31, 0.25]], 2];

function makeChart() {
	return {
		meta: { title: "proj" },
		beat: {
			bpm: [[0, 120]],
			time_sig: [[0, [4, 4]]],
			scroll_speed: [[0, 1], [100, [1, -1985]], [101, [-1985, 1]]],
			stop: [[2000, 1]],
		},
		note: { bt: [[], [], [], []], fx: [[], []], laser: [[judged, tailMoving], []] },
	};
}

test("relocates a stop-hidden tail section into an earlier gap", () => {
	const chart = makeChart();
	const snapshot = JSON.stringify(chart);
	const warnings = [];
	const out = projectTailDecorations(chart, (message) => warnings.push(message));

	assert.equal(JSON.stringify(chart), snapshot, "input chart must not be mutated");
	assert.deepEqual(out.chart.note.laser[0][0], judged, "judged section untouched");
	// Head (-1) dropped, body rebased onto the destination gap grid.
	assert.deepEqual(out.chart.note.laser[0][1], [14, [[0, 0.5], [30, 0.25]], 2]);
	assert.deepEqual(warnings, [
		"Projected 1 nonjudged decorative laser sections into their earlier scroll positions; timing rounding is bounded by the destination scroll grid.",
	]);
	// Every tail section moved → future scroll/stop declarations are dropped.
	assert.deepEqual(out.chart.beat.scroll_speed, [[0, 1], [60, 1]]);
	assert.deepEqual(out.chart.beat.stop, []);
	assert.deepEqual(out.decorations, [{
		lane: 0,
		sectionIndex: 1,
		sourceStart: 2000,
		sourceEnd: 2031,
		projectedStart: 14,
		projectedEnd: 44,
		width: 2,
		maximumScrollError: 0,
		removedHeadPoints: 1,
	}]);
});

test("partial projection keeps unmovable sections and drops only their head", () => {
	const chart = makeChart();
	// Second tail at 3015: its distances overshoot every gap, so y() cannot
	// project it; the stop-hidden pass trims the pseudo slam in place instead.
	chart.beat.stop = [[2000, 1], [3015, 1]];
	const tailBlocked = [3015, [[0, 2], [1, 0.75], [31, 0.75]], 2];
	chart.note.laser[0] = [judged, tailMoving, tailBlocked];
	const scrollBefore = JSON.parse(JSON.stringify(chart.beat.scroll_speed));
	const stopBefore = JSON.parse(JSON.stringify(chart.beat.stop));

	const warnings = [];
	const out = projectTailDecorations(chart, (message) => warnings.push(message));

	assert.deepEqual(out.chart.note.laser[0][1], [14, [[0, 0.5], [30, 0.25]], 2]);
	assert.deepEqual(out.chart.note.laser[0][2], [3016, [[0, 0.75], [30, 0.75]], 2]);
	assert.deepEqual(warnings, [
		"Some tail artwork retains its original body timing because no unambiguous, grid-accurate earlier projection was found; future scroll declarations were retained.",
		"Projected 1 nonjudged decorative laser sections into their earlier scroll positions; timing rounding is bounded by the destination scroll grid.",
		"Removed 1 stop-hidden entries from nonjudged tail artwork while retaining its original visible body timing and future scroll declarations; no safe earlier projection was found.",
	]);
	// Partial projection keeps the original scroll/stop declarations.
	assert.deepEqual(out.chart.beat.scroll_speed, scrollBefore);
	assert.deepEqual(out.chart.beat.stop, stopBefore);
	assert.equal(out.decorations.length, 2);
	assert.equal(out.decorations[1].retainedBodyTiming, true);
});

test("relocated rows flow into TRACK1 in array order with the decorative ct", () => {
	const vox = convertKsonToVox(makeChart(), () => {});
	const match = /#TRACK1\r?\n([\s\S]*?)#END/.exec(vox);
	assert.ok(match, "TRACK1 section present");
	const rows = match[1].trim().split(/\r?\n/);
	// Array order, not time order: the relocated section (pulses 14/44) is
	// emitted after the in-place section that ends at 60. Its moving from-row
	// carries ct=2 (reference decorative `h` flag), the final point ct=0.
	assert.deepEqual(rows, [
		"001,01,00\t0.000000\t1\t0\t0\t1\t0\t0\t0\t0\t0",
		"001,01,60\t1.000000\t2\t0\t0\t1\t0\t0\t0\t0\t0",
		"001,01,14\t0.500000\t1\t0\t0\t2\t0\t2\t0\t0\t0",
		"001,01,44\t0.250000\t2\t0\t0\t2\t0\t0\t0\t0\t0",
	]);
});
