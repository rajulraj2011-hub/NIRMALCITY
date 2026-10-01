# NirmalCity — Flask + MongoDB

The Flask app serves the frontend and REST API from the same origin. Accounts, complaints, pickup requests, report status, and complaint photo paths are stored in MongoDB. Uploaded photos are stored on disk in `uploads/` (or `UPLOAD_DIR`); MongoDB stores the relative photo path, not the image binary.

## Run on Windows

1. Install/start MongoDB Community Server, or create a MongoDB Atlas database.
2. From this directory, run:

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

3. Edit `.env`: set `MONGO_URI`, and replace `JWT_SECRET` with a long random secret. Set `ADMIN_EMAIL` to the email that should receive admin access.

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

   The app refuses to start while `JWT_SECRET` is missing, shorter than 32 characters, or still the example placeholder — a known secret would let anyone forge an admin session.

4. Start the app:

```powershell
python app.py
```

Open <http://127.0.0.1:5000>. Check database connectivity at <http://127.0.0.1:5000/api/health>. Sign up with the configured `ADMIN_EMAIL` — sign-up is a three-step flow (email → 6-digit OTP sent by email → set password), so the admin account needs mailbox access (or SMTP left unconfigured for dev mode). New admin status is assigned only by the server; it cannot be requested from the frontend.

To grant admin to an account that already exists (for example, if `ADMIN_EMAIL` was added after that user signed up):

```powershell
python app.py make-admin someone@example.com
```

For GPS, use `localhost`/`127.0.0.1` during development. Browsers require HTTPS for location access on deployed sites. Users must grant location permission; they can also type the location manually. Reverse geocoding turns coordinates into a short label such as `Saket Nagar, Kanpur` through `GET /api/geocode/reverse` (see below).

## API

All protected routes require `Authorization: Bearer <token>`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Backend, MongoDB, and upload-directory health |
| POST | `/api/auth/signup` | **Step 1:** validate the email and send a unique 6-digit OTP (returns a masked address; in dev mode — no SMTP credentials — the code comes back as `dev_otp`) |
| POST | `/api/auth/resend-otp` | Send a fresh code (60 s cooldown, previous code invalidated) |
| POST | `/api/auth/verify-otp` | **Step 2:** check the code (5 wrong attempts / 15 min, 5-minute validity) and issue a 10-minute `setup_token` |
| POST | `/api/auth/set-password` | **Step 3:** with the `setup_token`, set the password — the account is created and a token returned |
| POST | `/api/auth/forgot-password` | **Forgot-password step 1:** email a 6-digit reset code to a registered address (same cooldown/expiry rules; `400` when no account exists) |
| POST | `/api/auth/resend-reset-otp` | Send a fresh reset code (60 s cooldown, previous code invalidated) |
| POST | `/api/auth/verify-reset-otp` | **Step 2:** check the code and issue a 10-minute single-use `reset_token` (bound to the address and its `session_epoch`) |
| POST | `/api/auth/reset-password` | **Step 3:** with the `reset_token`, set a new password — every earlier session is invalidated and the caller is signed in |
| POST | `/api/auth/login` | Login and return token |
| POST | `/api/auth/logout` | Revoke the current token on the server |
| GET | `/api/auth/me` | Restore the signed-in account |
| POST | `/api/reports` | Create complaint using multipart form fields `location`, `problem_type`, `details`, optional `latitude`, `longitude`, and `photo`. Runs Gemini verification and returns the verdict in `complaint.verification` |
| GET | `/api/geocode/reverse?lat=..&lon=..` | Coordinates to a short label (`latitude`/`longitude` accepted too) |
| GET | `/api/reports/mine` | Current user's complaints (`?limit=`, default 100, max 500) |
| GET | `/api/reports` | Admin live-monitor complaint list (`?limit=`, max 500). AI-rejected reports are filtered out |
| PATCH | `/api/reports/<id>/status` | Admin sets `Pending`, `In Progress`, or `Resolved` |
| POST | `/api/pickups` | Create pickup request (`address`, `pickup_date` as `YYYY-MM-DD`, not in the past) |
| GET | `/api/pickups` | Admin pickup request list (`?limit=`, max 500) |
| PATCH | `/api/pickups/<id>/status` | Admin sets `Pending`, `In Progress`, or `Resolved` |
| GET | `/api/activity/mine` | Current user's complaints and pickup requests (`?limit=`) |
| GET | `/api/admin/coupons/feed` | Admin: coupon-feed status — last run, next due, active auto-code count, per-source pages, and which tracked sites publish no paste codes |
| POST | `/api/admin/coupons/refresh` | Admin: start a feed refresh now (background; poll the status endpoint). Rate-limited (6 per hour) |

