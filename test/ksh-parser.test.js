import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decodeKshBytes, parseKsh } from "../src/ksh-parser.js";
import { convertKsonToVox } from "../src/converter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const readFixture = (name) => fs.readFileSync(path.join(here, "..", "testdata", name));

// ---------------------------------------------------------------------------
// Byte decoding: UTF-8 with BOM, otherwise strict Shift-JIS
// ---------------------------------------------------------------------------

test("decodeKshBytes prefers a UTF-8 BOM and otherwise requires strict Shift-JIS", () => {
	// UTF-8 with BOM decodes as UTF-8.
	const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("title=テスト\n--\n", "utf8")]);
	assert.equal(decodeKshBytes(utf8), "title=テスト\n--\n");

	// No BOM: Shift-JIS (testdata\poly.ksh era charts) — テ=83 65 ス=83 58 ト=83 67.
	const sjis = new Uint8Array([
		...Buffer.from("title=", "ascii"),
		0x83, 0x65, 0x83, 0x58, 0x83, 0x67,
		...Buffer.from("\n--\n", "ascii"),
	]);
	assert.equal(decodeKshBytes(sjis), "title=テスト\n--\n");

	// Without a BOM decoding is strict Shift-JIS: an invalid lead/trail pair
	// throws instead of silently producing mojibake.
	const invalid = Buffer.from("title=\x83\n", "latin1");
	assert.throws(() => decodeKshBytes(invalid), /Could not read KSH text as Shift-JIS/);
});

// ---------------------------------------------------------------------------
// poly.ksh: full parser structure (the byte-verified benchmark chart)
// ---------------------------------------------------------------------------

test("poly.ksh parses to the reference KSON structure with no warnings", () => {
	const { kson, warnings } = parseKsh(decodeKshBytes(readFixture("poly.ksh")));
	assert.deepEqual(warnings, []);
	assert.equal(kson.format_version, 1);
	assert.equal(kson.meta.title, "polyriddim");
	assert.equal(kson.meta.artist, "phonon");
	assert.equal(kson.meta.chart_author, "Jakads");
	assert.equal(kson.meta.difficulty, 3); // infinite
	assert.equal(kson.meta.level, 18);
	// ksh_unknown uses null-prototype objects; normalize for deepEqual.
	assert.deepEqual(JSON.parse(JSON.stringify(kson.compat)), {
		ksh_version: "167",
		ksh_unknown: { meta: {}, option: {}, line: [] },
	});
	assert.deepEqual(kson.beat.bpm, [[0, 140], [7680, 122.5], [41280, 140]]);
	assert.deepEqual(kson.beat.time_sig, [[0, [4, 4]], [8, [7, 4]], [28, [4, 4]]]);
	// Laser sections: [startPulse, [[relPulse, value], ...], width]; a plain
	// point carries a single position number, a slam carries [from, to].
	assert.deepEqual(kson.note.laser[0][0], [2880, [[0, 0], [960, [0, 1]]], 1]);
	assert.deepEqual(kson.note.laser[1][0], [0, [[0, [1, 0]]], 1]);
	// Chips carry no length; holds are [pulse, length].
	assert.deepEqual(kson.note.fx[0][0], [6720, 960]);
	assert.deepEqual(kson.note.bt[0][0], [1920, 960]);
	assert.ok(Array.isArray(kson.camera.cam.body.zoom_top));
	assert.ok(Array.isArray(kson.camera.cam.body.zoom_bottom));
	assert.ok(kson.audio.audio_effect.fx);
});

test("poly.ksh converts byte-identically to the live editor VOX export", () => {
	const { kson } = parseKsh(decodeKshBytes(readFixture("poly.ksh")));
	assert.equal(convertKsonToVox(kson), readFixture("poly.golden.vox").toString("utf8"));
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

const MINI_KSH = [
	"title=Mini",
	"artist=Test",
	"t=120",
	"ver=167",
	"--",
	"beat=4/4",
	"0000|00|0:",
	"0000|00|::",
	"0000|00|::",
	"0000|00|::",
	"0000|00|::",
	"0000|00|::",
	"0000|00|::",
	"0000|00|--",
	"--",
	"#END",
].join("\n");

test("a one-point KSH laser is dropped with a warning instead of a degenerate section", () => {
	const { kson, warnings } = parseKsh(MINI_KSH);
	assert.ok(warnings.includes(
		"A KSH laser with fewer than two position points was omitted; its source is retained.",
	));
	assert.deepEqual(kson.note.laser[0], []);
	assert.deepEqual(kson.note.laser[1], []);
	assert.equal(kson.meta.title, "Mini");
});

test("parseKsh rejects malformed charts", () => {
	assert.throws(() => parseKsh("title=NoSeparator\n#0001:\n"), /missing measure separator/);
	assert.throws(() => parseKsh("--\n"), /missing title/);
});
