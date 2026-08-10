# OpenLoop GUI (React + Tauri)

A thin client of the OpenLoop server (OpenAI-compatible API + WS event/approval stream).
The same codebase runs in a browser and as the OpenLoop desktop app.

## First time: bootstrap the Python backend

A fresh checkout has no server to run — create the venv both flows below expect:

```bash
bash packaging/setup_dev_env.sh   # → .venv
```

## Run it (browser, two terminals)

1. **Start the server** (needs a model key, e.g. `OPENAI_API_KEY`, in the environment —
   or add one later in the app's Settings):
   ```bash
   ./.venv/bin/openloop-server --cwd /path/to/your/project --port 8765
   ```
2. **Start the UI:**
   ```bash
   cd surfaces/gui
   npm install      # first time
   npm run dev      # → http://localhost:5173
   ```

Open http://localhost:5173. The UI talks to `http://127.0.0.1:8765` (override with
`VITE_OPENLOOP_HTTP` / `VITE_OPENLOOP_WS`). Start the server before Vite so the
UI can read its per-launch token from `<state-dir>/sidecar-8765.token`; restart
Vite if the server is restarted.

## Run the desktop app from source

The Tauri shell wraps the same UI and supervises the Python server itself — no separate
terminal. It needs the Rust toolchain (`rustup`) plus the venv from the bootstrap step;
in dev it finds the server at `.venv/bin/openloop-server` automatically. A
packaged sidecar binary is produced by the scripts in `packaging/`.

```bash
cd surfaces/gui
npm install        # first time
npm run tauri dev  # builds the shell, launches the window, starts the server
```

## Tests

```bash
npx tsc --noEmit && npx vitest run   # typecheck + unit
npx playwright test                  # hermetic e2e (mocked /v1 + WS, no Python needed)
```
