# Calibration guide

This guide is for one fixed setup: **the same LED light, the same position, the same iPad**. Everything below exists to keep that setup identical from one photo to the next, so a change in a number means a change in the beans and not in the camera.

> **Honest status:** until you have photographed and entered 5–6 reference lots of known Agtron value, every Agtron-like number in the app is an **uncalibrated estimate** (a provisional straight line, L* 45 → 65, L* 55 → 80). Treat band names as indicative only. L* and b* are still useful for comparing *your own* roasts on *this* setup.

## 1. Camera app and settings

Use **Halide** or **ProCamera**. The built-in Camera app does not let you lock everything below.

| Setting | Value |
|---|---|
| Format | **RAW / ProRAW** (DNG). Export a JPEG or PNG in sRGB from it for the app (see §5). |
| HDR / Smart HDR | **Off** (in iOS Settings → Camera too, if your iPad offers it). |
| Exposure | **Locked** (manual ISO + shutter). Choose it once so the plate is bright but **not clipped** (no channel at 255 on the plate). Write the values down. |
| White balance | **Locked** to a fixed Kelvin/tint (e.g. measured once off the grey card). Never auto. |
| Focus | **Locked** (manual focus) at the plate distance. |
| Flash, night mode, portrait/depth effects, filters | Off. |
| Lens | Always the same lens (1×). No digital zoom. |

Save these as a preset in the app if it supports one.

## 2. Physical setup

- **Light:** the same LED, same brightness, warmed up ~5 min. Switch off or block other light (windows, ceiling lights).
- **Position:** the iPad on a fixed stand, lens parallel to the table, **at a fixed distance**. Mark the stand, plate and card positions with tape.
- **Background:** **matte, neutral** (grey or white, not glossy, not coloured). Glossy surfaces cause glare that skews the white reference.
- **Plate:** the same plain white, preferably matte, plate every time. One layer of beans, not touching the rim.
- **Card:** a **ColorChecker** (or at least a neutral **grey card**) **always in frame**, flat, in the same place, in the same light as the beans and not shadowed by the iPad. It is how drift gets caught and, later, how per-image colour correction works.
- No shadows from you or the iPad across the plate.

## 3. Taking a measurement photo

1. Check the preset is active (exposure, WB and focus locked; RAW on; HDR off).
2. Beans in a single layer on the plate, card in its marked place.
3. Shoot 2–4 photos of the same batch, reshuffling the beans between shots; the app merges them into one report.

## 4. Photographing the Agtron references (5–6 lots)

You need 5–6 bean lots whose Agtron value is **known** (measured on an Agtron/Lighttells meter, or a roaster's reference lots with a stated whole-bean Agtron value), **spread across the range you roast** (e.g. ~45, 55, 65, 75, 85, 95).

For each reference:
1. Same setup and preset as §1–§2, card in frame.
2. Take 3 photos, reshuffling beans between shots.
3. Load them in the app and note the **mean L\*** (and its SD) together with the known Agtron value, the lot name and the date.
4. Note whether the meter value is **whole-bean or ground**; do not mix the two in one calibration.

Enter the (L*, Agtron) pairs in the Calibration panel. Today the app takes two points: use the lightest and darkest references and check the others land within ~3 Agtron points of the line. (An N-point monotonic fit with error reporting is specified in [`CALIBRATION_SPEC.md`](CALIBRATION_SPEC.md).) Keep the reference beans sealed, dark and cool; they change colour as they age, so re-measure or replace them every few months.

## 5. Getting photos into the app

Export each RAW as **sRGB** JPEG/PNG (8-bit is fine) without extra edits (no auto-enhance, no tone curve, no "vivid"). Use the same export settings every time. Wide-gamut (Display P3) or HDR exports may be handled differently by the browser; avoid them.

## 6. Rechecks

- **Monthly:** re-photograph at least 2 references (lightest and darkest). If either is more than ~3 Agtron points off, re-photograph all and re-calibrate.
- **Immediately after any change** to the light (bulb, brightness, position), the iPad position or distance, the camera app, its settings, or an iOS update that touches the camera, the plate, the background, or the card: full recheck.
- Keep a log: date, exposure/WB values, the references' mean L*, and the result.
