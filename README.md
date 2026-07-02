# Hermes Login Portal

A minimal Node + Vite login page that gates access to the Hermes dashboard. It issues a signed HttpOnly session cookie on successful sign-in and exposes an `/auth-check` endpoint that a Caddy reverse proxy can call via `forward_auth` to decide whether to forward a request to the dashboard.

## Architecture (production)

```
                          h01.mmsim.com
                                │
                                ▼
                        ┌───────────────┐
                        │  Caddy proxy  │  owns the public domain
                        │  (this Caddyfile)
                        └──────┬────────┘
              /login, /assets, │         all other paths
              /auth-check,     │         (only if cookie is valid)
              /logout          │
                    ┌──────────▼──────────┐   ┌──────────────────────┐
                    │  hermes-login (Node)│   │ hermes-dashboard     │
                    │  this repo, :4173   │   │ (existing Python)    │
                    └─────────────────────┘   └──────────────────────┘
```

- Caddy owns `h01.mmsim.com` publicly.
- Every request goes through `forward_auth` → Node's `/auth-check`.
- No valid cookie → Caddy redirects the browser to `/login`.
- Valid cookie → Caddy forwards the request to the Python dashboard.

## Endpoints served by `server.js`

| Path | Purpose |
|---|---|
| `GET /` and `GET /login` | Serve the login SPA (`dist/index.html`). |
| `POST /login` | Validate credentials, set `hermes_auth` cookie, redirect to `/`. |
| `GET /auth-check` | Return `200` if the request carries a valid `hermes_auth` cookie, `401` otherwise. Called by Caddy `forward_auth`. |
| `GET /logout` | Clear the cookie and redirect to `/login`. |
| `GET /assets/*`, `favicon.ico` | Static assets built by Vite. |

## Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `BASIC_AUTH_USER` | yes | — | Username accepted by the login form. |
| `BASIC_AUTH_PASSWORD` | yes | — | Password accepted by the login form. |
| `SESSION_SECRET` | strongly recommended | random per boot | HMAC key used to sign the session cookie. If unset a random key is generated on every start, so all sessions are invalidated when the process restarts. |
| `SESSION_MAX_AGE` | no | `28800` (8 h) | Cookie lifetime in seconds. |
| `PORT` | no | `4173` | Port the Node server listens on. |
| `COOKIE_SECURE` | no | `1` | Set to `0` only for local `http://` testing so the cookie is still sent. |

## Run locally

```powershell
$env:BASIC_AUTH_USER = 'admin'
$env:BASIC_AUTH_PASSWORD = 'change-this-password'
$env:SESSION_SECRET = 'local-dev-secret-change-me'
$env:COOKIE_SECURE = '0'
& "C:\Program Files\nodejs\npm.cmd" run build
& "C:\Program Files\nodejs\npm.cmd" run start
```

Open http://localhost:4173/ and sign in. After login the browser is redirected to `/`, which — because there is no Caddy proxy locally — will re-serve the login page. Locally, use `/auth-check` to verify the cookie was set:

```powershell
curl.exe -i -b (curl.exe -s -D - -o NUL -X POST -d "username=admin&password=change-this-password" http://localhost:4173/login | Select-String "hermes_auth") http://localhost:4173/auth-check
```

For UI iteration:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run dev
```

Open http://localhost:5173/. The dev server proxies `/login` to `http://localhost:4173`; keep the Node server running in a second terminal.

## Deploy on Zeabur (3 services, all in the same project)

### 1. `hermes-dashboard` (already exists)

- Currently owns `h01.mmsim.com` — that must move to the Caddy service.
- On this service, **remove** the `h01.mmsim.com` domain. Do **not** add another public domain; it will only be reached internally.
- Note the port the Python app listens on inside the container (commonly `8000`). You will need it for the Caddyfile.

### 2. `hermes-login` (new, this repo)

- Add Service → Git → pick this repo.
- Zeabur auto-detects Node and runs `npm install` → `npm run build` → `npm start`.
- **Do not** attach any public domain.
- Set variables:
  - `BASIC_AUTH_USER` — chosen username.
  - `BASIC_AUTH_PASSWORD` — a strong password.
  - `SESSION_SECRET` — a random 32+ char string (e.g. `openssl rand -hex 32`).
  - `PORT` — `4173` (keep in sync with the Caddyfile).

### 3. `hermes-proxy` (new Caddy service)

- Add Service → **Marketplace** → **Caddy** (or any generic Caddy template).
- Mount `deploy/Caddyfile` from this repo as the Caddy config, or paste its contents into the service's config.
- Update the upstream host/port lines in the Caddyfile if your Zeabur service names or the dashboard port differ:
  - `reverse_proxy hermes-login:4173`
  - `reverse_proxy hermes-dashboard:8000`
- Attach `h01.mmsim.com` to this service. Update DNS at your registrar so `h01.mmsim.com` points to this Caddy service.

### 4. Verify

- Visit `https://h01.mmsim.com/sessions` in a private window with no cookies → you should be redirected to `https://h01.mmsim.com/login`.
- Sign in with the credentials from step 2 → the browser lands on `https://h01.mmsim.com/` (the dashboard).
- Visit `https://h01.mmsim.com/logout` → cookie cleared, redirected back to the login page.
- The dashboard service should have no public domain, so nobody can reach it around the proxy.

## Scripts

- `npm run dev` — Vite dev server on port 5173.
- `npm run build` — TypeScript check + Vite production build into `dist/`.
- `npm run start` — Serve `dist/` and handle auth via `server.js`.
- `npm run preview` — Vite preview of the built site (no auth).
