/**
 * KSON (format_version 1) -> SOUND VOLTEX VOX v13 converter.
 *
 * The output layer replicates the live sdvxindex.com editor's VOX writer — the
 * community-standard v13 dialect — verified byte-for-byte against live exports
 * of oracle fixtures. Cross-checked against pyKSH-exporter (v10 dialect) and
 * the official KSON spec (kson_format.md).
 *
 * VOX v13 timing model:
 *   - Positions are "MMM,BB,TT"; TT is the tick within the beat and runs
 *     0..(960/denominator-1). One VOX tick == one KSON pulse (resolution 240,
 *     written as #BEAT RESOLUTION 240).
 *   - Hold lengths and controller durations are ticks == KSON pulses.
 *   - Stops are ManualSpeed f0 blocks (BPM 4- markers are NOT used in v13).
 *
 * Camera pipeline: KSON zoom_top/zoom_bottom are projected through the game's
 * exact camera model (ported from sdvxindex) into CAM_RotX/CAM_Radi rows;
 * center_split becomes Morphing2 (x0.00712); rotation_deg + manual tilt x10
 * become BIL_RotZ. Ramps are adaptively linearized (tolerance ~0.002 deg for
 * rotation, 0.02 units for radius), matching the reference writer's behavior.
 * ManualSpeed scroll ramps are sampled every pulse (reference parity).
 *
 * Laser spin events (KSON slam_event.spin/half_spin) are attached to slams by
 * pulse + direction; VOX native spin codes 6/7 with a duration fitted on the
 * reference writer's grid. KSON swing has no native equivalent and is dropped
 * (matches the reference writer).
 *
 * KSON input contract (subset consumed here):
 *   beat.bpm          [[pulse, bpm], ...]
 *   beat.time_sig     [[measureIndex, [num, den]], ...]
 *   beat.scroll_speed [[pulse, value, curve?], ...]   (1 = normal speed)
 *   beat.stop         [[pulse, relPulses], ...]       (spec: relative pulses)
 *   note.bt[0..3]     chip: pulse | hold: [pulse, length] | {pulse, length?}
 *   note.fx[0..1]     same as bt; effects via audio.fx.long_event or {effect}
 *   note.laser[0..1]  [startPulse, points, width?, legacySpinMap?] sections
 *                     points: [y, v] | [y, v, curve] | [y, [from, to], curve?]
 *   audio.fx.def      [[name, {type, v}], ...] (or object map, legacy)
 *   audio.fx.long_event {name: [lane0Pulses, lane1Pulses]}
 *   audio.key_sound.fx.chip_event {pulse: sampleId}
 *   audio.key_sound.bt.chip_event [[pulse, sampleId]]
 *   camera.cam.body.zoom_top/zoom_bottom/rotation_deg/center_split
 *                     [[pulse, value|[from, to], curve?], ...]
 *   camera.tilt       [[pulse, number|"bigger"|...], ...]
 *   camera.cam.pattern.laser.slam_event
 *                     {spin: [[pulse, dir, len]], half_spin: [...], swing: [...]}
 *   compat.ksh_version numeric in (0,167) => legacy camera projection
 */

import { projectTailDecorations } from "./tail-projection.js";

const VOX_RESOLUTION = 240;
const LASER_SAMPLE_STEP = 15; // reference writer samples lasers every 15 ticks
// Reference camera writer chord adapter: 64-chord cap per span, 0.02 absolute
// error and the five chord-error sample nodes (Gauss-Legendre-ish quartet).
const CAM_MAX_SEGMENTS = 64;
const CAM_ABS_ERROR = 0.02;
const CAM_SAMPLES = [0.25, 0.5, 0.75, (1 - 1 / Math.sqrt(3)) / 2, (1 + 1 / Math.sqrt(3)) / 2];
const MORPHING_RATE = 0.00712; // center_split -> Morphing2 scale
const SPIN_CODES = { spin: 6, half_spin: 7 };
// Reference writer's spin duration grid: units = round(len * k), min 1.
const SPIN_DURATION_K = {
	spin: (360 / 675) / (24 * (3 / 7)),
	half_spin: 0.55 / (24 * (Math.PI / 6.5973444)),
};
const TILT_MODE_MAP = {
	normal: 0,
	bigger: 1,
	biggest: 1,
	keep_normal: 2,
	keep_bigger: 2,
	keep_biggest: 2,
	zero: 0,
};
const FX_NO_EFFECT_ID = 255; // hold marker used by the reference for effect-less FX holds
const FX_SLOT_OFFSET = 2; // first preset occupies effect id 2

const SP_HEADER_ROWS = [
	"001,01,00\tAIRL_ScaX\t0\t0\t0.00\t1.00\t0.00\t0.00",
	"001,01,00\tAIRR_ScaX\t0\t0\t0.00\t2.00\t0.00\t0.00",
];

// ------------------------------------------------------------------ helpers

function requireObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object.`);
	}
	return value;
}

function numberOr(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function finite(value, label) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new TypeError(`${label} must be a finite number.`);
	}
	return parsed;
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function pad(value, width) {
	return String(Math.max(0, Math.round(value))).padStart(width, "0");
}

/** formatFixed2: SPCONTROLLER baseline values (AIR rows). */
function formatFixed2(value) {
	if (!Number.isFinite(value)) {
		throw new TypeError("VOX values must be finite numbers.");
	}
	const text = value.toFixed(2);
	return Object.is(value, -0) ? "0.00" : text;
}

/** BPM rows use the minimal JS string ("120", "150.5"). */
function formatBpm(value) {
	if (!Number.isFinite(value)) {
		throw new TypeError("VOX BPM values must be finite numbers.");
	}
	return Object.is(value, -0) ? "0" : String(value);
}

/**
 * Camera value formatting: String(Number(v.toPrecision(12))) — matches the
 * reference writer's f/d prefixed values ("d60.3110448418", "f0.356", "f0").
 */
function formatCameraValue(value) {
	const rounded = Number(Number(value).toPrecision(12));
	return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** ManualSpeed values keep full JS float precision (reference parity). */
function formatSpeedValue(value) {
	return Object.is(value, -0) ? "0" : String(value);
}

/** Parse a graph point value: number or [from, to] instant-change pair. */
function parseSpan(value, label) {
	if (Array.isArray(value)) {
		return [finite(value[0], `${label}[0]`), finite(value[1] ?? value[0], `${label}[1]`)];
	}
	const v = finite(value, label);
	return [v, v];
}

function parseCurvePair(curve) {
	if (curve === null || curve === undefined || curve === "linear") return null;
	if (Array.isArray(curve) && curve.length === 2) {
		return [numberOr(curve[0], 0), numberOr(curve[1], 0)];
	}
	if (typeof curve === "object") {
		return [numberOr(curve.a, 0), numberOr(curve.b, 0)];
	}
	return null; // ease_in/ease_out strings approximate as linear (curveType below)
}

/**
 * Evaluate a KSON quadratic Bezier curve control pair (a, b) at t in [0,1].
 * The curve runs (0,0) -> (1,1): x(s) = 2a·s·(1-s) + s², y(s) = 2b·s·(1-s) + s².
 * Exact port of the reference writer's curve evaluator (module 99561 `O` /
 * module 5138 `A`): solve x(s) = t with the numerically stable closed-form
 * quadratic root (no bisection), then evaluate y(s). Clamps and operation
 * order match the reference bit-for-bit so 6dp/toPrecision(12) formatting
 * lands on the same side of every rounding straddle.
 */
export function evaluateKsonCurve(ctlA, ctlB, ctlT) {
	let a = clamp(ctlA, 0, 1);
	let b = clamp(ctlB, 0, 1);
	let t = clamp(ctlT, 0, 1);
	if (a === b) return t;
	const r = Math.sqrt(Math.max(0, a * a + t - 2 * a * t));
	const s = a < 0.25 ? (a - r) / (2 * a - 1) : t / (a + r);
	return clamp(2 * (1 - s) * s * b + s * s, 0, 1);
}

/** Curve -> VOX laser curveType cell (0 linear, 2 bezier, 4 ease_out, 5 ease_in). */
function curveTypeOf(curve) {
	if (curve === "ease_out" || curve === "ease_out_sin") return 4;
	if (curve === "ease_in" || curve === "ease_in_sin") return 5;
	return parseCurvePair(curve) ? 2 : 0;
}

function curveY(curve, t) {
	const pair = parseCurvePair(curve);
	return pair ? evaluateKsonCurve(pair[0], pair[1], t) : t;
}

/**
 * Timeline: maps KSON pulses to VOX "MMM,BB,TT" positions using the chart's
 * time-signature map. TT is the tick within the beat (0..beatLen-1) and one
 * tick equals one KSON pulse.
 */
class Timeline {
	constructor(timeSig, bpm) {
		const changes = (timeSig ?? []).length ? [...timeSig].sort((x, y) => x[0] - y[0]) : [[0, [4, 4]]];
		if (Number(changes[0][0]) !== 0) changes.unshift([0, [4, 4]]);
		this.sigs = [];
		let ci = 0;
		let measure = 0;
		let pulse = 0;
		let num = 4;
		let den = 4;
		const lastIndex = Math.max(0, Number(changes[changes.length - 1][0]) || 0);
		while (measure <= lastIndex) {
			while (ci < changes.length && Number(changes[ci][0]) <= measure) {
				num = Math.max(1, Math.round(Number(changes[ci][1][0])));
				den = Math.max(1, Math.round(Number(changes[ci][1][1])));
				ci++;
			}
			const beatLen = (960 / den);
			// [startPulse, num, den, measureIndex, measureLen, beatLen]
			this.sigs.push([pulse, num, den, measure, num * beatLen, beatLen]);
			pulse += num * beatLen;
			measure++;
		}
		this.lastPulse = pulse;
		this.bpmTable = (bpm ?? []).map((entry) => ({
			pulse: Math.max(0, Math.round(Number(Array.isArray(entry) ? entry[0] : entry.pulse))),
			bpm: finite(Array.isArray(entry) ? entry[1] : entry.bpm, "bpm"),
		})).sort((a, b) => a.pulse - b.pulse);
	}

	_findSig(pulse) {
		this._extendSigs(pulse);
		let lo = 0;
		let hi = this.sigs.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (this.sigs[mid][0] <= pulse) lo = mid; else hi = mid - 1;
		}
		return this.sigs[lo];
	}

	/** Build measures on demand past the last time_sig change (pattern continues). */
	_extendSigs(pulse) {
		let sig = this.sigs[this.sigs.length - 1];
		while (sig[0] + sig[4] <= pulse) {
			const next = [sig[0] + sig[4], sig[1], sig[2], sig[3] + 1, sig[4], sig[5]];
			this.sigs.push(next);
			sig = next;
		}
	}

	/** Position as {measure (1-based), beat (1-based), tick (0-based)}. */
	position(pulse) {
		const p = Math.max(0, Number.isFinite(pulse) ? pulse : 0);
		const sig = this._findSig(p);
		const num = sig[1];
		const measureIdx = sig[3];
		const measureLen = sig[4];
		const beatLen = sig[5];
		const rest = clamp(p - sig[0], 0, measureLen);
		const beat = Math.min(num, Math.floor(rest / beatLen) + 1);
		const tick = clamp(Math.round(rest - (beat - 1) * beatLen), 0, Math.round(beatLen) - 1);
		return { measure: measureIdx + 1, beat, tick };
	}

	format(pulse) {
		const { measure, beat, tick } = this.position(pulse);
		return `${pad(measure, 3)},${pad(beat, 2)},${pad(tick, 2)}`;
	}

	/** Durations: 1 tick == 1 KSON pulse. */
	ticks(pulses) {
		return Math.round(pulses);
	}

	pulseAtPosition({ measure, beat, tick }) {
		const m = Math.max(1, Math.round(Number(measure)));
		const b = Math.max(1, Math.round(Number(beat)));
		const t = Math.max(0, Math.round(Number(tick) || 0));
		// Build measures on demand so far-out positions resolve past the last
		// time_sig change.
		while (this.sigs.length < m) this._extendSigs(this.sigs[this.sigs.length - 1][0] + this.sigs[this.sigs.length - 1][4]);
		const sig = this.sigs[Math.min(this.sigs.length - 1, m - 1)];
		const num = sig[1];
		const measureLen = sig[4];
		const beatLen = sig[5];
		return sig[0] + (m - 1 - sig[3]) * measureLen + (Math.min(b, num) - 1) * beatLen + Math.min(t, Math.round(beatLen) - 1);
	}

	walkMeasure(pulse) {
		const sig = this._findSig(pulse);
		const [, num, , , measureLen, beatLen] = sig;
		const measureStart = sig[0] + Math.floor((pulse - sig[0]) / measureLen) * measureLen;
		const out = [];
		for (let i = 0; i < num; i++) {
			const beatStart = measureStart + i * beatLen;
			if (beatStart > pulse) break;
			out.push({
				pulse: beatStart,
				beatLen,
				beatStart: beatStart,
				measureEndPulse: measureStart + measureLen,
				beatEndPulse: beatStart + beatLen,
			});
		}
		return out;
	}

	findTimePoint(pulse) {
		return this.walkMeasure(pulse).at(-1) ?? {
			pulse: 0,
			beatLen: 240,
			beatStart: 0,
			measureEndPulse: 960,
			beatEndPulse: 240,
		};
	}

	bpmAt(pulse) {
		let bpm = 120;
		for (const entry of this.bpmTable) {
			if (entry.pulse > pulse) break;
			bpm = entry.bpm;
		}
		return bpm;
	}
}

/**
 * Build a piecewise graph evaluator from normalized points
 * ({pulse, from, to, curve}) — value before/after an instant change, linear
 * (or Bezier) interpolation in between, first-point "from" before the graph
 * (reference `E`: exact points honor the side; spans interpolate after→before).
 */
function makeGraph(points) {
	return (pulse, side = "after") => {
		if (!points.length) return 0;
		let lo = 0;
		let hi = points.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (points[mid].pulse <= pulse) lo = mid + 1; else hi = mid;
		}
		if (!lo) return points[0].from ?? 0;
		const cur = points[lo - 1];
		const next = points[lo];
		if (cur.pulse === pulse) return side === "after" ? cur.to : cur.from;
		if (!next) return cur.to;
		const span = next.pulse - cur.pulse;
		const t = span > 0 ? (pulse - cur.pulse) / span : 1;
		const y = curveY(cur.curve, t);
		return cur.to + (next.from - cur.to) * y;
	};
}

/** Normalize one KSON note entry to {pulse, length, effect, sampleId}. */
export function normalizeNote(entry) {
	if (Array.isArray(entry)) {
		if (typeof entry[0] === "object" && entry[0] !== null) {
			return { pulse: finite(entry[0].pulse, "note.pulse"), length: finite(entry[0].length ?? 0, "note.length"), effect: entry[0].effect, sampleId: entry[0].sampleId };
		}
		return { pulse: finite(entry[0], "note.pulse"), length: finite(entry[1] ?? 0, "note.length"), effect: entry[2], sampleId: entry[3] };
	}
	if (typeof entry === "number") return { pulse: finite(entry, "note.pulse"), length: 0, effect: undefined, sampleId: undefined };
	requireObject(entry, "note");
	return { pulse: finite(entry.pulse, "note.pulse"), length: finite(entry.length ?? 0, "note.length"), effect: entry.effect, sampleId: entry.sampleId };
}

/** Flatten a KSON graph ([[pulse, value], ...]) into normalized points. */
function flattenGraph(graph, label, valueTransform = (v) => v) {
	if (graph === undefined || graph === null) return [];
	const list = Array.isArray(graph) ? graph : Object.entries(graph).map(([pulse, value]) => [pulse, value]);
	return list.map((entry, index) => {
		const pulse = finite(entry[0], `${label}[${index}].pulse`);
		const [from, to] = parseSpan(entry[1], `${label}[${index}].value`);
		const curve = entry.length > 2 ? entry[2] : undefined;
		return { pulse, from: valueTransform(from), to: valueTransform(to), curve };
	}).sort((a, b) => a.pulse - b.pulse);
}

// ------------------------------------------------- camera projection (ported)

const DEG = Math.PI / 180;
const C_ANG = 41.28;
const C_A = 60.12;
const C_S = Math.fround(2 * Math.fround(5000 / 4999));
const C_L = 3;
const C_M = 608.4;
const C_H = (14 * C_M) / 1024;
const C_P = C_M - C_H;
const C_COS15 = Math.cos(15 * DEG);
const C_SIN15 = Math.sin(15 * DEG);
const C_SINR = Math.sin(-0.6125);
const C_COSR = Math.cos(-0.6125);

function projectRaw(zoomTop, zoomBottom, legacy) {
	const r = zoomBottom / (zoomBottom > 0 ? 450 : 180);
	let o;
	let a;
	let s;
	let l;
	if (legacy) {
		const t = zoomTop / 75 / (zoomTop <= 0 ? 2.5 : 1);
		const n = C_H / C_P;
		o = 100 * -t * C_SINR;
		a = C_M / 2 + 100 * t * C_COSR;
		s = (100 * -r * C_SINR * C_M) / C_P + 100 * t * n * C_SINR;
		l = -C_M / 2 - (100 * r * C_COSR * C_M) / C_P - 100 * t * n * C_COSR;
	} else {
		const t = 0.15 * zoomTop * DEG;
		o = (C_P * Math.sin(t)) / 2.5;
		a = -C_P / 2 + C_P * Math.cos(t);
		s = (100 * -r * C_SINR * C_M) / C_P - (C_H * Math.sin(t)) / 2.5;
		l = -C_P / 2 - (C_H / 2) * Math.cos(t) - (100 * r * C_COSR * C_M) / C_P;
	}
	const c = C_H / C_M;
	const u = s + (o - s) * c;
	const d = l + (a - l) * c;
	return {
		y: C_COS15 * (u - 45) + C_SIN15 * (d + 366),
		z: -C_SIN15 * (u - 45) + C_COS15 * (d + 366),
		dy: C_COS15 * (o - u) + C_SIN15 * (a - d),
		dz: -C_SIN15 * (o - u) + C_COS15 * (a - d),
	};
}

const PROJECT_BASE = [false, true].map((legacy) => {
	const t = projectRaw(0, 0, legacy);
	return { ...t, horizonHeight: t.dy / t.dz - t.y / t.z };
});

/** Exact game camera projection: zoomTop/zoomBottom -> {rotX, radius}. */
export function projectCamera(zoomTop, zoomBottom, legacy = false) {
	const clampZ = (e) => (Number.isFinite(e) ? clamp(e, -65535, 65535) : 0);
	const e = clampZ(zoomTop);
	const t = clampZ(zoomBottom);
	const p = projectRaw(e, t, legacy);
	const base = PROJECT_BASE[legacy ? 1 : 0];
	const raw = ((C_S * C_A + C_L) * p.z) / base.z;
	const radius = clamp((raw - C_L) / C_S, 4, 2000);
	const num = Math.tan(C_ANG * DEG) * (p.dy * p.z - p.y * p.dz);
	const den = base.horizonHeight * p.dz * p.z;
	let rotX = Math.atan2(num, den) / DEG;
	const target = C_ANG + (legacy ? 0 : 0.15 * e);
	rotX += 360 * Math.round((target - rotX) / 360);
	return { rotX, radius };
}

/**
 * Reference module 1819 `y()` with limit flags: projection state for the
 * zoom_side roll (ZX). Returns { radius, limited, flags }.
 */
function projectionInfo(zoomTop, zoomBottom, legacy) {
	const flags = [];
	let limited = false;
	const conv = (value) => {
		if (!Number.isFinite(value)) {
			limited = true;
			flags.push("non-finite-input");
			return 0;
		}
		const clamped = clamp(value, -65535, 65535);
		if (clamped !== value) {
			limited = true;
			flags.push("input-limited");
		}
		return clamped;
	};
	const top = conv(zoomTop);
	const bottom = conv(zoomBottom);
	if (legacy) flags.push("legacy-smoothing");
	const p = projectRaw(top, bottom, legacy);
	const base = PROJECT_BASE[legacy ? 1 : 0];
	const raw = ((C_S * C_A + C_L) * p.z) / base.z;
	const unscaled = (raw - C_L) / C_S;
	const radius = clamp(unscaled, 4, 2000);
	if (radius !== unscaled) {
		limited = true;
		flags.push("radius-limited");
	}
	if (p.z <= 0) {
		limited = true;
		flags.push("source-behind-camera");
	}
	const num = Math.tan(C_ANG * DEG) * (p.dy * p.z - p.y * p.dz);
	const den = base.horizonHeight * p.dz * p.z;
	if (Math.abs(num) + Math.abs(den) < 1e-12) {
		limited = true;
		flags.push("degenerate-projection");
	}
	return { radius, limited, flags };
}

/**
 * Reference module 1819 `x()` (ZX): zoom_side -> native BIL_RotZ roll degrees.
 * The horizontal lane offset is fitted as an equivalent roll around the
 * judgment line; geometry rotating past |m| > 540 yields 0 with an
 * "offscreen-horizontal-translation" flag instead.
 */
export function rollFromZoomSide(zoomSide, zoomTop, zoomBottom, legacy = false) {
	const flags = [];
	let limited = false;
	let side = zoomSide;
	if (!Number.isFinite(side)) {
		side = 0;
		limited = true;
		flags.push("non-finite-input");
	}
	const clamped = clamp(side, -65535, 65535);
	if (side !== clamped) {
		limited = true;
		flags.push("input-limited");
	}
	if (!clamped) return { rollDegrees: 0, limited, flags };
	const proj = projectionInfo(zoomTop, zoomBottom, legacy);
	const m = clamped / 6 / (608 / 13) * (104139.63821411133 / (C_S * proj.radius + C_L));
	if (Math.abs(m) > 540) {
		return {
			rollDegrees: 0,
			limited: true,
			flags: [...new Set([...flags, ...proj.flags, "offscreen-horizontal-translation"])],
		};
	}
	return {
		rollDegrees: -Math.atan2(m, 690) / DEG,
		limited: limited || proj.limited,
		flags: [...new Set([...flags, ...proj.flags])],
	};
}

/**
 * Reference camera chord adapter `B`: split [start, end) at BPM-change
 * pulses, start each sub-interval as one chord, then recursively bisect the
 * worst chord at its floor midpoint while its sample error exceeds the span
 * tolerance max(absoluteError, 0.001 * |value(end) - value(start)|), capped
 * at 64 chords per span. Calls emit(segStart, segDuration, v0, v1) per chord
 * in timeline order. The span's endpoint value must be evaluated on the
 * BEFORE side of the joint (ramps reach the pre-jump value; the dur0 anchor
 * row carries the jump).
 */
function emitCameraSpan(start, end, valueAt, absoluteError, bpmPulses, emit) {
	if (end <= start) return { count: 0, over: false };
	const breaks = [...new Set([start, ...bpmPulses.filter((p) => p > start && p < end), end])].sort((a, b) => a - b);
	const delta = Math.max(1e-8, Math.abs(valueAt(end) - valueAt(start)));
	const tolerance = Math.max(absoluteError, 0.001 * delta);
	const chord = (left, right) => {
		const v0 = valueAt(left);
		const v1 = valueAt(right);
		const width = right - left;
		let err = 0;
		for (const frac of CAM_SAMPLES) {
			err = Math.max(err, Math.abs(valueAt(left + width * frac) - (v0 + (v1 - v0) * frac)));
		}
		return { left, right, v0, v1, err };
	};
	let count = 0;
	let over = false;
	for (let i = 0; i + 1 < breaks.length; i++) {
		if (breaks[i + 1] <= breaks[i]) continue;
		const segs = [chord(breaks[i], breaks[i + 1])];
		while (segs.length < CAM_MAX_SEGMENTS) {
			let worst = -1;
			let worstErr = tolerance;
			for (let s = 0; s < segs.length; s++) {
				const seg = segs[s];
				if (seg.right - seg.left > 1 && seg.err > worstErr) {
					worst = s;
					worstErr = seg.err;
				}
			}
			if (worst < 0) break;
			const seg = segs[worst];
			const mid = Math.floor((seg.left + seg.right) / 2);
			segs.splice(worst, 1, chord(seg.left, mid), chord(mid, seg.right));
		}
		for (const seg of segs) {
			if (seg.err > tolerance) over = true;
			emit(seg.left, seg.right - seg.left, seg.v0, seg.v1);
			count++;
		}
	}
	return { count, over };
}

/**
 * Reference tilt value evaluator `N`: numeric manual tilt scaled x10, string
 * modes count as 0; the before-side of an exact point falls back to the
 * previous point's after value when the point itself has no numeric before.
 */
function makeTiltEvaluator(points) {
	return (pulse, side = "after") => {
		let lo = 0;
		let hi = points.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (points[mid].pulse <= pulse) lo = mid + 1; else hi = mid;
		}
		if (!lo) return 0;
		const idx = lo - 1;
		const cur = points[idx];
		const next = points[lo];
		if (cur.pulse === pulse && side === "before") {
			if (idx === 0) return pulse === 0 && typeof cur.before === "number" ? 10 * cur.before : 0;
			const prev = points[idx - 1];
			return typeof prev.after !== "number" ? 0 : 10 * (typeof cur.before === "number" ? cur.before : prev.after);
		}
		if (typeof cur.after !== "number") return 0;
		if (next && typeof next.before === "number") {
			const span = next.pulse - cur.pulse;
			const t = span > 0 ? (pulse - cur.pulse) / span : 1;
			return 10 * (cur.after + (next.before - cur.after) * curveY(cur.curve, t));
		}
		return 10 * cur.after;
	};
}

// --------------------------------------------------------- FX effect mapping

const EFFECT_DEFAULTS = {
	retrigger: { update_period: "1/2", wave_length: "0", rate: "70%", update_trigger: "off", mix: "0%>100%" },
	gate: { wave_length: "0", rate: "50%", mix: "0%>90%" },
	tapestop: { speed: "50%", trigger: "off>on", mix: "0%>100%" },
	flanger: { period: "2.0", delay: "30samples", depth: "45samples", feedback: "60%", stereo_width: "0%", vol: "75%", mix: "0%>80%" },
	pitch_shift: { pitch: "0>12", chunk_size: "700samples", overlap: "40%", mix: "0%>100%" },
	bitcrusher: { reduction: "0samples-30samples", mix: "0%>100%" },
	wobble: { wave_length: "0", freq_1: "500Hz", freq_2: "20000Hz", q: "1.414", mix: "0%>80%" },
	low_pass_filter: { v: "0%-100%", mix: "0%>100%" },
	high_pass_filter: { v: "0%-100%", mix: "0%>100%" },
	peaking_filter: { v: "0%-100%", gain: "50%", mix: "0%>100%" },
};

const EFFECT_VALUE_RE_STR = "(?:-?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:/[0-9]+)?(?:samples|kHz|Hz|ms|s|%|dB)?|on|off)";
const EFFECT_VALUE_RE = new RegExp(`^(${EFFECT_VALUE_RE_STR})(?:-(${EFFECT_VALUE_RE_STR}))?$`);

/** Parse "A>B" (off>value) or "A-B" (min-max) range strings. */
function parseRange(str) {
	const parts = String(str ?? "").trim().split(">");
	if (parts.length > 2) return null;
	const m = EFFECT_VALUE_RE.exec(parts[parts.length - 1]);
	if (!m) return null;
	const lo = m[1];
	const hi = m[2] ?? lo;
	return { off: parts.length === 2 ? parts[0] : lo, min: lo, max: hi };
}

/** Convert an effect value string to a number (%, kHz, fractions, on/off). */
function parseEffectValue(str) {
	if (str === "on") return 1;
	if (str === "off") return 0;
	const text = String(str);
	const fraction = /^(-?\d+(?:\.\d+)?)\/(\d+)$/.exec(text);
	if (fraction) return Number(fraction[1]) / Number(fraction[2]);
	return parseFloat(text) * (text.endsWith("%") ? 0.01 : text.endsWith("kHz") ? 1e3 : 1);
}

function sVal(str, which = "min", fallback = 0) {
	const parsed = parseRange(str);
	const value = parsed ? parseEffectValue(parsed[which]) : NaN;
	return Number.isFinite(value) ? value : fallback;
}

function plainVal(str) {
	const parsed = parseRange(str);
	return parsed ? parseEffectValue(parsed.min) : 0;
}

/**
 * Native tape-stop fallback curve (ported from the reference writer):
 * returns [durationDivisor, curve] clamped to the native DSP limits.
 */
function tapestopCurve(speed, warn) {
	const n = 1 + 100 * clamp(speed, 0, 1);
	const r = -Math.log(2.5) / 8e3;
	const i = Math.expm1(r);
	let lo = 0;
	let hi = Math.ceil(1e6 / n);
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if ((n / 5e5) * ((Math.expm1(r * mid) / i) + mid / 2) >= 1) hi = mid; else lo = mid + 1;
	}
	const s = lo / 44100;
	const curve = clamp(s, 0.1, 2);
	const c = (44100 * curve * n * 1.5) / 5e5;
	const divisor = clamp(c, 1, 10);
	if (curve !== s || divisor !== c) {
		warn("Tape stop fallback reached native duration/curve limits; settings were clamped.");
	}
	return [divisor, curve];
}

const EFFECT_DSP_WARNING = "KSON effects use the native VOX DSP. Timing and compatible parameters are converted, but KSM and native algorithms, wet levels and modulation curves can differ.";

/**
 * Map a KSON effect definition to the native VOX effect row:
 * {type, params} — ported 1:1 from the reference writer's effect mapper.
 */
export function mapEffect(typeName, values, warn, timing = 4) {
	const type = typeName || 0;
	if (!type) return { type: 0, params: [] };
	const a = { ...(EFFECT_DEFAULTS[type] ?? {}), ...(values ?? {}) };
	const mix = 100 * sVal(a.mix, "min", 1);
	const u = (t, params) => {
		warn(EFFECT_DSP_WARNING);
		return { type: t, params };
	};
	const c = (message) => {
		warn(`Effect "${typeName}": ${message}; the original KSON definition is preserved.`);
		return { type: 0, params: [] };
	};
	if (type === "bitcrusher") {
		const reduction = sVal(a.reduction);
		if (!(reduction > 0)) return { type: 0, params: [] };
		if (reduction > 30) return c("sample reduction exceeds the native 30-frame range");
		return u(7, [mix, reduction]);
	}
	if (type === "pitch_shift") {
		warn("KSON pitch chunk_size/overlap are retained in the source; the native pitch algorithm has different controls.");
		return u(9, [mix, sVal(a.pitch)]);
	}
	if (type === "tapestop") {
		if (!sVal(a.trigger, "min", 1)) return { type: 0, params: [] };
		warn(`Effect "${typeName}": using the native Tape stop fallback; its slowdown and fade approximate the KSON effect.`);
		return u(4, [mix, ...tapestopCurve(sVal(a.speed, "min", 0.5), warn)]);
	}
	if (type === "retrigger") {
		const wave = plainVal(a.wave_length);
		const period = plainVal(a.update_period);
		if (!(wave > 0 && period > 0)) return c("zero/nonperiodic retrigger timing has no native equivalent");
		const ratio = period / wave;
		if (Math.abs(ratio - Math.round(ratio)) > 1e-7 || ratio < 1 || ratio > 32) {
			return c("retrigger update/repeat ratio is outside the native integer division range");
		}
		if (sVal(a.update_trigger)) warn("KSON retrigger update_trigger is preserved; native update timing is periodic.");
		return u(1, [Math.round(ratio), mix, 4 * period, 1, sVal(a.rate, "min", 0.7), 0]);
	}
	if (type === "gate") {
		const wave = plainVal(a.wave_length);
		if (!(wave > 0)) return c("zero gate length has no native rhythmic equivalent");
		if (Math.abs(sVal(a.rate, "min", 0.5) - 0.5) > 1e-9) {
			warn("KSON gate duty rate is preserved; native Gate has a fixed duty cycle.");
		}
		const div = clamp(2 * Math.round(1 / (4 * wave)), 2, 32);
		return u(2, [mix, div, 2 * div * wave]);
	}
	if (type === "wobble") {
		const wave = plainVal(a.wave_length);
		if (!(wave > 0)) return c("zero wobble length has no native rhythmic equivalent");
		warn("KSM Wobble shapes its triangle oscillator through two sine functions; the native triangle oscillator is used, so the sweep shape differs.");
		return u(6, [0, 3, mix, sVal(a.freq_1, "min", 500), sVal(a.freq_2, "min", 20000), 1 / (4 * wave), sVal(a.q, "min", 1.414)]);
	}
	if (type === "flanger") {
		const delay = sVal(a.delay, "min", NaN);
		const depth = sVal(a.depth, "min", NaN);
		const period = plainVal(a.period);
		const valid = [delay, depth].every((v) => Number.isInteger(v) && v >= 0 && v <= 44100);
		if (!valid || !parseRange(a.period) || period < 0) return c("flanger delay, depth or period is invalid");
		const dSum = delay + depth / 2;
		const half = depth / 2;
		const h = clamp(dSum / 44.1, 0.1, 3);
		const p = (half / (44.1 * h)) * 100;
		const f = clamp(Math.round(p), 0, 100);
		// Reference `v = timing/(4*period)` — timing is the time-signature
		// numerator at the segment pulse (default 4).
		const v = period === 0 ? 0 : timing / (4 * period);
		if (!Number.isFinite(v)) return c("flanger modulation rate is outside the finite native range");
		warn(`Effect "${typeName}": native Flanger is used (sine sweep, integer depth); feedback/stereo/vol are preserved in the source.`);
		return u(3, [mix, h, v, f, 2]);
	}
	if (type === "low_pass_filter" || type === "high_pass_filter") {
		const isLow = type === "low_pass_filter";
		warn(`Effect "${typeName}": native cutoff/Q settings are used for the converted filter.`);
		return u(isLow ? 11 : 12, [mix, sVal(a.freq, "min", isLow ? 400 : 40), sVal(a.freq_max, "min", isLow ? 18000 : 5000), sVal(a.q, "min", 0.7)]);
	}
	return c(`the ${type} algorithm does not have a verified parameter mapping`);
}

/** Effect row text: "type, p1, p2, ..." with 12-significant-digit params. */
export function formatEffectRow(effect) {
	return [effect.type, ...effect.params.map((v) => Number(Number(v).toPrecision(12)))].join(", ");
}

// ------------------------------------------------------------ laser sections

/**
 * Normalize spin events from KSON camera slam_event (absolute pulses,
 * [pulse, dir, len]) and legacy section maps ([pulse, lenKshTicks]).
 */
function collectSpinEvents(chart, sections) {
	const events = [];
	const slam = chart?.camera?.cam?.pattern?.laser?.slam_event ?? {};
	for (const kind of ["spin", "half_spin"]) {
		const list = slam[kind];
		if (!Array.isArray(list)) continue;
		for (const entry of list) {
			if (!Array.isArray(entry) || entry.length < 3) continue;
			events.push({
				kind,
				pulse: Math.round(Number(entry[0])),
				dir: Number(entry[1]) < 0 ? -1 : 1,
				len: Math.max(1, Math.round(Number(entry[2]))),
			});
		}
	}
	// Legacy: per-section spin maps [pulse, kshLen] — direction comes from the slam.
	for (const section of sections) {
		const legacyMap = section[3];
		if (!legacyMap || typeof legacyMap !== "object") continue;
		for (const kind of ["spin", "half_spin"]) {
			const list = legacyMap[kind];
			if (!Array.isArray(list)) continue;
			for (const entry of list) {
				const pulse = Math.round(Number(entry[0]));
				events.push({ kind, pulse, dir: 0, len: Math.max(1, Math.round(Number(entry[1]) * 5)), legacy: true });
			}
		}
	}
	return events.sort((a, b) => a.pulse - b.pulse);
}

function spinDuration(kind, len) {
	return Math.max(1, Math.round(len * SPIN_DURATION_K[kind]));
}

// --------------------------------------- native spin duration fit (module 8698)

const SPIN_PRESETS = { spin: [1, 6], half_spin: [5, 7] };
const SPIN_CRITICAL_SUBDIVISIONS = 256;
const SPIN_ERROR_GRID = 192;
const SPIN_SEARCH_DIVISOR = 192;
const wrapDeg = (deg) => ((deg + 180) % 360 + 360) % 360 - 180;

/** Native preset angle (degrees) at fraction r of the native duration. */
function nativeSpinAngle(kind, r, direction) {
	if (!Number.isFinite(r) || r < 0 || r >= 1) return 0;
	let deg;
	if (kind === "spin") {
		deg = r < 360 / 675
			? (Math.sin((r / (360 / 675)) * 0.75) / Math.sin(0.75)) * 360
			: r < 440 / 675
				? 30 * Math.sin(((9 * (675 * r - 360)) / 8) * DEG)
				: 30 * (1 - Math.cos(((90 * (1 - r)) / 235) * 675 * DEG) ** 2);
	} else {
		deg = r < 0.275
			? (Math.sin((r / 0.275) * 1.8) / Math.sin(1.8)) * 60
			: r < 0.55
				? ((Math.cos((1.8 * (400 * r - 110)) / 110) - Math.cos(1.8)) / (1 - Math.cos(1.8))) * 60
				: r < 0.775
					? (-Math.sin((1.8 * (400 * r - 220)) / 90) / Math.sin(1.8)) * 15
					: -(((Math.cos((1.8 * (400 * r - 310)) / 90) - Math.cos(1.8)) / (1 - Math.cos(1.8))) * 15);
	}
	return -(direction < 0 ? -1 : 1) * deg;
}

/** KSON slam spin angle (degrees) at time fraction t (reference float32 model). */
function ksonSpinAngle(kind, t, direction) {
	const f = Math.fround;
	if (t < 0 || t > 1) return 0;
	const r = f(t);
	const i = direction < 0 ? 1 : -1;
	if (kind === "half_spin") {
		return f(f(80 * f(f(Math.sin(f(r * f(6.5973444)))) * i)) * f(1 - r));
	}
	const a = f(0.42857143);
	if (r < a) return f(f(840 * i) * r);
	const s = f(r - a);
	return f(f(f(f(Math.sin(f(s * f(7.6969018)))) * i) * f(52.499996)) * f(f(0.5714286) - s));
}

/**
 * Reference native spin duration fit `h`: pick the duration on the native
 * 0.1-beat grid whose preset curve best matches the KSON slam spin, scoring
 * candidates by RMS degrees over merged critical samples (256 source
 * subdivisions + BPM boundaries + shape landmarks) and scanning
 * coarse-to-fine from the source/landmark seeds. Returns the VOX row values
 * (nativeSpinType -> field 3, nativeDuration -> field 9) plus nativeEndPulse.
 */
export function spinFit({ kind, pulse, length, direction, bpmEvents }) {
	if (!SPIN_PRESETS[kind]) throw new RangeError("Only KSON spin and half_spin have native presets.");
	if (!Number.isSafeInteger(pulse) || pulse < 0 || !Number.isSafeInteger(length) || length <= 0
		|| !Number.isSafeInteger(pulse + length) || ![-1, 1].includes(direction)) {
		throw new RangeError("Invalid source spin timing or direction.");
	}
	// BPM timeline (seconds/pulse/beat conversions at resolution 240).
	const bpmMap = new Map([[0, 120]]);
	for (const entry of bpmEvents ?? []) {
		if (!Array.isArray(entry) || !Number.isSafeInteger(entry[0]) || entry[0] < 0
			|| !Number.isFinite(entry[1]) || entry[1] <= 0) continue;
		bpmMap.set(entry[0], entry[1]);
	}
	const rows = [...bpmMap].sort((a, b) => a[0] - b[0]).map(([p, bpm]) => ({ pulse: p, bpm, seconds: 0 }));
	rows.forEach((row, idx) => {
		if (idx) row.seconds = rows[idx - 1].seconds + (60 * (row.pulse - rows[idx - 1].pulse)) / 240 / rows[idx - 1].bpm;
	});
	const at = (value, key) => {
		let lo = 0;
		let hi = rows.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (rows[mid][key] <= value) lo = mid + 1; else hi = mid;
		}
		return rows[Math.max(0, lo - 1)];
	};
	const secondsAt = (p) => {
		const row = at(p, "pulse");
		return row.seconds + (60 * (p - row.pulse)) / 240 / row.bpm;
	};
	const pulseAt = (sec) => {
		const row = at(sec, "seconds");
		return row.pulse + ((sec - row.seconds) * row.bpm * 240) / 60;
	};

	const v = secondsAt(pulse);
	const bpm = at(pulse, "pulse").bpm;
	const sourceSeconds = secondsAt(pulse + length) - v;
	const landmarkFraction = kind === "spin" ? 360 / 675 : 0.55;
	const landmarkScale = kind === "spin" ? 3 / 7 : Math.PI / 6.5973444;
	const landmarkSeconds = (secondsAt(pulse + length * landmarkFraction) - v) / landmarkScale;
	const tick = 6 / bpm;
	if (!(sourceSeconds > 0) || !(tick > 0) || !Number.isFinite(landmarkSeconds)) {
		throw new RangeError("Source spin timing cannot be represented as finite seconds.");
	}
	const toTicks = (sec) => Math.max(1, Math.round(sec / tick));
	const sourceTicks = toTicks(sourceSeconds);
	const landmarkTicks = toTicks(landmarkSeconds);
	let lo = Math.max(1, Math.floor((0.5 * Math.min(sourceSeconds, landmarkSeconds)) / tick));
	let hi = Math.max(lo, Math.ceil((1.75 * Math.max(sourceSeconds, landmarkSeconds)) / tick));
	if (!Number.isSafeInteger(hi)) throw new RangeError("Source spin exceeds the native duration grid.");
	const ticksToSeconds = (e) => Math.fround(
		e % 10 === 0
			? Math.fround(60 / Math.fround(bpm)) * Math.fround(e / 10)
			: Math.fround(6 / Math.fround(bpm)) * Math.fround(e),
	);
	const fallbackTicks = Math.max(1, Math.round(length / 24));
	const windowSeconds = Math.max(sourceSeconds, ticksToSeconds(hi), ticksToSeconds(fallbackTicks));
	if (!Number.isFinite(windowSeconds) || !(ticksToSeconds(1) > 0)) {
		throw new RangeError("Source spin exceeds finite native float timing.");
	}

	// Merged critical sample times (relative seconds): source shape, BPM
	// boundaries inside the spin, and the preset's piecewise landmarks.
	const critical = [...new Set([
		...Array.from({ length: SPIN_CRITICAL_SUBDIVISIONS + 1 }, (_, i) => secondsAt(pulse + (length * i) / SPIN_CRITICAL_SUBDIVISIONS) - v),
		...rows.filter((row) => row.pulse > pulse && row.pulse < pulse + length).map((row) => row.seconds - v),
		...[landmarkFraction, ...(kind === "spin" ? [440 / 675] : [0.275, 0.775])]
			.map((f) => secondsAt(pulse + length * f) - v),
	])].sort((a, b) => a - b);

	const cache = new Map();
	const rmsError = (candidate) => {
		if (cache.has(candidate)) return cache.get(candidate);
		const durSec = ticksToSeconds(candidate);
		const grid = Array.from({ length: SPIN_ERROR_GRID + 1 }, (_, i) => (durSec * i) / SPIN_ERROR_GRID);
		let ci = 0;
		let gi = 0;
		let last = 0;
		let acc = 0;
		while (ci < critical.length || gi < grid.length) {
			const t = Math.min(critical[ci] ?? Infinity, grid[gi] ?? Infinity);
			while (critical[ci] === t) ci++;
			while (grid[gi] === t) gi++;
			if (t > last) {
				const mid = (last + t) / 2;
				const srcFrac = (pulseAt(v + mid) - pulse) / length;
				const diff = wrapDeg(nativeSpinAngle(kind, srcFrac, direction) - ksonSpinAngle(kind, mid / durSec, direction));
				acc += diff * diff * (t - last);
			}
			last = t;
		}
		const rms = Math.sqrt(acc / windowSeconds);
		cache.set(candidate, rms);
		return rms;
	};

	let best = sourceTicks;
	const consider = (candidate) => {
		const err = rmsError(candidate);
		const prev = rmsError(best);
		if (err < prev - 1e-9 || (Math.abs(err - prev) <= 1e-9 && Math.abs(candidate - sourceTicks) < Math.abs(best - sourceTicks))) {
			best = candidate;
		}
	};
	consider(landmarkTicks);
	for (;;) {
		const step = Math.max(1, Math.ceil((hi - lo) / SPIN_SEARCH_DIVISOR));
		for (let cand = lo; cand <= hi; cand += step) consider(cand);
		consider(hi);
		if (step === 1) break;
		lo = Math.max(lo, best - step);
		hi = Math.min(hi, best + step);
	}
	const wholeBeats = best % 10 === 0;
	const durSec = ticksToSeconds(best);
	return {
		type: SPIN_PRESETS[kind][wholeBeats ? 0 : 1],
		duration: wholeBeats ? best / 10 : best,
		endPulse: pulseAt(v + durSec),
	};
}

/**
 * Attach spin events to slams once, across both lanes, by pulse + direction.
 * Returns {attachments: Map "lane:pulse" -> spin, unmatched: [...]}.
 */
export function attachSpins(sections, spinEvents) {
	const events = spinEvents.map((s) => ({ ...s, used: false }));
	const attachments = new Map();
	for (let lane = 0; lane < sections.length; lane++) {
		for (const section of sections[lane] ?? []) {
			const startPulse = Math.round(Number(section[0]));
			for (const entry of section[1] ?? []) {
				const [from, to] = parseSpan(entry[1], "laser point");
				if (from === to) continue;
				const dir = to > from ? 1 : -1;
				const pulse = startPulse + Math.round(Number(entry[0]));
				const spin = events.find((s) => !s.used && s.pulse === pulse && (s.legacy ? true : s.dir === dir));
				if (spin) {
					spin.used = true;
					attachments.set(`${lane}:${pulse}`, spin);
				}
			}
		}
	}
	return { attachments, unmatched: events.filter((s) => !s.used) };
}

/**
 * Emit laser TRACK rows. `originals` mode emits only key points (section
 * starts, slams, ends) without curve samples or comments — the
 * TRACK ORIGINAL L/R dialect. Returns {rows, endPulse}.
 */
function emitLaserTrack(timeline, sections, attachments, opts) {
	const { originals = false, lane = 0, bpmEvents = [], laserControlPulses = [], audioFx = null, decorative = null } = opts ?? {};
	const rows = [];
	let maxPulse = 0;
	let curvedWarned = false;

	for (const [sectionIndex, section] of sections.entries()) {
		const startPulse = Math.round(finite(section[0], "laser section pulse"));
		const rawPoints = Array.isArray(section[1]) ? section[1] : [];
		const width = section[2] === 2 ? 2 : 1;
		if (!rawPoints.length) continue;
		const isDecorative = Boolean(decorative && decorative.has(sectionIndex));
		const points = rawPoints.map((entry, index) => {
			const y = finite(entry[0], `laser point [${index}].y`);
			const [from, to] = parseSpan(entry[1], `laser point [${index}].value`);
			const curve = entry.length > 2 ? entry[2] : undefined;
			return { pulse: startPulse + y, from, to, curve };
		}).sort((a, b) => a.pulse - b.pulse);
		const last = points[points.length - 1];
		maxPulse = Math.max(maxPulse, last.pulse);

		const built = [];
		const push = (pulse, value, ct, spin, spinDur, comment, curve) => {
			built.push({ pulse, value, ct, spin, spinDur, comment, curve });
		};
		const fmtVal = (v) => (Object.is(v, -0) ? "0.000000" : v.toFixed(6));

		for (let i = 0; i < points.length; i++) {
			const point = points[i];
			const next = points[i + 1];
			const isSlam = point.from !== point.to;
			// Reference `m`/`p`/`h`: an OUTGOING segment that moves (to !==
			// next.from) and is EITHER curved (distinct control pair) or part
			// of a decorative tail projection → its non-slam from-row and its
			// slam to-row carry ct=2; slam from-rows and the final point stay
			// ct=0. Only curved segments get the 64th-note samples (`m`).
			const pair = parseCurvePair(point.curve) ?? [0, 0];
			const moves = Boolean(next) && point.to !== next.from;
			const moving = moves && pair[0] !== pair[1];
			const segCt = originals ? 0 : (moving || (moves && isDecorative) ? 2 : 0);
			if (isSlam) {
				const spin = attachments.get(`${lane}:${point.pulse}`);
				let spinCode = 0;
				let spinDur = 0;
				let comment = null;
				if (spin) {
					// Reference module 8698: fit the slam length to the native
					// duration grid — field 3 gets the preset id (1/6 full-turn,
					// 5/7 sway depending on whole-beat vs tenths), field 9 the
					// fitted duration. Cached on the event so both the TRACK
					// and TRACK ORIGINAL rows share one fit.
					if (!spin.fit) {
						try {
							spin.fit = spinFit({
								kind: spin.kind,
								pulse: spin.pulse,
								length: spin.len,
								direction: spin.dir || (point.to > point.from ? 1 : -1),
								bpmEvents,
							});
						} catch {
							spin.fit = { type: SPIN_CODES[spin.kind], duration: spinDuration(spin.kind, spin.len), endPulse: spin.pulse + spin.len };
						}
					}
					spinCode = spin.fit.type;
					spinDur = spin.fit.duration;
					comment = `// KSON camera.cam.pattern.laser.slam_event.${spin.kind}`;
					maxPulse = Math.max(maxPulse, point.pulse + spin.len, Math.ceil(spin.fit.endPulse - 1e-4));
				}
				push(point.pulse, point.from, 0, spinCode, spinDur, comment, point.curve);
				push(point.pulse, point.to, segCt, 0, 0, null, point.curve);
			} else {
				push(point.pulse, point.from, segCt, 0, 0, null, point.curve);
			}
			if (!moving || originals) continue;
			curvedWarned = true;
			// Reference `m`: one sample every 15 pulses (64th notes) plus the
			// chart's laser control pulses (BPM + laser audio effect
			// pulse_event/param_change positions) strictly inside the segment;
			// the set is sorted, deduped by pulse only — values never dedup.
			const span = next.pulse - point.pulse;
			const samplePulses = new Set();
			for (let p = point.pulse + LASER_SAMPLE_STEP; p < next.pulse; p += LASER_SAMPLE_STEP) samplePulses.add(p);
			for (const control of laserControlPulses) {
				if (control > point.pulse && control < next.pulse) samplePulses.add(control);
			}
			const fromValue = point.to;
			const toValue = next.from;
			for (const p of [...samplePulses].sort((a, b) => a - b)) {
				const y = curveY(point.curve, span > 0 ? (p - point.pulse) / span : 1);
				push(p, fromValue + (toValue - fromValue) * y, segCt, 0, 0, null, point.curve);
			}
		}

		// Reference row rules: a lone row is duplicated, and seg is positional
		// (first row 1, last row 2, every other row 0).
		if (built.length === 1) built.push({ ...built[0] });
		let list = built;
		if (audioFx) {
			// Reference module 14131 rewrite: audio-effect control pulses
			// strictly inside a segment get interpolated rows (the
			// segment's last row and same-pulse slam pairs excluded), then
			// every row carries the active native laser filter id in field 4.
			// TRACK ORIGINAL keeps an interpolated row only when the control
			// pulse switches the active filter id — the playable tracks keep
			// every control pulse (same-pulse slam pairs excluded either way).
			list = [];
			for (let idx = 0; idx < built.length; idx++) {
				const row = built[idx];
				list.push(row);
				const next = built[idx + 1];
				if (!next || next.pulse <= row.pulse) continue;
				for (const control of audioFx.controlPulses) {
					if (control <= row.pulse) continue;
					if (control >= next.pulse) break;
					if (originals && audioFx.filterAt(control) === audioFx.filterAt(control - 1)) continue;
					// The interpolated row evaluates the bracket row's outgoing
					// KSON curve (reference emits curveY-based values — the
					// TRACK ORIGINAL rows match a segment-curve evaluation, not
					// a linear blend between the bracket rows).
					const t = (control - row.pulse) / (next.pulse - row.pulse);
					const y = curveY(row.curve, t);
					const value = Number(Number(row.value + (next.value - row.value) * y).toPrecision(12));
					list.push({ pulse: control, value, ct: row.ct, spin: 0, spinDur: 0, comment: null });
				}
			}
			for (const row of list) row.filter = audioFx.filterAt(row.pulse);
		}
		for (let idx = 0; idx < list.length; idx++) {
			const row = list[idx];
			const seg = idx === 0 ? 1 : (idx === list.length - 1 ? 2 : 0);
			const comment = originals ? null : row.comment;
			rows.push(`${timeline.format(row.pulse)}\t${fmtVal(row.value)}\t${seg}\t${row.spin}\t${row.filter || 0}\t${width}\t0\t${row.ct}\t0\t${row.spinDur}\t0${comment ? `\t${comment}` : ""}`);
		}
	}
	return { rows, endPulse: maxPulse, curved: curvedWarned };
}

