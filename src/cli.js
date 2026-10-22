import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertKsonToVox } from "./converter.js";

function printUsage() {
	console.error([
		"Usage:",
		"  node src/cli.js <input.ksh|input.kson> [output.vox]",
		"  node src/cli.js <file|dir>... [-o <outputDir>] [--speed-cap <n|none>] [--max-speed <n>] [--min-speed <n>]",
		"",
		"Batch mode converts every .ksh/.kson chart given; directory arguments",
		"are scanned recursively. Outputs are written beside each input, or",
		"mirrored under <outputDir> when -o/--out is passed. One failing chart",
		"does not stop the rest of the batch. --speed-cap overrides the ±10000",
		"lane-speed magnitude cap (default 10000; 'none' emits raw values).",
		"--max-speed clamps the chart's own scroll_speed values (KSON/KSH speed",
		"units, 1 = normal speed) to ±n before conversion, so speed ramps run",
		"down to the limit; emitted ManualSpeed never exceeds either cap.",
		"--min-speed floors those values at n (0 = no reverse scroll) because",
		"the game hides notes during negative-speed sections.",
	].join("\n"));
}

const CHART_EXT = new Set([".ksh", ".kson"]);

// Returns {chart, warnings} — KSH files are decoded from raw bytes
// (UTF-8 with BOM, else strict Shift-JIS) before parsing.
async function loadChart(inputPath) {
	const ext = path.extname(inputPath).toLowerCase();
	if (ext === ".ksh") {
		const { parseKsh, decodeKshBytes } = await import("./ksh-parser.js");
		const { kson, warnings } = parseKsh(decodeKshBytes(fs.readFileSync(inputPath)));
		return { chart: kson, warnings };
	}
	const raw = fs.readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
	if (ext === ".kson" || raw.trimStart().startsWith("{")) {
		return { chart: JSON.parse(raw), warnings: [] };
	}
	throw new Error("Input must be a .ksh or .kson chart.");
}

/** Convert one chart and write the .vox; prints its own summary + warnings. */
async function convertOne(inputPath, outputPath, { batch = false, convertOptions = {} } = {}) {
	const { chart, warnings: parseWarnings } = await loadChart(inputPath);
	const converterWarnings = [];
	const vox = convertKsonToVox(chart, (message) => converterWarnings.push(message), convertOptions);
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, Buffer.from(vox, "ascii"));

	const warnings = [...new Set([...parseWarnings, ...converterWarnings])];
	const sectionRows = (name) => {
		const match = new RegExp(`^#${name}\\n([\\s\\S]*?)^#END$`, "m").exec(vox);
		return match && match[1].trim() ? match[1].trim().split("\n").length : 0;
	};
	const label = batch
		? `${path.basename(inputPath)} -> ${outputPath}`
		: `Wrote ${outputPath}`;
	console.log(label);
	console.log(
		`VOX v13 · ${sectionRows("TRACK1") + sectionRows("TRACK8")} laser nodes · ${sectionRows("FXBUTTON EFFECT INFO") / 2} FX presets · ${warnings.length} warning(s)`,
	);
	for (const warning of warnings) {
		console.warn(`Warning: ${batch ? `[${path.basename(inputPath)}] ` : ""}${warning}`);
	}
}

/** Recursively collect .ksh/.kson files under a directory (hidden entries skipped). */
function collectCharts(entry, out) {
	const stat = fs.statSync(entry);
	if (stat.isDirectory()) {
		for (const name of fs.readdirSync(entry)) {
			if (name.startsWith(".")) continue;
			collectCharts(path.join(entry, name), out);
		}
	} else if (CHART_EXT.has(path.extname(entry).toLowerCase())) {
		out.push(entry);
	}
	return out;
}

/** Deepest directory that contains every input file (input tree root). */
function commonRoot(files) {
	let root = path.dirname(files[0]);
	for (const file of files.slice(1)) {
		let dir = path.dirname(file);
		for (;;) {
			const rel = path.relative(root, dir);
			if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) break;
			if (root === path.dirname(root)) return root;
			root = path.dirname(root);
		}
	}
	return root;
}

/** Output path for one chart: beside the input, or mirrored under outDir. */
function outputPathFor(file, root, outDir) {
	const base = `${path.basename(file, path.extname(file))}.vox`;
	if (!outDir) return path.join(path.dirname(file), base);
	let rel = path.relative(root, path.dirname(file));
	if (rel.startsWith("..") || path.isAbsolute(rel)) rel = "";
	return path.join(outDir, rel, base);
}

