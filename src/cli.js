import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertKsonToVox } from "./converter.js";

function printUsage() {
	console.error("Usage: node src/cli.js <input.ksh|input.kson> [output.vox]");
}

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

async function main(args) {
	if (args.length < 1 || args.length > 2 || args[0] === "--help" || args[0] === "-h") {
		printUsage();
		return args[0] === "--help" || args[0] === "-h" ? 0 : 2;
	}

	const inputPath = path.resolve(args[0]);
	const outputPath = args[1]
		? path.resolve(args[1])
		: path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.vox`);

	const { chart, warnings: parseWarnings } = await loadChart(inputPath);
	const converterWarnings = [];
	const vox = convertKsonToVox(chart, (message) => converterWarnings.push(message));
	fs.writeFileSync(outputPath, Buffer.from(vox, "ascii"));

	const warnings = [...new Set([...parseWarnings, ...converterWarnings])];
	const sectionRows = (name) => {
		const match = new RegExp(`^#${name}\\n([\\s\\S]*?)^#END$`, "m").exec(vox);
		return match && match[1].trim() ? match[1].trim().split("\n").length : 0;
	};
	console.log(`Wrote ${outputPath}`);
	console.log(
		`VOX v13 · ${sectionRows("TRACK1") + sectionRows("TRACK8")} laser nodes · ${sectionRows("FXBUTTON EFFECT INFO") / 2} FX presets · ${warnings.length} warning(s)`,
	);
	for (const warning of warnings) {
		console.warn(`Warning: ${warning}`);
	}
	return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		console.error(`Conversion failed: ${error.message}`);
		process.exitCode = 1;
	}
}
