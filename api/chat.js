import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';

const MB_BASE    = 'https://api.mindbodyonline.com/public/v6';
const CLIENT_NAME = 'ProSwing Athletic Training';

const REVENUE_KEYWORDS = ['revenue', 'mrr', 'money', 'income', 'profit', 'earnings'];

// ── Module-level member data cache (survives warm invocations) ────────────────
let _cache     = null;
let _cacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

function parseSessionToken(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('octo_session='));
  if (!match) return null;
  return match.slice('octo_session='.length);
}

function verifySession(token, secret) {
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return null;
  const encodedPayload = token.slice(0, lastDot);
  const storedSig      = token.slice(lastDot + 1);
  const derivedSig = crypto.createHmac('sha256', secret).update(encodedPayload).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(derivedSig, 'hex'), Buffer.from(storedSig, 'hex'))) return null;
  } catch { return null; }
  let payload;
  try { payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()); }
  catch { return null; }
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ── Mindbody helpers ──────────────────────────────────────────────────────────

async function mbGetStaffToken() {
  const mbApiKey = process.env.MINDBODY_API_KEY;
  const mbSiteId = process.env.MINDBODY_SITE_ID;
  const mbUser   = process.env.MINDBODY_STAFF_USERNAME;
  const mbPass   = process.env.MINDBODY_STAFF_PASSWORD;
  const res = await fetchWithTimeout(`${MB_BASE}/usertoken/issue`, {
    method: 'POST',
    headers: { 'Api-Key': mbApiKey, 'SiteId': mbSiteId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: mbUser, Password: mbPass })
  });
  if (!res.ok) throw new Error(`Mindbody auth failed: ${res.status}`);
  return (await res.json()).AccessToken;
}