// ------------------------------------------------------------------ converter

function normalizeFxDefs(def) {
	if (!def) return [];
	if (Array.isArray(def)) {
		return def.map((entry) => ({
			name: String(entry[0]),
			type: entry[1]?.type,
			values: entry[1]?.v ?? entry[1]?.params ?? {},
		}));
	}
	return Object.entries(def).map(([name, spec]) => ({
		name,
		type: spec?.type,
		values: spec?.v ?? spec?.params ?? {},
	}));
}

/**
 * Convert a KSON chart object into VOX v13 text (sdvxindex dialect).
 * Returns the VOX file contents; diagnostics go to `warn`.
 */
/**
 * Reference module 32509 `G` — terminal-slam jump adaptation.
 *
 * When an isolated scroll jump sits exactly at the end of a laser section
 * whose last point is a slam (`terminalSlam`), the native engine may hide the
 * slam. The reference delays the jump ~0.1 seconds into the following empty
 * interval: every step under the window adopts the prior graph speed, the
 * delayed point carries the window's residual distance as a one-pulse speed,
 * and the resume step keeps its original value there (so total scroll
 * distance is recovered). All guards (range threshold, notes, stops, other
 * jumps) mirror the reference byte-for-byte.
 */
function adaptTerminalJumps({ steps, graph, notes, stops, maxBpm, secondsAtPulse, maxPulse, format, warn }) {
	const valueAtStep = (pulse) => {
		let lo = 0;
		let hi = steps.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (steps[mid].pulse <= pulse) lo = mid + 1;
			else hi = mid;
		}
		const entry = steps[Math.max(0, lo - 1)];
		return entry ? entry.value : 1;
	};
	const spanDistance = (from, to) => {
		let sum = 0;
		let cursor = from;
		let value = valueAtStep(from);
		for (const step of steps) {
			if (step.pulse <= from) continue;
			if (step.pulse >= to) break;
			sum += (step.pulse - cursor) * value;
			cursor = step.pulse;
			value = step.value;
		}
		return sum + (to - cursor) * value;
	};
	const fr = Math.fround;
	const terminalEnds = new Set(notes.filter((n) => n.terminalSlam).map((n) => n.end));
	const graphAt = new Map(graph.map((p) => [p.pulse, p]));
	// H6: (totalRangeUnits - behindUnits) * maxBpm / minEffectiveSpeed.
	const range = ((3640 - 240) * maxBpm) / 100;
	const delays = [];
	const injected = new Map();
	for (let i = 0; i + 1 < steps.length; i++) {
		const step = steps[i];
		const n = step.pulse;
		const next = steps[i + 1];
		if (!terminalEnds.has(n) || delays.some((d) => n < d.resumePulse)) continue;
		const prior = graphAt.get(n)?.from;
		if (!(prior > 0) || !(step.value > prior)) continue;
		if (2 * (next.pulse - n) * (step.value - prior) <= range) continue;
		// Smallest pulse more than ~0.1s after the jump (0.101s search seed).
		const limit = fr(fr(secondsAtPulse(n)) + fr(0.1));
		let low = n;
		let high = Math.min(maxPulse, Math.max(n + 1, Math.ceil(n + ((240 * maxBpm) / 60) * 0.101)));
		let y = high;
		if (!(fr(secondsAtPulse(y)) > limit)) continue;
		while (low + 1 < y) {
			const mid = Math.floor((low + y) / 2);
			if (fr(secondsAtPulse(mid)) > limit) y = mid;
			else low = mid;
		}
		const x = y;
		const w = x + 1;
		if (w > maxPulse || next.pulse > x) continue;
		if (2 * (x - n) * prior >= range) continue;
		if (stops.some((s) => s.duration > 0 && s.pulse < w && s.pulse + s.duration > n)) continue;
		if (notes.some((note) => (note.start > n && note.start <= w) || (note.start <= n && note.end > n))) continue;
		if (steps.slice(i + 1).some((s, k) => {
			if (s.pulse >= w) return false;
			const stepNext = steps[i + k + 2];
			const until = Math.min(w, stepNext ? stepNext.pulse : w);
			return 2 * Math.abs(s.value - prior) * (until - s.pulse) > range;
		})) continue;
		const distance = spanDistance(n, w);
		if (2 * distance <= range) continue;
		const residual = distance - (x - n) * prior;
		if (residual > 0 && Number.isFinite(residual)) {
			delays.push({
				sourcePulse: n,
				delayedPulse: x,
				resumePulse: w,
				delaySeconds: secondsAtPulse(x) - secondsAtPulse(n),
				priorSpeed: prior,
				sourceSpeed: step.value,
				delayedSpeed: residual,
				sourceDistance: 2 * distance,
			});
			injected.set(x, residual);
			injected.set(w, valueAtStep(w));
		}
	}
	if (!delays.length) return steps;
	for (const d of delays) {
		warn(`An isolated scroll jump at ${format(d.sourcePulse)} was delayed ${(1e3 * d.delaySeconds).toFixed(2)}ms to ${format(d.delayedPulse)} within an empty interval so native terminal slams remain visible. Its distance is recovered by ${format(d.resumePulse)}; note times and the original source scroll graph are preserved.`);
	}
	const rebuilt = new Map(steps.map((step) => {
		const d = delays.find((delay) => step.pulse >= delay.sourcePulse && step.pulse < delay.resumePulse);
		return [step.pulse, d ? (step.pulse < d.delayedPulse ? d.priorSpeed : d.delayedSpeed) : step.value];
	}));
	injected.forEach((value, pulse) => rebuilt.set(pulse, value));
	return [...rebuilt].sort((a, b) => a[0] - b[0]).map(([pulse, value]) => ({ pulse, value }));
}

