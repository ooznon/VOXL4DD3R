// Decorative tail-laser projection — a faithful port of reference module 78799
// (sdvxindex.com editor f_000011.js, exported as `n`), which the editor runs on
// every KSON before its VOX writer (module 99561 `F`).
//
// The editor splits "tail artwork" into two passes:
//   1. y(): nonjudged sections past `lastPlayablePulse` whose head is an
//      out-of-range pseudo slam (value -1/2) sitting on a 1-pulse stop get
//      RELOCATED into an earlier forward-scroll gap whose accumulated scroll
//      distance range can absorb the section's body distances. The head point
//      is dropped (removedHeadPoints); points are rounded onto the destination
//      scroll grid with a bounded error. When every tail section projects, the
//      scroll_speed/stop declarations past the playable pulse are discarded.
//   2. x(): stop-hidden pseudo-slam sections that could not move keep their
//      timing but lose the out-of-range head point (removedHeadPoints).
//
// Both passes rewrite chart.note.laser sections IN PLACE (same lane/index), so
// the writer emits relocated rows in original array order — not time order.

const GRAPH_STEP = 15; // control-point expansion step (pulses)
const EPS = 1e-7;
const MAX_POINTS = 1e5;
const MIN_ROUND = 1;

const approx = (a, b) => Math.abs(a - b) < EPS;
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const normValue = (v) => (Array.isArray(v) ? v : [v, v]);

// `d()` — is this head value an out-of-lane-range pseudo slam (-1 / 2)?
function headOutOfRange(value, width) {
	const n = (208 * value + 24) * width + (width === 1 ? 128 : 0);
	return n + 22 <= 0 || n - 22 >= 512;
}

// `m()` — KSON control-pair curve evaluation.
function curveValue(c0, c1, t) {
	if (c0 === c1) return t;
	const r = Math.sqrt(Math.max(0, c0 * c0 + t - 2 * c0 * t));
	const f = c0 < 0.25 ? (c0 - r) / (2 * c0 - 1) : t / (c0 + r);
	return 2 * (1 - f) * f * c1 + f * f;
}

// `h()` — parse + validate a graph (laser section points or scroll points).
function parseGraph(points) {
	if (!Array.isArray(points) || !points.length || points.length > MAX_POINTS) throw new Error("Invalid graph.");
	const out = points.map((pt) => {
		if (!Array.isArray(pt) || pt.length < 2 || pt.length > 3) throw new Error("Invalid graph point.");
		const [before, after] = normValue(pt[1]);
		const control = pt[2] || [0, 0];
		if (
			!Number.isSafeInteger(pt[0]) || pt[0] < 0 ||
			![before, after].every(Number.isFinite) ||
			(Array.isArray(pt[1]) && 2 !== pt[1].length) ||
			!Array.isArray(control) || control.length !== 2 ||
			control.some((c) => !Number.isFinite(c) || c < 0 || c > 1)
		) throw new Error("Invalid graph value.");
		return { pulse: pt[0], before, after, control };
	}).sort((a, b) => a.pulse - b.pulse);
	if (out.some((pt, i) => i && pt.pulse === out[i - 1].pulse)) throw new Error("Duplicate graph position.");
	return out;
}

// `p()` — insert explicit samples where a control curve leaves the linear path.
function expandGraph(graph) {
	const out = [];
	graph.forEach((pt, i) => {
		out.push({ ...pt });
		const next = graph[i + 1];
		if (next && pt.control[0] !== pt.control[1] && pt.after !== next.before)
			for (let pulse = pt.pulse + GRAPH_STEP; pulse < next.pulse; pulse += GRAPH_STEP) {
				if (out.length >= MAX_POINTS) throw new Error("Graph expansion is too large.");
				const v = pt.after + (next.before - pt.after) * curveValue(...pt.control, (pulse - pt.pulse) / (next.pulse - pt.pulse));
				out.push({ pulse, before: v, after: v, control: [0, 0] });
			}
	});
	return out;
}

// `f()` — binary search: last index whose arr[i][key] <= target.
function lastAtOrBefore(arr, target, key = "pulse") {
	let lo = 0, hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid][key] <= target) lo = mid + 1;
		else hi = mid;
	}
	return Math.max(0, lo - 1);
}

