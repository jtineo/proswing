# OctoEmployee — ProSwing Athletic Training

AI-powered business coach for fitness studios. Members log in via SMS PIN. Staff ask questions about at-risk members, revenue, and churn in a mobile chat interface. Nightly Mindbody sync scores every member for risk and updates GoHighLevel. Monthly report delivers ROI numbers by SMS.

---

## System Overview

| File | What it does |
|---|---|
| `index.html` | The entire app: PWA login screens + dashboard (no framework, no build step) |
| `manifest.json` | Makes the app installable on iPhone home screen |
| `service-worker.js` | Offline mode + Web Push notification handler |
| `api/chat.js` | Accepts a question, verifies session, calls Claude, returns answer |
| `api/sync.js` | Pulls all Mindbody members, scores risk, writes to GoHighLevel contacts |
| `api/report.js` | Generates monthly ROI report via Claude and sends it by SMS |
| `api/briefing.js` | Sends a Monday morning SMS briefing to the studio owner |
| `api/auth/request.js` | Validates phone, generates 6-digit PIN, sends via GHL SMS |
| `api/auth/verify.js` | Validates PIN, issues 30-day HttpOnly session cookie |
| `api/auth/logout.js` | Clears session cookie |
| `api/auth/status.js` | Checks if current session cookie is valid |
| `api/admin/users.js` | Add, remove, or list users without redeployment |
| `config/users.json` | User roster: phone numbers, GHL contact IDs, roles |
| `vercel.json` | Routing rules, security headers, function timeouts |

---

## Environment Variables

Copy `.env.example` to `.env` and fill in every value. Also add all of these to the Vercel dashboard (Project → Environment Variables) — this is the most common cause of production failures.

| Variable | How to get it |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| `GHL_API_KEY` | GHL → Settings → Integrations → API Keys (use Agency key) |
| `GHL_LOCATION_ID` | GHL → Sub-account → Settings → Business Profile → Location ID |
| `MINDBODY_API_KEY` | [developers.mindbodyonline.com](https://developers.mindbodyonline.com) → Your App |
| `MINDBODY_SITE_ID` | Mindbody → Account Settings → Site ID |
| `AUTH_SECRET` | Generate below |
| `PIN_STORE_SECRET` | Generate below |
| `ADMIN_TOKEN` | Generate below |
| `AGENCY_OWNER_CONTACT_ID` | GHL → Contacts → agency owner → copy ID from URL |

---

## Generate Secrets

Run these once in your terminal and paste the output into `.env` and Vercel:

```bash
# AUTH_SECRET (64-char hex)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# PIN_STORE_SECRET (32-char hex)
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"

# ADMIN_TOKEN (64-char hex)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## GitHub + Vercel Deployment

1. Create a new GitHub repo and push this code:
   ```bash
   git init
   git add -A
   git commit -m "Initial deploy"
   git remote add origin https://github.com/YOUR_ORG/octoemployee-proswing.git
   git push -u origin master
   ```

2. Go to [vercel.com](https://vercel.com) → Add New Project → import the GitHub repo.

3. In Vercel project settings → Environment Variables, add every variable from the table above. Add to **both** Production and Preview environments.

4. After deploy, Vercel auto-deploys on every push to `master`.

---

## GHL Workflow Configuration

Set up three GHL workflows to call the protected endpoints on a schedule:

**Nightly Sync** (runs 2am daily):
- Trigger: Time-based, every day at 2:00am
- Action: HTTP Request
  - Method: POST
  - URL: `https://your-project.vercel.app/api/sync`
  - Headers: `Authorization: Bearer YOUR_ADMIN_TOKEN`
  - Body: `{"clientId":"proswing-001"}`

**Monthly Report** (runs 1st of each month):
- Trigger: Time-based, 1st of month at 9:00am
- Action: HTTP Request
  - Method: POST
  - URL: `https://your-project.vercel.app/api/report`
  - Headers: `Authorization: Bearer YOUR_ADMIN_TOKEN`
  - Body: `{"clientId":"proswing-001"}`

**Monday Briefing** (runs every Monday):
- Trigger: Time-based, every Monday at 8:00am
- Action: HTTP Request
  - Method: POST
  - URL: `https://your-project.vercel.app/api/briefing`
  - Headers: `Authorization: Bearer YOUR_ADMIN_TOKEN`
  - Body: `{"clientId":"proswing-001"}`

---

## Manual Endpoint Testing

```bash
# Check session status (should return 401 when not logged in)
curl https://your-project.vercel.app/api/auth/status

# Request a PIN (replace with a real authorized phone number)
curl -X POST https://your-project.vercel.app/api/auth/request \
  -H "Content-Type: application/json" \
  -d '{"phone":"7045550001"}'

# Trigger a manual sync
curl -X POST https://your-project.vercel.app/api/sync \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"clientId":"proswing-001"}'

# Trigger a manual report
curl -X POST https://your-project.vercel.app/api/report \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"clientId":"proswing-001"}'

# Trigger Monday briefing
curl -X POST https://your-project.vercel.app/api/briefing \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"clientId":"proswing-001"}'
```

---

## User Management

All user changes go through the admin API. Requires `x-admin-token` header.

**List all users** (phone numbers are masked):
```bash
curl -X POST https://your-project.vercel.app/api/admin/users \
  -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"list"}'
```

**Add a user:**
```bash
curl -X POST https://your-project.vercel.app/api/admin/users \
  -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "add",
    "user": {
      "name": "Jane Smith",
      "phone": "7045550002",
      "role": "manager",
      "ghlContactId": "GHL_CONTACT_ID_HERE"
    }
  }'
```

Valid roles: `owner`, `manager`, `staff`

**Remove a user** (sets active = false, does not delete):
```bash
curl -X POST https://your-project.vercel.app/api/admin/users \
  -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"remove","user":{"phone":"7045550002"}}'
```

To add the user to `config/users.json` permanently (persists across cold starts), edit the file directly and redeploy.

---

## Replicating for a New Client

1. Duplicate this entire repo.
2. In `index.html` update `CLIENT_NAME` and `CLIENT_ID` at the top of the script block.
3. In `config/users.json` update `clientId`, `clientName`, and replace the users array.
4. Generate new `AUTH_SECRET`, `PIN_STORE_SECRET`, and `ADMIN_TOKEN` (never reuse across clients).
5. Create a new Vercel project linked to the new repo.
6. Add all environment variables for the new client to the Vercel dashboard.
7. Set up GHL workflows pointing to the new Vercel URL.
8. Test locally, then deploy.
