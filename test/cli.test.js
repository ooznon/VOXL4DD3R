import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "src", "cli.js");

const chart = {
	meta: {},
	beat: { bpm: [[0, 120]], time_sig: [[0, [4, 4]]], scroll_speed: [[0, 1]] },
	note: { bt: [[[0, 480]], [], [], []], fx: [[], []], laser: [[], []] },
};

const kshStub = [
	"title=Test", "artist=Test", "effect=1CHiN05E", "jacket=jacket.jpg",
	"illustrator=Test", "difficulty=novice", "level=1", "t=120",
	"m=bgm.ogg", "ver=200", "--", "beat=4/4", "0000|00|--", "--",
].join("\n") + "\n";

/** Temp dir with a chart at the root and one in a subdirectory. */
function makeTree(dir) {
	fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
	fs.writeFileSync(path.join(dir, "a.kson"), JSON.stringify(chart));
	fs.writeFileSync(path.join(dir, "sub", "b.kson"), JSON.stringify(chart));
}

test("batch mode converts every chart in a directory tree", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voxl4dd3r-"));
	try {
		makeTree(dir);
		const { stdout } = await run(process.execPath, [cli, dir]);
		assert.ok(fs.existsSync(path.join(dir, "a.vox")));
		assert.ok(fs.existsSync(path.join(dir, "sub", "b.vox")));
		assert.ok(stdout.includes("Converted 2 chart(s), 0 failed."), stdout);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("-o mirrors the input tree under the output directory", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voxl4dd3r-"));
	try {
		makeTree(dir);
		const out = path.join(dir, "out");
		await run(process.execPath, [cli, dir, "-o", out]);
		assert.ok(fs.existsSync(path.join(out, "a.vox")));
		assert.ok(fs.existsSync(path.join(out, "sub", "b.vox")));
		// Inputs are left untouched when an output directory is given.
		assert.ok(!fs.existsSync(path.join(dir, "a.vox")));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a failing chart does not stop the batch", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voxl4dd3r-"));
	try {
		makeTree(dir);
		fs.writeFileSync(path.join(dir, "broken.kson"), "{not json");
		const error = await run(process.execPath, [cli, dir]).then(
			() => assert.fail("expected a nonzero exit"),
			(e) => e,
		);
		assert.equal(error.code, 1);
		assert.ok(error.stderr.includes("Failed"), error.stderr);
		assert.ok(error.stderr.includes("broken.kson"), error.stderr);
		assert.ok(error.stdout.includes("Converted 2 chart(s), 1 failed."), error.stdout);
		// The healthy charts still converted.
		assert.ok(fs.existsSync(path.join(dir, "a.vox")));
		assert.ok(fs.existsSync(path.join(dir, "sub", "b.vox")));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy single-file form still writes an explicit output path", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voxl4dd3r-"));
	try {
		const input = path.join(dir, "a.kson");
		fs.writeFileSync(input, JSON.stringify(chart));
		const output = path.join(dir, "custom.vox");
		const { stdout } = await run(process.execPath, [cli, input, output]);
		assert.ok(fs.existsSync(output));
		assert.ok(stdout.includes(`Wrote ${output}`), stdout);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("same-name charts in one folder get a _2 suffix and a collision note", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voxl4dd3r-"));
	try {
		fs.writeFileSync(path.join(dir, "in.kson"), JSON.stringify(chart));
		fs.writeFileSync(path.join(dir, "in.ksh"), kshStub);
		const { stdout } = await run(process.execPath, [cli, dir]);
		assert.ok(fs.existsSync(path.join(dir, "in.vox")));
		assert.ok(fs.existsSync(path.join(dir, "in_2.vox")));
		assert.ok(stdout.includes("name collision"), stdout);
		assert.ok(stdout.includes("Converted 2 chart(s), 0 failed."), stdout);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("--max-speed clamps chart-unit speeds and rejects bad values", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voxl4dd3r-"));
	try {
		const spiky = {
			...chart,
			beat: { bpm: [[0, 120]], time_sig: [[0, [4, 4]]], scroll_speed: [[0, 1], [960, [1, 7000]], [1920, 1]] },
		};
		const input = path.join(dir, "spike.kson");
		fs.writeFileSync(input, JSON.stringify(spiky));
		const { stderr } = await run(process.execPath, [cli, input, "--max-speed", "3000"]);
		assert.ok(stderr.includes("clamped to the max speed"), stderr);
		const vox = fs.readFileSync(path.join(dir, "spike.vox"), "ascii");
		const values = vox.split(/\r?\n/).filter(r => r.includes("ManualSpeed"))
			.map(r => Number(r.split("\t")[4].slice(1)));
		assert.ok(values.includes(3000), `the clamped value is emitted: ${values}`);
		assert.deepEqual(values.filter(v => Math.abs(v) > 3000), [], "no ManualSpeed exceeds --max-speed");

		const bad = await run(process.execPath, [cli, input, "--max-speed", "0"]).then(
			() => assert.fail("expected a nonzero exit"),
			(e) => e,
		);
		assert.equal(bad.code, 2);
		assert.ok(bad.stderr.includes("Invalid max speed"), bad.stderr);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("--min-speed floors reverse scroll and rejects bad values", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voxl4dd3r-"));
	try {
		const reversy = {
			...chart,
			beat: { bpm: [[0, 120]], time_sig: [[0, [4, 4]]], scroll_speed: [[0, 1], [960, [1, -8]], [1920, 1]] },
		};
		const input = path.join(dir, "reverse.kson");
		fs.writeFileSync(input, JSON.stringify(reversy));
		const { stderr } = await run(process.execPath, [cli, input, "--min-speed", "0"]);
		assert.ok(stderr.includes("floored to the min speed"), stderr);
		const vox = fs.readFileSync(path.join(dir, "reverse.vox"), "ascii");
		const values = vox.split(/\r?\n/).filter(r => r.includes("ManualSpeed"))
			.map(r => Number(r.split("\t")[4].slice(1)));
		assert.ok(values.includes(0), `the floor is emitted: ${values}`);
		assert.deepEqual(values.filter(v => v < 0), [], "no ManualSpeed goes below --min-speed");

		const bad = await run(process.execPath, [cli, input, "--min-speed", "abc"]).then(
			() => assert.fail("expected a nonzero exit"),
			(e) => e,
		);
		assert.equal(bad.code, 2);
		assert.ok(bad.stderr.includes("Invalid min speed"), bad.stderr);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("--flag-reverse marks negative ManualSpeed rows with 2147483648", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voxl4dd3r-"));
	try {
		const reversy = {
			...chart,
			beat: { bpm: [[0, 120]], time_sig: [[0, [4, 4]]], scroll_speed: [[0, 1], [960, [1, -8]], [1920, 1]] },
		};
		const input = path.join(dir, "reverse.kson");
		fs.writeFileSync(input, JSON.stringify(reversy));
		await run(process.execPath, [cli, input, path.join(dir, "flagged.vox"), "--flag-reverse"]);
		const flags = (out) => fs.readFileSync(out, "ascii").split(/\r?\n/)
			.filter(r => r.includes("ManualSpeed"))
			.map(r => Number(r.split("\t")[2]));
		const flagged = flags(path.join(dir, "flagged.vox"));
		assert.ok(flagged.includes(2147483648), `negative rows are flagged: ${flagged}`);
		assert.deepEqual(flagged.filter(f => f !== 0 && f !== 2147483648), [], "only bit 31 is set");

		await run(process.execPath, [cli, input, path.join(dir, "plain.vox")]);
		assert.deepEqual(flags(path.join(dir, "plain.vox")).filter(f => f !== 0), [], "no flag by default");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("--safe-reverse bounds reverse drift and accepts a budget argument", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voxl4dd3r-"));
	try {
		// Long reverse window: drift = 4 * 1920 / 2 = 3840 pulse-units = 4 measures.
		const reversy = {
			...chart,
			beat: { bpm: [[0, 120]], time_sig: [[0, [4, 4]]], scroll_speed: [[0, 1], [960, [1, -4]], [2880, 1]] },
		};
		const input = path.join(dir, "reverse.kson");
		fs.writeFileSync(input, JSON.stringify(reversy));
		const drift = async (args) => {
			const out = path.join(dir, `out${args.length}.vox`);
			const { stderr } = await run(process.execPath, [cli, input, out, ...args]);
			const rows = fs.readFileSync(out, "ascii").split(/\r?\n/)
				.filter(r => r.includes("ManualSpeed"))
				.map(r => {
					const parts = r.split("\t");
					const [m, b, t] = parts[0].split(",").map(Number);
					return { pulse: (m - 1) * 960 + (b - 1) * 240 + t, spd: Number(parts[4].slice(1)) };
				})
				.sort((a, b) => a.pulse - b.pulse);
			let acc = 0;
			let max = 0;
			for (let i = 0; i < rows.length; i++) {
				const dt = i + 1 < rows.length ? rows[i + 1].pulse - rows[i].pulse : 0;
				if (rows[i].spd < 0) { acc += -rows[i].spd * dt; if (acc > max) max = acc; }
				else acc = Math.max(0, acc - rows[i].spd * dt);
			}
			return { stderr, maxDrift: max / 960 };
		};

		const base = await drift([]);
		assert.ok(base.maxDrift > 3, `default keeps full reverse: ${base.maxDrift}`);

		const safe = await drift(["--safe-reverse"]);
		assert.ok(safe.maxDrift <= 0.5 + 1e-6, `default budget 0.5 bounds the drift: ${safe.maxDrift}`);
		assert.ok(safe.stderr.includes("safe-reverse"), safe.stderr);

		const loose = await drift(["--safe-reverse", "2"]);
		assert.ok(loose.maxDrift <= 2 + 1e-6, `the budget argument is honored: ${loose.maxDrift}`);
		assert.ok(loose.maxDrift > safe.maxDrift, "a bigger budget keeps more reverse");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
