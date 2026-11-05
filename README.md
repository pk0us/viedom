# Viedom

Map-first real-estate marketplace.

Requires Node 26.3+, pnpm 12.14 and Docker Desktop. Run from this directory in PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm setup:local
pnpm config:check
pnpm infra:up
pnpm db:indexes
pnpm db:seed
pnpm dev
```

`setup:local` creates a root `.env` if missing, generates local secrets and appends missing authentication defaults while preserving every existing value. Keep it private. The applications run on the host; authenticated MongoDB runs in Docker with persistent volumes. Email/password authentication works without a cloud account.

Open [the public shell](http://localhost:4200), [owner workspace preview](http://localhost:4200/owner) or [service status](http://localhost:4200/health). The API uses `http://localhost:3000/api`; its health endpoints are `/api/health` and `/api/health/ready`. The previews contain no live listings or account data.

Use `.env.example` for available settings. To change ports, update `WEB_PORT`, `API_PORT`, `WEB_ORIGIN`, `PUBLIC_API_BASE_URL` and `SSR_API_BASE_URL` consistently. Preserve the existing database credentials; editing `.env` does not rotate stored MongoDB users. See [configuration details](docs/local-development-design.md).

Stop the app watchers with Ctrl+C. `pnpm infra:logs` shows dependency logs; `pnpm infra:down` stops dependencies and retains data. Do not delete Docker volumes for normal shutdown.

```powershell
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db
pnpm format:check
pnpm smoke:local
```

The local smoke check runs persistence and authentication integration tests, verifies credentialed browser cookies, builds the applications, verifies authenticated database access and restart persistence, then checks production SSR, browser/API recovery, responsive shells, keyboard navigation and axe. On Windows it uses installed Chrome by default. Screenshots and results are written under ignored `test-results/`.

`db:indexes` creates the core and authentication collections with reviewed validators and indexes. Repeat runs verify existing validators and add missing indexes; they never drop data or indexes. Validator drift or invalid existing records require a reviewed migration. `db:seed` also provisions, then inserts missing synthetic fixtures without overwriting existing records. Fixtures have no login passwords and do not appear in the shell. Both commands refuse production, remote targets and databases without a `local`, `dev` or `test` name segment. Use `pnpm db:indexes --test` / `pnpm db:seed --test` for the separate test database. See [persistence conventions](docs/persistence.md) for bounds, relationships, projection safety and transactional snapshot repair.

After `pnpm build` and `pnpm infra:up`, use `pnpm smoke:ui` to repeat the browser checks against the existing build without rebuilding or restarting MongoDB. Both smoke commands start and stop their own application processes; stop other app instances on the configured ports first.

The Phase 05 authentication API supports email/password login and Google sign-in using Passport Google OAuth 2.0 and JWT strategies. Browser authentication screens arrive in Phase 07. To enable Google, create a Google OAuth **Web application** client and put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the root `.env`. Register the exact callback `http://localhost:3000/api/auth/google/callback` (adjust with the browser API port/origin). Leave both values blank to disable Google locally. See [authentication contracts and setup](docs/authentication.md); existing fixtures intentionally cannot log in.

See [UI foundations](docs/ui-foundations.md) for styling, shared feedback, formatting and form conventions, and [implementation status](docs/implementation-status.md) for phase progress.
