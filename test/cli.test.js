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
