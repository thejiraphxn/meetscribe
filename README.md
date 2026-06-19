# MeetScribe

macOS desktop app that captures meeting audio, transcribes it (realtime via
Deepgram or batch via Groq), summarises with an LLM, and syncs sessions to a
cloud backend.

## Monorepo layout

```
meetscribe/
├── apps/
│   ├── desktop/    # Tauri v2 (Rust) + React + TypeScript + Vite + Tailwind
│   └── backend/    # Express.js + TypeScript + Prisma (PostgreSQL)
├── native/         # Swift helper — system-audio tap (ScreenCaptureKit)
├── sidecar/        # Python 3.11+ audio engine (WebSocket on :8765)
└── packages/
    └── shared/     # Shared TypeScript DTOs / WS protocol types
```

Managed with **npm workspaces**. `npm install` at the root wires everything up.

## Prerequisites

| Tool      | Needed for                | Notes                                        |
| --------- | ------------------------- | -------------------------------------------- |
| Node ≥20  | backend, desktop UI, shared | present                                    |
| Python ≥3.11 | sidecar                | `pip install -r sidecar/requirements.txt`    |
| Rust (rustup) | Tauri shell           | **not yet installed** — `cargo build` needs it |
| Swift / Xcode | native helper         | CLT 16.4 has a modulemap bug (see below)     |
| PostgreSQL | backend (or use Render)  | `DATABASE_URL`                               |

## Build & verify (per package)

```bash
npm install                              # all workspaces

# shared types
npm run build:shared                     # ✅ compiles

# backend
cd apps/backend && npx prisma generate && npm run build   # ✅ compiles

# desktop UI (React side)
cd apps/desktop && npm run typecheck && npx vite build     # ✅ builds

# sidecar (syntax)
cd sidecar && python3 -m py_compile *.py                    # ✅ compiles

# native helper
cd native && swiftc -O SystemAudioTap.swift -o systemtap \
  -framework ScreenCaptureKit -framework AVFoundation       # see toolchain note

# Tauri shell (needs Rust)
cd apps/desktop && npm run tauri dev                        # needs rustup
```

## Run locally

1. **Backend**: copy `apps/backend/.env.example` → `.env`, fill secrets, then
   `npm run dev:backend`.
2. **Sidecar**: copy `sidecar/.env.example` → `.env` (Deepgram + Groq keys),
   then `python sidecar/main.py`.
3. **Native helper** (optional, for system audio): build `native/systemtap` and
   place/symlink it where the sidecar expects (`MEETSCRIBE_SYSTEMTAP_PATH`).
4. **Desktop**: `cd apps/desktop && npm run tauri dev` (requires Rust).

## Sidecar bundling (for the Tauri externalBin)

```bash
pip install pyinstaller
cd sidecar
pyinstaller --onefile --name meetscribe-sidecar main.py
cp dist/meetscribe-sidecar \
   ../apps/desktop/src-tauri/binaries/meetscribe-sidecar-aarch64-apple-darwin
```

## Deployment

`render.yaml` provisions a Render Web Service + managed PostgreSQL. Set
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `BACKEND_URL` in the dashboard;
`JWT_SECRET` / `JWT_REFRESH_SECRET` are generated.

## Known toolchain blockers (environment, not code)

- **Rust missing** — the Tauri shell (`apps/desktop/src-tauri`) is written but
  unbuilt. Install via `rustup` then `npm run tauri dev`.
- **Swift CLT 16.4 modulemap bug** — `swiftc` errors with
  `redefinition of module 'SwiftBridging'`. Fix in `native/README.md`
  (install full Xcode, or retire the stale `module.modulemap`).

## Open integration notes (intentional follow-ups)

- **Project/localId on sync**: the sidecar creates the local session row with an
  empty `projectId` and the UI windows don't currently learn the active
  `localId` (transcript broadcasts omit it). Wiring the selected project +
  session id end-to-end (e.g. an extra field on `cmd:start`, and echoing
  `session_id` in broadcasts) is the remaining glue before `cmd:sync` can post a
  backend-valid payload. The backend, SQLite layer, and `sync.py` payload
  assembly are all in place.
- **Token storage**: implemented with the `keyring` crate (OS keychain) rather
  than `tauri-plugin-stronghold`; the command surface is identical, swap in
  `src-tauri/src/tokens.rs` if stronghold is preferred.
- **Soft delete**: `Project.deletedAt` was added to the Prisma schema to support
  the documented `DELETE /projects/:id` soft-delete behaviour.
```