async function mbFetch(path, params, accessToken) {
  const mbApiKey = process.env.MINDBODY_API_KEY;
  const mbSiteId = process.env.MINDBODY_SITE_ID;
  const url = new URL(MB_BASE + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetchWithTimeout(url.toString(), {
    headers: {
      'Api-Key': mbApiKey, 'SiteId': mbSiteId, 'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    }
  });
  if (!res.ok) throw new Error(`MB ${path} failed: ${res.status}`);
  return res.json();
}

// ── Build member context from live Mindbody data ──────────────────────────────

async function buildMemberContext() {
  const now    = Date.now();
  const DAY    = 86400000;
  const LOOKBACK = 60; // days — faster than 180, sufficient for risk scoring

  const accessToken = await mbGetStaffToken();

  // Fetch appointments for lookback window
  const startDate = new Date(now - LOOKBACK * DAY).toISOString().split('T')[0];
  const endDate   = new Date(now).toISOString().split('T')[0];
  const allAppts  = [];
  let offset = 0;

  for (let page = 0; page < 10; page++) {
    if (page > 0) await sleep(200);
    const batch = await mbFetch('/appointment/staffappointments',
      { startDate, endDate, limit: 200, offset }, accessToken);
    const appts = batch.Appointments || [];
    allAppts.push(...appts);
    if (appts.length < 200) break;
    offset += 200;
  }

  // Aggregate per client
  const thirtyAgo = now - 30 * DAY;
  const sixtyAgo  = now - 60 * DAY;
  const sevenAgo  = now -  7 * DAY;
  const byClient  = {};

  for (const appt of allAppts) {
    const cid = String(appt.ClientId || '');
    if (!cid) continue;
    const t = new Date(appt.StartDateTime).getTime();
    if (t > now) continue; // skip future bookings
    if (appt.Status === 'Cancelled' || appt.Status === 'LateCancelled') continue;

    if (!byClient[cid]) byClient[cid] = { lastVisit: 0, last30: 0, prior30: 0, noShows: 0 };
    const c = byClient[cid];
    if (t > c.lastVisit) c.lastVisit = t;
    if (t > thirtyAgo)             c.last30++;
    else if (t > sixtyAgo)         c.prior30++;
    if (appt.Status === 'NoShow')  c.noShows++;
  }

  // Score each client
  const scored = Object.entries(byClient).map(([cid, d]) => {
    const daysSince = d.lastVisit ? Math.floor((now - d.lastVisit) / DAY) : 999;
    const score = Math.min(10, Math.max(0,
      (daysSince / 60) * 40 +
      (d.last30 < d.prior30 ? 25 : 0) +
      (d.noShows * 5)
    ));
    const segment = score >= 7 ? 'at-risk' : 'active';
    return { cid, daysSince, score: parseFloat(score.toFixed(1)), segment,
             last30: d.last30, lastVisit: d.lastVisit };
  });

  scored.sort((a, b) => b.score - a.score);

  const atRisk  = scored.filter(c => c.segment === 'at-risk');
  const active  = scored.filter(c => c.segment === 'active');
  const recent7 = scored.filter(c => c.daysSince <= 7).sort((a, b) => a.daysSince - b.daysSince);

  // Fetch names for top 20 at-risk + top 10 recent
  const idsToName = [...new Set([
    ...atRisk.slice(0, 20).map(c => c.cid),
    ...recent7.slice(0, 10).map(c => c.cid)
  ])];

  const nameMap = {};
  if (idsToName.length > 0) {
    const mbApiKey = process.env.MINDBODY_API_KEY;
    const mbSiteId = process.env.MINDBODY_SITE_ID;
    // Batch in groups of 20
    for (let i = 0; i < idsToName.length; i += 20) {
      if (i > 0) await sleep(150);
      const batchIds = idsToName.slice(i, i + 20);
      const url = new URL(`${MB_BASE}/client/clients`);
      url.searchParams.set('limit', '25');
      batchIds.forEach(id => url.searchParams.append('clientIds', id));
      const res = await fetchWithTimeout(url.toString(), {
        headers: {
          'Api-Key': mbApiKey, 'SiteId': mbSiteId, 'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        for (const m of (data.Clients || [])) {
          const name = `${(m.FirstName || '').trim()} ${(m.LastName || '').trim()}`.trim();
          if (name) nameMap[m.Id] = name;
        }
      }
    }
  }

  const name = (cid) => nameMap[cid] || `Member ${cid}`;

  // Format context
  const ts  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
  const lines = [
    `=== ${CLIENT_NAME} — Live Member Data (as of ${ts} ET) ===`,
    ``,
    `OVERVIEW`,
    `  Members with activity in last 60 days: ${scored.length}`,
    `  At-risk: ${atRisk.length}  |  Active: ${active.length}`,
    `  Visited in last 7 days: ${recent7.length}`,
    ``,
    `AT-RISK MEMBERS (need outreach — worst first):`,
  ];

  atRisk.slice(0, 20).forEach((c, i) => {
    lines.push(`  ${i + 1}. ${name(c.cid)} — ${c.daysSince} days since last visit, score ${c.score}, ${c.last30} visits in last 30 days`);
  });
  if (atRisk.length > 20) lines.push(`  ...and ${atRisk.length - 20} more at-risk members`);

  lines.push(``, `RECENTLY ACTIVE (last 7 days):`);
  if (recent7.length === 0) {
    lines.push(`  No visits recorded in the last 7 days.`);
  } else {
    recent7.slice(0, 10).forEach(c => {
      lines.push(`  - ${name(c.cid)} — ${c.daysSince === 0 ? 'today' : c.daysSince + ' day(s) ago'}`);
    });
  }

  return lines.join('\n');
}

async function getMemberContext() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;
  const ctx   = await buildMemberContext();
  _cache      = ctx;
  _cacheTime  = Date.now();
  return ctx;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) throw new Error('AUTH_SECRET is not set');

  const token = parseSessionToken(req.headers.cookie);
  if (!token) return res.status(401).json({ error: 'Session expired. Please log in.' });

  const payload = verifySession(token, authSecret);
  if (!payload) return res.status(401).json({ error: 'Session expired. Please log in.' });

  const { question } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question is required' });
  }
  if (question.length > 1000) {
    return res.status(400).json({ error: 'Question too long (max 1000 characters).' });
  }

  const lowerQ = question.toLowerCase();
  if (!payload.permissions?.canViewRevenue && REVENUE_KEYWORDS.some(kw => lowerQ.includes(kw))) {
    return res.status(403).json({ error: 'Revenue data requires owner access.' });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is not set');

  // Fetch live member context (cached for 1 hour)
  let memberContext = '';
  try {
    memberContext = await getMemberContext();
  } catch (e) {
    console.error('[chat] Member context fetch failed:', e.message);
    memberContext = '(Live member data temporarily unavailable.)';
  }

  try {
    const client = new Anthropic({ apiKey: anthropicKey });

    const message = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 600,
      system: `You are Otto, the AI business partner for ${CLIENT_NAME}. You serve as their marketing manager, CFO, and operations director all in one. You have access to live member data pulled directly from their Mindbody system.

Your voice: direct and specific. Use real member names and dollar amounts. End every response with one clear recommended action. Keep responses under 120 words for mobile readability. Never say you don't have data — you do.

${memberContext}`,
      messages: [{ role: 'user', content: question }]
    });

    const answer = message.content?.[0]?.text || 'No response received.';
    return res.status(200).json({ answer });
  } catch (e) {
    console.error('[chat] Claude API error:', e.message, e.status ?? '');
    return res.status(500).json({ error: e.message });
  }
}