// `v()` — parse beat.stop into merged {start, end} windows.
function parseStops(stops) {
	if (!Array.isArray(stops)) throw new Error("Invalid stops.");
	const out = [];
	stops.map((row) => {
		if (!Array.isArray(row) || row.length !== 2 || row.some((v) => !Number.isSafeInteger(v) || v < 0))
			throw new Error("Invalid stop.");
		return { start: row[0], end: row[0] + row[1] };
	}).sort((a, b) => a.start - b.start).forEach((st) => {
		if (st.end === st.start) return;
		const last = out.at(-1);
		if (last && st.start <= last.end) last.end = Math.max(last.end, st.end);
		else out.push(st);
	});
	return out;
}

// `N()` — is this section a *judged* laser (real gameplay laser)?
function isJudgedSection(section, graph, bpmList) {
	if (graph.some((pt) => pt.before !== pt.after)) return true;
	const expanded = expandGraph(graph);
	return expanded.some((pt, i) => {
		const next = expanded[i + 1];
		if (!next) return false;
		const a = section[0] + pt.pulse;
		const b = section[0] + next.pulse;
		let bpm = bpmList[0][1];
		for (const row of bpmList) {
			if (row[0] > a) break;
			bpm = row[1];
		}
		const step = bpm >= 256 ? 120 : 60;
		return Math.ceil(a / step) * step < b;
	});
}

// `buildScrollGraph` — scroll speed as an accumulated-distance function `at()`.
function buildScrollGraph(scrollSpeed, stops, limit) {
	const authored = parseGraph(scrollSpeed || [[0, 1]]);
	const graph = expandGraph(authored);
	const stopObjs = parseStops(stops);
	if (graph[0].pulse !== 0) throw new Error("Scroll graph does not begin at zero.");
	const stopBps = stopObjs.flatMap((st) => [st.start, st.end]);
	const bp = [...new Set([0, limit, ...graph.map((pt) => pt.pulse), ...stopBps])]
		.filter((p) => p >= 0 && p <= limit).sort((a, b) => a - b);
	const spans = [];
	let distance = 0;
	for (let i = 0; i + 1 < bp.length; i++) {
		const from = bp[i], to = bp[i + 1];
		const idx = lastAtOrBefore(graph, from);
		const cur = graph[idx], next = graph[idx + 1];
		const speedAt = (x) => (next
			? cur.after + (next.before - cur.after) * (x - cur.pulse) / (next.pulse - cur.pulse)
			: cur.after);
		const frozen = stopObjs.some((st) => st.start <= from && st.end >= to);
		const a = frozen ? 0 : speedAt(from);
		const b = frozen ? 0 : speedAt(to);
		spans.push({ start: from, end: to, distance, a, b });
		distance += (a + b) * (to - from) / 2;
	}
	const at = (pulse) => {
		const span = spans[lastAtOrBefore(spans, pulse, "start")];
		const n = pulse - span.start;
		return span.distance + span.a * n + (span.b - span.a) * n * n / (2 * (span.end - span.start));
	};
	return { authored, graph, stops: stopObjs, spans, at };
}

