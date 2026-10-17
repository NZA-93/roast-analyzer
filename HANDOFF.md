# Handoff: tester, feedback loop, calibration (17 Oct 2026, 11:45 CEST)

Branch `wip/tester-calibration`. It sits one commit ahead of `main` (`cd33cfb`).

**Heads-up:** the tester and feedback-loop commit `cd33cfb` went to `main` **before** the instruction to keep this work off main. Pages has already built it, so it is live at https://nza-93.github.io/roast-analyzer/. Nothing has been force-pushed or reverted. If it should come off main, revert `cd33cfb` there (a normal revert, no history rewrite).

## Done (on main, live)
- **Test detection mode** (`docs/js/tester.js`, UI in `docs/index.html`, styles at the end of `docs/css/style.css`).
  - Tools: ＋ Missed, ✕ Not a bean (reason: crumb/gap/glare/other), ⧉ Merged (n beans), ÷ Split, 🎨 Band, ▭ Area (optional review rectangle). Undo and Reset.
  - Live precision, recall, F1, count error and band agreement are computed against the corrections.
  - Corrections are stored per image SHA-256 in localStorage under `ra-gt:<sha>`. Export and import are JSON.
  - **Submit feedback** copies the JSON, then opens a prefilled issue with the label `detector-feedback`. A body longer than about 7k characters is sent as a gzip+base64 block (```` ```roastgt-gz ````). If even that is too long, the JSON is downloaded and the user pastes it.
  - Tested headless on a mobile viewport (390×844): tools work, metrics update, export and submit work, no console errors.
- **Ground-truth format and scoring** (`docs/js/evaluate.js`): schema `roast-analyzer/ground-truth@1`. Truth entries are compact `[x,y]` or `[x,y,{band,group}]`. Corrections reference beans by centre point, not id, so they survive detector changes. Matching is greedy one-to-one within 1.0 × the bean radius (1.6 × for merged groups). The page and Node use the same code.
- **Seed ground truth:** `feedback/sample1-tile-seed-2026-10-17.json` covers the central tile of sample 1 (x 640–970, y 440–790). It holds 83 true beans: 2 split fragments removed and 2 missed pale beans added, hand-audited at 3× zoom. One annotator, bootstrapped from detector output, so it is biased toward the detector.
- **Benchmark/tuner** (`tools/benchmark.mjs`):
  - Evaluates `docs/params.json` against `feedback/*.json` (images are found by hash in `docs/demo/` or `feedback/images/`).
  - `--tune` runs coordinate descent over `TUNABLE` and only ships a gain of at least +0.005 F1.
  - Stability guard on the unlabeled demo photos.
  - Writes `docs/params.json`, `docs/metrics/history.json` and `docs/changelog.json`.
  - `--ci` exits 1 if F1 drops more than 0.01 against the last history entry on the same ground-truth fingerprint.
  - The page loads `params.json` and shows the detector version, benchmark F1 and changelog.
- **Current benchmark:** v1.1.0, F1 / precision / recall 0.9759, count error 0 on 83 beans (1 photo). Tuning found no gain, which is expected because the seed was bootstrapped from these parameters.
- **Issue ingestion** (`tools/issue-to-feedback.mjs`): parses the json or gz block, validates the schema, downloads an attached photo when it is not already in the repo, and writes `feedback/issue-N.json`. Tested end to end on a simulated issue built from the page's real prefilled URL.
- Labels `detector-feedback` and `calibration-profile` exist in the repo.

## Half-done
1. **GitHub Actions are not active.** The box's gh token has no `workflow` scope, so the workflows are staged in `ci/workflows/` (`benchmark.yml`, `feedback-issue.yml`; see `ci/README.md`). Someone with workflow scope needs to `git mv ci/workflows/*.yml .github/workflows/`. Then check that Pages rebuilds after the bot commits (pushes made with GITHUB_TOKEN may not trigger a legacy Pages build; if they don't, switch Pages to an Actions deploy).
2. **Stability-guard change (this branch, uncommitted on main):** `tools/benchmark.mjs` used to reject any tune that moved the demo bean count by more than 10%. That blocked legitimate feedback. In the synthetic loop test, tuning took F1 from 0.83 to 0.99 and was still rejected (1903→1617). The new rule rejects a tune only when the swing differs by more than 10 percentage points from the count change the ground truth asks for. **Not yet re-run:** I stopped `tools/loop-test.mjs` mid-run.
3. **`tools/loop-test.mjs`** builds synthetic feedback (truth = detector with `nmsRadius 1.15, bodySigma 0.5`), runs `benchmark.mjs --tune --dry` and asserts the F1 improves. It still has to pass with the new guard (about 75 s locally). After that, consider adding it to CI.
4. **Benchmark data is thin:** 1 tile, 83 beans. Get Nicolò to review 2–3 more tiles, including edge and pale-bean areas, on samples 2–4 before trusting the tuning.

## Not started: calibration (requested scope)
1. **Card detection** (planned `docs/js/colorcal.js`, called in `worker.js` before `analyzeImage`):
   - Find flat, uniform, near-square regions on a 1/4-scale image and cluster them by size.
   - Estimate the lattice vectors u and v from the nearest-neighbour vectors, then fit a 4×6 window with at least 16 hits.
   - Sample the 24 patch medians and pick the orientation (4 rotations, or 8 including transposes) with the lowest residual of a least-squares 3×3 CCM, in linear RGB, against the ColorChecker sRGB references.
   - Accept the card only if the mean ΔE after CCM is below about 8 and the grey row is monotonic.
   - Grey card: a large, flat, low-chroma region with L* between 25 and 75 that is not the plate. It gives diagonal gains to 18% reflectance.
   - Fallback: the existing plate white balance plus flat-field.
2. **Analyzer hook:** add `opts.ccm`. Keep the plate plane only for the spatial fall-off: normalise to the plate value at the centre instead of the 0.80 reference, then apply the CCM before the Lab conversion. Return the raw plate stats (linear RGB at the plate centre) for drift checks. Record `mode: 'card' | 'grey' | 'plate'`.
3. **Calibrate flow:**
   - Shoot 5–6 reference lots with known Agtron, enter the values, and use each photo's median L*.
   - Fit a monotonic curve: PAV isotonic regression, then piecewise-linear with linear end extrapolation. Show the RMSE and leave-one-out RMSE in Agtron.
   - Save it as a named profile (`{name, mode, points, knots, refStats}`) in localStorage, with export/import.
   - Submit it through an issue with the `calibration-profile` label, and extend `issue-to-feedback.mjs` to write `calibration/<name>.json`.
   - `agtronFromL` must accept `cal.knots`.
4. **Drift warnings:** compare each new photo's raw plate exposure (warn above ±0.3 EV) and white balance (R/G and B/G, warn above 5%) with the profile's `refStats`. Also warn when the colour mode differs (for example, card missing).
5. **`docs/CALIBRATION.md`:** Nicolò's setup is a fixed LED light and position, and an iPad.
   - Use Halide or ProCamera with exposure, white balance and focus locked.
   - Shoot RAW (or ProRAW); no HDR, no flash, no Night mode.
   - Matte, non-glossy background; plate in the same spot each time.
   - ColorChecker or grey card always in frame, beside the plate and not shadowed.
   - Recheck monthly, and whenever the light, device or app changes, by re-shooting one reference lot.
6. **Test idea:** composite a synthetic ColorChecker onto a demo photo with a known colour cast and exposure shift. Check that the card is detected and that the bean L* matches the uncast photo to within about 1.
