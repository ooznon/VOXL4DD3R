import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	convertKsonToVox,
	evaluateKsonCurve,
	__testing,
} from "../src/converter.js";

const {
	formatBpm,
	formatCameraValue,
	formatSpeedValue,
	normalizeNote,
	Timeline,
	makeGraph,
	curveTypeOf,
	spinDuration,
	mapEffect,
	formatEffectRow,
	normalizeFxDefs,
} = __testing;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readFixture = name => JSON.parse(fs.readFileSync(path.join(root, "testdata", name), "utf8"));
const readText = name => fs.readFileSync(path.join(root, "testdata", name), "utf8");

/** Rows of one #SECTION from converted output. */
function section(vox, name) {
	const lines = vox.split(/\r?\n/);
	const start = lines.indexOf(`#${name}`);
	let end = start + 1;
	while (lines[end] !== "#END") end++;
	return lines.slice(start + 1, end);
}

// ---------------------------------------------------------------------------
// Golden tests: byte-identical parity with the live sdvxindex.com editor export
// ---------------------------------------------------------------------------

test("oracle fixture exports byte-identically to the live editor reference", () => {
	assert.equal(convertKsonToVox(readFixture("oracle.kson")), readText("oracle.golden.vox"));
});

test("curve-scroll fixture exports byte-identically to the live editor reference", () => {
	assert.equal(convertKsonToVox(readFixture("curve-scroll.kson")), readText("curve-scroll.golden.vox"));
});

// ---------------------------------------------------------------------------
// Dialect structure
// ---------------------------------------------------------------------------

