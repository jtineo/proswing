import crypto from 'crypto';

const MB_BASE  = 'https://api.mindbodyonline.com/public/v6';
const GHL_BASE = 'https://rest.gohighlevel.com/v1';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

function verifyAdminToken(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) throw new Error('ADMIN_TOKEN is not set');
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return false;
  const provided = authHeader.slice(7);
  try {
    return crypto.timingSafeEqual(Buffer.from(adminToken), Buffer.from(provided));
  } catch { return false; }
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

async function mbGetStaffToken() {
  const mbApiKey = process.env.MINDBODY_API_KEY;
  const mbSiteId = process.env.MINDBODY_SITE_ID;
  const mbUser   = process.env.MINDBODY_STAFF_USERNAME;
  const mbPass   = process.env.MINDBODY_STAFF_PASSWORD;
  if (!mbApiKey || !mbSiteId || !mbUser || !mbPass) {
    throw new Error('Missing required MINDBODY env vars');
  }
  const res = await fetchWithTimeout(`${MB_BASE}/usertoken/issue`, {
    method: 'POST',
    headers: { 'Api-Key': mbApiKey, 'SiteId': mbSiteId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: mbUser, Password: mbPass })
  });
  if (!res.ok) throw new Error(`Mindbody auth failed: ${res.status}`);
  const data = await res.json();
  return data.AccessToken;
}

async function mbGet(path, params, accessToken) {
  const mbApiKey = process.env.MINDBODY_API_KEY;
  const mbSiteId = process.env.MINDBODY_SITE_ID;
  const url = new URL(MB_BASE + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = {
    'Api-Key': mbApiKey, 'SiteId': mbSiteId, 'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`
  };
  const res = await fetchWithTimeout(url.toString(), { headers });
  if (!res.ok) throw new Error(`Mindbody ${path} failed: ${res.status}`);
  return res.json();
}

async function mbUpdateClientExternalId(clientId, externalId, accessToken) {
  const mbApiKey = process.env.MINDBODY_API_KEY;
  const mbSiteId = process.env.MINDBODY_SITE_ID;
  const res = await fetchWithTimeout(`${MB_BASE}/client/updateclient`, {
    method: 'POST',
    headers: {
      'Api-Key': mbApiKey, 'SiteId': mbSiteId, 'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ Client: { Id: clientId, ExternalId: externalId } })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`updateclient failed ${res.status}: ${body.substring(0, 100)}`);
  }
  return res.json();
}

async function fetchAllGhlContacts(ghlKey) {
  const contacts = [];
  let startAfterId = null;

  for (let page = 0; page < 20; page++) {
    if (page > 0) await sleep(300);
    const url = new URL(`${GHL_BASE}/contacts/`);
    url.searchParams.set('limit', '100');
    if (startAfterId) url.searchParams.set('startAfter', startAfterId);

    const res = await fetchWithTimeout(url.toString(), {
      headers: { 'Authorization': `Bearer ${ghlKey}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) break;
    const data = await res.json();
    const batch = data.contacts || [];
    contacts.push(...batch);
    if (batch.length < 100) break;
    startAfterId = batch[batch.length - 1].id;
  }

  return contacts;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!verifyAdminToken(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ghlKey   = process.env.GHL_API_KEY;
  const mbApiKey = process.env.MINDBODY_API_KEY;
  const mbSiteId = process.env.MINDBODY_SITE_ID;
  if (!ghlKey)   throw new Error('GHL_API_KEY is not set');
  if (!mbApiKey) throw new Error('MINDBODY_API_KEY is not set');
  if (!mbSiteId) throw new Error('MINDBODY_SITE_ID is not set');

  const MAX_UPDATES = 40; // stay within Vercel 60s limit — run again if needed
  const lookbackDays = 180;

  // ── Step 1: Mindbody auth ──────────────────────────────
  const accessToken = await mbGetStaffToken();

  // ── Step 2: Fetch appointments, build active client ID set ─
  const apptStartDate = new Date(Date.now() - lookbackDays * 86400000).toISOString().split('T')[0];
  const apptEndDate   = new Date().toISOString().split('T')[0];
  const activeClientIds = new Set();
  let apptOffset = 0;

  for (let page = 0; page < 15; page++) {
    if (page > 0) await sleep(300);
    const batch = await mbGet('/appointment/staffappointments', {
      startDate: apptStartDate, endDate: apptEndDate, limit: 200, offset: apptOffset
    }, accessToken);
    const appts = batch.Appointments || [];
    for (const a of appts) {
      if (a.ClientId) activeClientIds.add(String(a.ClientId));
    }
    if (appts.length < 200) break;
    apptOffset += 200;
  }

  // ── Step 3: Fetch active members in batches of 20 ─────
  const apptClientIds = [...activeClientIds];
  const members = [];
  const BATCH = 20;

  for (let i = 0; i < Math.min(apptClientIds.length, 400); i += BATCH) {
    if (i > 0) await sleep(250);
    const batchIds = apptClientIds.slice(i, i + BATCH);
    const url = new URL(`${MB_BASE}/client/clients`);
    url.searchParams.set('limit', String(BATCH + 5));
    batchIds.forEach(id => url.searchParams.append('clientIds', id));
    const mbRes = await fetchWithTimeout(url.toString(), {
      headers: {
        'Api-Key': mbApiKey, 'SiteId': mbSiteId, 'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });
    if (mbRes.ok) {
      const data = await mbRes.json();
      members.push(...(data.Clients || []));
    }
  }

  // ── Step 4: Fetch all GHL contacts, build lookup maps ─
  const ghlContacts = await fetchAllGhlContacts(ghlKey);
  const byEmail = {};
  const byPhone = {};
  for (const c of ghlContacts) {
    if (c.email) byEmail[c.email.toLowerCase()] = c.id;
    const norm = normalizePhone(c.phone);
    if (norm) byPhone[norm] = c.id;
  }

  // ── Step 5: Match and link ─────────────────────────────
  let linked    = 0;
  let alreadyLinked = 0;
  let unmatched = 0;
  let updateErrors = 0;
  const errors = [];

  for (const member of members) {
    // Skip if already linked
    if (member.ExternalId) {
      alreadyLinked++;
      continue;
    }

    // Try email first, then each phone field
    const email = (member.Email || '').toLowerCase();
    const phones = [member.MobilePhone, member.HomePhone, member.WorkPhone]
      .map(normalizePhone).filter(Boolean);

    let ghlContactId = null;
    if (email && byEmail[email]) ghlContactId = byEmail[email];
    if (!ghlContactId) {
      for (const p of phones) {
        if (byPhone[p]) { ghlContactId = byPhone[p]; break; }
      }
    }

    if (!ghlContactId) {
      unmatched++;
      continue;
    }

    if (linked >= MAX_UPDATES) continue; // reached cap — counted as unmatched for this run

    try {
      await sleep(100);
      await mbUpdateClientExternalId(member.Id, ghlContactId, accessToken);
      linked++;
    } catch (e) {
      updateErrors++;
      errors.push(`${member.Id}: ${e.message}`);
    }
  }

  const remaining = members.filter(m => !m.ExternalId).length - linked - updateErrors - unmatched;

  return res.status(200).json({
    success: true,
    activeMembers: members.length,
    ghlContacts: ghlContacts.length,
    alreadyLinked,
    linked,
    unmatched,
    updateErrors,
    remaining: Math.max(0, remaining),
    errors: errors.slice(0, 5)
  });
}
