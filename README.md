# Visitor Dashboard

GitHub Pages frontend + Cloudflare Worker API + private D1 database.

## Features
- Account signup and login (passwords are PBKDF2-hashed; raw passwords are never stored).
- Visitor telemetry is sent only after the visitor accepts the collection notice.
- Browser/platform hint, screen size, language, timezone, page URL/referrer, server-observed IP hash and country, page views, heartbeats and opted-in click events.
- Admin-only live dashboard (polls every 5 seconds).
- Prepared SQL statements, input validation, origin allowlist, request-size limits and hashed random session tokens.

## Important
This is a starter project, not a compliance guarantee or a substitute for a security review. Tell visitors what is collected, why, retention period, and how to request deletion. Collect only what you need. Do not use this for covert tracking. Public sign-up is enabled; if you want only invited users, add an invitation flow before launch. Configure Cloudflare rate limiting for `/api/*` and monitor abuse.

## 1. Create the D1 database
In a browser-based Cloudflare dashboard:
1. Open **Workers & Pages → D1 SQL Database** and create a database named `visitor-dashboard-db`.
2. Open its SQL console and run the complete contents of `schema.sql`.
3. Open **Workers & Pages → Create → Worker** and create `visitor-dashboard-api`.
4. In the Worker settings, add a D1 binding named `DB` pointing to `visitor-dashboard-db`.
5. Add these Worker variables/secrets:
   - `ALLOWED_ORIGIN` (plain variable): your exact GitHub Pages origin, for example, `https://your-username.github.io`; replace it with your real GitHub Pages origin, with no path. For a project site, the origin is still `https://YOUR-USERNAME.github.io`.
   - `ADMIN_EMAIL` (plain variable): the email address of the account that may open the dashboard. Use lowercase.
   - `SESSION_TTL_SECONDS` (optional variable): `604800` for seven days.
6. Paste `worker.js` into the Worker editor and deploy.
7. Copy the deployed Worker URL, such as `https://visitor-dashboard-api.YOUR-SUBDOMAIN.workers.dev`.

## 2. Configure the frontend
1. Open `index.html`.
2. Replace `https://REPLACE-WITH-YOUR-WORKER.workers.dev` with your actual Worker URL.
3. Set `API_ORIGIN` to the same URL (without a trailing slash).
4. Commit `index.html` to a GitHub repository.
5. In GitHub, open **Settings → Pages**, select your branch and root folder, and enable Pages.

## 3. Create the admin account
1. Visit your published GitHub Pages URL.
2. Create an account using the exact email configured as `ADMIN_EMAIL`.
3. Sign in, accept the collection notice if you want this browser to send telemetry, then choose **Dashboard**.
4. Other users can create their own accounts and opt in. Only the configured admin account can read the dashboard.

## Data handling
- The backend does not store the raw IP address. It stores a SHA-256 hash of the IP plus Cloudflare's country code when available.
- Passwords are salted and derived with PBKDF2-SHA-256. Session tokens are random, shown only to the browser, and stored hashed in D1.
- Telemetry is not collected before consent. Revoke consent using the button in the page.
- To remove a user's account/data, use the D1 console and delete that user's rows from `events`, `sessions`, and `users` in that order.
- Configure an appropriate retention/deletion policy before inviting real users.

## Security notes
- Keep the D1 database bound only to the Worker; never expose database credentials or admin secrets in HTML.
- Set a Cloudflare rate-limiting rule for `/api/auth/signup` and `/api/auth/login` and consider Turnstile for public signup.
- The dashboard is not a public analytics API: requests require a valid session and the configured admin email.
