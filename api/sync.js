import crypto from 'crypto';

const MB_BASE   = 'https://api.mindbodyonline.com/public/v6';
const GHL_BASE  = 'https://rest.gohighlevel.com/v1';
const GHL_BASE2 = 'https://services.leadconnectorhq.com';

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
    return crypto.timingSafeEqual(
      Buffer.from(adminToken),
      Buffer.from(provided)
    );
  } catch {
    return false;
  }
}

async function ghlSendSms(contactId, message) {
  const ghlKey = process.env.GHL_API_KEY;
  await fetchWithTimeout(`${GHL_BASE}/conversations/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghlKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type: 'SMS', contactId, message })
  });
}

// Field key → GHL custom field ID mapping
const GHL_FIELD_IDS = {
  'contact.risk_score':                '5EDNb2oC1gvGdtvLgNlV',
  'contact.member_segment':            'o5WPqC5CCWTiYdiEPX2S',
  'contact.days_since_visit':          'jkEPIFUnvAwUctSZFLfe',
  'contact.last_visit_date':           'OijfvU1GrJwnweXGb81G',
  'contact.package_expiry':            'hANHqKanhBgustQM6oa2',
  'contact.lifetime_value':            'Gm2WhfxPpEyaNAqdAkRJ',
  'contact.last_sync_result':          'mu6Ac274nldfGOLH4dxQ',
  'contact.last_sync_time':            'afs9HmJQ8ea4ErdFoSxI',
  'contact.last_sync_status':          'o1hLZzF5Evuk1uS1w01D',
  'contact.last_sync_count':           '1ru38ovOsZaHRBdE7bhu',
  'contact.members_recovered_increment': '11yQ2UDsitFvKBk0tyFJ',
  'contact.revenue_recovered_increment': 'NbS6XAXteLGrgZGq0QJ8',
  'contact.new_members_increment':     'jm5AQXYjJkO8XKAfrC0A',
  'contact.at_risk_caught_increment':  '4utx2oyCrkzDneJvfLpq'
};

async function ghlUpdateContact(contactId, fields) {
  const ghlKey = process.env.GHL_API_KEY;
  const customFields = Object.entries(fields)
    .filter(([key]) => GHL_FIELD_IDS[key])
    .map(([key, field_value]) => ({ id: GHL_FIELD_IDS[key], field_value }));
  await fetchWithTimeout(`${GHL_BASE2}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${ghlKey}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    body: JSON.stringify({ customFields })
  });
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

async function fetchGhlContactMaps(ghlKey, locationId) {
  const byEmail = {};
  const byPhone = {};
  let startAfterId = null;

  for (let page = 0; page < 25; page++) {
    if (page > 0) await sleep(200);
    const url = new URL(`${GHL_BASE2}/contacts/`);
    url.searchParams.set('locationId', locationId);
    url.searchParams.set('limit', '100');
    if (startAfterId) url.searchParams.set('startAfterId', startAfterId);

    const res = await fetchWithTimeout(url.toString(), {
      headers: {
        'Authorization': `Bearer ${ghlKey}`,
        'Content-Type':  'application/json',
        'Version':       '2021-07-28'
      }
    });
    if (!res.ok) break;
    const data = await res.json();
    const batch = data.contacts || [];

    for (const c of batch) {
      if (c.email) byEmail[c.email.toLowerCase()] = c.id;
      const norm = normalizePhone(c.phone);
      if (norm) byPhone[norm] = c.id;
    }

    if (batch.length < 100) break;
    startAfterId = batch[batch.length - 1].id;
  }

  return { byEmail, byPhone };
}

