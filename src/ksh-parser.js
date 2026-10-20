/**
 * KSH -> KSON parser, ported 1:1 from the sdvxindex reference parser
 * (f_000012 module 46136, exports `N` = parseKsh and `S` = decode).
 *
 * Produces a KSON format_version 1 chart object compatible with
 * convertKsonToVox(), plus a list of non-fatal warnings. Fatal errors
 * (missing title, missing "--", invalid BPM/time signature) throw.
 */

// KSH effect type name -> KSON effect type name.
const KSH_TYPE_MAP = {
	Retrigger: "retrigger",
	Gate: "gate",
	Flanger: "flanger",
	PitchShift: "pitch_shift",
	BitCrusher: "bitcrusher",
	Phaser: "phaser",
	Wobble: "wobble",
	TapeStop: "tapestop",
	Echo: "echo",
	SideChain: "sidechain",
	SwitchAudio: "switch_audio",
	HighPassFilter: "high_pass_filter",
	LowPassFilter: "low_pass_filter",
	PeakingFilter: "peaking_filter",
};

// Filter shorthand -> effect type ("fx"/"fx;bitcrusher" are switch aliases).
const FILTER_MAP = {
	peak: "peaking_filter",
	hpf1: "high_pass_filter",
	lpf1: "low_pass_filter",
	bitc: "bitcrusher",
	fx: "fx",
	"fx;bitc": "fx;bitcrusher",
};

// FX button character -> effect spec ("Type;param") for hold letters.
const BUTTON_EFFECTS = {
	S: "Retrigger;8",
	V: "Retrigger;12",
	T: "Retrigger;16",
	W: "Retrigger;24",
	U: "Retrigger;32",
	G: "Gate;4",
	H: "Gate;8",
	K: "Gate;12",
	I: "Gate;16",
	L: "Gate;24",
	J: "Gate;32",
	F: "Flanger",
	P: "PitchShift;12",
	B: "BitCrusher;5",
	Q: "Phaser",
	X: "Wobble;12",
	A: "TapeStop",
	D: "SideChain",
};

// KSH camelCase parameter -> KSON snake_case parameter.
const PARAM_RENAMES = {
	attackTime: "attack_time",
	chunkSize: "chunk_size",
	feedbackLevel: "feedback_level",
	fileName: "filename",
	freqMax: "freq_max",
	hiCutGain: "hi_cut_gain",
	hiFreq: "freq_2",
	holdTime: "hold_time",
	loFreq: "freq_1",
	overWrap: "overlap",
	Q: "q",
	releaseTime: "release_time",
	stereoWidth: "stereo_width",
	updateTrigger: "update_trigger",
	volume: "vol",
	waveLength: "wave_length",
};

// Laser position alphabet: index / 50 -> normalized 0..1.
const LASER_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const createObj = () => Object.create(null);
const num = (value, fallback = 0) => {
	const n = Number.parseFloat(value);
	return Number.isFinite(n) ? n : fallback;
};
const truncNum = (value, fallback = 0) => Math.trunc(num(value, fallback));
const round3 = (value) => Math.round(value * 1e3) / 1e3;
const mapName = (name, isFilter = false) => {
	const table = isFilter ? FILTER_MAP : KSH_TYPE_MAP;
	return hasOwn(table, name) ? table[name] : name;
};
const splitKV = (line) => {
	const at = line.indexOf("=");
	return at < 0 ? null : [line.slice(0, at), line.slice(at + 1)];
};

/** list of [pulse, value]: overwrite, or build an instant [from, to] pair when combining. */
function setPoint(list, pulse, value, combine = false) {
	const found = list.find((e) => e[0] === pulse);
	if (found) found[1] = combine ? [Array.isArray(found[1]) ? found[1][0] : found[1], value] : value;
	else list.push([pulse, value]);
}

function parseTimeSig(value) {
	const m = /^(\d+)\/(\d+)$/.exec(value);
	if (!m || +m[1] < 1 || +m[2] < 1 || (960 * +m[1]) % +m[2]) {
		throw new Error(`Invalid KSH time signature: ${value}`);
	}
	return [+m[1], +m[2]];
}