export function convertKsonToVox(chart, warn = () => {}) {
	requireObject(chart, "chart");
	// Reference import order (f_000011 `ie`): decorative tail-laser projection
	// (module 78799) rewrites laser sections BEFORE anything else reads them.
	const projection = projectTailDecorations(chart, warn);
	chart = projection.chart;
	const tailDecorations = projection.decorations;
	const meta = chart.meta ?? {};
	const beat = requireObject(chart.beat ?? {}, "beat");
	const note = chart.note ?? {};
	const audio = chart.audio ?? {};
	const camera = chart.camera ?? {};
	const camBody = camera.cam?.body ?? {};

	const bpmEntries = Array.isArray(beat.bpm) ? beat.bpm : [];
	const bpmTable = bpmEntries.map((entry) => ({ pulse: Math.max(0, Math.round(Number(entry[0]))), bpm: finite(entry[1], "bpm") }));
	if (!bpmTable.length || bpmTable[0].pulse > 0) bpmTable.unshift({ pulse: 0, bpm: 120 });
	const timeline = new Timeline(beat.time_sig, bpmTable);

	// Reference `R(time_sig)` rows: one row per change; the previous measure
	// length extends to the next change. The mapper reads the numerator at the
	// segment pulse (`A(t,n)`) as the Flanger modulation timing (default 4),
	// and Flanger holds split at these change pulses.
	const timingMap = new Map([[0, [4, 4]]]);
	for (const entry of Array.isArray(beat.time_sig) ? beat.time_sig : []) {
		if (!Array.isArray(entry)) continue;
		const idx = Math.round(Number(entry[0]));
		const sig = entry[1];
		if (
			Number.isSafeInteger(idx) && Array.isArray(sig) && sig.length === 2 &&
			sig.every((x) => Number.isSafeInteger(Number(x)) && Number(x) > 0)
		) {
			timingMap.set(idx, [Number(sig[0]), Number(sig[1])]);
		}
	}
	const timingRows = [];
	let timingCursor = 0;
	for (const [idx, [num, den]] of [...timingMap].sort((a, b) => a[0] - b[0])) {
		const prev = timingRows.at(-1);
		if (prev) timingCursor += (idx - prev.index) * prev.measurePulses;
		timingRows.push({ index: idx, pulse: timingCursor, numerator: num, measurePulses: (960 * num) / den });
	}
	const timingNumeratorAt = (pulse) => {
		let num = 4;
		for (const row of timingRows) {
			if (row.pulse <= pulse) num = row.numerator;
			else break;
		}
		return num;
	};
	const timingChangePulses = timingRows.map((row) => row.pulse);

	// ------------------------------------------------------------------ notes
	const btLanes = [0, 1, 2, 3].map((lane) => (note.bt?.[lane] ?? []).map(normalizeNote).sort((a, b) => a.pulse - b.pulse));
	const fxLanes = [0, 1].map((lane) => (note.fx?.[lane] ?? []).map(normalizeNote).sort((a, b) => a.pulse - b.pulse));

	// Effect assignment: audio.audio_effect.fx.long_event {name: [lane0, lane1]}
	// entries are pulses or [pulse, inlineValues] (KSH single-char effects carry
	// their v{} inline and have no def).
	const fxRoot = audio.audio_effect?.fx ?? audio.fx ?? {};
	const fxDefs = normalizeFxDefs(fxRoot.def);
	const longEvent = fxRoot.long_event ?? {};
	const fxParamChange = fxRoot.param_change ?? {};
	const eventsAt = [[], []];
	for (const [name, lanes] of Object.entries(longEvent)) {
		for (const lane of [0, 1]) {
			for (const entry of lanes?.[lane] ?? []) {
				const pulse = Math.round(Number(Array.isArray(entry) ? entry[0] : entry));
				const values = Array.isArray(entry) && entry[1] && typeof entry[1] === "object" ? entry[1] : undefined;
				eventsAt[lane].push({ pulse, name, values });
			}
			eventsAt[lane].sort((a, b) => a.pulse - b.pulse);
		}
	}

	// Reference preset resolver (f_000011 `y`): def lookup by name with the name
	// itself as the effect type fallback; values = def.v + param_change at the
	// segment pulse, overridden by the event's inline values.
	const resolveEffect = (name, pulse, inlineValues, timing = 4) => {
		const def = fxDefs.find((d) => d.name === name);
		const values = { ...(def?.values ?? {}) };
		const changes = fxParamChange[name];
		if (changes) {
			for (const [param, list] of Object.entries(changes)) {
				let best;
				for (const [p, value] of Array.isArray(list) ? list : []) {
					const pNum = Math.round(Number(p));
					if (pNum <= pulse && (!best || pNum >= best.pulse)) best = { pulse: pNum, value };
				}
				if (best) values[param] = best.value;
			}
		}
		if (inlineValues) Object.assign(values, inlineValues);
		return mapEffect(def?.type || name, values, warn, timing);
	};
	// Reference `y(...).type` — the resolved string type (def.type or the name).
	const effectTypeName = (name) => fxDefs.find((d) => d.name === name)?.type || name;

	// Reference allocator (f_000011 `L`): presets are pairs [FX-L effect, FX-R
	// effect] allocated lazily in first-use order and deduplicated by content.
	// A blank pair is reserved at slot index 12; ids start at FX_SLOT_OFFSET.
	const emptyEffect = () => ({ type: 0, params: [] });
	const presetPairs = [];
	const presetIds = new Map();
	const allocatePreset = (left, right) => {
		const pair = [left || emptyEffect(), right || emptyEffect()];
		const key = pair.map((effect) => formatEffectRow(effect)).join("|");
		if (presetIds.has(key)) return presetIds.get(key);
		if (presetPairs.length === 12) presetPairs.push([emptyEffect(), emptyEffect()]);
		if (presetPairs.length >= 252) {
			warn("The native FX preset ID range is full; additional KSON definitions remain in the source archive.");
			return 0;
		}
		const id = presetPairs.length + FX_SLOT_OFFSET;
		presetPairs.push(pair);
		presetIds.set(key, id);
		return id;
	};

	// Reference chip-sample registry: key_sound.fx.chip_event names that look
	// like files get native sample ids from 200 (first-use order); each chip
	// row carries the id and volume (vol*100, default 100).
	const chipNames = new Map();
	const chipSamples = [new Map(), new Map()];
	for (const [name, lanes] of Object.entries(audio.key_sound?.fx?.chip_event ?? {})) {
		if (!/\.[a-z0-9]+$/i.test(name)) {
			warn(`KSON built-in chip sound “${name}” has no verified native sample identity and is preserved.`);
			continue;
		}
		const id = chipNames.size + 200;
		if (id > 253) {
			warn("Custom FX chip file count exceeds the available native IDs; excess sounds are preserved in the source archive.");
			continue;
		}
		chipNames.set(name, id);
		for (const lane of [0, 1]) {
			for (const entry of lanes?.[lane] ?? []) {
				const pulse = Math.round(Number(Array.isArray(entry) ? entry[0] : entry));
				const opts = Array.isArray(entry) && entry[1] && typeof entry[1] === "object" ? entry[1] : {};
				const vol = Number.isFinite(Number(opts.vol)) ? Number(opts.vol) : 1;
				if (chipSamples[lane].has(pulse)) {
					warn("Simultaneous custom FX samples on one chip cannot all fit a native chip row; the first sample is used and all events are preserved.");
				} else {
					chipSamples[lane].set(pulse, { id, volume: 100 * vol });
				}
			}
		}
	}

	// --------------------------------------------------------- note rows
	const trackRows = [[], [], [], [], [], [], [], []];
	for (let lane = 0; lane < 4; lane++) {
		const rows = trackRows[2 + lane];
		for (const n of btLanes[lane]) {
			const pos = timeline.format(n.pulse);
			if (n.length > 0) rows.push(`${pos}\t${timeline.ticks(n.length)}\t0`);
			else rows.push(`${pos}\t0\t${n.sampleId ? numberOr(n.sampleId, 0) : 0}`);
		}
	}
	for (let lane = 0; lane < 2; lane++) {
		const rows = trackRows[lane === 0 ? 1 : 6];
		// Reference splits holds at event, param_change and BPM boundaries.
		const splitPulses = new Set();
		for (const changes of Object.values(fxParamChange)) {
			for (const list of Object.values(changes)) {
				for (const [p] of Array.isArray(list) ? list : []) splitPulses.add(Math.round(Number(p)));
			}
		}
		for (const entry of bpmTable) splitPulses.add(entry.pulse);
		for (const n of fxLanes[lane]) {
			const pos = timeline.format(n.pulse);
			if (n.length <= 0) {
				const hit = n.sampleId ? null : chipSamples[lane].get(n.pulse);
				const sampleId = n.sampleId ? numberOr(n.sampleId, 0) : (hit?.id || 0);
				const volume = n.sampleId ? 0 : formatCameraValue(hit?.volume ?? 0);
				rows.push(`${pos}\t0\t${sampleId}\t${volume}`);
				continue;
			}
			const end = n.pulse + n.length;
			// Reference `f`: only events INSIDE the hold [start, end) count; an
			// explicit effect on the note itself acts as an event at the hold
			// start and wins over same-pulse entries. Events before the hold
			// never assign a preset (unmatched holds keep effect id 0).
			const events = eventsAt[lane].filter((ev) => ev.pulse >= n.pulse && ev.pulse < end);
			if (n.effect) events.push({ pulse: n.pulse, name: n.effect, values: undefined });
			events.sort((a, b) => a.pulse - b.pulse);
			// Reference: holds whose events resolve to Flanger also split at
			// time-signature changes so the modulation timing stays correct.
			const isFlangerHold = events
				.some((ev) => ev.name && effectTypeName(ev.name) === "flanger");
			const points = new Set([n.pulse, end]);
			for (const ev of events) if (ev.pulse > n.pulse && ev.pulse < end) points.add(ev.pulse);
			for (const p of splitPulses) if (p > n.pulse && p < end) points.add(p);
			if (isFlangerHold) for (const p of timingChangePulses) if (p > n.pulse && p < end) points.add(p);
			const sorted = [...points].sort((a, b) => a - b);
			for (let i = 0; i + 1 < sorted.length; i++) {
				const from = sorted[i];
				const to = sorted[i + 1];
				if (to <= from) continue;
				const active = events.filter((ev) => ev.pulse <= from).slice(-1)[0];
				const effect = active?.name ? resolveEffect(active.name, from, active.values, timingNumeratorAt(from)) : emptyEffect();
				const id = effect.type ? allocatePreset(effect, emptyEffect()) : 0;
				rows.push(`${timeline.format(from)}\t${timeline.ticks(to - from)}\t${id}\t0`);
			}
		}
	}

	// -------------------------------------------------------------- lasers
	const laserSections = [0, 1].map((lane) => (Array.isArray(note.laser?.[lane]) ? note.laser[lane] : []));
	// Relocated/trimmed tail sections keep their array slot; the reference
	// writer flags their moving rows as decorative (ct=2) on TRACK1/TRACK8.
	const decorativeIndices = [new Set(), new Set()];
	for (const deco of tailDecorations) {
		if (deco && decorativeIndices[deco.lane]) decorativeIndices[deco.lane].add(deco.sectionIndex);
	}
	const flatSections = laserSections.flat();
	const spinEvents = collectSpinEvents(chart, flatSections);
	const { attachments, unmatched } = attachSpins(laserSections, spinEvents);
	const unmatchedPulses = new Set(unmatched.map((s) => `${s.kind}@${s.pulse}`));
	for (const spin of unmatched) {
		warn(`${spin.kind} at pulse ${spin.pulse} has no matching laser slam and direction; it was dropped.`);
	}
	for (const spin of spinEvents) {
		if (!unmatchedPulses.has(`${spin.kind}@${spin.pulse}`)) {
			warn(`${spin.kind} at pulse ${spin.pulse} was fitted to the closest native spin motion on its duration grid; amplitude/decay remain approximate.`);
		}
	}
	let laserEndPulse = 0;
	const spinBpmEvents = bpmTable.map((entry) => [entry.pulse, entry.bpm]);
	// Reference `X`: laser control pulses — BPM positions plus laser audio
	// effect pulse_event/param_change positions. Curved laser segments get
	// additional64th-note samples at every control pulse inside them.
	const laserFx = audio.audio_effect?.laser ?? audio.laser ?? {};
	const laserControlPulses = [
		...bpmTable.map((entry) => entry.pulse),
		...Object.values(laserFx.pulse_event ?? {}).flatMap((list) => (Array.isArray(list) ? list : [])),
		...Object.values(laserFx.param_change ?? {}).flatMap((params) => Object.values(params ?? {}).flatMap(
			(list) => (Array.isArray(list) ? list.map((entry) => entry?.[0]) : []),
		)),
	].filter((p) => Number.isSafeInteger(p) && p >= 0).sort((a, b) => a - b);

	// --------------------------------------------- laser audio effects (14131)
	// Reference module 14131 `oS`: laser defs resolve by name (def.type with
	// def.v, param_change at the pulse); `Q` maps each row's active effect to
	// a native laser filter id, deduplicated into TAB EFFECT INFO presets.
	const laserWarned = new Set();
	const laserWarn = (message) => {
		if (laserWarned.has(message)) return;
		laserWarned.add(message);
		warn(message);
	};
	const laserDefs = Array.isArray(laserFx.def) ? laserFx.def : [];
	const laserParamChange = laserFx.param_change ?? {};
	const resolveLaser = (name, pulse) => {
		const def = laserDefs.find((d) => d[0] === name)?.[1];
		const type = def?.type || name;
		const values = { ...(EFFECT_DEFAULTS[type] ?? {}), ...(def?.v ?? {}) };
		const changes = laserParamChange[name];
		if (changes) {
			for (const [param, list] of Object.entries(changes)) {
				let best;
				for (const entry of Array.isArray(list) ? list : []) {
					const p = Math.round(Number(entry[0]));
					if (p <= pulse && (!best || p >= best.pulse)) best = { pulse: p, value: entry[1] };
				}
				if (best) values[param] = best.value;
			}
		}
		return { type, values };
	};
	const laserPulseEvents = Object.entries(laserFx.pulse_event ?? {})
		.flatMap(([name, list]) => (Array.isArray(list) ? list.map((entry) => ({ pulse: Number(entry), name })) : []))
		.sort((a, b) => a.pulse - b.pulse);
	// Reference `Y`: audio control pulses (pulse_event + param_change — no
	// BPM) driving the interpolation rows; distinct from `X` above.
	const laserAudioControls = [...new Set([
		...laserPulseEvents.map((e) => e.pulse),
		...Object.values(laserParamChange).flatMap((params) => Object.values(params ?? {}).flatMap(
			(list) => (Array.isArray(list) ? list.map((entry) => Number(entry[0])) : []),
		)),
	])].filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
	const laserFilterPresets = [];
	const laserFilterIds = new Map();
	const laserNativeFilter = (resolved, name) => {
		const { type, values } = resolved;
		if (!type || type === "peaking_filter") {
			if (Object.keys(values).some((k) => !["v", "gain", "mix"].includes(k)) || values.gain !== "50%" || values.mix !== "0%>100%") {
				laserWarn("Custom KSON peaking-filter gain/frequency/mix is preserved; VOX filter 0 uses the native fixed peaking response.");
			}
			return { id: 0 };
		}
		const mix = 100 * sVal(values.mix, "max", 1);
		if (type === "bitcrusher") {
			const reduction = sVal(values.reduction, "max", 30);
			if (reduction > 30 || reduction <= 0) {
				laserWarn(`Laser effect “${name}” exceeds native bitcrusher limits and is preserved without a substitute.`);
				return { id: 0 };
			}
			laserWarn("KSON laser effects use native filter curves; KSM positional interpolation and wet levels may differ.");
			return { type: 3, params: [mix, reduction] };
		}
		if (type === "low_pass_filter" || type === "high_pass_filter") {
			const isLow = type === "low_pass_filter";
			laserWarn("KSON laser filters use native cutoff defaults and positional curves; KSM client-specific filter gain and resonance are preserved in the source archive.");
			return {
				type: isLow ? 1 : 2,
				params: [mix, sVal(values.freq, "min", isLow ? 400 : 40), sVal(values.freq_max, "max", isLow ? 18000 : 5000), sVal(values.q, "max", 0.7)],
			};
		}
		laserWarn(`Laser effect “${name}” (${type}) requires FX-parameter automation without a verified native mapping; it is preserved without substituting an unrelated filter.`);
		return { id: 0 };
	};
	const laserFilterAt = (pulse) => {
		const event = laserPulseEvents.filter((e) => e.pulse <= pulse).at(-1);
		const name = event?.name ?? "peaking_filter";
		const native = laserNativeFilter(resolveLaser(name, pulse), name);
		if ("id" in native) return native.id;
		const key = formatEffectRow(native);
		if (!laserFilterIds.has(key)) {
			laserFilterPresets.push(native);
			laserFilterIds.set(key, laserFilterPresets.length);
		}
		return laserFilterIds.get(key);
	};
	const laserAudioFx = laserAudioControls.length
		? { controlPulses: laserAudioControls, filterAt: laserFilterAt }
		: null;

	let laserCurved = false;
	if (laserSections[0].length) {
		const main = emitLaserTrack(timeline, laserSections[0], attachments, { lane: 0, bpmEvents: spinBpmEvents, laserControlPulses, audioFx: laserAudioFx, decorative: decorativeIndices[0] });
		trackRows[0] = main.rows;
		laserEndPulse = Math.max(laserEndPulse, main.endPulse);
		laserCurved = laserCurved || main.curved;
	}
	if (laserSections[1].length) {
		const main = emitLaserTrack(timeline, laserSections[1], attachments, { lane: 1, bpmEvents: spinBpmEvents, laserControlPulses, audioFx: laserAudioFx, decorative: decorativeIndices[1] });
		trackRows[7] = main.rows;
		laserEndPulse = Math.max(laserEndPulse, main.endPulse);
		laserCurved = laserCurved || main.curved;
	}
	if (laserCurved) {
		warn("Curved KSON lasers use 64th-note samples for VOX playback; authored points, slams and effect changes retain their exact timing. Preserve the KSON source to recover its exact curve controls.");
	}
	const originalL = laserSections[0].length ? emitLaserTrack(timeline, laserSections[0], attachments, { originals: true, lane: 0, bpmEvents: spinBpmEvents, audioFx: laserAudioFx }).rows : [];
	const originalR = laserSections[1].length ? emitLaserTrack(timeline, laserSections[1], attachments, { originals: true, lane: 1, bpmEvents: spinBpmEvents, audioFx: laserAudioFx }).rows : [];

	// --------------------------------------------------------------- camera
	// Reference `aJ`: legacy projection only for numeric #KSH_VERSION in
	// (0, 167) — the pre-167 40 ms smoothing era. Modern/absent versions use
	// the current projection.
	const kshVer = chart.compat?.ksh_version;
	const legacy = (typeof kshVer === "string" || typeof kshVer === "number")
		&& String(kshVer).trim() !== ""
		&& Number.isFinite(Number(kshVer))
		&& Number(kshVer) > 0
		&& Number(kshVer) < 167;
	const zoomTop = flattenGraph(camBody.zoom_top, "camera.cam.body.zoom_top");
	const zoomBottom = flattenGraph(camBody.zoom_bottom, "camera.cam.body.zoom_bottom");
	const zoomSide = flattenGraph(camBody.zoom_side, "camera.cam.body.zoom_side");
	const rotation = flattenGraph(camBody.rotation_deg, "camera.cam.body.rotation_deg");
	const centerSplit = flattenGraph(camBody.center_split, "camera.cam.body.center_split");
	const tiltRaw = Array.isArray(camera.tilt) ? camera.tilt : [];
	// Unified tilt timeline (reference `z`): numeric values and named modes in
	// one pulse-sorted list. Instant [from,to] pairs and curves are kept;
	// string modes evaluate to 0 on BIL_RotZ (see makeTiltEvaluator).
	const tiltTimeline = [];
	for (const entry of tiltRaw) {
		const pulse = Math.round(Number(entry[0]));
		let before = entry[1];
		let after = entry[1];
		let curve = [0, 0];
		if (Array.isArray(entry[1])) {
			if (Array.isArray(entry[1][1])) {
				// [value, [curve]] — curved value, no instant change.
				curve = entry[1][1];
				const src = Array.isArray(entry[1][0]) ? entry[1][0] : [entry[1][0], entry[1][0]];
				[before, after] = src;
			} else {
				// [from, to] — instant change.
				[before, after] = entry[1];
			}
		}
		tiltTimeline.push({ pulse, before, after, curve });
	}
	tiltTimeline.sort((a, b) => a.pulse - b.pulse);
	// Reference `Y`: BIL_RotZ exists only when rotation or a NUMERIC manual
	// tilt value is present (named modes alone drive Tilt rows only).
	const tiltNumeric = tiltTimeline.some((p) => typeof p.before === "number" || typeof p.after === "number");

	const spRows = [...SP_HEADER_ROWS];

	// Reference `y()`/`N()`: `lastPlayablePulse` = max BT/FX note end and
	// "judged" laser section end. A section is judged when it contains a slam
	// (before !== after) or when a beat-grid point (60 pulses, 120 at BPM
	// >= 256) falls inside one of its segments. Laser tail sections beyond it
	// are nonjudged decorative artwork; the reference project them into
	// earlier gaps and clip the scroll/stop timeline at `x`, which is what
	// fixes END POSITION and the ManualSpeed tail on real charts.
	const lastPlayablePulse = (() => {
		let x = 0;
		for (const lane of laserSections) {
			for (const section of lane) {
				if (!Array.isArray(section) || !Array.isArray(section[1]) || !section[1].length) continue;
				const start = Number(section[0]) || 0;
				const graph = section[1].map((point) => ({
					pulse: Number(point[0]) || 0,
					before: Array.isArray(point[1]) ? point[1][0] : point[1],
					after: Array.isArray(point[1]) ? point[1][1] : point[1],
				}));
				const end = start + graph[graph.length - 1].pulse;
				let judged = graph.some((p) => p.before !== p.after);
				if (!judged) {
					judged = graph.some((p, index) => {
						const next = graph[index + 1];
						if (!next) return false;
						const a = start + p.pulse;
						const s = start + next.pulse;
						let bpm = bpmTable[0]?.bpm ?? 120;
						for (const entry of bpmTable) {
							if (entry.pulse > a) break;
							bpm = entry.bpm;
						}
						const grid = bpm >= 256 ? 120 : 60;
						return Math.ceil(a / grid) * grid < s;
					});
				}
				if (judged) x = Math.max(x, end);
			}
		}
		for (const lane of [...btLanes, ...fxLanes]) {
			for (const n of lane) x = Math.max(x, n.pulse + n.length);
		}
		return x;
	})();
	let decorationCount = 0;
	if (lastPlayablePulse > 0) {
		for (const lane of laserSections) {
			for (const section of lane) {
				const points = Array.isArray(section?.[1]) ? section[1] : [];
				if (points.length && Number(section[0]) + Number(points[points.length - 1][0]) > lastPlayablePulse) decorationCount++;
			}
		}
	}
	if (decorationCount) {
		warn(`${decorationCount} nonjudged decorative laser tail sections lie beyond the last playable pulse; scroll, stops and END POSITION were clipped there (the reference editor additionally relocates those sections into earlier gaps).`);
	}

	// ManualSpeed: reference step pulses `q` = scroll points + BPM positions +
	// stop endpoints + every pulse where the scroll value changes; values are
	// stop-masked, extreme jumps are fitted to the native float32 clock, and
	// rows are deduped against the previous emitted value.
	// Decorative tail: the reference clips the scroll graph at
	// `lastPlayablePulse` (linear interpolation to the clip point) and drops
	// stops starting at/after it.
	const scroll = (() => {
		const flat = flattenGraph(beat.scroll_speed ?? [[0, 1]], "beat.scroll_speed");
		if (!decorationCount || !flat.length || flat.at(-1).pulse <= lastPlayablePulse) return flat;
		const clipped = flat.filter((p) => p.pulse < lastPlayablePulse);
		const index = flat.findLastIndex((p) => p.pulse <= lastPlayablePulse);
		const cur = flat[index];
		if (!cur) return flat;
		const next = flat[index + 1];
		if (cur.pulse === lastPlayablePulse) {
			clipped.push(cur);
		} else if (next) {
			const ratio = (lastPlayablePulse - cur.pulse) / (next.pulse - cur.pulse);
			const value = cur.to + (next.from - cur.to) * ratio; // reference interpolates linearly here
			clipped.push({ pulse: lastPlayablePulse, from: value, to: value });
		} else {
			clipped.push({ pulse: lastPlayablePulse, from: cur.to, to: cur.to });
		}
		return clipped;
	})();
	const stops = (Array.isArray(beat.stop) ? beat.stop : []).map((entry) => ({
		pulse: Math.max(0, Math.round(Number(entry[0]))),
		duration: Math.max(0, Math.round(Number(entry[1]))),
	})).sort((a, b) => a.pulse - b.pulse)
		.filter((s) => !decorationCount || s.pulse < lastPlayablePulse);
	// Last pulse of the step timeline (END POSITION counts it).
	let scrollEndPulse = 0;
	if (scroll.length || stops.length) {
		const scrollAt = makeGraph(scroll);
		// Reference `C(bpmTable)`: the pure-BPM seconds clock.
		const marks = [];
		let seconds = 0;
		for (const entry of bpmTable) {
			const prev = marks.at(-1);
			if (prev) seconds += (60 * (entry.pulse - prev.pulse)) / (prev.bpm * VOX_RESOLUTION);
			marks.push({ pulse: entry.pulse, bpm: entry.bpm, seconds });
		}
		const secondsAtPulse = (pulse) => {
			let i = marks.length - 1;
			while (i > 0 && marks[i].pulse > pulse) i--;
			const mark = marks[i] ?? { pulse: 0, bpm: 120, seconds: 0 };
			return mark.seconds + (60 * (pulse - mark.pulse)) / (mark.bpm * VOX_RESOLUTION);
		};
		// Reference float-clock fit: extreme ManualSpeed jumps are nudged to a
		// float32 neighbor so `8 * seconds * bpm * value` tracks the linear
		// distance `2 * deltaPulse * value` within 0.25 pulses.
		let fitWarned = false;
		const fitSpeedValue = (value, pulse, nextPulse, bpm) => {
			if (!value || nextPulse === undefined || nextPulse <= pulse) return value;
			const fr = Math.fround;
			const a = fr(fr(secondsAtPulse(nextPulse)) - fr(secondsAtPulse(pulse)));
			const s = fr(bpm);
			const linear = 2 * (nextPulse - pulse) * value;
			const clock = (candidate) => fr(8 * fr(a * fr(s * fr(candidate))));
			const err = Math.abs(clock(value) - linear);
			if (!(a > 0) || !Number.isFinite(linear) || err <= 0.25) return value;
			const start = fr(linear / (a * s * 8));
			if (!Number.isFinite(start)) return value;
			const buf = new DataView(new ArrayBuffer(4));
			buf.setFloat32(0, start, true);
			const bits = buf.getUint32(0, true);
			let best = value;
			let bestErr = err;
			for (const neighbor of [bits, bits - 1, bits + 1]) {
				buf.setUint32(0, neighbor, true);
				const candidate = buf.getFloat32(0, true);
				if (!Number.isFinite(candidate)) continue;
				const candidateErr = Math.abs(clock(candidate) - linear);
				if (candidateErr < bestErr) {
					best = candidate;
					bestErr = candidateErr;
				}
			}
			if (best !== value && !fitWarned) {
				fitWarned = true;
				warn("Extreme KSON scroll distances were fitted to the native float clock to keep short forward/reverse jumps aligned; original scroll values are preserved in the source archive.");
			}
			return best;
		};
		const stepPulses = new Set([0]);
		for (const entry of bpmTable) stepPulses.add(entry.pulse);
		for (const p of scroll) stepPulses.add(p.pulse);
		for (const s of stops) {
			stepPulses.add(s.pulse);
			stepPulses.add(s.pulse + s.duration);
		}
		for (let i = 0; i + 1 < scroll.length; i++) {
			if (scroll[i].to !== scroll[i + 1].from) {
				const start = scroll[i].pulse;
				const end = scroll[i + 1].pulse;
				if (parseCurvePair(scroll[i].curve)) {
					// Curved ramps are subsampled: a step is kept whenever the
					// curve drifts max(0.005, 0.5% of the value) away from the
					// last kept step, bounding the piecewise-constant error
					// while avoiding 240 rows per beat on long smooth curves.
					// (Linear ramps stay per-pulse, matching the reference.)
					let kept = scrollAt(start);
					for (let p = start + 1; p < end; p++) {
						const value = scrollAt(p);
						if (Math.abs(value - kept) >= Math.max(0.005, Math.abs(value) * 0.005)) {
							stepPulses.add(p);
							kept = value;
						}
					}
				} else {
					for (let p = start + 1; p < end; p++) stepPulses.add(p);
				}
			}
		}
		const baseSteps = [...stepPulses].sort((a, b) => a - b).map((pulse) => ({
			pulse,
			value: stops.some((s) => pulse >= s.pulse && pulse < s.pulse + s.duration) ? 0 : scrollAt(pulse),
		}));
		// Reference `d.G`: delay isolated terminal-slam jumps into the
		// following empty interval (see adaptTerminalJumps).
		const jumpNotes = [
			...btLanes.flat().map((n) => ({ start: n.pulse, end: n.pulse + n.length })),
			...fxLanes.flat().map((n) => ({ start: n.pulse, end: n.pulse + n.length })),
			...laserSections.flat().flatMap((section) => {
				const points = Array.isArray(section?.[1]) ? section[1] : [];
				const lastPoint = points.at(-1);
				if (!lastPoint) return [];
				const from = Array.isArray(lastPoint[1]) ? lastPoint[1][0] : lastPoint[1];
				const to = Array.isArray(lastPoint[1]) ? lastPoint[1][1] : lastPoint[1];
				return [{
					start: Number(section[0]) || 0,
					end: (Number(section[0]) || 0) + (Number(lastPoint[0]) || 0),
					terminalSlam: from !== to,
				}];
			}),
		];
		const steps = adaptTerminalJumps({
			steps: baseSteps,
			graph: scroll,
			notes: jumpNotes,
			stops,
			maxBpm: Math.max(...bpmTable.map((entry) => entry.bpm)),
			secondsAtPulse,
			maxPulse: 9600000, // reference `A` = 960 * 1e4
			format: (pulse) => timeline.format(pulse),
			warn,
		});
		scrollEndPulse = steps.length ? steps[steps.length - 1].pulse : 0;
		// The VOX default speed is 1.0, so the reference omits the redundant
		// initial row when the chart starts at the default.
		// Extreme KSON scroll speeds (e.g. 1000000) stutter native playback,
		// so the emitted magnitude is capped at ±10000 — both the raw step
		// value and the float-clock-fitted result (the fit otherwise nudges
		// the capped value back above the limit: its float32 absolute-seconds
		// clock deviates from the linear distance on long spans).
		const MAX_LANE_SPEED = 10000;
		const capSpeed = (v) => (v > MAX_LANE_SPEED ? MAX_LANE_SPEED : (v < -MAX_LANE_SPEED ? -MAX_LANE_SPEED : v));
		let last = 1;
		let bpmIndex = 0;
		for (let i = 0; i < steps.length; i++) {
			const { pulse, value } = steps[i];
			while (bpmIndex + 1 < bpmTable.length && bpmTable[bpmIndex + 1].pulse <= pulse) bpmIndex++;
			const capped = capSpeed(value);
			const fitted = capSpeed(fitSpeedValue(capped, pulse, steps[i + 1]?.pulse, bpmTable[bpmIndex]?.bpm ?? 120));
			if (fitted !== last) {
				spRows.push(`${timeline.format(pulse)}\tManualSpeed\t0\t0\tf${formatSpeedValue(fitted)}\t0\t0\t0`);
				last = fitted;
			}
		}
	}

	// Projection (CAM_RotX d-prefix, CAM_Radi f-prefix). Row order matches the
	// reference: per joint, per controller — dur0 anchor/jump row then that
	// controller's ramp pieces for the span starting at the joint.
	// Camera SPCONTROLLER writers (reference `y`): per joint, a dur0 anchor
	// row (first joint, last joint, or instant jump) then that controller's
	// chord rows for the span starting at the joint. BPM pulses split spans;
	// curved spans bisect recursively at floor midpoints.
	const camBpmPulses = [...new Set(bpmTable.map((entry) => entry.pulse))].sort((a, b) => a - b);
	const cameraWarnings = new Set();
	const emitSpRow = (pulse, dur, name, v0, v1, prefix, comment) => {
		spRows.push(`${timeline.format(pulse)}\t${name}\t2\t${dur}\t${prefix}${formatCameraValue(v0)}\t${prefix}${formatCameraValue(v1)}\t0\t0\t// ${comment}`);
	};
	const cameraSpan = (start, end, valueAt, absoluteError, emit) => {
		const res = emitCameraSpan(start, end, valueAt, absoluteError, camBpmPulses, emit);
		if (res.over || res.count > CAM_MAX_SEGMENTS) {
			cameraWarnings.add("Some camera curves use bounded approximate linear segments; their original KSON B\u00e9zier controls are preserved.");
		}
	};

	// Projection (CAM_RotX d-prefix from zoom_top, CAM_Radi f-prefix from
	// zoom_bottom): the projected camera curve is chord-fitted per joint span.
	// Shared evaluators also feed the zoom_side roll (BIL_RotZ) below.
	const zoomTopAt = makeGraph(zoomTop);
	const zoomBottomAt = makeGraph(zoomBottom);
	const emitProjection = () => {
		if (!zoomTop.length && !zoomBottom.length) return;
		const jointsSet = new Set([0]);
		for (const p of zoomTop) jointsSet.add(p.pulse);
		for (const p of zoomBottom) jointsSet.add(p.pulse);
		const joints = [...jointsSet].sort((a, b) => a - b);
		const jumpSet = new Set([...zoomTop, ...zoomBottom].filter((p) => p.from !== p.to).map((p) => p.pulse));
		const controllers = [
			{
				name: "CAM_RotX",
				value: (p, side) => projectCamera(zoomTopAt(p, side), zoomBottomAt(p, side), legacy).rotX,
				prefix: "d",
				comment: "KSON camera.cam.body.zoom_top",
			},
			{
				name: "CAM_Radi",
				value: (p, side) => projectCamera(zoomTopAt(p, side), zoomBottomAt(p, side), legacy).radius,
				prefix: "f",
				comment: "KSON camera.cam.body.zoom_bottom",
			},
		];
		for (let i = 0; i < joints.length; i++) {
			const j = joints[i];
			const next = joints[i + 1];
			for (const c of controllers) {
				// dur0 anchor: first joint, last joint, or an instant jump.
				if (i === 0 || next === undefined || jumpSet.has(j)) {
					emitSpRow(j, 0, c.name, c.value(j, "before"), c.value(j, "after"), c.prefix, c.comment);
				}
				if (next === undefined) continue;
				// Ramp endpoints: after-side at the joint start (post-jump
				// value), before-side at the joint end (pre-jump value).
				const spanValue = (p) => c.value(p, p === next ? "before" : "after");
				cameraSpan(j, next, spanValue, CAM_ABS_ERROR, (a, dur, v0, v1) => emitSpRow(a, dur, c.name, v0, v1, c.prefix, c.comment));
			}
		}
	};
	emitProjection();

	// Morphing2 = center_split x 0.00712 (reference G). Spans interpolate the
	// KSON curve from the start point's after value to the end point's before
	// value; constant spans keep a single hold chord row.
	if (centerSplit.length) {
		const value = (raw) => raw * MORPHING_RATE;
		const emit = (pulse, dur, v0, v1) => emitSpRow(pulse, dur, "Morphing2", v0, v1, "f", "KSON camera.cam.body.center_split");
		for (let i = 0; i < centerSplit.length; i++) {
			const point = centerSplit[i];
			const next = centerSplit[i + 1];
			// dur0 anchor: first point, last point, or an instant jump.
			if (!(i > 0 && point.from === point.to && next)) {
				emit(point.pulse, 0, value(point.from), value(point.to));
			}
			if (!next) continue;
			const span = next.pulse - point.pulse;
			const spanValue = (p) => value(point.to + (next.from - point.to) * curveY(point.curve, span > 0 ? (p - point.pulse) / span : 1));
			cameraSpan(point.pulse, next.pulse, spanValue, 0.002, emit);
		}
		cameraWarnings.add("KSON camera center_split uses approximate native Morphing2; native splitting leaves lasers in the unsplit coordinate space.");
	}

	// BIL_RotZ = rotation_deg + manual tilt x10 + zoom_side roll (reference
	// module 5138 with module 1819 `x()`/ZX). When zoom_side is present its
	// zoom_top/zoom_bottom pulses also become joints, because the roll depends
	// on them. dur0 anchors at the first/last joint and instant jumps; a span
	// is skipped when both joint triples (rotation, tilt, zoom_side) are zero.
	if (rotation.length || tiltNumeric || zoomSide.length) {
		const rotAt = makeGraph(rotation);
		const tiltAt = makeTiltEvaluator(tiltTimeline);
		const sideAt = makeGraph(zoomSide);
		const triple = (p, side) => [rotAt(p, side), tiltAt(p, side), sideAt(p, side)];
		const rollAt = (p, side = "after") => {
			const roll = rollFromZoomSide(sideAt(p, side), zoomTopAt(p, side), zoomBottomAt(p, side), legacy);
			if (roll.flags.includes("offscreen-horizontal-translation")) {
				cameraWarnings.add("Offscreen KSON horizontal translation remains inactive because native rotation cannot reproduce its lane-hiding effect; original source values are preserved.");
			} else if (roll.limited) {
				cameraWarnings.add("Extreme KSON horizontal camera geometry was limited to a usable native rotation; original source values are preserved.");
			}
			return roll.rollDegrees;
		};
		const valueAt = (p, side = "after") => rotAt(p, side) + tiltAt(p, side) + rollAt(p, side);
		const jointsSet = new Set([0]);
		for (const p of rotation) jointsSet.add(p.pulse);
		for (const p of tiltTimeline) jointsSet.add(p.pulse);
		for (const p of zoomSide) jointsSet.add(p.pulse);
		if (zoomSide.length) {
			for (const p of zoomTop) jointsSet.add(p.pulse);
			for (const p of zoomBottom) jointsSet.add(p.pulse);
		}
		const joints = [...jointsSet].sort((a, b) => a - b);
		const parts = [
			rotation.length ? "cam.body.rotation_deg" : null,
			tiltNumeric ? "tilt" : null,
			zoomSide.length ? "cam.body.zoom_side" : null,
		].filter(Boolean).join(" + ");
		const comment = `KSON camera.${parts}`;
		const emit = (pulse, dur, v0, v1) => emitSpRow(pulse, dur, "BIL_RotZ", v0, v1, "d", comment);
		for (let i = 0; i < joints.length; i++) {
			const j = joints[i];
			const next = joints[i + 1];
			const before = valueAt(j, "before");
			const after = valueAt(j);
			// dur0 anchor: first joint, last joint, or an instant jump.
			if (!(i > 0 && next !== undefined && before === after)) {
				emit(j, 0, before, after);
			}
			if (next === undefined) continue;
			const contributes = [...triple(j), ...triple(next, "before")].some((v) => v !== 0);
			if (!contributes) continue;
			const spanValue = (p) => valueAt(p, p === next ? "before" : "after");
			cameraSpan(j, next, spanValue, CAM_ABS_ERROR, emit);
		}
		if (rotation.length || tiltNumeric) {
			cameraWarnings.add("KSON manual tilt and rotation_deg use combined native BIL_RotZ lane rotation. Native judgment/background transforms and the KSM 40 ms manual/automatic blend differ; original source values are preserved.");
		}
		if (zoomSide.length) {
			cameraWarnings.add("KSON zoom_side is approximated by native BIL_RotZ rotation fitted near the judgment line. Rotation cannot reproduce horizontal translation across the whole lane; source timing, direction and values are preserved.");
			if (legacy) cameraWarnings.add("Legacy KSH horizontal camera motion has a 40 ms smoothing transition that remains approximate.");
		}
	}
	if (zoomTop.length || zoomBottom.length || centerSplit.length || rotation.length || tiltTimeline.length) {
		cameraWarnings.add("KSON camera movement was converted to editable approximate VOX commands. Camera projection, tilt smoothing, split behavior and spin shapes differ between engines; original KSON camera data is preserved.");
	}
	for (const message of cameraWarnings) warn(message);

	// Tilt SPCONTROLLER rows (values ride on BIL_RotZ; rows carry f0 f0).
	const endPulse = Math.max(
		...btLanes.flat().map((n) => n.pulse + n.length),
		...fxLanes.flat().map((n) => n.pulse + n.length),
		// Decorative tail lasers are relocated to/kept within `x` by the
		// reference projection, so their END contribution stops at `x`.
		decorationCount ? Math.min(laserEndPulse, lastPlayablePulse) : laserEndPulse,
		scrollEndPulse,
		...stops.map((s) => s.pulse + s.duration),
		...zoomTop.map((p) => p.pulse),
		...zoomBottom.map((p) => p.pulse),
		...zoomSide.map((p) => p.pulse),
		...rotation.map((p) => p.pulse),
		...tiltTimeline.map((p) => p.pulse),
		0,
	);
	// Reference `W` for the last Tilt row: max(chart max pulse, start of the
	// measure after the camera/spin max pulse `I` — camera joints tracked by
	// `k()` plus the slam module's maxPulse with native spin end pulses).
	let cameraMaxPulse = 0;
	for (const p of [...zoomTop, ...zoomBottom, ...zoomSide, ...rotation, ...tiltTimeline, ...centerSplit]) {
		cameraMaxPulse = Math.max(cameraMaxPulse, p.pulse);
	}
	for (const spin of attachments.values()) {
		if (spin.fit) cameraMaxPulse = Math.max(cameraMaxPulse, spin.pulse + spin.len, Math.ceil(spin.fit.endPulse - 1e-4));
	}
	const tiltTailPulse = Math.max(
		endPulse,
		timeline.pulseAtPosition({ measure: timeline.position(cameraMaxPulse).measure + 1, beat: 1, tick: 0 }),
	);
	for (let i = 0; i < tiltTimeline.length; i++) {
		const point = tiltTimeline[i];
		// Numeric tilt and the "zero" preset emit a Tilt command row; other
		// named modes are visual presets only (values ride on BIL_RotZ).
		if (!((typeof point.after === "number" && Number.isFinite(point.after)) || point.after === "zero")) continue;
		const next = tiltTimeline[i + 1] ? tiltTimeline[i + 1].pulse : tiltTailPulse;
		const dur = Math.max(0, timeline.ticks(next - point.pulse));
		spRows.push(`${timeline.format(point.pulse)}\tTilt\t2\t${dur}\tf0\tf0\t1\t0\t// KSON camera.tilt`);
	}

	// Reference module 14131 `V`: KSON laser Gate "Off" values become native
	// AUTO tab notes over the control-pulse intervals where the gate's off-mix
	// is audible (and no physical FX hold overlaps), deduplicated into preset
	// pairs (the blank slot rule in `allocatePreset` keeps FX ids identical).
	const endPulseBound = timeline.pulseAtPosition({ measure: timeline.position(endPulse).measure + 1, beat: 1, tick: 0 });
	const gateNames = [...new Set([
		...laserDefs.map((d) => d[0]),
		...Object.keys(laserParamChange),
	])].filter((name) => resolveLaser(name, 0).type === "gate");
	const autoTabRows = [];
	if (gateNames.length && endPulseBound > 0) {
		const fxHolds = fxLanes.flat().filter((n) => n.length > 0).map((n) => ({ start: n.pulse, end: n.pulse + n.length }));
		const laserSpans = laserSections.flatMap((lane) => lane
			.map((sec) => ({ start: Number(sec[0]), end: Number(sec[0]) + Number(sec[1]?.[sec[1].length - 1]?.[0] || 0) }))
			.filter((span) => span.end > span.start))
			.sort((a, b) => a.start - b.start);
		const firstBpm = bpmTable[0]?.bpm ?? 120;
		const bpmAt = (pulse) => {
			let value = firstBpm;
			for (const entry of bpmTable) if (entry.pulse <= pulse) value = entry.bpm;
			return value;
		};
		const controlPulses = [...new Set([
			0,
			endPulseBound,
			...laserPulseEvents.map((e) => e.pulse),
			...gateNames.flatMap((name) => Object.values(laserParamChange[name] ?? {}).flatMap(
				(list) => (Array.isArray(list) ? list.map((entry) => Number(entry[0])) : []),
			)),
			...fxHolds.flatMap((hold) => [hold.start, hold.end]),
			...bpmTable.map((entry) => entry.pulse),
		])].filter((p) => Number.isFinite(p) && p >= 0 && p <= endPulseBound).sort((a, b) => a - b);
		const formatRange = (from, to) => `${timeline.format(from)}–${timeline.format(to)}`;
		const mappings = [];
		for (let i = 0; i + 1 < controlPulses.length; i++) {
			const start = controlPulses[i];
			const end = controlPulses[i + 1];
			const lastEvent = laserPulseEvents.filter((e) => e.pulse <= start).at(-1);
			const activeName = lastEvent?.name ?? "peaking_filter";
			const candidates = gateNames.filter((name) => name !== activeName)
				.map((name) => ({ name, ...resolveLaser(name, start) }))
				.filter((entry) => sVal(entry.values.mix, "off", 0) > 0);
			if (!candidates.length) continue;
			if (fxHolds.some((hold) => hold.start < end && hold.end > start)) {
				laserWarn(`KSON laser Gate Off values at ${formatRange(start, end)} overlap a physical FX hold. That automatic layer is preserved without replacing the hold's native effect.`);
				continue;
			}
			if (candidates.length > 2) {
				laserWarn(`KSON laser Gate Off values at ${formatRange(start, end)} have ${candidates.length} layers. Native AUTO uses the first two in definition order; additional layers remain in the source archive.`);
			}
			const natives = candidates.slice(0, 2).map((entry) => ({
				name: entry.name,
				native: mapEffect(entry.type, Object.fromEntries(Object.entries(entry.values).map(
					([key, value]) => [key, parseRange(value)?.off ?? value],
				)), laserWarn, 4),
			})).filter((entry) => entry.native.type);
			if (!natives.length) continue;
			const id = allocatePreset(natives[0]?.native, natives[1]?.native);
			if (!id) continue;
			const names = natives.map((entry) => entry.name);
			const last = mappings.at(-1);
			if (last?.endPulse === start && last.effectId === id && JSON.stringify(last.names) === JSON.stringify(names)) {
				last.endPulse = end;
			} else {
				mappings.push({ startPulse: start, endPulse: end, effectId: id, names });
			}
		}
		for (const mapping of mappings) {
			let cursor = mapping.startPulse;
			for (const span of laserSpans) {
				if (!(span.end <= cursor || span.start >= mapping.endPulse)) {
					if (span.start > cursor) break;
					cursor = Math.max(cursor, span.end);
					if (cursor >= mapping.endPulse) break;
				}
			}
			if (cursor < mapping.endPulse) {
				laserWarn(`KSON automatic Gate ${mapping.names.join(" + ")} at ${formatRange(mapping.startPulse, mapping.endPulse)} includes time without a real laser. Native AUTO is audible only while a real laser is active; no notes were added.`);
			}
		}
		if (mappings.length) {
			laserWarn("KSON laser Gate Off values were converted into editable native AUTO presets. They keep the selected laser filter and use the SDVX Gate algorithm.");
		}
		for (const mapping of mappings) {
			autoTabRows.push(`${timeline.format(mapping.startPulse)}\t${mapping.endPulse - mapping.startPulse}\t${mapping.effectId}\t0\t// KSON laser Off: ${mapping.names.map((n) => JSON.stringify(n)).join(" + ")}`);
		}
	}

	// ------------------------------------------------------------- sections
	// One comment row per unified tilt entry (named modes keep their KSON name).
	const tiltModeRows = ["001,01,00\t0"];
	for (const point of tiltTimeline) {
		const named = typeof point.after === "string";
		if (named && !(point.after in TILT_MODE_MAP)) {
			throw new Error(`Unknown KSON camera.tilt mode "${point.after}".`);
		}
		const mode = named ? TILT_MODE_MAP[point.after] : 0;
		tiltModeRows.push(`${timeline.format(point.pulse)}\t${mode}\t// KSON camera.tilt ${named ? point.after : "manual"}`);
	}

	const bpmRows = bpmTable.map((entry) => `${timeline.format(entry.pulse)}\t${formatBpm(entry.bpm)}\t4`);
	const beatSigRows = (Array.isArray(beat.time_sig) && beat.time_sig.length ? beat.time_sig : [[0, [4, 4]]])
		.map((entry, index) => {
			const pulse = timeline.pulseAtPosition({ measure: Number(entry[0]) + 1, beat: 1, tick: 0 });
			const num = Math.max(1, Math.round(Number(entry[1][0])));
			const den = Math.max(1, Math.round(Number(entry[1][1])));
			return { pulse, num, den, index };
		})
		.sort((a, b) => a.pulse - b.pulse || a.index - b.index)
		.map((entry) => `${timeline.format(entry.pulse)}\t${entry.num}\t${entry.den}`);

	const endMeasure = timeline.position(endPulse).measure + 1;
	const sections = [
		["FORMAT VERSION", ["13"]],
		["BEAT RESOLUTION", [String(VOX_RESOLUTION)]],
		["BEAT INFO", beatSigRows],
		["BPM INFO", bpmRows],
		["TILT MODE INFO", tiltModeRows],
		["END POSITION", [`${pad(endMeasure, 3)},01,00`]],
		["TAB EFFECT INFO", laserFilterPresets.map((effect) => formatEffectRow(effect))],
		// Presets hold after the FX note walk above, so `presetPairs` is final:
		// two rows per pair (FX-L line, FX-R line), and two param assignments.
		["FXBUTTON EFFECT INFO", presetPairs.flatMap((pair) => pair.map((effect) => formatEffectRow(effect)))],
		["TAB PARAM ASSIGN INFO", presetPairs.flatMap((pair, index) => pair.map(() => `${index}, 0, 0, 0`))],
		...trackRows.map((rows, index) => [`TRACK${index + 1}`, rows]),
		["SPCONTROLER", spRows],
		// Reference: a populated TRACK AUTO TAB block is serialized directly
		// after SPCONTROLLER; when empty it falls back to the slot just above
		// TRACK ORIGINAL L (between REVERB and the ORIGINAL tracks).
		...(autoTabRows.length ? [["TRACK AUTO TAB", autoTabRows]] : []),
		["LYRIC INFO", []],
		["REVERB EFFECT PARAM", []],
		...(autoTabRows.length ? [] : [["TRACK AUTO TAB", autoTabRows]]),
		["TRACK ORIGINAL L", originalL],
		["TRACK ORIGINAL R", originalR],
	];

	// Reference parity: the writer emits one extra blank line after the
	// SPCONTROLLER block (3 blank lines after #SPCONTROLER's #END, 2 elsewhere).
	const text = sections
		.map(([name, rows]) => `#${name}\n${rows.length ? `${rows.join("\n")}\n` : ""}#END\n${name === "SPCONTROLER" ? "\n" : ""}`)
		.join("\n\n");
	if (meta.title) warn(`Converted "${meta.title}"${meta.artist ? ` by ${meta.artist}` : ""}.`);
	return `// SOUND VOLTEX OUTPUT TEXT FILE\n\n${text}\n`;
}

export const __testing = {
	formatFixed2,
	formatBpm,
	formatCameraValue,
	formatSpeedValue,
	parseSpan,
	normalizeNote,
	Timeline,
	makeGraph,
	curveTypeOf,
	collectSpinEvents,
	emitLaserTrack,
	spinDuration,
	spinFit,
	mapEffect,
	formatEffectRow,
	normalizeFxDefs,
	rollFromZoomSide,
};