async function mbGetStaffToken() {
  const mbApiKey  = process.env.MINDBODY_API_KEY;
  const mbSiteId  = process.env.MINDBODY_SITE_ID;
  const mbUser    = process.env.MINDBODY_STAFF_USERNAME;
  const mbPass    = process.env.MINDBODY_STAFF_PASSWORD;
  if (!mbApiKey) throw new Error('MINDBODY_API_KEY is not set');
  if (!mbSiteId) throw new Error('MINDBODY_SITE_ID is not set');
  if (!mbUser)   throw new Error('MINDBODY_STAFF_USERNAME is not set');
  if (!mbPass)   throw new Error('MINDBODY_STAFF_PASSWORD is not set');

  const res = await fetchWithTimeout(`${MB_BASE}/usertoken/issue`, {
    method: 'POST',
    headers: {
      'Api-Key': mbApiKey,
      'SiteId':  mbSiteId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ Username: mbUser, Password: mbPass })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mindbody auth failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data.AccessToken;
}

async function mbGet(path, params, accessToken) {
  const mbApiKey = process.env.MINDBODY_API_KEY;
  const mbSiteId = process.env.MINDBODY_SITE_ID;

  const url = new URL(MB_BASE + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const headers = {
    'Api-Key': mbApiKey,
    'SiteId':  mbSiteId,
    'Content-Type': 'application/json'
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetchWithTimeout(url.toString(), { headers });
  if (!res.ok) throw new Error(`Mindbody ${path} failed: ${res.status}`);
  return res.json();
}

function computeRiskScore(visits, member, lookbackDays = 180) {
  const now = Date.now();
  const windowStart    = now - lookbackDays * 86400000;
  const thirtyDaysAgo  = now - 30 * 86400000;
  const sixtyDaysAgo   = now - 60 * 86400000;

  const recentVisits = visits.filter(v => new Date(v.StartDateTime).getTime() > windowStart);

  const lastVisit = recentVisits.reduce((latest, v) => {
    const t = new Date(v.StartDateTime).getTime();
    return t > latest ? t : latest;
  }, 0);

  const daysSinceVisit = lastVisit
    ? Math.floor((now - lastVisit) / 86400000)
    : 999;

  const visitsLast30  = recentVisits.filter(v => new Date(v.StartDateTime).getTime() > thirtyDaysAgo).length;
  const visitsPrior30 = recentVisits.filter(v => {
    const t = new Date(v.StartDateTime).getTime();
    return t > sixtyDaysAgo && t <= thirtyDaysAgo;
  }).length;

  const noShows30 = recentVisits.filter(v =>
    v.SignedIn === false && new Date(v.StartDateTime).getTime() > thirtyDaysAgo
  ).length;

  const packageExpiry = member.ClientIndexes?.[0]?.Value || null;
  const daysUntilExpiry = packageExpiry
    ? Math.floor((new Date(packageExpiry).getTime() - now) / 86400000)
    : 999;

  const score = Math.min(10, Math.max(0,
    (daysSinceVisit / 60) * 40 +
    (visitsLast30 < visitsPrior30 ? 25 : 0) +
    (daysUntilExpiry < 14 ? 20 : 0) +
    (noShows30 * 5)
  ));

  const lifetimeValue = member.AccountBalance || 0;
  const segment = score >= 7
    ? 'at-risk'
    : (score < 4 && lifetimeValue > 1000 ? 'vip' : 'active');

  return {
    score: parseFloat(score.toFixed(2)),
    segment,
    daysSinceVisit,
    lastVisitDate: lastVisit ? new Date(lastVisit).toISOString() : null,
    packageExpiry,
    lifetimeValue
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!verifyAdminToken(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ghlKey        = process.env.GHL_API_KEY;
  const ghlLocationId = process.env.GHL_LOCATION_ID;
  const agencyContactId = process.env.AGENCY_OWNER_CONTACT_ID;
  if (!ghlKey)          throw new Error('GHL_API_KEY is not set');
  if (!ghlLocationId)   throw new Error('GHL_LOCATION_ID is not set');
  if (!agencyContactId) throw new Error('AGENCY_OWNER_CONTACT_ID is not set');

  const { clientId, lookbackMonths: rawLookback } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  const lookbackMonths = rawLookback === 12 ? 12 : 6; // only 6 or 12 accepted, default 6
  const lookbackDays   = lookbackMonths * 30;

  const syncRecord = {
    clientId,
    startTime: new Date().toISOString(),
    status: 'running',
    membersProcessed: 0,
    atRiskFound: 0,
    errors: [],
    endTime: null
  };

  // Anomaly check ─────────────────────────────────
  const hour = new Date().getUTCHours();
  if (hour < 1 || hour > 4) {
    await ghlSendSms(agencyContactId,
      `OctoEmployee WARNING: Sync triggered outside normal window.\nClient: ${clientId} | Time: ${new Date().toISOString()}\nVerify this was intentional.`
    );
  }

  try {
    // ── Authenticate with Mindbody ────────────────────
    const accessToken = await mbGetStaffToken();
    console.log('[sync] Mindbody staff token acquired');

    // Monthly counter accumulators
    let membersRecovered  = 0;
    let revenueRecovered  = 0;
    let newMembers        = 0;
    let atRiskCaught      = 0;

    const now     = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const avgMemberValue = 150; // fallback default

    // ── Pull all appointments in bulk, group by ClientId ──
    const apptStartDate = new Date(Date.now() - lookbackDays * 86400000).toISOString().split('T')[0];
    const apptEndDate   = new Date().toISOString().split('T')[0];
    const allAppts = [];
    let apptOffset = 0;
    for (let page = 0; page < 15; page++) {
      if (page > 0) await sleep(300);
      const batch = await mbGet('/appointment/staffappointments', {
        startDate: apptStartDate,
        endDate:   apptEndDate,
        limit:     200,
        offset:    apptOffset
      }, accessToken);
      const appts = batch.Appointments || [];
      allAppts.push(...appts);
      if (appts.length < 200) break;
      apptOffset += 200;
    }
    console.log('[sync] Appointments pulled:', allAppts.length);

    // Group by ClientId (appointment ClientId matches member Id)
    const apptsByClient = {};
    for (const appt of allAppts) {
      const cid = String(appt.ClientId || '');
      if (!cid) continue;
      if (!apptsByClient[cid]) apptsByClient[cid] = [];
      apptsByClient[cid].push(appt);
    }

    // ── Fetch active members by appointment ClientIds ─────
    // /client/clients default sort puts inactive old clients first — we only want
    // the clients who actually have appointments in the lookback window.
    const apptClientIds = Object.keys(apptsByClient);
    const members = [];
    const MEMBER_BATCH = 20;
    const mbApiKey = process.env.MINDBODY_API_KEY;
    const mbSiteId = process.env.MINDBODY_SITE_ID;
    for (let i = 0; i < Math.min(apptClientIds.length, 400); i += MEMBER_BATCH) {
      if (i > 0) await sleep(250);
      const batchIds = apptClientIds.slice(i, i + MEMBER_BATCH);
      const url = new URL(`${MB_BASE}/client/clients`);
      url.searchParams.set('limit', String(MEMBER_BATCH + 5));
      batchIds.forEach(id => url.searchParams.append('clientIds', id));
      const res = await fetchWithTimeout(url.toString(), {
        headers: {
          'Api-Key': mbApiKey,
          'SiteId':  mbSiteId,
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        members.push(...(data.Clients || []));
      }
    }
    console.log('[sync] Active members fetched:', members.length);

    // ── Build GHL contact lookup maps (email + phone) ──
    const { byEmail, byPhone } = await fetchGhlContactMaps(ghlKey, ghlLocationId);
    console.log(`[sync] GHL contact map built: ${Object.keys(byEmail).length} emails, ${Object.keys(byPhone).length} phones`);

    // Compute risk for all members, collect GHL updates to run in parallel batches
    const ghlUpdates = []; // { contactId, fields }

    for (const member of members) {
      // Map appointments to visit-like objects for risk scoring
      const memberAppts = apptsByClient[String(member.Id)] || [];
      const visits = memberAppts
        .filter(a =>
          new Date(a.StartDateTime).getTime() < Date.now() &&
          a.Status !== 'Cancelled' && a.Status !== 'LateCancelled'
        )
        .map(a => ({
          StartDateTime: a.StartDateTime,
          SignedIn: a.Status !== 'NoShow'
        }));

      const risk = computeRiskScore(visits, member, lookbackDays);

      // Find GHL contact by email or phone
      const email = (member.Email || '').toLowerCase();
      const phones = [member.MobilePhone, member.HomePhone, member.WorkPhone]
        .map(normalizePhone).filter(Boolean);

      let ghlContactId = (email && byEmail[email]) || null;
      if (!ghlContactId) {
        for (const p of phones) {
          if (byPhone[p]) { ghlContactId = byPhone[p]; break; }
        }
      }

      // DEBUG — log first 3 unmatched members to diagnose matching
      if (!ghlContactId && syncRecord.membersProcessed < 3) {
        console.log(`[sync] no-match: MB email="${email}" phones="${phones.join(',')}" name="${member.FirstName} ${member.LastName}"`);
      }

      // Monthly counter logic
      const prevSegment = member.CustomField?.member_segment || 'active';
      if (prevSegment === 'at-risk' && risk.segment === 'active') {
        membersRecovered++;
        revenueRecovered += avgMemberValue;
      }
      if (new Date(member.CreationDate).getTime() >= monthStart.getTime()) {
        newMembers++;
      }
      if (prevSegment !== 'at-risk' && risk.segment === 'at-risk') {
        atRiskCaught++;
      }

      if (risk.segment === 'at-risk') syncRecord.atRiskFound++;
      syncRecord.membersProcessed++;

      // Queue GHL update if contact found
      if (ghlContactId) {
        ghlUpdates.push({
          contactId: ghlContactId,
          fields: {
            'contact.risk_score':       risk.score,
            'contact.member_segment':   risk.segment,
            'contact.days_since_visit': risk.daysSinceVisit,
            'contact.last_visit_date':  risk.lastVisitDate,
            'contact.package_expiry':   risk.packageExpiry,
            'contact.lifetime_value':   risk.lifetimeValue
          }
        });
      }
    }

    // ── Flush GHL updates in parallel batches of 5 ────
    const GHL_BATCH = 5;
    for (let i = 0; i < ghlUpdates.length; i += GHL_BATCH) {
      const batch = ghlUpdates.slice(i, i + GHL_BATCH);
      await Promise.all(batch.map(async ({ contactId, fields }) => {
        try {
          await ghlUpdateContact(contactId, fields);
        } catch (e) {
          syncRecord.errors.push(`GHL update failed for ${contactId}: ${e.message}`);
        }
      }));
    }

    // ── Update health monitor contact ─────────────────
    syncRecord.status  = 'success';
    syncRecord.endTime = new Date().toISOString();

    await ghlUpdateContact(agencyContactId, {
      'contact.last_sync_result':            JSON.stringify(syncRecord),
      'contact.last_sync_time':              new Date().toISOString(),
      'contact.last_sync_status':            'success',
      'contact.last_sync_count':             syncRecord.membersProcessed,
      'contact.members_recovered_increment': membersRecovered,
      'contact.revenue_recovered_increment': revenueRecovered,
      'contact.new_members_increment':       newMembers,
      'contact.at_risk_caught_increment':    atRiskCaught
    });

    return res.status(200).json({
      success: true,
      processed: syncRecord.membersProcessed,
      atRisk: syncRecord.atRiskFound,
      ghlMatched: ghlUpdates.length,
      ghlEmailMapSize: Object.keys(byEmail).length,
      ghlPhoneMapSize: Object.keys(byPhone).length,
      errors: syncRecord.errors.slice(0, 5)
    });

  } catch (error) {
    syncRecord.status  = 'failed';
    syncRecord.endTime = new Date().toISOString();
    syncRecord.errors.push(error.message);

    // Update health monitor with failure
    try {
      await ghlUpdateContact(agencyContactId, {
        'contact.last_sync_result': JSON.stringify(syncRecord),
        'contact.last_sync_time':   new Date().toISOString(),
        'contact.last_sync_status': 'failed',
        'contact.last_sync_count':  syncRecord.membersProcessed
      });
    } catch { /* best-effort */ }

    // Alert agency owner via SMS
    try {
      await ghlSendSms(agencyContactId,
        `OctoEmployee SYNC FAILED\nClient: ${clientId}\nTime: ${new Date().toISOString()}\nError: ${error.message.substring(0, 100)}\nAction required: check Vercel Functions log immediately.`
      );
    } catch { /* best-effort */ }

    throw error;
  }
}
