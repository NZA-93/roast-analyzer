# ☕ Roast Analyzer

Bean-by-bean roast colour analysis from phone photos, 100% client-side.

**Live app:** https://nza-93.github.io/roast-analyzer/ · **Demo batch:** https://nza-93.github.io/roast-analyzer/?demo

Put roasted beans in one layer on a white plate, take a photo from above, and the app:

1. finds the plate and uses it as the **white reference** (white balance + planar flat-field),
2. segments every **individual bean**, including touching ones (distance transform + "bean body" markers + marker-controlled watershed, fragment merge / blob split), and rejects crumbs and plate-edge pieces,
3. measures a **robust colour per bean**: median CIELAB of the bean interior, excluding the centre crease (darkest 15%) and specular highlights (brightest 8%),
4. removes any **lighting gradient** across the photo (planar detrend of bean colour vs. position; beans are spread at random, so a trend is lighting),
5. converts L* to an **Agtron-like roast index** (two-point calibration, see below) and SCA-style bands: Green/Yellow, Cinnamon, Light, City, City+, Full City, Vienna, French,
6. shows a **roast map** (L* vs b*, band strips), **histogram**, mean / SD / uniformity, **outliers** (quakers, underdeveloped, scorched), a clickable **overlay** coloured by band,
7. merges several photos into **one batch report** with per-sample stats and a sample-to-sample consistency check, and exports **CSV / JSON**.

## Reference batch — 17 Oct 2026

4 independent samples = 100% of the morning popper roast (`docs/demo/`, resized to 1600 px). Precomputed report: [`docs/reports/2026-10-17.json`](docs/reports/2026-10-17.json), summary in [`docs/reports/2026-10-17.md`](docs/reports/2026-10-17.md).

## Calibration (read this)

The Agtron-like number is **not** an Agtron reading. Default mapping is a provisional straight line (L* 45 → 65, L* 55 → 80). Calibrate with two lots of known Agtron value photographed with the same phone, plate and light; enter their mean L* in the Calibration panel (stored on your device). See [`docs/CRITIQUE.md`](docs/CRITIQUE.md) for the full calibration path and known limitations.

## Code

- `docs/js/analyzer.js` — the algorithm (pure JS, no dependencies; runs in browser and Node)
- `docs/js/worker.js` — runs the analysis off the UI thread
- `docs/js/app.js`, `docs/index.html`, `docs/css/style.css` — UI
- `tools/run.mjs` — command-line batch run in Node (`cd tools && npm i && node run.mjs ../docs/demo/*.jpg`)

## Swipe review (ground truth in ~1 minute)

After loading photos, tap **👆 Check the detector**. You get one bean card at a time: swipe right if it's correct, left if it's wrong (then tap one reason chip, or wait 2 s), up to skip. Undo is top-left. Then 4 zoomed gap tiles follow, one per screen. Tap any missed bean, or tap **None ✓**. Misses are scaled up by the share of the plate's gap area that was reviewed.

- Cards: 70% targeted (low detector confidence, unusual size, colour outliers) and 30% random, each tagged. Precision is reported from the random answers only.
- Answers are kept on the device (`localStorage` outbox) and POSTed to `FEEDBACK_ENDPOINT` in `docs/js/config.js` with automatic retry. Until that's set, use **Export answers**.
- `docs/js/swipe-core.js` turns a batch into `roast-analyzer/ground-truth@1` files (scope = reviewed beans only). "Wrong colour" is a flag stored with raw L* and glare, never a band label.
- The `worker/` Cloudflare Worker validates batches and commits them to `feedback/` (not deployed yet; see `worker/README.md`).
- Swipe batches score precision from the random cards, and recall over the whole plate (detections × precision vs estimated misses). They never compute count error.
- Tests: `cd tools && npm test` (fast), plus `npm run test:bench` (about 3 min; covers the biased-file skip and the per-photo holdout). Browser end-to-end check: `node tools/swipe-e2e.mjs` with `docs/` served on :8765.