List endpoints are capped: unbounded "load everything" queries were replaced with a `limit` parameter.

### Behaviour worth knowing

- **Reverse geocoding.** The browser no longer calls Nominatim directly — it answered `403` for this deployment, which left users with `Lat .., Lon ..` in the location box. The request now goes through `GET /api/geocode/reverse`, which runs server-side with a proper User-Agent, prefers Photon (OpenStreetMap) and falls back to BigDataCloud, keeps a small in-memory cache (rounded to ~11 m), and is rate-limited (120/h per IP). It returns `{"label": "Usmanpur, Kanpur"}` — or `{"label": null}`, in which case the client keeps the coordinate text, so GPS still works offline.
- **Signed photo URLs.** `/uploads/...` links returned by the API carry an expiring `exp`/`sig` pair (`PHOTO_URL_TTL_HOURS`, default 24 h). Opening one without a signature, or with an expired/tampered one, returns 401. A request that presents a valid `Authorization: Bearer` token is also accepted. If the underlying file is gone, the admin/activity tables show a page icon instead of a broken image.
- **List thumbnails.** Each upload also gets a ≤320 px JPEG preview (`<uuid>.thumb.jpg`, tuned with `THUMB_SIZE`/`THUMB_QUALITY`) generated server-side by Pillow, signed exactly like the original. The Live Monitor list loads these previews; the full-resolution original is only fetched when **Open Photo** is clicked. Records uploaded before thumbnails existed — or when Pillow is missing or cannot decode the file — fall back to the original path, so a thumbnail failure never breaks a report.
- **Live Monitor details & photo viewer.** Every complaint row has a **👁 Details** button (all metadata: id, reporter, coordinates, status, timestamps) and, when a photo is attached, a **📷 Photo** button that opens a lightbox with zoom in/out, reset, fit-to-screen, drag-to-pan, mouse-wheel zoom, and Esc/backdrop close. Entries without a photo show a muted "No photo" label; a photo whose file has vanished shows a message instead of a broken image.
- **Track (My Activity).** Residents see their own full history (reports + pickups, verified and rejected, with AI verdicts) in the same row layout as the Live Monitor, with working **👁 Details** and **📷 Photo** buttons. For an **admin** the same section becomes a monitoring view over *everyone's* reports: an **"In Progress"** group (all in-progress requests, any user) followed by the **"Latest 3 new reports"** group — status dropdowns included, AI-rejected reports excluded.
- **Gemini report verification.** Every new complaint is sent to the Gemini API (`GEMINI_API_KEY`, model `GEMINI_MODEL`, default `gemini-2.5-flash`) with its photo, description, problem type, and location; the model answers `{"verdict": "genuine"|"fake", "confidence", "reason"}`. The verdict is stored in `verification: {status, reason, confidence, model, checked_at}`:
  - `verified` → shown in the admin Live Monitor with a green **✓ AI Verified** chip.
  - `rejected` → **never reaches the admin portal**; the resident still sees it in Track with a red **✗ AI Rejected** chip and the reason, so fake reports cannot slip into the queue while remaining visible to their author.
  - `pending` → the API was unreachable, the key is missing, or the reply was unusable. Reports still reach admins, flagged **⏳ Review needed** (a Gemini outage must not drop real complaints). Set `ONLY_VERIFIED_TO_ADMIN=true` to hide these too.
  Photos over ~1.5 MB are downscaled in memory before upload, prompt-injection text inside complaints is explicitly ignored, and the verifier never raises — verification can fail, the report cannot. Complaints saved before this feature exist without the field and are treated as grandfathered (always listed). The submit alert tells the resident the verdict immediately.
