# Hermes Login Portal

A simple login page for the Hermes Agent dashboard. After successful sign-in, redirects to the dashboard.

## Run locally

```powershell
$env:BASIC_AUTH_USER = 'admin'
$env:BASIC_AUTH_PASSWORD = 'change-this-password'
$env:DASHBOARD_URL = 'http://hermes-dashboard:5000/sessions'
& "C:\Program Files\nodejs\npm.cmd" run build
& "C:\Program Files\nodejs\npm.cmd" run start
```

Open http://localhost:4173/ and sign in with the values above.

For UI development:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run dev
```

Open http://localhost:5173/.

## Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `BASIC_AUTH_USER` | yes | — | Username for login |
| `BASIC_AUTH_PASSWORD` | yes | — | Password for login |
| `DASHBOARD_URL` | no | `http://hermes-dashboard:5000/sessions` | Where to redirect after login |
| `PORT` | no | `4173` | Server port |

## Deploy on Zeabur

1. **Push to GitHub** — this repo is already set up for deployment.
2. **Create `hermes-login` service**:
   - Add Service → Git → pick this repo.
   - Zeabur auto-runs `npm install` → `npm run build` → `npm start`.
3. **Set variables**:
   - `BASIC_AUTH_USER` = your username
   - `BASIC_AUTH_PASSWORD` = your password
   - `DASHBOARD_URL` = internal dashboard URL (e.g., `http://hermes-dashboard:5000/sessions`)
   - `PORT` = `4173`
4. **Attach domain**:
   - Add `h01.mmsim.com` to this service.
   - Update DNS at your registrar.
5. **Secure the dashboard** (important):
   - On the existing dashboard service, remove the public domain (`h01.mmsim.com`).
   - It will only be reachable internally within Zeabur.

## Scripts

- `npm run dev` — Vite dev server on 5173.
- `npm run build` — Build for production.
- `npm run start` — Run server on port 4173.
- `npm run preview` — Vite preview (no auth).