test("output follows the v13 dialect: section order, headers and the SPCONTROLLER blank-line quirk", () => {
	const vox = convertKsonToVox(readFixture("curve-scroll.kson"));
	assert.match(vox, /^\/\/ SOUND VOLTEX OUTPUT TEXT FILE\n\n#FORMAT VERSION\n13\n#END\n/);
	assert.match(vox, /#BEAT RESOLUTION\n240\n#END/);
	assert.match(vox, /#TILT MODE INFO\n001,01,00\t0\n#END/);
	assert.match(vox, /#TAB EFFECT INFO\n#END/);
	assert.match(vox, /#TRACK AUTO TAB\n#END/);
	assert.match(vox, /#TRACK ORIGINAL R\n#END\n\n$/);

	const order = ["FORMAT VERSION", "BEAT RESOLUTION", "BEAT INFO", "BPM INFO", "TILT MODE INFO",
		"END POSITION", "TAB EFFECT INFO", "FXBUTTON EFFECT INFO", "TAB PARAM ASSIGN INFO",
		"TRACK1", "TRACK2", "TRACK3", "TRACK4", "TRACK5", "TRACK6", "TRACK7", "TRACK8",
		"SPCONTROLER", "LYRIC INFO", "REVERB EFFECT PARAM", "TRACK AUTO TAB",
		"TRACK ORIGINAL L", "TRACK ORIGINAL R"];
	let cursor = -1;
	for (const name of order) {
		const at = vox.indexOf(`#${name}\n`);
		assert.ok(at > cursor, `#${name} appears after the previous section`);
		cursor = at;
	}
	// Reference quirk: exactly one extra blank line after SPCONTROLLER only.
	assert.match(vox, /#END\n\n\n\n#LYRIC INFO/);
	assert.doesNotMatch(vox, /#END\n\n\n\n#(?!LYRIC INFO)/);
});

test("BPM, beat info, time signatures and END POSITION follow the reference", () => {
	const oracle = convertKsonToVox(readFixture("oracle.kson"));
	assert.deepEqual(section(oracle, "BPM INFO"), ["001,01,00\t120\t4", "002,01,00\t150.5\t4"]);
	assert.deepEqual(section(oracle, "BEAT INFO"), ["001,01,00\t4\t4", "003,01,00\t3\t4"]);
	assert.deepEqual(section(oracle, "END POSITION"), ["004,01,00"]);
	// curve-scroll ends on the scroll timeline's last point (pulse 1920 = measure 3).
	assert.deepEqual(section(convertKsonToVox(readFixture("curve-scroll.kson")), "END POSITION"), ["004,01,00"]);
});

// ---------------------------------------------------------------------------
// Lasers
// ---------------------------------------------------------------------------

test("curved laser spans are sampled every 15 pulses with 11 fields and curveType 2", () => {
	const track1 = section(convertKsonToVox(readFixture("curve-scroll.kson")), "TRACK1");
	assert.equal(track1.length, 66);
	const first = track1[0].split("\t");
	assert.equal(first.length, 11, "laser rows carry 11 tab-separated fields");
	assert.deepEqual(first.slice(0, 4), ["001,01,00", "0.000000", "1", "0"]);
	assert.equal(first[7], "2", "bezier start row keeps curveType 2");
	// Samples run every 15 pulses and keep their span's curveType.
	assert.equal(track1[1].split("\t")[0], "001,01,15");
	assert.equal(track1[1].split("\t")[7], "2");
	// Section end row: seg=2, value 1.0, curveType reset to 0.
	assert.deepEqual(track1[32].split("\t").slice(0, 3), ["001,03,00", "1.000000", "2"]);
	assert.equal(track1[32].split("\t")[7], "0");
	// Second section starts with seg=1 at pulse 960.
	assert.deepEqual(track1[33].split("\t").slice(0, 3), ["002,01,00", "1.000000", "1"]);
	// Final end row.
	assert.deepEqual(track1[65].split("\t").slice(0, 3), ["002,03,00", "0.000000", "2"]);
});

test("TRACK ORIGINAL L mirrors laser lanes with all curveType fields zeroed", () => {
	const original = section(convertKsonToVox(readFixture("curve-scroll.kson")), "TRACK ORIGINAL L");
	assert.equal(original.length, 4, "two sections -> start + end rows only");
	for (const row of original) {
		const f = row.split("\t");
		assert.equal(f.length, 11);
		assert.equal(f[7], "0", "ORIGINAL rows never carry bezier curveType");
	}
	assert.deepEqual(original[0].split("\t").slice(0, 3), ["001,01,00", "0.000000", "1"]);
	assert.deepEqual(original[1].split("\t").slice(0, 3), ["001,03,00", "1.000000", "2"]);
});

test("slam spins attach to laser rows with native durations and a source comment", () => {
	const track1 = section(convertKsonToVox(readFixture("oracle.kson")), "TRACK1");
	const spinning = track1.filter(row => row.split("\t")[3] !== "0");
	assert.equal(spinning.length, 4);
	for (const row of spinning) {
		const f = row.split("\t");
		assert.ok(["6", "7"].includes(f[3]), "spin ids come from the native table");
		assert.ok(Number(f[9]) >= 1, "spin duration is on the native grid");
		assert.ok(row.includes("// KSON camera.cam.pattern.laser.slam_event."), "source comment preserved");
	}
	assert.ok(spinning[0].includes("spin"));
	assert.ok(spinning[2].includes("half_spin"));
});

// ---------------------------------------------------------------------------
// SPCONTROLLER: speed, stops
// ---------------------------------------------------------------------------

test("ManualSpeed omits the redundant default row and writes only the speed steps", () => {
	const sp = section(convertKsonToVox(readFixture("curve-scroll.kson")), "SPCONTROLER");
	const speed = sp.filter(row => row.includes("ManualSpeed"));
	// Starts at the default 1.0 -> no row at pulse 0; rows only at the steps.
	assert.deepEqual(speed.map(r => r.split("\t")[0]), ["002,01,00", "003,01,00"]);
	assert.ok(speed[0].includes("f1.5"));
	assert.ok(speed[1].includes("f0.5"));
	// AIR baseline rows always come first.
	assert.ok(sp[0].includes("AIRL_ScaX"));
	assert.ok(sp[1].includes("AIRR_ScaX"));
});

test("changing speed ramps are sampled at every pulse, curves included", () => {
	const sp = section(convertKsonToVox(readFixture("speed-curve.kson")), "SPCONTROLER");
	const speed = sp.filter(r => r.includes("ManualSpeed"));
	// Reference: native ManualSpeed is a step command, so every pulse of a
	// changing span (after_i !== before_{i+1}) becomes a row — linear AND
	// curved ramps alike; values are the exact curve evaluations.
	assert.equal(speed[0].split("\t")[0], "001,01,01");
	assert.ok(speed[0].includes("f1.0005208333333333"), "full float precision is retained");
	const pulseOf = row => {
		const [m, b, t] = row.split("\t")[0].split(",").map(Number);
		return (m - 1) * 960 + (b - 1) * 240 + t;
	};
	const linearRows = speed.filter(r => pulseOf(r) < 960);
	const curvedRows = speed.filter(r => pulseOf(r) >= 960);
	assert.equal(linearRows.length, 959, "the linear ramp is sampled per pulse");
	assert.equal(curvedRows.length, 961, "the curved ramp is sampled per pulse too");
	assert.ok(speed.at(-1).split("\t")[0] === "003,01,00" && speed.at(-1).includes("f0.5"), "the ramp still ends exactly on the graph's last point");
	// Every pulse's held value equals the true bezier ramp value exactly
	// (1.5 -> 0.5, controls [0.2, 0.8]) — no piecewise-constant drift.
	const held = new Map();
	for (const row of speed) held.set(pulseOf(row), Number(row.split("\t")[4].slice(1)));
	let last = 1;
	for (let p = 1; p <= 1920; p++) {
		if (held.has(p)) last = held.get(p);
		const t = p < 960 ? p / 960 : (p - 960) / 960;
		const trueValue = p < 960
			? 1 + 0.5 * t
			: 1.5 - evaluateKsonCurve(0.2, 0.8, t);
		assert.ok(Math.abs(trueValue - last) <= 1e-9 + Math.abs(trueValue) * 1e-12,
			`held speed at pulse ${p} matches the curve (held ${last}, true ${trueValue})`);
	}
});

test("stops become ManualSpeed f0 blocks that resume at the graph value", () => {
	const sp = section(convertKsonToVox(readFixture("oracle.kson")), "SPCONTROLER");
	const stopRow = sp.findIndex(r => r.includes("ManualSpeed") && r.includes("\tf0\t"));
	assert.equal(sp[stopRow], "001,03,00\tManualSpeed\t0\t0\tf0\t0\t0\t0");
	// 120-pulse stop resumes on the exact resume pulse with the ramp value.
	assert.equal(sp[stopRow + 1], "001,03,120\tManualSpeed\t0\t0\tf1.625\t0\t0\t0");
});

test("unprojectable tail sections keep scroll, stops and extend END like the reference", () => {
	// BT ends at pulse 480 (last playable); the single-point non-slam laser
	// section at 1200 is nonjudged decoration whose head value (1) is in
	// range, so the reference projection cannot relocate it: the scroll
	// graph and stops stay untouched, and END POSITION keeps following the
	// kept tail rows (U = 1200 -> measure after = 003,01,00).
	const warnings = [];
	const vox = convertKsonToVox({
		meta: {},
		beat: {
			bpm: [[0, 120]],
			time_sig: [[0, [4, 4]]],
			scroll_speed: [[0, 1], [240, [1, 4]], [960, [4, 2]]],
			stop: [[720, 120]],
		},
		note: {
			bt: [[[0, 480]], [], [], []],
			fx: [[], []],
			laser: [[[1200, [[0, [1, 1]]]]], []],
		},
	}, message => warnings.push(message));
	assert.deepEqual(section(vox, "END POSITION"), ["003,01,00"]);
	const speed = section(vox, "SPCONTROLER").filter(r => r.includes("ManualSpeed"));
	assert.deepEqual(speed.map(r => r.split("\t")[0]), ["001,02,00", "001,04,00", "001,04,120", "002,01,00"]);
	assert.deepEqual(speed.map(r => r.split("\t")[4]), ["f4", "f0", "f4", "f2"]);
	// The 720 stop stays (no all-projected truncation) as a ManualSpeed f0
	// block that resumes at the graph value.
	assert.ok(warnings.some(w => w.includes("Some tail artwork retains")));
});

test("ManualSpeed output magnitude is capped at 10000", () => {
	// Extreme KSON scroll values (e.g. 1000000) stutter native playback, so
	// the emitted magnitude is clamped to ±10000 — also after the reference
	// float-clock fit, which otherwise nudges the capped value back above the
	// limit on long spans (float32 absolute-seconds rounding).
	const vox = convertKsonToVox({
		meta: {},
		beat: {
			bpm: [[0, 185]],
			time_sig: [[0, [4, 4]]],
			scroll_speed: [[0, 1], [96000, [1, 1000000]], [96017, 1000000]],
		},
		note: {
			bt: [[[0, 96480]], [], [], []],
			fx: [[], []],
			laser: [[], []],
		},
	}, () => {});
	const speed = section(vox, "SPCONTROLER").filter(r => r.includes("ManualSpeed"));
	const values = speed.map(r => Number(r.split("\t")[4].slice(1)));
	assert.ok(values.some(v => v === 10000), "the capped value is emitted");
	const over = values.filter(v => Math.abs(v) > 10000);
	assert.deepEqual(over, [], "no ManualSpeed exceeds the ±10000 cap");
});

test("--max-speed clamps chart-unit scroll_speed before the step timeline", () => {
	// maxSpeed is expressed in the chart's own speed units (KSON scroll_speed
	// / KSH scroll_speed=, 1 = normal speed): the graph itself is clamped, so
	// the post-spike ramp starts at the limit — unlike speedCap, which only
	// clips the emitted rows against the default ±10000 output cap.
	const spikeChart = {
		meta: {},
		beat: {
			bpm: [[0, 185]],
			time_sig: [[0, [4, 4]]],
			scroll_speed: [[0, 1], [960, [1, 1000000]], [1920, 1]],
		},
		note: { bt: [[[0, 3840]]], fx: [[], []], laser: [[], []] },
	};
	const speedValues = (options) => {
		const warnings = [];
		const vox = convertKsonToVox(spikeChart, (message) => warnings.push(message), options);
		return {
			warnings,
			values: section(vox, "SPCONTROLER").filter(r => r.includes("ManualSpeed"))
				.map(r => Number(r.split("\t")[4].slice(1))),
		};
	};

	const capped = speedValues({ maxSpeed: 5000 });
	assert.deepEqual(capped.values.filter(v => Math.abs(v) > 5000), [], "no ManualSpeed exceeds the chart-unit max speed");
	assert.ok(capped.values.includes(5000), "the ramp starts at the clamped chart-unit value");
	assert.ok(capped.warnings.some(w => w.includes("clamped to the max speed")), `clamping is reported: ${capped.warnings}`);

	// When both caps are set, the emitted magnitude never exceeds either one.
	const tight = speedValues({ maxSpeed: 5000, speedCap: 2000 });
	assert.deepEqual(tight.values.filter(v => Math.abs(v) > 2000), [], "the tighter of the two caps wins");
});

test("--min-speed floors negative chart-unit scroll_speed", () => {
	// Negative (reverse) scroll hides notes in game: the engine computes
	// upcoming notes as behind the judgment line once the scroll integral
	// goes negative. minSpeed floors the graph (like maxSpeed clamps it) so
	// ramps settle at the floor; 0 means no reverse scroll at all.
	const reverseChart = {
		meta: {},
		beat: {
			bpm: [[0, 185]],
			time_sig: [[0, [4, 4]]],
			scroll_speed: [[0, 1], [960, [1, -8]], [2880, 1]],
		},
		note: { bt: [[[0, 3840]]], fx: [[], []], laser: [[], []] },
	};
	const speedValues = (options) => {
		const warnings = [];
		const vox = convertKsonToVox(reverseChart, (message) => warnings.push(message), options);
		return {
			warnings,
			values: section(vox, "SPCONTROLER").filter(r => r.includes("ManualSpeed"))
				.map(r => Number(r.split("\t")[4].slice(1))),
		};
	};

	// Default output keeps the reverse segment untouched (byte parity).
	assert.ok(speedValues({}).values.some(v => v < 0), "reverse scroll is emitted by default");

	const floored = speedValues({ minSpeed: 0 });
	assert.deepEqual(floored.values.filter(v => v < 0), [], "no ManualSpeed goes below the min speed");
	assert.ok(floored.values.includes(0), "the ramp settles at the floor");
	assert.ok(floored.warnings.some(w => w.includes("floored to the min speed")), `flooring is reported: ${floored.warnings}`);

	// A partial floor keeps a gentle reverse while still bounding it.
	const gentle = speedValues({ minSpeed: -1 });
	assert.deepEqual(gentle.values.filter(v => v < -1), [], "reverse scroll is bounded by the floor");
});

test("--flag-reverse marks negative ManualSpeed rows with the native visual-scroll flag", () => {
	// Official charts (vallis 068, kiskillilia 122, exrixis 056) put bit 31
	// (2147483648) in the first int field of ManualSpeed rows that script the
	// scroll without displacing notes. flagReverse applies the same marker to
	// negative rows so reverse sections stay visible in game.
	const reverseChart = {
		meta: {},
		beat: {
			bpm: [[0, 185]],
			time_sig: [[0, [4, 4]]],
			scroll_speed: [[0, 1], [960, [1, -8]], [2880, 1]],
		},
		note: { bt: [[[0, 3840]]], fx: [[], []], laser: [[], []] },
	};
	const speedRows = (options) => {
		const vox = convertKsonToVox(reverseChart, () => {}, options);
		return section(vox, "SPCONTROLER").filter(r => r.includes("ManualSpeed"));
	};
	const value = (r) => Number(r.split("\t")[4].slice(1));
	const flag = (r) => Number(r.split("\t")[2]);

	// Default output keeps flag 0 (byte parity).
	assert.ok(speedRows({}).every(r => flag(r) === 0), "no flag by default");

	const flagged = speedRows({ flagReverse: true });
	assert.ok(flagged.some(r => value(r) < 0), "reverse scroll is still emitted");
	assert.ok(flagged.every(r => (value(r) < 0) === (flag(r) === 2147483648)),
		"exactly the negative rows carry 2147483648");
});

test("--safe-reverse bounds each reverse window to the drift budget", () => {
	// In game, notes vanish once the scroll integral has fallen behind its
	// running peak (empirically: drift 0.5 measures of scroll distance stays
	// visible, drift 2.8 hides notes for ~1.5 measures). safeReverse scales
	// negative windows down only as far as needed to keep the accumulated
	// drift within the budget, so deep short reverse survives while long
	// windows become gentle drifts.
	const scaleChart = {
		meta: {},
		beat: {
			bpm: [[0, 185]],
			time_sig: [[0, [4, 4]]],
			// A short deep window (drift 0.25 measures — fits the budget)
			// and a long shallow one (drift 6.4 — does not).
			scroll_speed: [[0, 1], [960, [1, -8]], [1080, [8, 1]], [2880, [1, -4]], [6720, 1]],
		},
		note: { bt: [[[0, 7680]]], fx: [[], []], laser: [[], []] },
	};
	// Max accumulated drift in 4/4-measures over the emitted ManualSpeed rows.
	const drift = (options) => {
		const warnings = [];
		const vox = convertKsonToVox(scaleChart, (message) => warnings.push(message), options);
		const rows = section(vox, "SPCONTROLER").filter(r => r.includes("ManualSpeed"))
			.map(r => {
				const [pos, , , , spd] = r.split("\t");
				const [m, b, tick] = pos.split(",").map(Number);
				return { pulse: (m - 1) * 960 + (b - 1) * 240 + tick, spd: Number(spd.slice(1)) };
			})
			.sort((a, b) => a.pulse - b.pulse);
		let acc = 0;
		let max = 0;
		let minSpd = 0;
		for (let i = 0; i < rows.length; i++) {
			const dt = i + 1 < rows.length ? rows[i + 1].pulse - rows[i].pulse : 0;
			if (rows[i].spd < 0) {
				acc += -rows[i].spd * dt;
				if (acc > max) max = acc;
				if (rows[i].spd < minSpd) minSpd = rows[i].spd;
			} else acc = Math.max(0, acc - rows[i].spd * dt);
		}
		return { warnings, maxDrift: max / 960, minSpd };
	};

	// Default output keeps full reverse depth (byte parity).
	const base = drift({});
	assert.ok(base.minSpd <= -8, `default keeps the deep window: ${base.minSpd}`);

	// Budget 0.5: drift is bounded but reverse is not removed. The short
	// window's -8 survives untouched (it fits), so the drift drop from the
	// long window proves the scaling.
	const safe = drift({ safeReverse: true });
	assert.ok(base.maxDrift > 3, `default keeps full reverse drift: ${base.maxDrift}`);
	assert.ok(safe.maxDrift <= 0.5 + 1e-6, `drift stays within the budget: ${safe.maxDrift}`);
	assert.ok(safe.minSpd < 0, "reverse scroll still exists (gentle where needed)");
	assert.ok(safe.warnings.some(w => w.includes("safe-reverse")), `shaping is reported: ${safe.warnings}`);

	// A larger budget keeps more reverse.
	const loose = drift({ safeReverse: true, safeReverseBudget: 2 });
	assert.ok(loose.maxDrift <= 2 + 1e-6, `drift stays within the custom budget: ${loose.maxDrift}`);
	assert.ok(loose.maxDrift > safe.maxDrift, "a bigger budget allows deeper reverse");
});

test("--safe-reverse repays the drift before every note after a reverse window", () => {
	// A note immediately after a reverse window stays hidden in game until
	// the accumulated deficit is fully repaid at its pulse — the budget
	// alone does not guarantee that (window area can be within budget while
	// the repayment tail still runs past the note).
	const chart = {
		meta: {},
		beat: {
			bpm: [[0, 185]],
			time_sig: [[0, [4, 4]]],
			// Window 960..1920 (drift 1 measure), only partly repaid by the
			// time the chip at 2400 arrives.
			scroll_speed: [[0, 1], [960, [1, -2]], [2880, [2, 1]]],
		},
		note: { bt: [[[2400]], [], [], []], fx: [[], []], laser: [[], []] },
	};
	// Accumulated drift (4/4-measures) at one pulse over the emitted rows.
	const accAt = (options, pulse) => {
		const vox = convertKsonToVox(chart, () => {}, options);
		const rows = section(vox, "SPCONTROLER").filter(r => r.includes("ManualSpeed"))
			.map(r => {
				const [pos, , , , spd] = r.split("\t");
				const [m, b, tick] = pos.split(",").map(Number);
				return { pulse: (m - 1) * 960 + (b - 1) * 240 + tick, spd: Number(spd.slice(1)) };
			})
			.sort((a, b) => a.pulse - b.pulse);
		let acc = 0;
		for (let i = 0; i < rows.length; i++) {
			const next = i + 1 < rows.length ? rows[i + 1].pulse : pulse;
			if (rows[i].pulse >= pulse) break;
			const dt = Math.min(next, pulse) - rows[i].pulse;
			if (dt <= 0) continue;
			if (rows[i].spd < 0) acc += -rows[i].spd * dt;
			else acc = Math.max(0, acc - rows[i].spd * dt);
		}
		return acc / 960;
	};

	// Default keeps full reverse, so the note sits deep in the un-repaid tail.
	const base = accAt({}, 2400);
	assert.ok(base > 0.1, `default leaves the note behind the deficit: ${base}`);

	// safe-reverse scales the window until the drift is repaid by the note.
	const safe = accAt({ safeReverse: true }, 2400);
	assert.ok(safe < 0.01, `drift is repaid at the note's pulse: ${safe}`);
});

// ---------------------------------------------------------------------------
// FX / BT notes
// ---------------------------------------------------------------------------

test("FX holds carry preset ids and unused defs are dropped", () => {
	const vox = convertKsonToVox(readFixture("effects.kson"));
	// FX hold at pulse 0 length 480 references preset slot 0 -> effect id 2.
	assert.deepEqual(section(vox, "TRACK2"), ["001,01,00\t480\t2\t0"]);
	// One used preset (retrigger) -> two FXBUTTON lines; the unused wobble
	// def is not emitted.
	assert.deepEqual(section(vox, "FXBUTTON EFFECT INFO"), ["1, 1, 100, 1, 1, 0.7, 0", "0"]);
	// Two TAB PARAM rows for the single slot.
	assert.deepEqual(section(vox, "TAB PARAM ASSIGN INFO"), ["0, 0, 0, 0", "0, 0, 0, 0"]);
});

test("BT holds write their length and lasers occupy TRACK1/8 while FX maps to TRACK2/7", () => {
	const vox = convertKsonToVox(readFixture("curve-scroll.kson"));
	assert.deepEqual(section(vox, "TRACK3"), ["001,01,00\t480\t0"]); // BT-A hold
	assert.ok(section(vox, "TRACK1").length > 0, "left laser -> TRACK1");
	assert.deepEqual(section(vox, "TRACK8"), [], "right laser empty -> TRACK8");
	assert.deepEqual(section(vox, "TRACK2"), [], "no FX notes -> TRACK2");
});

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

test("Timeline positions survive time signature changes and extend indefinitely", () => {
	const timeline = new Timeline([[0, [4, 4]], [2, [3, 4]]], [{ pulse: 0, bpm: 120 }]);
	assert.deepEqual(timeline.position(0), { measure: 1, beat: 1, tick: 0 });
	assert.deepEqual(timeline.position(960), { measure: 2, beat: 1, tick: 0 });
	// Measure 3 (index 2) is 3/4 -> 720 pulses.
	assert.deepEqual(timeline.position(1920), { measure: 3, beat: 1, tick: 0 });
	// Positions past the last time_sig change keep extending the pattern.
	assert.deepEqual(timeline.position(2640), { measure: 4, beat: 1, tick: 0 });
	assert.equal(timeline.pulseAtPosition({ measure: 4, beat: 1, tick: 0 }), 2640);
	// Round-trip through a far position still resolves.
	assert.equal(timeline.pulseAtPosition(timeline.position(5000)), 5000);
});

test("KSON bezier curves evaluate through x(t) bisection", () => {
	assert.equal(evaluateKsonCurve(0, 1, 0), 0);
	assert.equal(evaluateKsonCurve(0, 1, 1), 1);
	// Control points on the diagonal reproduce the identity curve.
	for (const t of [0.25, 0.5, 0.75]) {
		assert.ok(Math.abs(evaluateKsonCurve(0.25, 0.25, t) - t) < 1e-9);
	}
	// Control points pulled toward the end overshoot the diagonal (ease-out).
	assert.ok(evaluateKsonCurve(0.1, 0.9, 0.5) > 0.5);
});

test("graph interpolation connects points linearly unless a curve is attached", () => {
	const graph = makeGraph([
		{ pulse: 0, from: 0, to: 0 },
		{ pulse: 100, from: 100, to: 100 },
	]);
	assert.equal(graph(50), 50);
	assert.equal(graph(100, "after"), 100);
	const stepped = makeGraph([
		{ pulse: 0, from: 1, to: 1 },
		{ pulse: 100, from: 1, to: 1.5 },
	]);
	assert.equal(stepped(100, "before"), 1, "before-side of an instant change");
	assert.equal(stepped(100, "after"), 1.5, "after-side of an instant change");
});

test("curveTypeOf maps KSON curves to the VOX curve ids", () => {
	assert.equal(curveTypeOf("linear"), 0);
	assert.equal(curveTypeOf([[0.2, 0.8]]), 2);
	assert.equal(curveTypeOf("ease_out"), 4);
	assert.equal(curveTypeOf("ease_out_sin"), 4);
	assert.equal(curveTypeOf("ease_in"), 5);
	assert.equal(curveTypeOf(undefined), 0);
});

test("formatters reproduce the reference value syntax", () => {
	assert.equal(formatBpm(120), "120");
	assert.equal(formatBpm(150.5), "150.5");
	assert.equal(formatCameraValue(0), "0");
	assert.equal(formatCameraValue(-0), "0");
	assert.equal(formatCameraValue(1 / 3), "0.333333333333");
	assert.equal(formatSpeedValue(1.5), "1.5");
	assert.equal(formatSpeedValue(0), "0");
});

test("normalizeNote accepts array, object and scalar note forms", () => {
	assert.deepEqual(normalizeNote([10, 20, "fx1", 3]), { pulse: 10, length: 20, effect: "fx1", sampleId: 3 });
	assert.deepEqual(normalizeNote(42), { pulse: 42, length: 0, effect: undefined, sampleId: undefined });
	assert.deepEqual(normalizeNote({ pulse: 7, length: 8, effect: "e" }), { pulse: 7, length: 8, effect: "e", sampleId: undefined });
});

test("mapEffect converts KSON effects to native DSP rows and refuses invalid ones", () => {
	const warnings = [];
	const warn = msg => warnings.push(msg);
	const retrigger = mapEffect("retrigger", { update_period: "1/4", wave_length: "0.25", mix: "100%" }, warn);
	assert.equal(formatEffectRow(retrigger), "1, 1, 100, 1, 1, 0.7, 0");
	const gate = mapEffect("gate", { wave_length: "0.125", mix: "90%" }, warn);
	assert.equal(gate.type, 2);
	const broken = mapEffect("retrigger", { update_period: "0", wave_length: "0" }, warn);
	assert.equal(broken.type, 0, "zero timing falls back to the unmodified definition");
	assert.ok(warnings.length > 0, "DSP conversion warnings are surfaced");
});

test("normalizeFxDefs accepts both array and object def shapes", () => {
	const fromArray = normalizeFxDefs([["a", { type: "gate", v: { wave_length: "0.125" } }]]);
	assert.equal(fromArray[0].name, "a");
	assert.equal(fromArray[0].values.wave_length, "0.125");
	const fromObject = normalizeFxDefs({ b: { type: "wobble", v: { wave_length: "0.25" } } });
	assert.equal(fromObject[0].name, "b");
});

test("spinDuration scales slam lengths onto the native duration grid", () => {
	assert.ok(spinDuration("spin", 240) > 0);
	assert.ok(spinDuration("half_spin", 240) > 0);
	assert.ok(spinDuration("spin", 480) > spinDuration("spin", 240), "longer slams spin longer");
});

test("empty and minimal charts still produce a valid skeleton", () => {
	const vox = convertKsonToVox({ format_version: 1, meta: {}, beat: { bpm: [[0, 120]] }, note: {} });
	assert.match(vox, /#FORMAT VERSION\n13\n#END/);
	// END POSITION is one measure past the last used one, so an empty chart
	// still points at measure 2.
	assert.deepEqual(section(vox, "END POSITION"), ["002,01,00"]);
	assert.deepEqual(section(vox, "TRACK8"), []);
	assert.deepEqual(section(vox, "SPCONTROLER").length, 2, "AIR baselines only");
});

test("invalid chart input throws a descriptive error", () => {
	assert.throws(() => convertKsonToVox(null), /chart/);
	assert.throws(() => convertKsonToVox({ beat: { bpm: [[0, "not-a-number"]] } }), /bpm/);
});