- **Rewards: points + coupons.** Every report Gemini verifies as genuine immediately pays its author **10 points** (`REWARD_POINTS`), recorded in a `rewards` collection; rejected and pending reports pay nothing. The resident's **Rewards** tab (the former Pickup section — its request form was removed) shows only a **🎁 Reward Earnings** panel with the point balance, the per-report earnings list, and a **partner coupon catalog of real, working codes** curated in `COUPON_CATALOG` — every entry carries the real partner `code`, its `valid_til` expiry, a `verified_on` date and a `source` link, and the panel shows all three. Offers past their `valid_til` are filtered out of `GET /api/rewards` and rejected with 400 on redeem, so expired coupons are never shown; the hand-verified seeds live in `COUPON_CATALOG` (edit it to add/remove a seed), while fresh codes also arrive automatically every 4 days through the coupon feed described below. Spending points via `POST /api/rewards/redeem` unlocks an offer exactly once: points are deducted with an atomic balance guard and the **real partner code** (plus visit URL, validity and source) is stored in the `redemptions` collection and revealed with a copy button — no generated placeholder codes. Double unlocks return 409, insufficient points 400. (Amazon.in and Flipkart are deliberately absent: their own help pages state they issue no paste-in promo codes — only "collect" coupons and bank offers.)
- **Automatic coupon feed (every 4 days).** `coupon_feed.py` re-scans the ten named Indian coupon sources on a schedule (`COUPON_REFRESH_DAYS`, default 4 days — a daemon thread started with the server under `__main__`, re-checking every `COUPON_FEED_CHECK_MINUTES`, default 360) and merges what it verifies into a `partner_coupons` collection that `GET /api/rewards` appends after the hand-verified seeds. Five sources serve real paste codes in their public HTML and are scraped: **GrabOn** (6 brand pages), **CouponDunia** (6), **GoPaisa** (4), **Cashaly** (5 store pages plus their per-coupon reveal pages) and **PaisaWapas** (2); the other five named sites — **CashKaro, Zingoy, DesiDime, DealZap, Magicpin** — never publish paste codes to logged-out visitors (login-gated reveal, redirect-only deals, client-side-only code strings, or cashback with no codes at all), so they are listed in the feed status with that reason instead of being scraped blindly. Every cycle: new codes are added (deduped by website+code, seeds always win the collision, capped at 6 active per site / 30 overall), codes seen again get `verified_on` bumped and keep the farthest validity, codes missing from two consecutive *successful* scans are staled out, entries past `valid_til` are expired out — and a page that returns zero codes is treated as a suspected parse break and never penalises existing entries. Codes are validated against a shape check and a generic-word blacklist (`CODE`, `CASHBACK`, `OFF`…), only real paste codes are kept, and each auto entry shows an `auto-verified via <site>` badge plus its source URL in the UI. Admins get a **🔄 Automatic Coupon Feed** card in the admin panel (last run, sources, honest no-code list, **↻ Refresh now**) backed by `GET /api/admin/coupons/feed` and `POST /api/admin/coupons/refresh` — admin-only, rate-limited, single-run-locked; a failed run does not consume the schedule, so the next check retries. Source pages are fetched read-only with a browser User-Agent and a politeness delay (`COUPON_FETCH_DELAY`), and the tests exercise every parser plus the whole add/re-verify/stale/expiry lifecycle from canned pages with no network access.
- **Admin panel scope.** The admin panel shows only the Live Monitor (complaints). Pickup requests were removed from it, and admin accounts do not see the **Rewards** option in the navigation at all. The pickup *request form* was removed from the resident portal too — the `GET /api/pickups` and `PATCH /api/pickups/<id>/status` endpoints still exist (unchanged API surface), and pickups scheduled before the removal still appear in residents' Track history.
- **Upload validation.** Files are checked against real image signatures (JPEG/PNG/GIF/WEBP bytes), not just the client-declared MIME type, and are written to disk only after the complaint record is created — a failed insert or rejected request never leaves an orphaned file.
- **Rate limits.** Login (10 per 5 min per account, 30 per 5 min per IP), signup (20 per hour per IP), and report creation (60 per hour per user) return `429` with a `Retry-After` header. Tunable via `AUTH_LOGIN_LIMIT`, `AUTH_LOGIN_IP_LIMIT`, `AUTH_SIGNUP_LIMIT`, `REPORT_LIMIT`.
- **Sessions.** Logout bumps a server-side epoch, so the token stops working immediately instead of staying valid until `JWT_HOURS`.
- **CORS.** Only enabled when `CORS_ORIGINS` is set; there is no `*` default. Same-origin deployments need no CORS at all.
- **Security headers.** `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and a Content-Security-Policy are applied to every response.

Password validation rejects anything over 128 characters before hashing (a slow-hash denial-of-service guard). Passwords are stored as Werkzeug password hashes. Sign-up requires email OTP verification end-to-end: each attempt emails a unique 6-digit code via SMTP (`SMTP_USER`/`SMTP_PASSWORD`, Gmail app password), the code is stored **hashed** (SHA-256, bound to the address) for 5 minutes with a 60-second resend cooldown and a 5-attempt limit, and only a verified address receives the short-lived `setup_token` that can set a password. Without SMTP credentials the server runs in dev mode: the code is logged and returned as `dev_otp` so local sign-up still works — real deployments must configure SMTP, since `ADMIN_EMAIL` is only as trustworthy as this flow. **Password reset** (`Forgot password?` on the login page) reuses the same OTP machinery for registered addresses only: the emailed code carries password-reset wording, the resulting `reset_token` is bound to the account's `session_epoch` (one successful reset bumps the epoch, so the token is single-use), and completing a reset bumps `session_epoch` as well — every session token issued before the reset stops working immediately.

## Tests

The suite writes to a separate `nirmalcity_test` database, so it never touches real data. MongoDB must be running.

```powershell
python -m pytest tests/ -v
```

It covers signup (the full email → OTP → password flow, including wrong/expired/single-use codes and the setup-token guard), password reset (forgot-password → OTP → new password, unknown addresses, cooldown, expiry, old-password death, session invalidation, and single-use reset tokens), login/logout, authorization (user vs. admin), report and pickup validation, photo signing and thumbnail generation, Gemini verification verdicts and admin filtering, oversized uploads, rate limiting, pagination, status transitions, and the automatic coupon feed (every source parser against canned pages, the add / re-verify / stale / expire lifecycle, seed-code dedupe, per-site caps, the not-due skip, the admin feed endpoints with their rate limit, and redemption of an auto-discovered code). Autouse fixtures stub the verifier and the OTP mailer, and the feed tests monkeypatch the page fetcher, so tests never call the real Gemini API, SMTP, or any coupon site.

## Deployment notes

- Set a unique, private `JWT_SECRET`; do not commit `.env`.
- Use HTTPS, restrict `CORS_ORIGINS`, and put the app behind a production WSGI server (the built-in `app.run` server is for development only).
- `ADMIN_EMAIL` only grants admin role at signup. Set it before registering the admin user, or use `make-admin` afterwards.
- Uploaded photos are kept on the app server's filesystem. Use persistent storage or object storage if deploying on ephemeral hosting.
- The rate limiter is in-memory and single-process; use a shared store if you scale to multiple workers.
