# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OctoEmployee for ProSwing Athletic Training. A mobile-first PWA (v0.10) deployed on Vercel. Staff log in via email PIN, then chat with **Otto** — an AI business partner (Claude) that has live access to Mindbody member data. Nightly sync scores all members for churn risk and writes results to GoHighLevel CRM.

No framework, no build step, no bundler. The entire frontend is `index.html`. Every backend endpoint is a Vercel serverless function under `api/`.

## Deploying

Push to `main` — Vercel auto-deploys. No CLI needed.

```bash
git add <files>
git commit -m "description"
git push
```

Or use the `/update-proswing` slash command in Claude Code, which commits, pushes, and runs a live sync in one step.

## Testing endpoints locally

Vercel CLI (`vercel dev`) will run the functions locally. Alternatively, test the live deployment directly:

```bash
# Check auth status
curl https://octo-proswing.vercel.app/api/auth/status

# Request a login PIN
curl -X POST https://octo-proswing.vercel.app/api/auth/request \
  -H "Content-Type: application/json" \
  -d '{"email":"dan@proswing.com"}'

# Trigger sync (requires ADMIN_TOKEN from .env)
curl -X POST https://octo-proswing.vercel.app/api/sync \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"clientId":"octo-proswing-001"}'
```

## Architecture

### Auth flow
1. `api/auth/request.js` — validates email against `config/users.json`, generates a 6-digit PIN, HMAC-hashes it with `PIN_STORE_SECRET`, stores in an in-memory `Map`, and sends the plain PIN via GHL email conversations API (v1).
2. `api/auth/verify.js` — re-hashes the submitted PIN and compares with `timingSafeEqual`. On success, issues a 30-day `octo_session` HttpOnly cookie (base64url payload + HMAC-SHA256 signature using `AUTH_SECRET`). Max 5 attempts before lockout.
3. `api/auth/logout.js` — clears the `octo_session` cookie.
4. `api/auth/status.js` — returns current session validity (used by the frontend to gate the chat UI).
5. All protected endpoints (`api/chat.js`) verify the session cookie by re-deriving the HMAC and checking expiry.

**PIN store is an in-memory module-level `Map` in `request.js`, shared with `verify.js` via ES module import.** This means PINs do not survive a cold start — users must re-request if the function instance goes cold.

### GHL API usage
Two different base URLs are used:
- `https://rest.gohighlevel.com/v1` — SMS sending only (`/conversations/messages`)
- `https://services.leadconnectorhq.com` — contact listing, creating, updating custom fields, and setting `externalId`

Custom field updates use the v2 API with **field IDs** (not key names). The key→ID map lives at the top of `api/sync.js`. Format:
```js
{ customFields: [{ id: '<field_id>', field_value: value }] }
// Header: 'Version': '2021-07-28'
```

The GHL contact's built-in `externalId` field stores the Mindbody client ID. This is set via `PUT /contacts/:id` with `{ externalId: String(mbClientId) }` and is used as the primary match key during sync.

### Mindbody API usage
- Auth: staff username/password → `POST /usertoken/issue` → `AccessToken` (Bearer token)
- Visit history is pulled from `/appointment/staffappointments` (not `/client/visits`) — the appointments endpoint returns all client visits and is paginated with `limit`/`offset`
- Client details fetched in batches of 20 via `/client/clients?clientIds[]=...`

### Risk scoring (`api/sync.js`)
Score 0–10 based on: days since last visit (40%), visit frequency drop last 30 vs prior 30 days (25%), upcoming package expiry within 14 days (20%), no-shows (5 pts each). Score ≥ 7 = `at-risk`, score < 4 with high lifetime value = `vip`, else `active`.

### Chat (`api/chat.js`)
On each request, pulls live Mindbody appointments for the last 60 days, scores every client, fetches names for the top 20 at-risk + 10 recently active, and injects a plain-text summary into the Claude system prompt. Result cached in-memory for 1 hour. Revenue questions are role-gated — only `owner` role can ask about money.

### Contact linking (`api/link.js`)
One-time (or periodic) endpoint that links Mindbody members to GHL contacts by writing the Mindbody client ID into GHL's `externalId` field. Run this after initial setup or whenever new MB members need to be synced to GHL.

- Fetches appointments from the last 180 days to identify active members
- Matches existing GHL contacts by `externalId` → email → phone
- Creates a new GHL contact if no match found
- Caps at 40 updates per run to stay within Vercel's 60s function timeout
- Accepts optional `offset` body param to paginate across multiple calls — response includes `nextOffset` (null when complete)
- Protected by `ADMIN_TOKEN`

### User management
`config/users.json` is read at runtime via `fs.readFileSync`. Active users: **Dan Gray** (owner, `jaime+proswing@tineo.me`). To add/remove users without redeploying, use `api/admin/users.js` (requires `x-admin-token` header) — changes are in-memory only and reset on cold start. For permanent changes, edit the file and push.

## Environment variables

All secrets live in `.env` locally and must also be added to the Vercel dashboard (Project → Environment Variables → Production + Preview). Missing dashboard vars are the #1 cause of production failures.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API (Otto's brain) |
| `GHL_API_KEY` | GoHighLevel agency-level key |
| `GHL_LOCATION_ID` | GHL sub-account location ID |
| `MINDBODY_API_KEY` | Mindbody developer API key |
| `MINDBODY_SITE_ID` | Mindbody numeric site ID |
| `MINDBODY_STAFF_USERNAME` | Dedicated API staff account username |
| `MINDBODY_STAFF_PASSWORD` | Dedicated API staff account password |
| `AUTH_SECRET` | 64-char hex — signs session cookies |
| `PIN_STORE_SECRET` | 32-char hex — HMAC-hashes PINs |
| `ADMIN_TOKEN` | 64-char hex — protects `/api/sync`, `/api/report`, `/api/briefing`, `/api/link` |
| `AGENCY_OWNER_CONTACT_ID` | GHL contact ID that receives sync failure alerts |

## Scheduled jobs (via GHL workflows)

Three GHL HTTP Request workflows call the protected endpoints:
- **Nightly sync** — 2am daily → `POST /api/sync`
- **Monthly report** — 1st of month 9am → `POST /api/report`
- **Monday briefing** — Monday 8am → `POST /api/briefing`

All require `Authorization: Bearer <ADMIN_TOKEN>` and `{"clientId":"octo-proswing-001"}` body.

---

_Last updated: 2026-03-29 (v2)_
