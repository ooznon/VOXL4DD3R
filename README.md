# VOXL4DD3R

KSH / KSON → SOUND VOLTEX **VOX v13** converter (formerly *KSON2VOX*). Node.js,
zero runtime
dependencies, no build step. The output dialect targets byte-level parity with
the **sdvxindex.com editor's** Import → Export VOX pipeline (`f_000011.js`
module 99561 `F` writer and friends).

## Quick start

```powershell
# KSH (Shift-JIS or UTF-8 with BOM)
node src\cli.js "C:\path\to\chart.ksh"

# KSON
node src\cli.js "C:\path\to\chart.kson"

# explicit output path
node src\cli.js "C:\path\to\chart.ksh" "C:\path\to\output.vox"
```

The default output is written beside the input as `chart.vox`. In VS Code,
select **Run and Debug → Convert KSON to VOX** for the interactive prompt.

Diagnostics (camera approximations, native DSP fallbacks, dropped KSH lasers)
are printed after the conversion summary line.

## Validation / parity status

| Benchmark | Input | Reference | Result |
| --- | --- | --- | --- |
| `testdata/poly.ksh` | KSH (polyriddim) | live editor export (47,601 B) | **byte-identical** |
| `stresstest-short/mxm.ksh` | KSH (stress test) | live editor export (190,419 B) | **byte-identical** |
| `testdata/oracle.kson` | KSON | live editor export | byte-identical (golden) |
| `testdata/curve-scroll.kson` | KSON | live editor export | byte-identical (golden) |
| local corpus | 28 charts | conversion succeeds | 28 ok / 0 failed |
| ksm.dev corpus | 14 charts | conversion succeeds | 14 ok / 0 failed |

“Byte-identical” means a full-file byte comparison of our VOX against the
editor's own **Export VOX** of the same imported chart, with the *Preserve
KSON data in VOX* option off.

## What is implemented

### Output dialect (v13)

- Exact section order: `FORMAT VERSION`, `BEAT RESOLUTION` (240), `BEAT INFO`,
  `BPM INFO`, `TILT MODE INFO`, `END POSITION`, `TAB EFFECT INFO`,
  `FXBUTTON EFFECT INFO`, `TAB PARAM ASSIGN INFO`, `TRACK1–8`, `SPCONTROLER`,
  `LYRIC INFO`, `REVERB EFFECT PARAM`, `TRACK AUTO TAB`, `TRACK ORIGINAL L/R`,
  including the reference's extra blank line after `SPCONTROLER`.
- Positions as `MMM,BB,TT`; `END POSITION` on the measure boundary after the
  last playable pulse — max BT/FX end, *judged* laser end (slam or on-grid
  point; nonjudged decorative tail sections are excluded) and the scroll
  timeline clipped at that pulse (reference `lastPlayablePulse` rule).

### Notes and effects

- BT/FX chips and holds → `TRACK3–6` (BT-A…D), `TRACK2/7` (FX-L/R), lasers →
  `TRACK1/8` (LD-L/R); `TRACK ORIGINAL L/R` carry key points only with all
  curve-type fields zeroed.
- FX preset pairs are allocated lazily as `[FX-L, FX-R]` rows, content-hashed,
  with two `TAB PARAM ASSIGN INFO` rows per pair.
- Hold effect events resolve only from events **inside** the hold range (an
  explicit effect on the note acts at the hold start); unmatched holds keep
  effect id `0`. Flanger holds split at time-signature changes.
- KSON `key_sound` chip samples map to VOX sample ids `200+` in insertion
  order; unknown sample names fall back to id `0` with a warning.
- KSON effects map onto the native VOX DSP (equalizer, bitcrusher, flanger,
  tape stop, …) with validated parameters; unsupported definitions fall back
  safely and the KSON source stays intact.

### Lasers

- 11-field rows `[pos, value, seg, spin, filter, wide, flag, ct, mode,
  spinDur, extra]`; slams emit a from-row plus a to-row; a lone row in a
  section is duplicated, and `seg` is positional (first `1`, last `2`,
  otherwise `0`).
- Curved segments are sampled every 15 pulses (64th notes) **plus** the
  chart's laser control pulses (BPM + laser audio-effect pulse/param positions)
  strictly inside the segment — no value dedup.
- Curve-type rule follows the reference `p` semantics: a curved, moving
  outgoing segment marks its non-slam from-row, its slam to-row and its
  samples `ct=2`.
