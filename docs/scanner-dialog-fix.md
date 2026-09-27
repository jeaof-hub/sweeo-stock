# Scanner modal lifecycle fix

Date: 2026-09-27

## Root cause

The entry form uses `showModal()` and occupies the browser top layer. The previous scanner was a normal section; its z-index could not place it above the modal or remove inherited inertness. Closing the entry form did not stop the camera. Pending camera permission and OCR promises could also complete after closing the form.

## Changes

- `index.html`: scanner is a dialog, opened after the entry dialog; video retains `playsinline`. Updated frontend cache versions.
- `style.css`: full viewport camera dialog, reset native dialog dimensions/spacing/backdrop, scrollable candidate list.
- `app.js`: scoped camera sessions; invalidate stale OCR and permission results; stop tracks/timers and close scanner on entry close; preserve entry rows on scanner close; focus quantity after accepting a scan. Esc and a temporary browser history entry let Back close the camera without dismissing the form. Stop camera when page is hidden or left.
- `app.js`: map the visible scanner frame through the video's `object-fit: cover` scale and offsets into intrinsic camera pixels. The crop is recalculated for each OCR pass, including after rotation, and camera constraints no longer request a fixed landscape resolution.
- No schema migration, database requests, stock changes or permission changes in this fix.

## Verification

- `node --test tests/*.test.mjs`: **38/38 passed**.
- `tests/browser/scanner-dialog.cjs`: **13/13 passed in Chrome, 13/13 passed in WebKit** with mobile viewport/touch settings.
- Both browser suites use a real canvas MediaStream; camera input, OCR output, torch capability and database reads are simulated. They do not contact the production database.
- The crop check does not mock its positional result: it inspects the pixels of the actual canvas passed to `worker.recognize`. A magenta marker inside the visible frame must be present and a cyan marker outside the frame must be absent. This passes for landscape 1280×720 and portrait 720×1280 camera streams on a portrait mobile viewport.
- Covered: visible-frame crop mapping, orientation change, modal/fullscreen geometry, clickable torch and candidates, close preserving rows/quantities, accepting/focusing quantity, two models and duplicate scan, manual entry, Esc, browser Back, parent close, late permission, stale OCR after close/reopen.
- `git diff --check`: passed.

Run a local HTTP server on port 8765; install Playwright and its WebKit browser, then run:

```sh
node tests/browser/scanner-dialog.cjs
ENGINE=webkit node tests/browser/scanner-dialog.cjs
```

Set `NODE_PATH` when Playwright is not locally installed, `CHROME_PATH` if Chrome is not at its default macOS path, and `BASE_URL` to change the server address.

## Screenshots — simulated camera, not physical devices

[Chrome landscape stream](screenshots/scanner-dialog/chromium-simulated-camera.png) · [Chrome portrait stream](screenshots/scanner-dialog/chromium-simulated-camera-portrait.png) · [WebKit landscape stream](screenshots/scanner-dialog/webkit-simulated-camera.png) · [WebKit portrait stream](screenshots/scanner-dialog/webkit-simulated-camera-portrait.png)

## Physical-device acceptance still required

No physical iPhone or Android phone was available. The requested screenshots from those devices have **not** been produced. Browser automation does not verify hardware camera permissions, mobile OS Back gestures, keyboard presentation, torch hardware, autofocus or real OCR accuracy.

On both iPhone Safari and Android Chrome:

- [ ] Open request with existing rows, open scanner, verify full camera view above form.
- [ ] Tap close, manual entry and candidate selection; test torch on supported Android hardware.
- [ ] Scan a product, verify row and quantity focus; scan a second model, then a duplicate.
- [ ] Close camera: stream stops and form retains all rows/quantities.
- [ ] Mobile Back closes only scanner; reopen camera successfully.
- [ ] Close parent form while scanning if possible; camera indicator switches off.
- [ ] Capture a screenshot with the camera open and record device/OS/browser versions.

## Release and rollback

Frontend-only release through the existing main → GitHub Pages workflow. Verify deployed HTML references `scanner-dialog-1` and deployed app/CSS match this commit. If actual-device testing finds a remaining issue, fix within this phase. If this change introduces a regression preventing stock entry, revert this commit and redeploy; manual product entry remains the fallback. No database rollback is required.
