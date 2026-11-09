# SOMA local web mode

The original SOMA UI is retained: **CadQuery viewer on the left, editor and agent terminals on the right**. Web requests now call shared model/terminal services directly in **Node.js**. There is no hidden Electron window, Chromium server, Xvfb or DISPLAY requirement. Electron remains a development dependency for the existing desktop edition only; it is absent from the Docker runtime.

## Start on this Mac

```sh
cd /Users/sukbeom/Documents/CADAI/SOMA
npm --prefix app run start:web
# another terminal: stop without deleting models
npm --prefix app run stop:web
# restart with the same start command
```

Open **http://127.0.0.1:8765/**. Use one browser tab. Reload after restarting, then reopen your model. Override the port with `SOMA_WEB_PORT=8876`; override data/Python with `SOMA_USER_DATA` and `SOMA_PYTHON`. The default data directory is `.soma-web/`, excluded from Git.

New installation (Python 3.12, uv, Node >=22 and Git required):

```sh
uv venv --python python3.12 .venv
uv pip install --python .venv/bin/python -r python/requirements-web.txt
uv pip install --python .venv/bin/python -e ./python
cd app
npm ci --ignore-scripts
npm rebuild node-pty
npm run start:web
```

No Electron installer is needed for web mode. `start:web` uses system Git, the repository's virtual environment and a managed PID file; it does not change global Python, shell configuration or Codex credentials. On Mac it repairs the executable bit of node-pty's packaged spawn helper. The desktop edition still uses `npm start` and needs its Electron installation.

## Workflow

1. Create/open a model. In the right terminal start your installed, authenticated `codex` (or `codex --no-alt-screen`). Wait for its prompt.
2. Click a face: it turns orange and a card identifies the part, surface, picked point and Python line.
3. Choose **Send to agent**, append the dimensional change, then press Enter in the Codex terminal. This inserts selection context; it does not submit a command by itself.
4. Codex edits the Python source. **Auto on** rebuilds and updates the viewer. Watch the build status: a failed build deliberately leaves the previous good mesh visible alongside the error.
5. **Import** opens a browser file picker and uploads into the model's `inputs/`. Opening a `.soma`/ZIP file also uses the browser picker. Maximum: 20 files per selection, 100 MiB per file. Uploads are staged under the data directory's `uploads/`; duplicate names get separate staging directories.
6. Export STEP/STL, editable CadQuery source, ZIP, drawings, or Save a `.soma` model. File exports ask for a filename, then show explicit **Download** links. Files stay under the data directory's `exports/`. Links expire after 30 minutes or a server restart; export again to obtain new links. STEP/STL do not preserve the Python parameters or design history.

Opening a server folder still requires its absolute path (Mac paths on Mac, container paths in Docker). File-path drag/drop and remote filesystem browsing are not implemented. “Show in folder” displays the server path. Deleted files go to the local data directory's `trash/` in web mode. Staged uploads and exports are retained on disk; remove them when no longer needed.

Selection references describe the current build, not permanent face IDs. Reselect after a rebuild. Connection loss blocks interaction and displays Reconnect. Once Codex has been launched in a web model, reopening it starts `codex resume --last --no-alt-screen` in that model's directory. Existing projects can use the terminal menu's **Resume Codex in this model**. This restores the most recent Codex conversation for that directory, not the exact PTY, multiple terminal tabs, unsent input, or another agent's session. Moving the project directory can change session matching. Authentication and Codex session storage must remain available (including the Compose Codex volume). Only the agent name is stored in SOMA's `terminal-resume/`, never credentials or conversation text. Codex inference uses the existing online service; local hosting does not mean offline inference.

Transfer/resume validation: real browser upload, STEP download, explicit and automatic Codex resume; HTTP integration tests cover upload limits/path traversal/origin protection, export downloads, and PTY resume dispatch. Existing unit and desktop smoke tests pass. Evidence: `validation/browser-download.png`, `validation/browser-auto-resume.png`. These additions were tested on Mac; this revision has not been retested in Docker or on Linux x64.

## PNG, video and FEM in web mode

