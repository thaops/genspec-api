# Deploy genspec-api to Render

## OOM fix (Reached heap limit / JavaScript heap out of memory)
`nest build` used the **tsc** builder which is memory-heavy and OOMs on Render Free (512MB).
Switched to the **SWC builder** (`nest-cli.json` → `builder: "swc"`, `typeCheck: false` + `.swcrc`).
Result: build is ~35 files in <0.2s using a fraction of the RAM. Type-safety is still enforced
locally/CI via `npm run typecheck`.

## Render setup
If you deploy via the dashboard (not the included `render.yaml`):

- **Environment:** Node
- **Build Command:** `npm ci && npm run build`
- **Start Command:** `node dist/main`
- **Environment variables:**
  - `NODE_OPTIONS = --max-old-space-size=460`  (keeps V8 within the 512MB box)
  - `NODE_ENV = production`
  - `MONGODB_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN=30d`
  - `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-2.5-flash`
  - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
  - `FRONTEND_URL` = comma-separated allowed web origins, for CORS.
    e.g. `https://gen-spec-web.vercel.app,http://localhost:3000`
    (After redeploy, the API also auto-allows any localhost/127.0.0.1 port for dev.)
  - Do NOT set `PORT` — Render injects it; `main.ts` reads `process.env.PORT`.

`render.yaml` (Blueprint) in this folder encodes all of the above; secrets are `sync:false`
(set their values in the dashboard).

## Notes
- If you still hit OOM on Free during `npm ci`, it's the install step, not the build — try
  `npm ci --no-audit --no-fund` or upgrade the instance.
- The AI copilot streams via Server-Sent Events and can run 40–150s per full draft; Render's
  free instance is fine for this (no request-duration cap on the persistent stream beyond idle).