// `g()` — invert at(): find the pulse inside [seg.start, seg.end] whose
// accumulated distance equals `target` (60 bisection iterations).
function invertDistance(T, seg, target) {
	let lo = seg.start, hi = seg.end;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (T.at(mid) < target) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

// `A()` — does the span chain over [from,to] carry one strictly-positive speed?
function uniformSpeed(T, from, to) {
	let known;
	for (const span of T.spans) {
		if (span.end <= from + EPS || span.start >= to - EPS) continue;
		if (!approx(span.a, span.b) || (known !== undefined && !approx(known, span.a))) return false;
		known = span.a;
	}
	return known !== undefined && known > 0;
}

// `b()` — rounding tolerance at a pulse: half the smaller distance step to the
// neighbouring pulses, floored at 1.
function roundTolerance(T, pulse) {
	const now = T.at(pulse);
	const steps = [];
	if (pulse >= 1) steps.push(Math.abs(now - T.at(pulse - 1)));
	if (pulse + 1 <= T.spans.at(-1).end) steps.push(Math.abs(T.at(pulse + 1) - now));
	return Math.max(MIN_ROUND, steps.length ? Math.min(...steps) / 2 : 0);
}

// `E()` — body window must never sample negative scroll-speed endpoints.
function nonNegativeBody(T, from, to) {
	return T.spans.every((span) => {
		if (span.end <= from || span.start >= to) return true;
		const speed = (x) => span.a + (span.b - span.a) * (x - span.start) / (span.end - span.start);
		return speed(Math.max(from, span.start)) >= 0 && speed(Math.min(to, span.end)) >= 0;
	});
}

// `S()` — would bridging [from,to] cross a laser audio-effect change or run
// through a flanger? (effect names resolve via def[].type, default peaking).
function crossesEffectBoundary(chart, from, to) {
	try {
		const laser = chart.audio?.audio_effect?.laser ?? chart.audio?.laser ?? {};
		const events = Object.entries(laser.pulse_event || {})
			.flatMap(([name, list]) => (Array.isArray(list) ? list.map((pulse) => ({ pulse: Number(pulse), name })) : []))
			.sort((a, b) => a.pulse - b.pulse);
		const paramPulses = Object.values(laser.param_change || {}).flatMap((params) =>
			Object.values(params || {}).flatMap((list) => (Array.isArray(list) ? list.map((entry) => Number(entry[0])) : [])));
		if ([...events.map((ev) => ev.pulse), ...paramPulses].some((p) => p > from && p < to)) return true;
		const active = events.filter((ev) => ev.pulse <= from).at(-1)?.name || "peaking_filter";
		const type = (laser.def || []).find((d) => d[0] === active)?.[1]?.type || active;
		return type === "flanger";
	} catch {
		return true;
	}
}

// `R()` — maximal forward (positive-speed) scroll stretches before `limit`,
// each carrying a distance range [first, last].
function forwardSegments(T, limit) {
	const out = [];
	let cur = null;
	for (const span of T.spans) {
		if (span.start >= limit) continue;
		const endPulse = Math.min(span.end, limit);
		const cuts = [span.start, endPulse];
		const slope = (span.b - span.a) / (span.end - span.start);
		if (slope) {
			const cross = span.start - span.a / slope;
			if (cross > span.start && cross < endPulse) cuts.splice(1, 0, cross);
		}
		for (let i = 0; i + 1 < cuts.length; i++) {
			const from = cuts[i], to = cuts[i + 1];
			const mid = span.a + slope * ((from + to) / 2 - span.start);
			if (mid <= 0) cur = null;
			else if (cur && approx(cur.end, from)) {
				cur.end = to;
				cur.last = T.at(to);
			} else {
				cur = { start: from, end: to, first: T.at(from), last: T.at(to) };
				out.push(cur);
			}
		}
	}
	return out;
}

// `y()` — the relocation pass. Returns {kson, decorations, lastPlayablePulse, warnings}.
function projectTails(chart) {
	const warnings = [];
	const decorations = [];
	const early = (lastPulse) => ({ kson: chart, decorations: [], lastPlayablePulse: lastPulse, warnings });
	if (!chart?.note?.laser || !chart.beat) return early(0);

	let sections, bpmList, lastPlayablePulse = 0;
	try {
		bpmList = (chart.beat.bpm || [[0, 120]]).map((row) => row.slice()).sort((a, b) => a[0] - b[0]);
		if (!bpmList.length || bpmList.some(([pos, val]) => !Number.isSafeInteger(pos) || pos < 0 || !Number.isFinite(val) || val <= 0))
			throw new Error("Invalid BPM.");
		sections = (chart.note.laser || []).flatMap((laneSections, lane) =>
			(laneSections || []).map((section, sectionIndex) => {
				if (!Array.isArray(section) || !Number.isSafeInteger(section[0]) || section[0] < 0)
					throw new Error("Invalid section.");
				const graph = parseGraph(section[1]);
				if (graph[0].pulse !== 0) throw new Error("Invalid section head.");
				const end = section[0] + graph.at(-1).pulse;
				const judged = isJudgedSection(section, graph, bpmList);
				if (judged) lastPlayablePulse = Math.max(lastPlayablePulse, end);
				return { section, sectionIndex, lane, graph, end, judged };
			}));
		for (const lane of ["bt", "fx"])
			for (const row of chart.note[lane] || [])
				for (const note of row) {
					const [start, dur] = typeof note === "number" ? [note, 0] : note;
					if (![start, dur].every((v) => Number.isSafeInteger(v) && v >= 0))
						throw new Error("Invalid button.");
					lastPlayablePulse = Math.max(lastPlayablePulse, start + dur);
				}
	} catch {
		return early(lastPlayablePulse);
	}

	const tail = sections.filter((s) => s.end > lastPlayablePulse);
	if (!tail.length || !lastPlayablePulse) return early(lastPlayablePulse);

	let scroll;
	try {
		const limit = Math.max(lastPlayablePulse + 1, ...sections.map((s) => s.end)) + 1;
		scroll = buildScrollGraph(chart.beat.scroll_speed, chart.beat.stop, limit);
	} catch {
		warnings.push("Decorative laser projection could not verify the scroll graph; its original timing was retained.");
		return early(lastPlayablePulse);
	}

	const maxPulse = lastPlayablePulse; // reference M
	const segments = forwardSegments(scroll, maxPulse); // reference R
	const projected = new Map(); // reference O
	let pointBudget = sections.reduce((sum, s) => sum + s.graph.length, 0); // reference I

	for (const item of tail) {
		const { section, graph } = item;
		const start = section[0];
		const head = graph[0];
		const second = graph[1];
		const width = section[2] ?? 1;
		const headStop = second && scroll.stops.find((st) => st.start <= start && st.end >= start + second.pulse);
		if (
			item.judged || start < lastPlayablePulse || !second || !headStop ||
			head.before !== head.after || ![1, 2].includes(width) || !headOutOfRange(head.after, width) ||
			graph.slice(1).some((pt) => pt.before !== pt.after || pt.after < 0 || pt.after > 1) ||
			!approx(scroll.at(start), scroll.at(start + second.pulse))
		) continue;

		// Body points (head dropped) and their scroll distances.
		const body = expandGraph(graph).filter((pt) => pt.pulse >= second.pulse);
		const distances = body.map((pt) => scroll.at(start + pt.pulse));
		if (
			distances.at(-1) <= distances[0] + EPS ||
			distances.some((v, i) => i && v < distances[i - 1] - EPS) ||
			!nonNegativeBody(scroll, start + second.pulse, item.end)
		) continue;

		// Exactly one forward gap must absorb the whole distance range.
		const targets = segments.filter((seg) => seg.first <= distances[0] + EPS && seg.last >= distances.at(-1) - EPS);
		if (targets.length !== 1) continue;
		const target = targets[0];
		const mapped = distances.map((d) => invertDistance(scroll, target, d)); // reference L
		let crossReverse = false; // reference D

		// Flat two-point section whose rounded tail misses the grid: try the
		// next forward gap for the end point only.
		if (body.length === 2 && body[0].after === body[1].after) {
			const t0 = Math.round(mapped[0]);
			const t1 = Math.round(mapped[1]);
			if (
				Math.abs(scroll.at(t0) - distances[0]) <= roundTolerance(scroll, t0) + EPS &&
				Math.abs(scroll.at(t1) - distances[1]) > roundTolerance(scroll, t1) + EPS
			) {
				const later = segments
					.filter((seg) => seg.start >= target.end && seg.first <= distances[1] + EPS && seg.last >= distances[1] - EPS)
					.at(-1);
				if (later) {
					const raw = invertDistance(scroll, later, distances[1]);
					const rounded = Math.round(raw);
					if (
						rounded > t0 && rounded <= maxPulse &&
						Math.abs(scroll.at(rounded) - distances[1]) <= roundTolerance(scroll, rounded) + EPS &&
						!crossesEffectBoundary(chart, t0, rounded)
					) {
						mapped[1] = raw;
						crossReverse = true;
					}
				}
			}
		}

		let maxError = 0; // reference K
		let roundingLimit = MIN_ROUND; // reference X
		let ok = true; // reference U
		const resampleNeeded = body.some((pt, i) => // reference G
			i && !approx(pt.after, body[i - 1].after) &&
			(!uniformSpeed(scroll, start + body[i - 1].pulse, start + pt.pulse) ||
				!uniformSpeed(scroll, mapped[i - 1], mapped[i])));

		const pairs = []; // reference B
		body.forEach((pt, i) => {
			const rounded = Math.round(mapped[i]);
			const error = Math.abs(scroll.at(rounded) - distances[i]);
			const tolerance = roundTolerance(scroll, rounded);
			maxError = Math.max(maxError, error);
			roundingLimit = Math.max(roundingLimit, tolerance);
			if (rounded < 0 || rounded > maxPulse || error > tolerance + EPS) {
				ok = false;
				return;
			}
			const last = pairs.at(-1);
			if (!last || last[0] !== rounded) pairs.push([rounded, pt.after]);
			else if (!approx(last[1], pt.after)) ok = false;
		});
		if (!ok || pairs.length < 2 || pairs.at(-1)[0] <= pairs[0][0]) continue;

		let finalPairs = pairs; // reference z
		if (resampleNeeded) {
			const from = pairs[0][0];
			const to = pairs.at(-1)[0];
			if (pointBudget + to - from + 1 - graph.length > MAX_POINTS) continue;
			const exact = new Map(pairs);
			const out = [];
			const sourceUniform = body.map((pt, i) => // reference o
				i + 1 < body.length && uniformSpeed(scroll, start + pt.pulse, start + body[i + 1].pulse));
			let cursor = 0; // reference s
			for (let pulse = from; pulse <= to; pulse++) {
				const wanted = Math.max(distances[0], Math.min(distances.at(-1), scroll.at(pulse)));
				while (cursor + 2 < body.length && distances[cursor + 1] < wanted) cursor++;
				const pa = body[cursor], pb = body[cursor + 1];
				const sourcePulse = sourceUniform[cursor]
					? start + pa.pulse + (pb.pulse - pa.pulse) * (wanted - distances[cursor]) / (distances[cursor + 1] - distances[cursor])
					: invertDistance(scroll, { start: start + pa.pulse, end: start + pb.pulse }, wanted);
				const value = exact.has(pulse)
					? exact.get(pulse)
					: pa.after + (pb.after - pa.after) * (sourcePulse - start - pa.pulse) / (pb.pulse - pa.pulse);
				out.push([pulse, value]);
			}
			finalPairs = out;
		}

		const newStart = finalPairs[0][0];
		const newEnd = finalPairs.at(-1)[0];
		const replacement = [newStart, finalPairs.map(([p, v]) => [p - newStart, v])];
		if (section[2] !== undefined) replacement.push(section[2]);
		projected.set(item, replacement);
		pointBudget += finalPairs.length - graph.length;
		decorations.push({
			lane: item.lane,
			sectionIndex: item.sectionIndex,
			sourceStart: start,
			sourceEnd: item.end,
			projectedStart: newStart,
			projectedEnd: newEnd,
			width,
			maximumScrollError: maxError,
			removedHeadPoints: 1,
			...(roundingLimit > MIN_ROUND ? { scrollRoundingLimit: roundingLimit } : {}),
			...(resampleNeeded ? { resampledBody: true } : {}),
			...(crossReverse ? { projectionAcrossReverse: true } : {}),
		});
	}

	if (projected.size !== tail.length)
		warnings.push("Some tail artwork retains its original body timing because no unambiguous, grid-accurate earlier projection was found; future scroll declarations were retained.");
	if (!projected.size) return early(lastPlayablePulse);

	const out = cloneJson(chart);
	for (const [item, replacement] of projected) out.note.laser[item.lane][item.sectionIndex] = replacement;
	if (projected.size === tail.length) {
		// Everything moved out of the tail: the future scroll/stop declarations
		// no longer describe any note and are cut back to the playable pulse.
		const reauthored = reauthorScroll(scroll, lastPlayablePulse);
		if (reauthored) out.beat.scroll_speed = reauthored;
		if (out.beat.stop) {
			out.beat.stop = scroll.stops
				.filter((st) => st.start < lastPlayablePulse)
				.map((st) => [st.start, Math.min(st.end, lastPlayablePulse) - st.start]);
		}
	}
	warnings.push(`Projected ${decorations.length} nonjudged decorative laser sections into their earlier scroll positions; timing rounding is bounded by the destination scroll grid.`);
	return { kson: out, decorations, lastPlayablePulse, warnings };
}

// Rebuild scroll_speed up to `limit` (authored prefix + expanded samples +
// interpolated endpoint), dropping every future declaration.
function reauthorScroll(scroll, limit) {
	const { authored, graph } = scroll;
	if (authored.at(-1).pulse <= limit) return null;
	const idx = lastAtOrBefore(authored, limit);
	const anchor = authored[idx];
	const rows = authored.slice(0, idx).map((pt) => [
		pt.pulse,
		pt.before === pt.after ? pt.after : [pt.before, pt.after],
		pt.control.slice(),
	]);
	const inRange = graph.filter((pt) => pt.pulse >= anchor.pulse && pt.pulse <= limit);
	for (const pt of inRange) rows.push([pt.pulse, pt.before === pt.after ? pt.after : [pt.before, pt.after]]);
	if (inRange.at(-1)?.pulse !== limit) {
		const cur = graph[lastAtOrBefore(graph, limit)];
		const next = graph[lastAtOrBefore(graph, limit) + 1];
		rows.push([limit, next
			? cur.after + (next.before - cur.after) * (limit - cur.pulse) / (next.pulse - cur.pulse)
			: cur.after]);
	}
	return rows;
}

// `x()` — stop-hidden pass: sections still parked under a stop lose their
// out-of-range head point in place (timing kept).
function dropStopHiddenHeads(state) {
	if (!state.lastPlayablePulse || !state.kson?.beat?.stop?.length) return state;
	let stops, bpmList;
	try {
		stops = parseStops(state.kson.beat.stop);
		bpmList = (state.kson.beat.bpm || [[0, 120]]).map((row) => row.slice()).sort((a, b) => a[0] - b[0]);
		if (!bpmList.length || bpmList.some(([pos, val]) => !Number.isSafeInteger(pos) || pos < 0 || !Number.isFinite(val) || val <= 0))
			return state;
	} catch {
		return state;
	}

	let working = state.kson;
	const decorations = state.decorations.slice();
	for (const [lane, laneSections] of (state.kson.note?.laser || []).entries()) {
		if (!Array.isArray(laneSections)) continue;
		for (const [index, section] of laneSections.entries()) {
			try {
				const [start, points, width = 1] = section;
				const graph = parseGraph(points);
				const head = graph[0];
				const second = graph[1];
				const end = start + graph.at(-1).pulse;
				if (
					!Number.isSafeInteger(start) || start < 0 || ![1, 2].includes(width) ||
					graph.length < 3 || head.pulse !== 0 || head.before !== head.after ||
					!headOutOfRange(head.after, width) ||
					graph.slice(1).some((pt) => pt.before !== pt.after || pt.after < 0 || pt.after > 1) ||
					!stops.some((st) => st.start <= start && st.end >= start + second.pulse) ||
					isJudgedSection(section, graph, bpmList)
				) continue;
				if (working === state.kson) working = cloneJson(state.kson);
				const replacement = cloneJson(section);
				replacement[0] = start + second.pulse;
				replacement[1] = points.slice()
					.sort((a, b) => a[0] - b[0])
					.slice(1)
					.map((pt) => [pt[0] - second.pulse, ...pt.slice(1)]);
				working.note.laser[lane][index] = replacement;
				decorations.push({
					lane,
					sectionIndex: index,
					sourceStart: start,
					sourceEnd: end,
					projectedStart: replacement[0],
					projectedEnd: end,
					width,
					maximumScrollError: 0,
					removedHeadPoints: 1,
					...(end > state.lastPlayablePulse ? { retainedBodyTiming: true } : {}),
				});
			} catch {
				// A malformed section simply skips this pass for that entry.
			}
		}
	}
	if (working === state.kson) return state;

	const added = decorations.slice(state.decorations.length);
	const retained = added.filter((d) => d.retainedBodyTiming).length;
	const warnings = [...state.warnings];
	if (added.length > retained)
		warnings.push(`Removed ${added.length - retained} stop-hidden entries from nonjudged in-song laser artwork; visible body timing and original KSON source are preserved.`);
	if (retained)
		warnings.push(`Removed ${retained} stop-hidden entries from nonjudged tail artwork while retaining its original visible body timing and future scroll declarations; no safe earlier projection was found.`);
	return { ...state, kson: working, decorations, warnings };
}

/**
 * Run both projection passes over a KSON chart.
 * Returns {chart, decorations} — the input object when nothing changed,
 * otherwise a rewritten deep clone — plus reporter warnings for every
 * emitted message. `decorations` lists every rewritten section
 * ({lane, sectionIndex, ...}) so the writer can flag its rows.
 */
export function projectTailDecorations(chart, warn = () => {}) {
	const result = dropStopHiddenHeads(projectTails(chart));
	for (const message of result.warnings) warn(message);
	return { chart: result.kson, decorations: result.decorations };
}