/** Keep batch outputs from one run from overwriting each other. */
function uniqueTarget(target, used, owner) {
	const key = target.toLowerCase();
	if (!used.has(key)) {
		used.set(key, owner);
		return [target, null];
	}
	const dir = path.dirname(target);
	const base = path.basename(target, ".vox");
	const claimedBy = used.get(key);
	for (let n = 2; ; n++) {
		const candidate = path.join(dir, `${base}_${n}.vox`);
		if (!used.has(candidate.toLowerCase())) {
			used.set(candidate.toLowerCase(), owner);
			return [candidate, claimedBy];
		}
	}
}

async function main(argv) {
	const inputs = [];
	let outDir = null;
	const convertOptions = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-o" || arg === "--out") {
			outDir = argv[++i];
			if (!outDir) {
				console.error(`Missing directory after ${arg}`);
				printUsage();
				return 2;
			}
		} else if (arg === "--speed-cap") {
			const raw = argv[++i];
			if (raw == null) {
				console.error(`Missing value after ${arg}`);
				printUsage();
				return 2;
			}
			if (raw === "none") {
				convertOptions.speedCap = Infinity;
			} else {
				const value = Number(raw);
				if (!Number.isFinite(value) || value <= 0) {
					console.error(`Invalid speed cap: ${raw} (expected positive number or 'none')`);
					return 2;
				}
				convertOptions.speedCap = value;
			}
		} else if (arg === "--max-speed") {
			const raw = argv[++i];
			if (raw == null) {
				console.error(`Missing value after ${arg}`);
				printUsage();
				return 2;
			}
			const value = Number(raw);
			if (!Number.isFinite(value) || value <= 0) {
				console.error(`Invalid max speed: ${raw} (expected positive number in KSON/KSH speed units, 1 = normal speed)`);
				return 2;
			}
			convertOptions.maxSpeed = value;
		} else if (arg === "--min-speed") {
			const raw = argv[++i];
			if (raw == null) {
				console.error(`Missing value after ${arg}`);
				printUsage();
				return 2;
			}
			const value = Number(raw);
			if (!Number.isFinite(value)) {
				console.error(`Invalid min speed: ${raw} (expected a number in KSON/KSH speed units, 1 = normal speed; 0 disables reverse scroll)`);
				return 2;
			}
			convertOptions.minSpeed = value;
		} else if (arg === "--help" || arg === "-h") {
			printUsage();
			return 0;
		} else if (arg.startsWith("-")) {
			console.error(`Unknown option: ${arg}`);
			printUsage();
			return 2;
		} else {
			inputs.push(arg);
		}
	}
	if (!inputs.length) {
		printUsage();
		return 2;
	}

	// Legacy single-file form: `<input> <output.vox>`.
	if (
		inputs.length === 2 && !outDir && /\.vox$/i.test(inputs[1]) &&
		fs.existsSync(inputs[0]) && fs.statSync(inputs[0]).isFile()
	) {
		await convertOne(path.resolve(inputs[0]), path.resolve(inputs[1]), { convertOptions });
		return 0;
	}

	const files = [];
	let missing = 0;
	for (const entry of inputs) {
		const resolved = path.resolve(entry);
		if (!fs.existsSync(resolved)) {
			console.error(`Input not found: ${entry}`);
			missing++;
			continue;
		}
		collectCharts(resolved, files);
	}
	if (outDir) outDir = path.resolve(outDir);
	const unique = [...new Set(files.map((file) => path.resolve(file)))];
	if (!unique.length) {
		console.error("No .ksh/.kson charts found.");
		return missing ? 1 : 2;
	}

	const root = commonRoot(unique);
	const used = new Map();
	let converted = 0;
	let failed = missing;
	for (const file of unique) {
		const [output, collidedWith] = uniqueTarget(outputPathFor(file, root, outDir), used, path.basename(file));
		if (collidedWith) {
			console.log(`note: ${path.basename(file)} -> ${path.basename(output)} (name collision with ${collidedWith} output)`);
		}
		try {
			await convertOne(file, output, { batch: true, convertOptions });
			converted++;
		} catch (error) {
			console.error(`Failed ${file}: ${error.message}`);
			failed++;
		}
	}
	console.log(`Converted ${converted} chart(s), ${failed} failed.`);
	return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		console.error(`Conversion failed: ${error.message}`);
		process.exitCode = 1;
	}
}