- KSON quadratic Bézier curves evaluate through the reference's closed-form
  solve (`O`/`A`), so 6dp / 12-significant-digit formatting lands on the same
  side of every rounding straddle.

### Camera and timing

- `zoom_top` / `zoom_bottom` → `CAM_RotX` / `CAM_Radi` via the reference
  projection (`y()`), chord-fitted per joint span: BPM-split sub-intervals,
  recursive worst-segment bisection up to 64 chords per span, tolerance
  `max(0.02°, 0.1% of the span)`.
- `center_split` → `Morphing2` (absolute error 0.002), with the reference's
  anchor rules at joints and instant jumps.
- `rotation_deg` + numeric/string `tilt` + `zoom_side` → combined `BIL_RotZ`.
  `zoom_side` rolls through the reference `ZX` fit (judgment-line roll, ±540°
  clamp) with its exact warnings.
- Slam spin patterns are fit to the native duration/type grid (reference spin
  fit, RMS over the critical sample set) and stamped on the laser rows with
  `// KSON camera.cam.pattern.laser.slam_event.*` comments.
- Manual speed uses the reference step set (scroll points, BPM positions,
  stop endpoints, per-pulse fill where values change) with stop masking,
  value dedup, the float32-clock fit for extreme jumps, and the reference
  terminal-slam jump delay (`d.G`): an isolated slam at a laser section's
  terminal slam is moved ~0.1 s into the following empty interval and its
  distance recovered at the resume step. Tilt rows follow the reference too.
- Time signatures, BPM changes, and `END POSITION` follow the KSON timeline.

### KSH input (`src/ksh-parser.js`)

- Faithful port of the editor's KSH → KSON parser (`f_000012`), proven
  structurally identical to the editor's own KSON export.
- Byte decoding: UTF-8 **with BOM**, otherwise strict Shift-JIS (invalid
  byte pairs raise an error instead of producing mojibake).
- Measure/row truncation, slams (30-pulse collapse), spins, effect
  definitions, `#define_fx`/`#define_filter`, and per-row option groups are
  all handled; unrecognized fields are retained under `compat.ksh_unknown`.
- A KSH laser with fewer than two position points is dropped with a warning.

## Tests

```powershell
node --test
```

(Equivalent to `npm test`; `node --test` is used directly here because
`npm.ps1` is blocked by the current PowerShell execution policy.)

28 tests:

- `test/converter.test.js` (23) — dialect structure, golden byte parity
  (oracle + curve-scroll vs live-editor exports), lasers/slams/spins, speed
  and stop emission, FX presets and holds, timeline, effect mapping,
  formatters, edge cases.
- `test/ksh-parser.test.js` (5) — Shift-JIS/BOM decoding, full `poly.ksh`
  parse structure, **poly.ksh → VOX byte parity** against
  `testdata/poly.golden.vox` (the live-editor export), short-laser drop,
  malformed input errors.

## Known limitations

- Camera output is approximate **by design**, exactly like the reference
  editor: bounded linear chords, combined `BIL_RotZ` for tilt + rotation,
  and `zoom_side` fitted to a roll angle (source timing, direction and values
  are preserved; the original KSON should be kept for exact recovery).
- Curved lasers play back on VOX's 64th-note sample grid.
- Effect algorithms are the native VOX DSP: phaser and sidechain have no
  verified parameter mapping (the KSON definition is preserved), tape stop and
  KSM wobble approximate their KSON shapes.
- Nonjudged decorative laser tail sections (beyond the last playable pulse)
  are kept at their source timing while the reference *relocates* them into
  earlier gaps; the scroll/stop/`END POSITION` clip already matches.
- Laser rows keep the reference's key-point structure, but per-control-pulse
  interpolation rows and the per-pulse effect-index column are not yet
  replicated (the reference samples laser audio-effect curves into both).
- Laser audio effects are not yet written to `TAB EFFECT INFO`,
  `TAB PARAM ASSIGN INFO` or `TRACK AUTO TAB`, and their FX presets are not
  expanded into `FXBUTTON EFFECT INFO`.
- UTF-8 KSH files require a BOM.

## Reference material

- sdvxindex.com editor (the byte-parity oracle)
- [kshootmania/ksm-v2](https://github.com/kshootmania/ksm-v2) — official
  KSH/KSON reference
- [SirusDoma/VoxCharger](https://github.com/SirusDoma/VoxCharger),
  [silverhawke249/pyKSH-exporter](https://github.com/silverhawke249/pyKSH-exporter)
  — VOX writer references
