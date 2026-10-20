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

test("continuous speed ramps are sampled per pulse with full float precision", () => {
	const sp = section(convertKsonToVox(readFixture("speed-curve.kson")), "SPCONTROLER");
	const speed = sp.filter(row => row.includes("ManualSpeed"));
	assert.ok(speed.length > 1900, `continuous ramp is sampled per pulse (got ${speed.length})`);
	// Pulse 0 holds the default 1.0 -> suppressed; sampling starts at pulse 1.
	assert.equal(speed[0].split("\t")[0], "001,01,01");
	assert.ok(speed[0].includes("f1.0005208333333333"), "full float precision is retained");
	// The ramp ends exactly on the graph's last point.
	assert.deepEqual(speed.at(-1).split("\t").slice(0, 2), ["003,01,00", "ManualSpeed"]);
	assert.ok(speed.at(-1).includes("f0.5"));
});

test("stops become ManualSpeed f0 blocks that resume at the graph value", () => {
	const sp = section(convertKsonToVox(readFixture("oracle.kson")), "SPCONTROLER");
	const stopRow = sp.findIndex(r => r.includes("ManualSpeed") && r.includes("\tf0\t"));
	assert.equal(sp[stopRow], "001,03,00\tManualSpeed\t0\t0\tf0\t0\t0\t0");
	// 120-pulse stop resumes on the exact resume pulse with the ramp value.
	assert.equal(sp[stopRow + 1], "001,03,120\tManualSpeed\t0\t0\tf1.625\t0\t0\t0");
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
