# Calibration implementation spec

For: **Bean Vision Developer**. Scope: `docs/js/analyzer.js`, `docs/js/app.js`, `docs/index.html`. Delivered in stages; each stage should ship on its own with tests in `tools/`.

## Current state (as of `cd33cfb`)

- Input: `<input type="file" accept="image/*">` → `createImageBitmap` → canvas resize → `getImageData` (8-bit sRGB). No RAW path.
- White reference: plate detected (bright, low-saturation, `max > 140`), planar flat-field per channel in linear RGB, normalised to an **assumed plate reflectance `ref = 0.80`** (L* ≈ 91.7).
- Colour: correct sRGB linearisation and sRGB/D65 → XYZ → CIELAB. No colour card, no CCM.
- Mapping: two-point linear `agtronFromL`, default provisional `{L1:45, A1:65, L2:55, A2:80}`; one unnamed `localStorage['roastCal']`.
- No fit error, profiles, or drift warnings.

## S1: N-point monotonic L* → Agtron fit

- Input: N ≥ 2 reference points `{L, agtron, name, n, sdL}` (5–6 is the target).
- Fit: monotone non-decreasing in L*. Use **isotonic regression** (PAVA) followed by **monotone PCHIP** (Fritsch–Carlson) interpolation through the pooled points. With N = 2 it reduces to the current straight line.
- Error: **leave-one-out** error in Agtron units (RMSE and max |error|), stored with the fit and shown in the UI.
- Range: outside `[min L*, max L*]` of the references, **clamp** to the end values and show a **warning** ("outside calibrated range") on that bean, sample and batch.
- Labels: with no user references (provisional default), every Agtron value and band is labelled **"uncalibrated estimate"**.
- Tests: monotonicity for random point sets; N = 2 equals the current line; known LOO values on a fixture.

## S2: Named profiles

- Stored in `localStorage` (e.g. `roastProfiles` = array, plus `activeProfile` id). Migrate an existing `roastCal` into a profile named "Legacy two-point".
- Profile schema:
  ```json
  { "id": "uuid", "name": "LED desk, iPad", "date": "ISO-8601", "device": "iPad …", "light": "LED …",
    "refs": [{ "name": "", "L": 0, "agtron": 0, "n": 0, "sdL": 0 }],
    "fit": { "method": "isotonic+pchip", "looRmse": 0, "looMax": 0, "Lmin": 0, "Lmax": 0 },
    "plateBaseline": { "rawRGB": [0,0,0], "wbGains": [0,0,0] },
    "cardBaseline": null, "algoVersion": "1.1" }
  ```
- UI: create, rename, select, delete; **JSON export/import** (validate the schema and reject unknown versions with a clear message).
- The export JSON report includes the active profile.

## S3: Drift warnings

- From each image, record the **raw plate level** (linear RGB of the fitted plane at the centre, before normalisation) and the **WB gains** (`ref / fit[ch][0]`).
- Warn when either deviates from the profile's `plateBaseline` beyond a threshold (start at ±5% for level, ±3% for any gain ratio; tune on real data). Show the warning on the sample and in the batch summary; never silently correct.
- Later (with S4): warn when the card's neutral patches give **ΔE00 > 3** against their reference values.

## S4: Card detection and a per-image CCM

- Detect a ColorChecker (24-patch) or a grey card in frame; sample patch medians in **linear sRGB**, avoiding the edges.
- Fit a **3×3 CCM** (least squares, optionally weighted to the neutrals) from the measured patches to the reference values in linear sRGB (D65), per image; apply it before the Lab conversion.
- Fallback: if no card is found or the fit fails acceptance, use the current plate path and flag the image "plate-only".
- Acceptance on the patches: **mean ΔE00 ≤ 2 and max ΔE00 ≤ 4**; otherwise fall back and warn.
- With a card, the absolute white comes from the card, which **replaces the `ref = 0.80` assumption**; the plate is still used for flat-field (spatial falloff).
- Store the card neutrals in `cardBaseline` for S3.

## Small fixes

1. **P3 decode:** request an sRGB canvas explicitly (`getContext('2d', { colorSpace: 'srgb' })`) and detect Display P3 or HDR (gain-map) inputs; warn or convert deliberately rather than relying on browser defaults.
2. **Linear resize:** downscale in linear light (or sample at full resolution) instead of `drawImage` averaging in gamma-encoded space.
3. **Plate threshold under locked exposure:** replace the fixed `max > 140` with a relative threshold (e.g. a high percentile of image brightness) so a darker locked exposure still finds the plate.
4. **Calibration L\*:** use each bean's L* **before** the spatial detrend (`Lraw`) for reference points and for the fit input, or apply the detrend identically in both; document which one.

## Swipe-feedback colour rules

- Colour feedback is a **flag**, not a label: "Wrong colour" records the bean id, its **raw L\*** (pre-detrend), a\*, b\*, and a **glare score** (e.g. fraction of near-clipped or specular pixels in the bean). It **never** records or suggests a band label.
- Colour flags never adjust the detector's segmentation params; they feed calibration and drift review only.
- Band labels come only from the fitted mapping of the active profile.