- **Render / FEM → Export PNG** saves an isometric 1280×720 model image to `renders/model.png`. Choose an Analysis result to export a legend/deformation image to `renders/analysis.png`. Download links appear when complete.
- **Animation → select animation → Make video** exports MP4, a contact-sheet PNG and VTT subtitles using the same renderer as the desktop edition. Create animations in `animations/*.py` and run `soma anim build` from the web terminal first.
- Existing agent commands such as `soma render --size 640x360 --out renders/cli.png` now use the connected browser. No Electron or virtual display is needed. A browser must stay open; disconnects and cancellation produce a failure, not a fresh success. Each uploaded artifact is limited to 100 MiB; contact sheets to 32 megapixels. Available H.264/VP9 encoders depend on the browser.
- **Render / FEM → FEM study path → Run FEM** executes an existing Python study relative to the model, e.g. `analyses/bracket.py`. Codex can write it using the existing SOMA FEM skill. **Analysis** displays stress, displacement, safety factor and loads, and supports **Recalculate**. This preserves CadQuery/Gmsh and SOMA's existing solver; it does not invent material/load inputs.
- FEM uses the already installed Mac environment. The minimal Docker image still excludes Gmsh/pyamg; Docker FEM and Linux x64 execution are not verified. CalculiX is not installed here, so this verification covers the built-in linear-elastic solver without contact. Long FEM jobs have a one-hour timeout; no new FEM cancellation UI was added.

Actual Mac validation: PNG download; 2-second camera-orbit MP4 (H.264, 1280×720, 30 fps, 61 frames including the endpoint, 2.033333 s); browser playback to the end; render cancellation; FEM execution, Analysis display, result PNG; missing-study error. Test inputs are in `validation/fem-review-model/`. No extra dependencies were installed. Research context and limitations: [RENDER_FEM_REVIEW.md](RENDER_FEM_REVIEW.md).

## Docker Compose (Mac Docker Desktop)

```sh
cd /Users/sukbeom/Documents/CADAI/SOMA
# Stop the native server first if using the same port.
npm --prefix app run stop:web
docker compose up --build -d
docker compose logs -f soma
docker compose stop                 # retain container and named volumes
docker compose start                # restart
docker compose down                 # remove container/network, retain named volumes
```

Open **http://127.0.0.1:8765/**. For a different port, prefix every Compose command with `SOMA_WEB_PORT=8876`. Ports are published explicitly on **127.0.0.1**; only the container's internal listener uses 0.0.0.0 so Docker can forward traffic. The bridge network is private to this Compose project, with no host networking, Docker socket mount, privileged mode, tunnel or automatic restart registration.

`/data` is the `soma-data` named volume (models, history, exports, logs). `/home/soma/.codex` is a separate `soma-codex` volume. The container runs as UID 10001, with Node, Python/CadQuery, Git and pinned Codex CLI 0.167.0. The build context is allowlisted; host authentication, `.venv`, `.git`, model workspaces and logs are never copied into the image. Do not use `down -v` unless you intend to delete these volumes.

Codex authentication is separate in Docker; the Mac credentials are not mounted or copied. Authenticate yourself in the web terminal or with:

```sh
docker compose exec soma codex login --device-auth
```

Use the login URL and code shown by Codex. No credentials or keys belong in the Compose file. This login was not performed during validation; authenticated Codex edits were verified in the native Mac Node server.

Retrieve exported files and editable models:

```sh
mkdir -p downloaded-exports
docker compose cp soma:/data/exports/. ./downloaded-exports/
# Export a .soma file to /data/exports in the UI to preserve the source/history package.
# Full backup (stop first for consistent files):
docker compose stop
docker compose cp soma:/data ./soma-data-backup
```

The first build downloads CAD wheels and native PTY build tools. The measured ARM64 image is approximately 4 GB. Linux aarch64 has no PyPI wheel for pinned `gmsh==4.15.2`; `requirements-web.txt` therefore selects core CAD/drawing/document dependencies using the same pinned base constraints, excluding FEM/gmsh/pyamg. No emulation or source-built gmsh was added. OpenGL client libraries satisfy OCCT/VTK imports; no display server is installed or started.

## Validation, 2026-11-09

Native Mac: macOS 27.0.1, Apple M2 Pro/arm64, Node 26.12.1, Python 3.12.16, SOMA 0.11.0, CadQuery 2.8.0, OCP 7.9.3.1.1, node-pty 1.1.0, Codex 0.167.0. Exact dependency snapshots are in `validation/`.

The real browser and authenticated Codex completed **10 → 12 mm** on the selected Lid under the Node server. The source changed, the viewer's hole enlarged automatically, and face area changed 2307.7 → 2273.2 mm². Orange selection and terminal wheel scrolling were verified. Screenshot: `validation/browser-headless-hole12.png`.

`validation/headless-model/` contains the 12 mm Python source and STEP/STL. `geometry-headless-hole12.json` records:

