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

`setup:local` creates a root `.env` if missing, generates local secrets and appends missing authentication/mail defaults while preserving every existing value. Keep it private. The applications run on the host; authenticated MongoDB and Mailpit run in Docker with persistent volumes. Email/password authentication, verification and recovery work without a cloud account.

Open [the public shell](http://localhost:4200), [create an account](http://localhost:4200/auth/register), [sign in](http://localhost:4200/auth/login) or check [service status](http://localhost:4200/health). The [owner workspace](http://localhost:4200/owner) requires a session; property management remains a preview. The API uses `http://localhost:3000/api`; its health endpoints are `/api/health` and `/api/health/ready`.

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
pnpm smoke:mail
pnpm smoke:auth
```

The local smoke check runs persistence and authentication integration tests, verifies credentialed browser cookies, builds the applications, verifies authenticated database access and restart persistence, then checks production SSR, browser/API recovery, responsive shells, keyboard navigation and axe. On Windows it uses installed Chrome by default. Screenshots and results are written under ignored `test-results/`.

`db:indexes` creates the core and authentication collections with reviewed validators and indexes. Repeat runs verify existing validators and add missing indexes; they never drop data or indexes. Validator drift or invalid existing records require a reviewed migration. `db:seed` also provisions, then inserts missing synthetic fixtures without overwriting existing records. Fixtures have no login passwords and do not appear in the shell. Both commands refuse production, remote targets and databases without a `local`, `dev` or `test` name segment. Use `pnpm db:indexes --test` / `pnpm db:seed --test` for the separate test database. See [persistence conventions](docs/persistence.md) for bounds, relationships, projection safety and transactional snapshot repair.

After `pnpm build` and `pnpm infra:up`, use `pnpm smoke:ui` to repeat the browser checks against the existing build without rebuilding or restarting MongoDB. Both smoke commands start and stop their own application processes; stop other app instances on the configured ports first.

Authentication supports email/password and Google sign-in using Passport Google OAuth 2.0 and JWT strategies. To enable Google, create a Google OAuth **Web application** client and put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the root `.env`. Register the exact callback `http://localhost:3000/api/auth/google/callback` (adjust with the browser API port/origin). Leave both values blank to disable Google locally. See [authentication contracts and setup](docs/authentication.md); existing fixtures intentionally cannot log in.

Phase 06 adds email verification and password recovery APIs. Open [Mailpit](http://localhost:8025) to inspect local messages; the host API sends SMTP to `127.0.0.1:1025`. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, optional `SMTP_USER`/`SMTP_PASSWORD`, and `MAIL_UI_PORT` in root `.env`. Local defaults use unauthenticated loopback capture; production requires an authenticated SMTP provider with TLS. Changing `SMTP_PORT` or `MAIL_UI_PORT` updates Compose and the API together. Normal shutdown retains captured messages.

Registration requests verification automatically and offers a resend. Open the newest link in Mailpit and explicitly confirm your email. Recovery starts at [forgot password](http://localhost:4200/auth/forgot-password). The browser removes email tokens from the address bar immediately, keeps them only in memory and requires confirmation before consuming them. Reloading a link page requires reopening the email. After reset, sign in with the new password; every prior session is revoked. Google-only accounts continue to use Google.

Session refresh is coordinated across requests and tabs using Web Locks. Use a current browser on localhost or HTTPS. Access and CSRF tokens never enter browser storage. `pnpm smoke:auth` builds the frontend and exercises registration, Mailpit verification/recovery, protected navigation, reload/expiry, simultaneous tabs, Google callback with mocked provider transport, logout and responsive accessibility against the separate test database. It starts/stops its own app processes; stop `pnpm dev` first. Only its synthetic accounts and exact captured messages are removed. `pnpm smoke:local` includes these journeys; `pnpm smoke:mail` retains the focused API/SMTP check. See [authentication conventions](docs/authentication.md) for API requests and failure/retry behavior.

See [UI foundations](docs/ui-foundations.md) for styling, shared feedback, formatting and form conventions, and [implementation status](docs/implementation-status.md) for phase progress.
