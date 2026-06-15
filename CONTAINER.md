# Dedicated dev server (Apple `container`)

The game is served from a Linux container (Apple `container` CLI, one lightweight
VM) instead of a host-local vite process. Benefits: isolated, reproducible, fixed
port `5210` that won't collide with the other projects in the shared launch.json.

> ⚠️ The container has **no GPU** — WebGPU cannot *render* inside it. It only
> serves the files. Visual/headless verification still happens in a host browser
> (Chrome via chrome-devtools MCP, or the offscreen `window.__outrun.probe()`).

## Layout

- **Container name:** `outrun-server`  ·  **image:** `node:22`  ·  **host port:** `5210`
- **Source:** host `./` bind-mounted at `/work` → edits hot-reload (vite HMR).
- **node_modules:** named volume `outrun_nm` mounted at `/work/node_modules` so the
  Linux install never clobbers the host's macOS `node_modules` (different binaries).

## Manage

```bash
# Start (first run: container system start; create volume)
container system status || container system start
container volume create outrun_nm 2>/dev/null || true
container run -d --name outrun-server \
  -v "$PWD:/work" -v outrun_nm:/work/node_modules \
  -w /work -p 5210:5210 -m 2G -c 2 \
  node:22 sh -c "npm install --no-audit --no-fund && npm run dev -- --host 0.0.0.0 --port 5210"

container logs -f outrun-server     # watch vite / HMR
container stop outrun-server        # pause (keeps install)
container start outrun-server       # resume
container delete outrun-server      # remove (volume persists deps)
```

Then open <http://localhost:5210/> in Chrome.

## Reset deps

If a dependency changes and you want a clean install:
```bash
container stop outrun-server && container delete outrun-server
container volume delete outrun_nm && container volume create outrun_nm
# then re-run the `container run` above
```