/**
 * Build the KSON effect v{} for a "Type;paramA;paramB" spec (KSH button chars
 * and fx-l/fx-r option values).
 */
function effectParams(type, a, b) {
	const paramA = truncNum(a, { retrigger: 8, gate: 4, wobble: 12, pitch_shift: 12, bitcrusher: 5, tapestop: 50, echo: 4 }[type] || 0);
	const paramB = truncNum(b, 60);
	const v = {};
	if (["retrigger", "gate", "wobble", "echo"].includes(type) && paramA > 0) v.wave_length = `1/${paramA}`;
	if (type === "pitch_shift") v.pitch = String(paramA);
	if (type === "bitcrusher") v.reduction = `${paramA}samples`;
	if (type === "tapestop") v.speed = `${paramA}%`;
	if (type === "echo") v.feedback_level = `${paramB}%`;
	return v;
}

/** Decode raw KSH bytes: UTF-8 with BOM, otherwise strict Shift-JIS. */
export function decodeKshBytes(bytes) {
	const buf = bytes instanceof ArrayBuffer
		? new Uint8Array(bytes)
		: ArrayBuffer.isView(bytes)
			? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
			: null;
	if (!buf) throw new Error("KSH decoding requires file bytes.");
	const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
	try {
		return new TextDecoder(hasBom ? "utf-8" : "shift_jis", { fatal: true }).decode(buf);
	} catch {
		throw new Error(`Could not read KSH text as ${hasBom ? "UTF-8" : "Shift-JIS"}. UTF-8 KSH files need a BOM.`);
	}
}

/**
 * Parse a KSH chart into KSON.
 * @param {string} text decoded KSH source
 * @returns {{kson: object, warnings: string[]}}
 */
