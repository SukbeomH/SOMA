# Headless web rendering and FEM review — 2026-11-09

Update: browser PNG/MP4 rendering and the web FEM launch UI are now implemented and verified on Mac (see WEB_LOCAL.md). Docker FEM is still not enabled. The design discussion below records the original review; the browser transport and shared renderer recommendation was implemented.

## PNG and video: recommended browser-side rendering

SOMA already has almost all rendering logic in `app/src/renderer/render.ts`: load the existing GLB into the existing Viewer, draw a fixed-size frame, use `canvas.toBlob('image/png')`, and encode a frame sequence using Mediabunny `CanvasSource` into MP4. The Electron dependency is the job transport/window, not the frame-generation algorithm. `Viewer.snapshot()` provides a canvas.

| Option | Server dependency | Advantages | Limitations |
|---|---|---|---|
| Existing browser + shared SOMA renderer (recommended) | None beyond current Node/CadQuery | Same visual appearance; reuse frame/annotation/animation code; no Electron/Xvfb | Browser must remain open; codec support and GPU/memory vary |
| `canvas.captureStream()` + MediaRecorder | None | Simple recording of interactive rotation | Real-time timing and background-tab throttling; not deterministic animation frame export |
| Optional headless Chromium worker | Chromium + OS libraries, optional software GPU | Can service `soma render` with no user browser connected | Larger image; WebGL/codec/sandbox/resource behavior needs separate x64 testing; no `--no-sandbox` shortcut |
| OCCT/VTK native offscreen rendering | EGL/OSMesa/native backend | Independent of browser | Different renderer, styling and annotations; does not directly preserve SOMA's existing animation pipeline |

Implementation path: extract `prepare/frame/png/sheet/video` from `render.ts` into a shared browser module; add an export job UI using a separate canvas; preserve the current viewer/camera; report progress and support cancellation; download PNG/MP4 with Blob URLs. Detect `canEncodeVideo` before starting; offer WebM/VP9 when appropriate, or report unsupported codecs. Include empty-scene, context-loss, large-frame and cancel tests. For CLI `soma render`, an optional bridge could dispatch jobs to the connected browser and return an explicit “browser required” error when none is connected. This is a proposed design, not an implemented CLI feature.

The present MP4 code already falls back from AVC to VP9. Mediabunny supports these containers/codecs, but encoder availability is browser-dependent. PNG needs no video codec. Browser Blob downloads should be revoked after use; long videos should avoid keeping every raw frame in memory.

Sources: [Canvas toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob), [captureStream](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream), [Mediabunny writing media](https://mediabunny.dev/guide/writing-media-files), [codec availability](https://mediabunny.dev/guide/supported-formats-and-codecs), [Chrome Headless](https://developer.chrome.com/docs/automation-and-testing/headless).

## FEM: existing SOMA implementation can run without a display

Repository inspection: `python/soma/fem.py` meshes BREP geometry with Gmsh's Python API, creates quadratic tetrahedra, and uses CalculiX when found. Without CalculiX it has a built-in linear-elastic direct/iterative solver for cases without contact. Contact/friction/preloaded-bolt cases require separate CalculiX verification. The pipeline writes a result GLB and metadata for the existing Analysis viewer. It does not call Gmsh's graphical event loop. CalculiX's solver and graphical pre/postprocessor are separate programs.

Official `gmsh==4.15.2` PyPI files checked: macOS x64/arm64, **manylinux_2_24_x86_64**, Windows amd64. There is no Linux aarch64 wheel in that release. Consequently the earlier ARM64 packaging obstacle is not the same on Linux x64. This confirms wheel availability only, not a successful x64 SOMA execution.

Suggested next Linux x64 validation: install pinned gmsh/pyamg in an optional FEM image/profile, run the bar benchmark below, then validate a cantilever against a reference solution and perform mesh convergence. Add CalculiX separately for contact; Debian bookworm supplies `calculix-ccx` 2.20-1 for amd64/arm64, whereas upstream lists 2.23. Do not assume the older package produces identical contact behavior to SOMA's expected version. `SOMA_CCX` can point to a deliberately selected solver. Keep FEM dependencies out of the minimal web image until this is checked.

For Linux ARM64, a distro Gmsh package or source build is possible in principle. Bookworm's Python wrapper is 4.8.4 and targets the distribution Python; mixing it with the image's Python 3.12 and pinned CAD libraries needs explicit compatibility testing. No package downgrade or global install was performed here.

Sources: [Gmsh official release files](https://pypi.org/project/gmsh/4.15.2/#files), [Gmsh manual](https://gmsh.info/doc/texinfo/), [CalculiX](https://www.calculix.de/), [Debian solver package](https://packages.debian.org/bookworm/calculix-ccx), [Debian Gmsh wrapper](https://packages.debian.org/bookworm/python3-gmsh).

## Actual Mac benchmark

Inputs: `validation/fem-review-model/model.py` and `study.py`. Aluminium 6082 bar 40 × 10 × 10 mm, E=70000 MPa, one end fixed, 100 N axial load on the other end. No contact or bolts. Existing isolated Python environment; DISPLAY and WAYLAND_DISPLAY unset; no new dependency installed.

```sh
env -u DISPLAY -u WAYLAND_DISPLAY .venv/bin/python -m soma analyze fem study.py \
  --project "$PWD/validation/fem-review-model" --json
```

Measured result (`validation/fem-review.json`): 8.44 s, direct built-in solver, 1980 nodes, 1017 Tet10 elements, 5625 free DOFs. Reaction −100 N balances +100 N applied load at reported precision. Reported maximum displacement 0.0006 mm; elementary axial-bar estimate FL/EA is 0.0005714286 mm. Output rounds displacement to four decimal places, so these values cannot establish a precise relative solver error. Fine/coarse peak von Mises stress is 1.269/1.121 MPa (13.29% difference), at the fixed-support edge; the uniform axial stress estimate is 1 MPa and is not the expected local peak at that constraint.

This proves the existing headless meshing/solver/result-generation path executes on this Mac. It is not a validation of a printed bracket's strength. Print anisotropy, material data, boundary conditions, contact and stress convergence remain necessary for design decisions. Linux x64 execution, CalculiX contact and Docker FEM remain untested.