- Body and Lid are valid single solids; Body is unchanged by bidirectional Boolean comparison.
- Body bounds X ±30, Y ±20, Z 0–25 mm; Lid X ±30, Y ±20, Z 25–27 mm.
- Hole center (0,0), diameter 12 mm, cylindrical surface spans the full Z 25–27 mm.
- Lid volume **4546.336293856408 mm³**, matching the analytic value within 1e-6 mm³.
- STEP reread preserves valid solids, volume within 1e-6 mm³ and bounds within 1e-6 mm.
- STL is closed/manifold; measured mesh volume/bounds errors are in the JSON. Units are **mm**, not encoded by STL. Requested tessellation tolerance is 0.01 mm; volume error is not a maximum surface-distance guarantee.

Docker Desktop ARM64: Node 24.21.0 / Python 3.12.16 / Codex 0.167.0. The runtime has no Electron package, Xvfb or DISPLAY and runs as UID 10001. Compose health check passed on 127.0.0.1:8876; the real Node integration test passed inside the container. Browser generation, 60 → 70 mm length change through its terminal, automatic rebuild and orange face selection passed (`browser-docker-headless.png`). The test container was stopped/removed after validation; its named data volumes remain.

Earlier hidden-Electron web evidence (`browser-hole8/10`, `final-model/`, `geometry-hole10.json`, `failure-test.json`) is retained as historical evidence. It does not prove the new runtime; the headless test and screenshot do. STEP/STL do not preserve Python parameters or design history.

An upstream CadQuery 2.8 export issue was fixed: exporting a Workplane around a Solid could iterate it into a Shell. Exports now use the registered Shape directly. STEP/BREP regression tests cover solids and compounds.

```sh
npm --prefix app run typecheck
npm --prefix app run test:web
# Set SOMA_PYTHON to the absolute path of .venv/bin/python;
# on this Mac system Git needs the following two variables for direct test scripts:
SOMA_PYTHON="$PWD/.venv/bin/python" LOCAL_GIT_DIRECTORY=/opt/homebrew \
  GIT_EXEC_PATH=/opt/homebrew/opt/git/libexec/git-core npm --prefix app run test:headless
LOCAL_GIT_DIRECTORY=/opt/homebrew GIT_EXEC_PATH=/opt/homebrew/opt/git/libexec/git-core npm --prefix app run test:unit
SOMA_PYTHON="$PWD/.venv/bin/python" LOCAL_GIT_DIRECTORY=/opt/homebrew \
  GIT_EXEC_PATH=/opt/homebrew/opt/git/libexec/git-core npm --prefix app run test:smoke
.venv/bin/python validation/test_step_export.py
.venv/bin/python validation/verify_model.py validation/headless-model 12 validation/headless-model
```

All these checks passed. The headless integration test starts the actual Node server without DISPLAY/WAYLAND_DISPLAY, creates and builds CAD, reads binary mesh data, exercises PTY output, confirms build-error/old-mesh behavior and recovery, and exports STEP/STL through web save dialogs. HTTP tests cover Host/Origin/cookie/client isolation, channel restrictions and traversal. The desktop smoke test verifies the retained original UI after shared-service extraction.

## Limits and changes

- **PNG/contact-sheet/video export and `soma render` remain desktop-only.** Web mode returns an explicit unsupported error; browser rendering and STEP/STL do not depend on these features.
- Docker authentication/inference, FEM/CalculiX, Intel Mac and Proxmox are not validated. No Proxmox deployment was performed. A future move needs CPU-specific CAD wheels, PTY behavior, storage ownership/backups, Codex sandbox/authentication and a deliberate access-control design; changing the bind address alone is unsupported.
- Existing native authentication was reused. Earlier in this PoC, Enter intended for a prompt reached Codex's update prompt and Homebrew unintentionally upgraded 0.165.0 → 0.167.0; this was disclosed at the time. Accepting the model folder trust prompt saved that trust. No custom API key was created.
- The locked upstream development dependencies reported 9 audit findings (7 moderate, 2 high); Docker's pruned runtime install reported zero at build time. Unrelated dependency upgrades were not attempted.
- The web terminal wheel fix uses xterm's public scrollLines API with accumulated fractional deltas. Terminal mouse-tracking/alternate-screen applications retain their own mouse handling; desktop mode is unchanged.

Validation details for the implemented renderer/FEM flow: `validation/web-render-fem.json`. TypeScript, web isolation, headless integration, desktop smoke and the desktop animation/render/analysis regression suite passed. Rendering cancellation kept the previous video byte-identical; a disconnected browser returned failure.
