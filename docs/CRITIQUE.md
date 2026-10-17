# Critic passes (17 Oct 2026)

Three separate reviews of the first working build, plus the fixes made.

## (a) Computer-vision critic: segmentation

**Manual count check (sample 1).** I counted beans by hand in a central 330 × 350 px tile of `sample1.jpg` (x 640–970, y 440–790; ~16% of the pile; counted in 4 horizontal strips, a bean belongs to the tile if its centre is inside). Manual count: **≈ 80 (±2, because some beans at the edge are ambiguous)**. Detected: **83**, so **+4%**, within the ±5% target. Earlier builds gave 74 (−7%) and 76 (−5%) on the same tile. Whole photo: 500 detected. Across the other 8 tiles of sample 1, a visual audit found about 1–3 misses or doubles per ~55 beans.

Findings and fixes:
1. *Distance transform alone under-splits a dense layer*, because touching beans leave almost no white between them. **Fix:** markers come from the distance transform plus a blurred "bean body" lightness map (σ = 0.42 × bean half-width), with non-max suppression at 0.85 × the half-width, then a watershed on that surface.
2. *Hole filling was swallowing the gaps between beans.* **Fix:** only tiny holes (specular highlights) are filled.
3. *Dark beans were dropped by the chroma rule, and contact shadows merged beans under a lightness rule.* **Fix:** a pixel counts as bean if it is saturated brown, or if it is dark **and** wide (a morphological opening removes thin contact shadows).
4. *Over-split fragments and merged blobs.* **Fix:** fragments under 0.5 × the median area merge into the neighbour they share the most boundary with. Blobs over 1.8 × the median area are split with k-means on pixel coordinates.
5. *Pale beans were rejected as "plate glare"* (bias against quakers!). **Fix:** glare rejection now also requires low chroma.
6. *There is a lighting gradient across every photo*: bean L* falls by ~20–30 units from top to bottom of the frame, and the plate-based flat-field did not remove it. **Fix:** a planar detrend of bean colour against position (the beans are spread at random, so any trend is lighting, not roast). The fitted trend is reported in `params.lightingTrend`.
7. Remaining: beans tilted on edge or heavily overlapped are sometimes split or merged. Crumbs under 0.3 × the median area are rejected and listed. The plate rim (3.5% of the plate radius) is excluded.

## (b) Roast-science critic: what the number means

- **The Agtron-like value is an estimate, not a measurement.** Agtron/Lighttells meters measure near-infrared reflectance, usually of *ground* coffee under controlled light. A phone measures visible surface colour of *whole* beans, through a tone curve, auto-exposure, HDR and sharpening. Whole-bean and ground readings differ, and more so for light roasts where the inside is lighter than the surface. The default mapping (L* 45 → 65, L* 55 → 80, linear) is provisional, and the band names should be read as **indicative**.
- **Spread is partly real and partly measurement.** The batch SD is about 8.6 L* (≈13 Agtron-like points). Contact sheets of the flagged beans show genuinely paler and darker beans, which fits a popper roast. Bean orientation (crease up or flat side up) and 3-D shading also add noise. So uniformity "±5" (31%) is a strict number. Use it to compare roasts with each other, not as an absolute grade.
- **Outliers** are flagged only if they are both statistically unusual (robust z) **and** at least 2 bands (20 points) away from the median. Quakers additionally need to be yellower or lower in chroma. Confirm them by eye: the app shows each one on the photo.
- **Calibration path:**
  1. Fix the setup: same plate, same spot, daylight or one fixed lamp, no flash. Lock exposure and white balance if your camera app allows it, and turn HDR off.
  2. Get 2–3 reference lots with known Agtron (whole bean, ideally also ground). Use a roaster's lot sheets, or borrow a meter (Lighttells CM-100, Agtron E10, DiFluid Omni) for one session.
  3. Photograph each lot with this app and note the mean L* (shown on the card).
  4. Enter two (L*, Agtron) points in the Calibration panel. With three or more lots, check the line fits; if it doesn't, fit separately for light and dark roasts.
  5. Recheck every few months, or when the light or phone changes. A colour checker card in the frame is a cheap way to catch drift.
  6. For your own popper, the most useful number is the **trend across your roasts** (same setup), even before calibration.

## (c) UX critic: mobile

Findings and fixes:
1. The first band palette (brown tones) was invisible on top of the beans. **Fix:** a high-contrast palette for the overlay, map and legend. Outliers get a white outline instead of red circles that cluttered the photo.
2. The outlier list rendered 200+ buttons on a phone. **Fix:** it's grouped by type in collapsible sections, capped at 40 each, with the rest in the CSV.
3. On a phone the overlay was too small to tap single beans. **Fix:** a "Zoom 2×" toggle with a scrollable photo. Taps snap to the nearest bean within 1.6 × the bean radius. Tapping a dot on the roast map jumps to that bean on the photo.
4. Analysis blocked the UI. **Fix:** it runs in a Web Worker, with progress per photo.
5. Tap targets are ≥ 44 px. Inputs are numeric. Sample tabs stay visible while scrolling. Phone photos are downscaled to 1600 px on the device, so nothing is uploaded.
6. Remaining: no pinch-zoom inside the canvas beyond the 2× toggle. The first load of the demo batch takes about 3–10 s on a phone.