export function parseKsh(text) {
	if (typeof text !== "string") throw new Error("KSH chart must be text.");
	const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
	const firstSep = lines.indexOf("--");
	if (firstSep < 0) throw new Error("Invalid KSH chart: missing measure separator (--).");

	// ------------------------------------------------------------------ header
	const header = createObj();
	const unknown = { meta: createObj(), option: createObj(), line: [] };
	const comments = [];
	const warnings = [];
	const warn = (msg) => {
		if (!warnings.includes(msg)) warnings.push(msg);
	};

	for (const line of lines.slice(0, firstSep)) {
		if (!line) continue;
		if (line.startsWith("//")) {
			comments.push([0, line.slice(2)]);
			continue;
		}
		const kv = splitKV(line);
		if (kv) header[kv[0]] = kv[1];
		else unknown.line.push([0, line]);
	}
	if (!hasOwn(header, "title")) throw new Error("Invalid KSH chart: missing title header.");

	const take = (key, fallback = "") => {
		const value = hasOwn(header, key) ? header[key] : fallback;
		delete header[key];
		return value;
	};

	const ver = take("ver", "100");
	const verCompat = take("ver_compat", "");
	const kshVersion = truncNum(verCompat || ver, 100); // y
	const timeSig = parseTimeSig(take("beat", "4/4")); // A
	const initialBpm = take("t", ""); // B
	const bgmNames = take("m").split(";"); // k
	const difficultyRaw = take("difficulty", "infinite");
	const difficultyIndex = ["light", "challenge", "extended", "infinite"].indexOf(difficultyRaw);
	const bgNames = take("bg", "desert").split(";");
	const layerNames = take("layer", "arrow").split(kshVersion >= 166 ? ";" : "/");

	const C = {
		format_version: 1,
		meta: {
			title: take("title"),
			artist: take("artist"),
			chart_author: take("effect"),
			jacket_filename: take("jacket"),
			jacket_author: take("illustrator", take("jacket_author")),
			difficulty: difficultyIndex < 0 ? difficultyRaw : difficultyIndex,
			level: Math.min(20, Math.max(1, truncNum(take("level", "1")))),
			disp_bpm: initialBpm,
			std_bpm: num(take("to")),
		},
		beat: { bpm: [], time_sig: [[0, timeSig]], scroll_speed: [], stop: [] },
		note: { bt: [[], [], [], []], fx: [[], []], laser: [[], []] },
		audio: {
			bgm: {
				filename: bgmNames[0] || "",
				vol: num(take("mvol", "100")) / 100 * (kshVersion === 100 ? 0.6 : 1),
				offset: truncNum(take("o")),
				preview: { offset: truncNum(take("po")), duration: truncNum(take("plength")) },
				legacy: { filename_f: bgmNames[1] || "", filename_p: bgmNames[2] || "", filename_fp: bgmNames[3] || "" },
			},
			key_sound: {
				fx: { chip_event: createObj() },
				laser: {
					vol: [[0, num(take("chokkakuvol", "50")) / 100]],
					slam_event: createObj(),
					legacy: { vol_auto: truncNum(take("chokkakuautovol", "1")) !== 0 },
				},
			},
			audio_effect: {
				fx: { def: [], long_event: createObj(), param_change: createObj() },
				laser: {
					def: [],
					pulse_event: createObj(),
					param_change: createObj(),
					peaking_filter_delay: truncNum(take("pfilterdelay", "40")),
					legacy: { filter_gain: [[0, num(take("pfiltergain", "50")) / 100]] },
				},
			},
		},
		camera: { tilt: [], cam: { body: {}, pattern: { laser: { slam_event: { spin: [], half_spin: [], swing: [] } } } } },
		bg: {
			legacy: {
				bg: [{ filename: bgNames[0] }, { filename: bgNames[1] || bgNames[0] }],
				layer: {
					filename: layerNames[0],
					duration: truncNum(layerNames[1]),
					rotation: { tilt: !!(1 & truncNum(layerNames[2], 3)), spin: !!(2 & truncNum(layerNames[2], 3)) },
				},
				movie: { filename: take("v"), offset: truncNum(take("vo")) },
			},
		},
		gauge: { total: truncNum(take("total")) },
		editor: { comment: comments },
		compat: { ksh_version: verCompat || ver, ksh_unknown: unknown },
	};

	for (const key of ["title_translit", "title_img", "artist_translit", "artist_img", "icon", "information"]) {
		if (hasOwn(header, key)) {
			C.meta[{ title_img: "title_img_filename", artist_img: "artist_img_filename", icon: "icon_filename" }[key] || key] = take(key);
		}
	}

	const I = C.audio.audio_effect.fx; // fx audio_effect
	const M = C.audio.audio_effect.laser; // laser audio_effect

	// beat.bpm: the first numeric BPM is always anchored at pulse 0.
	const applyBpm = (pulse, value) => {
		if (value.includes("-")) return;
		const bpm = round3(num(value));
		if (!(bpm > 0)) throw new Error(`Invalid KSH BPM at pulse ${pulse}: ${value}`);
		setPoint(C.beat.bpm, C.beat.bpm.length ? pulse : 0, kshVersion >= 130 ? Math.min(65535, bpm) : bpm);
	};
	if (initialBpm) applyBpm(0, initialBpm);

	// Laser filter registration (filtertype header / option rows).
	const applyFilter = (pulse, filterChar) => {
		let name = mapName(filterChar, true);
		if (name === "fx" && !M.def.some((d) => d[0] === name)) {
			if (bgmNames[1]) M.def.push([name, { type: "switch_audio", v: { filename: bgmNames[1] } }]);
			else name = "";
		}
		if (name === "fx;bitcrusher" && !M.def.some((d) => d[0] === name)) {
			M.def.push([name, { type: "bitcrusher", v: {} }]);
		}
		if (name) {
			M.pulse_event[name] ||= [];
			if (!M.pulse_event[name].includes(pulse)) M.pulse_event[name].push(pulse);
		}
	};
	if (hasOwn(header, "filtertype")) applyFilter(0, take("filtertype"));
	Object.assign(unknown.meta, header);

	// ------------------------------------------------------------ measure state
	const curves = createObj(); // key -> [[pulse, [a, b]], ...]
	const effectChanges = []; // FX hold effect changes
	const holds = [null, null, null, null, null, null]; // bt0-3, fxL, fxR
	const lasers = [null, null]; // open laser sections
	const recordUnknown = (key, pulse, value) => {
		unknown.option[key] ||= [];
		unknown.option[key].push([pulse, value]);
	};
	const closeHold = (lane) => {
		const hold = holds[lane];
		if (!hold) return;
		(lane < 4 ? C.note.bt[lane] : C.note.fx[lane - 4]).push([hold.start, Math.trunc(hold.length)]);
		holds[lane] = null;
	};
	const closeLaser = (lane) => {
		const section = lasers[lane];
		if (!section) return;
		lasers[lane] = null;
		if (section.points.length < 2) {
			warn("A KSH laser with fewer than two position points was omitted; its source is retained.");
			return;
		}
		// Slams: points within 30 pulses with a different value collapse into
		// an instant [from, to] span; the following isolated point is consumed.
		const points = [];
		for (let i = 0; i < section.points.length; i += 1) {
			const cur = section.points[i];
			const next = section.points[i + 1];
			const after = section.points[i + 2];
			if (next && next[0] - cur[0] <= 30 && next[1] !== cur[1]) {
				points.push([cur[0], [cur[1], next[1]]]);
				if (!after || after[0] - next[0] > 30 || after[1] === next[1]) i += 1;
			} else {
				points.push(cur);
			}
		}
		C.note.laser[lane].push([section.start, points, section.wide ? 2 : 1]);
	};

	let measureStart = 0; // V
	let measureIndex = 0; // G
	let curSig = timeSig; // W
	let rows = []; // K

	const flushMeasure = () => {
		const noteRows = rows.filter((e) => e.kind === "note");
		// Time signature changes inside the measure apply at the measure start.
		for (const opt of rows.filter((e) => e.kind === "option" && e.key === "beat")) {
			curSig = parseTimeSig(opt.value);
			setPoint(C.beat.time_sig, measureIndex, curSig);
		}
		const measureLen = (960 * curSig[0]) / curSig[1]; // a
		const rowLen = measureLen / Math.max(1, noteRows.length); // r
		if (noteRows.length && measureLen % noteRows.length) {
			warn(`KSH measure ${measureIndex + 1} uses ${noteRows.length} rows; positions are truncated to KSON pulses as in libkson.`);
		}
		const groups = new Map(); // row index -> {key: value}

		for (const row of rows) {
			const pulse = measureStart + Math.trunc(row.index * rowLen);
			if (row.kind === "comment") {
				comments.push([pulse, row.value]);
				continue;
			}
			if (row.kind === "unknown") {
				unknown.line.push([pulse, row.value]);
				continue;
			}
			if (row.kind !== "option") continue;
			const { key, value } = row;
			groups.has(row.index) || groups.set(row.index, createObj());
			groups.get(row.index)[key] = value;
			if (key === "beat") continue;
			if (key.endsWith("_curve")) {
				const base = key.slice(0, -6);
				curves[base] ||= [];
				curves[base].push([pulse, value.split(";").map((v) => num(v))]);
			} else if (key === "t") {
				applyBpm(pulse, value);
			} else if (key === "stop") {
				if (truncNum(value) > 0) setPoint(C.beat.stop, pulse, 5 * truncNum(value));
			} else if (key === "scroll_speed") {
				setPoint(C.beat.scroll_speed, pulse, num(value), true);
			} else if (["zoom_top", "zoom_bottom", "zoom_side", "center_split", "rotation_deg"].includes(key)) {
				const isZoom = key.startsWith("zoom_");
				const raw = key === "rotation_deg" ? num(value) : truncNum(isZoom && kshVersion < 167 ? value.slice(0, 4) : value);
				const range = isZoom && kshVersion < 167 ? 300 : 65535;
				C.camera.cam.body[key] ||= [];
				const inRange = Math.abs(raw) <= range
					|| (isZoom && kshVersion < 167 && C.camera.cam.body[key].some((e) => e[0] === pulse));
				if (inRange) setPoint(C.camera.cam.body[key], pulse, raw, true);
				else {
					recordUnknown(key, pulse, value);
					warn(`Out-of-range KSH ${key} was retained without substitute movement.`);
				}
			} else if (key === "tilt") {
				const parsed = /^[+-]?(?:\d|\.)/.test(value)
					? round3(num(value))
					: ({ big: "bigger", keep: "keep_bigger" }[value] || value);
				const existing = C.camera.tilt.find((e) => e[0] === pulse);
				setPoint(C.camera.tilt, pulse, parsed, typeof parsed === "number" || typeof existing?.[1] === "number");
			} else if (key === "chokkakuvol") {
				setPoint(C.audio.key_sound.laser.vol, pulse, num(value) / 100);
			} else if (key === "pfiltergain") {
				setPoint(M.legacy.filter_gain, pulse, num(value) / 100);
			} else if (key === "filtertype") {
				applyFilter(pulse, value);
			} else if (/^(fx|filter):[^:]+:[^:]+$/.test(key)) {
				const [kind, rawName, rawParam] = key.split(":");
				const target = kind === "fx" ? I : M;
				const name = mapName(rawName, kind === "filter");
				const param = PARAM_RENAMES[rawParam] || rawParam;
				target.param_change[name] ||= createObj();
				target.param_change[name][param] ||= [];
				setPoint(target.param_change[name][param], pulse, value);
			} else if (!/^(fx-[lr](?:_param1|_se)?|laserrange_[lr]|chokkakuse)$/.test(key)) {
				recordUnknown(key, pulse, value);
			}
		}

		for (let i = 0; i < noteRows.length; i += 1) {
			const row = noteRows[i];
			const pulse = measureStart + Math.trunc(i * rowLen);
			const opts = groups.get(i) || {};
			const [btField, fxField, laserField] = row.value.split("|");
			// BT lanes 0..3, FX lanes 4..5. Chip: BT "1", FX "2"; hold: BT "2", FX
			// letters/"1"; FX "0" ends a hold without a chip.
			for (let lane = 0; lane < 6; lane += 1) {
				const ch = lane < 4 ? btField[lane] : fxField[lane - 4];
				const isFx = lane >= 4;
				const isChipPath = isFx ? ch === "0" || ch === "2" : ch !== "2";
				if (isChipPath) {
					closeHold(lane);
					if (ch === (isFx ? "2" : "1")) {
						(isFx ? C.note.fx[lane - 4] : C.note.bt[lane]).push(pulse);
						const se = opts[`fx-${lane === 4 ? "l" : "r"}_se`];
						if (isFx && se) {
							const [name, vol] = se.split(";");
							C.audio.key_sound.fx.chip_event[name] ||= [[], []];
							C.audio.key_sound.fx.chip_event[name][lane - 4].push([pulse, { vol: num(vol, 100) / 100 }]);
						}
					}
					continue;
				}
				// Hold row.
				holds[lane] ||= { start: pulse, length: 0, legacy: false, effect: "", parameter: undefined };
				const hold = holds[lane];
				hold.length += rowLen;
				if (isFx) {
					const key = `fx-${lane === 4 ? "l" : "r"}`;
					const fromTable = ch !== "1"; // letter char -> spec table; "1" -> option lines
					let effect = fromTable ? BUTTON_EFFECTS[ch] || "" : opts[key];
					const parameter = opts[`${key}_param1`] ?? (fromTable ? hold.parameter : undefined);
					if (effect === undefined && hold.legacy) effect = "";
					if (effect !== undefined && !(fromTable && effect === hold.effect && parameter === hold.parameter)) {
						effectChanges.push({ time: pulse, lane: lane - 4, effect, parameter });
					}
					if (effect !== undefined) {
						hold.effect = effect;
						hold.parameter = parameter;
					}
					hold.legacy = fromTable;
				}
			}
			// Laser lanes: "-" ends, ":" continues, position chars append.
			for (let lane = 0; lane < 2; lane += 1) {
				const ch = laserField[lane];
				if (ch === "-") {
					closeLaser(lane);
					continue;
				}
				if (ch === ":") continue;
				const idx = LASER_CHARS.indexOf(ch);
				if (idx < 0) {
					warn(`Invalid KSH laser character ${ch} at pulse ${pulse}; source retained.`);
					continue;
				}
				lasers[lane] ||= { start: pulse, points: [], wide: opts[`laserrange_${lane ? "r" : "l"}`] === "2x" };
				const section = lasers[lane];
				const value = section.wide && ch === "C" ? 0.25 : section.wide && ch === "b" ? 0.75 : idx / 50;
				section.points.push([pulse - section.start, value]);
				if (opts.chokkakuse) {
					C.audio.key_sound.laser.slam_event[opts.chokkakuse] ||= [];
					C.audio.key_sound.laser.slam_event[opts.chokkakuse].push(pulse);
				}
			}
			// Spin suffix rides on the laser field: (@120 / S>240;scale;repeat;order
			const spin = /^([@S])([()<>])(\d+)(?:;(.*))?$/.exec(laserField.slice(2));
			if (spin) {
				const direction = ["(", "<"].includes(spin[2]) ? -1 : 1;
				const duration = 5 * +spin[3];
				const kind = spin[1] === "S" ? "swing" : ["(", ")"].includes(spin[2]) ? "spin" : "half_spin";
				const entry = [pulse, direction, duration];
				if (kind === "swing") {
					const o = (spin[4] || "").split(";");
					entry.push({
						scale: num(o[0], 250),
						repeat: truncNum(o[1], 3),
						decay_order: Math.min(2, Math.max(0, truncNum(o[2], 2))),
					});
				}
				C.camera.cam.pattern.laser.slam_event[kind].push(entry);
			} else if (laserField.length > 2) {
				unknown.line.push([pulse, laserField.slice(2)]);
				warn("Unrecognized KSH spin suffix retained without substitute motion.");
			}
		}

		measureStart += measureLen;
		measureIndex += 1;
		rows = [];
	};

	// ------------------------------------------------------------- main scan
	let q = 0; // row index within the current measure (notes only)
	for (const line of lines.slice(firstSep + 1)) {
		if (!line) continue;
		if (line.startsWith("#")) {
			// #define_fx Name type=...;param=value  /  #define_filter Name ...
			const def = /^#define_(fx|filter) +([^ ]+) +(.+)$/.exec(line);
			if (!def) {
				unknown.line.push([measureStart, line]);
				continue;
			}
			const params = createObj();
			for (const chunk of def[3].trimEnd().split(";")) {
				const kv = splitKV(chunk);
				if (kv && kv[1]) params[kv[0]] = kv[1];
			}
			const type = hasOwn(KSH_TYPE_MAP, params.type) ? KSH_TYPE_MAP[params.type] : null;
			if (!type) {
				unknown.line.push([measureStart, line]);
				warn(`KSH effect ${def[2]} has an unsupported or missing type and is retained as source.`);
				continue;
			}
			const target = def[1] === "fx" ? I : M;
			const name = mapName(def[2], def[1] !== "fx");
			const values = createObj();
			for (const key of Object.keys(params)) {
				if (key !== "type") values[PARAM_RENAMES[key] || key] = params[key];
			}
			const entry = [name, { type, v: values }];
			const at = target.def.findIndex((d) => d[0] === name);
			if (at >= 0) {
				target.def[at] = entry;
				warn(`Duplicate KSH effect ${name}: the final definition is used.`);
			} else {
				target.def.push(entry);
			}
			continue;
		}
		if (line === "--") {
			flushMeasure();
			q = 0;
			continue;
		}
		if (/^[012]{4}\|[^|]{2}\|[^|]{2}/.test(line)) {
			rows.push({ kind: "note", index: q++, value: line });
			continue;
		}
		if (line.startsWith("//")) {
			rows.push({ kind: "comment", index: q, value: line.slice(2) });
			continue;
		}
		const kv = splitKV(line);
		rows.push(kv ? { kind: "option", index: q, key: kv[0], value: kv[1] } : { kind: "unknown", index: q, value: line });
	}
	if (rows.length) {
		warn("KSH final measure separator was missing; the final measure was recovered.");
		flushMeasure();
	}
	holds.forEach((hold, lane) => {
		if (hold) {
			warn("A KSH hold reaches the chart ending; it was closed at its last row boundary.");
			closeHold(lane);
		}
	});
	lasers.forEach((_, lane) => closeLaser(lane));

	// Register FX hold changes as long_event entries keyed by the mapped name;
	// inline v{} params ride on each event (no def for single-char effects).
	for (const change of effectChanges) {
		const [rawType, rawA, rawB] = change.effect.split(";");
		const name = mapName(rawType);
		const defType = I.def.find((d) => d[0] === name)?.[1]?.type || name;
		I.long_event[name] ||= [[], []];
		I.long_event[name][change.lane].push([change.time, effectParams(defType, change.parameter ?? rawA, rawB)]);
	}

	// Apply *_curve options to laser points / scroll speed / tilt / camera body.
	for (const [key, list] of Object.entries(curves)) {
		for (const [pulse, pair] of list) {
			if (pair.length !== 2 || pair.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) {
				warn(`Invalid KSH ${key}_curve retained without applying it.`);
				recordUnknown(`${key}_curve`, pulse, pair.join(";"));
				continue;
			}
			if (key === "laser_l" || key === "laser_r") {
				const lane = key === "laser_l" ? 0 : 1;
				const section = C.note.laser[lane].find(
					(e) => pulse >= e[0] && pulse <= e[0] + e[1][e[1].length - 1][0],
				);
				const point = section?.[1].find((pt) => pt[0] === pulse - section[0]);
				if (point) point[2] = pair;
			} else {
				const list2 = key === "scroll_speed"
					? C.beat.scroll_speed
					: key === "tilt"
						? C.camera.tilt
						: C.camera.cam.body[key];
				const entry = list2?.find((e) => e[0] === pulse);
				if (entry) {
					if (key === "tilt") entry[1] = [entry[1], pair];
					else entry[2] = pair;
				}
			}
		}
	}

	// Defaults.
	if (!C.beat.bpm.length) {
		C.beat.bpm.push([0, 120]);
		warn("KSH has no initial numeric BPM; 120 BPM was used.");
	}
	if (!C.beat.scroll_speed.some((e) => e[0] === 0)) C.beat.scroll_speed.unshift([0, 1]);
	if (!C.camera.tilt.some((e) => e[0] === 0)) C.camera.tilt.unshift([0, "normal"]);

	// Legacy tilt scale: pre-v170 KSH tilt degrees >= 10 were displayed 1.4x.
	const tiltValues = (v) => (Array.isArray(v) && Array.isArray(v[1]) ? tiltValues(v[0]) : Array.isArray(v) ? v : [v]);
	if (kshVersion < 170 && C.camera.tilt.some((e) => tiltValues(e[1]).some((v) => typeof v === "number" && Math.abs(v) >= 10))) {
		const scale = (v) => (typeof v === "number"
			? round3(1.4 * v)
			: Array.isArray(v)
				? Array.isArray(v[1])
					? [scale(v[0]), v[1]]
					: v.map(scale)
				: v);
		C.camera.tilt.forEach((entry) => {
			entry[1] = scale(entry[1]);
		});
	}

	[...C.note.bt, ...C.note.fx].forEach((lane) => lane.sort((a, b) => (Array.isArray(a) ? a[0] : a) - (Array.isArray(b) ? b[0] : b)));

	if (Object.keys(unknown.meta).length || Object.keys(unknown.option).length || unknown.line.length) {
		warn("Unrecognized KSH fields are preserved in compat.ksh_unknown.");
	}
	return { kson: C, warnings };
}
