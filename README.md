# Viedom

Map-first real-estate marketplace.

Requires Node 26.3+, pnpm 12.14 and Docker Desktop. Run from this directory in PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm setup:local
pnpm config:check
pnpm infra:up
pnpm dev
```

`setup:local` creates a root `.env` if missing and preserves existing values. Keep it private. The applications run on the host; authenticated MongoDB runs in Docker with persistent volumes. No cloud account is required.

Open [the public shell](http://localhost:4200), [owner workspace preview](http://localhost:4200/owner) or [service status](http://localhost:4200/health). The API uses `http://localhost:3000/api`; its health endpoints are `/api/health` and `/api/health/ready`. The previews contain no live listings or account data.

Use `.env.example` for available settings. To change ports, update `WEB_PORT`, `API_PORT`, `WEB_ORIGIN`, `PUBLIC_API_BASE_URL` and `SSR_API_BASE_URL` consistently. Preserve the existing database credentials; editing `.env` does not rotate stored MongoDB users. See [configuration details](docs/local-development-design.md).

Stop the app watchers with Ctrl+C. `pnpm infra:logs` shows dependency logs; `pnpm infra:down` stops dependencies and retains data. Do not delete Docker volumes for normal shutdown.

```powershell
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
pnpm smoke:local
```

The local smoke check builds the applications, verifies authenticated database access and restart persistence, then checks production SSR, browser/API recovery, responsive shells, keyboard navigation and axe. On Windows it uses installed Chrome by default. Screenshots and results are written under ignored `test-results/`.

After `pnpm build` and `pnpm infra:up`, use `pnpm smoke:ui` to repeat the browser checks against the existing build without rebuilding or restarting MongoDB. Both smoke commands start and stop their own application processes; stop other app instances on the configured ports first.

See [UI foundations](docs/ui-foundations.md) for styling, shared feedback, formatting and form conventions, and [implementation status](docs/implementation-status.md) for phase progress.
