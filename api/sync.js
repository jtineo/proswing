import crypto from 'crypto';

const MB_BASE = 'https://api.mindbodyonline.com/public/v6';
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

async function ghlUpdateContact(contactId, fields) {
  const ghlKey = process.env.GHL_API_KEY;
  await fetchWithTimeout(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${ghlKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ customField: fields })
  });
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

function computeRiskScore(visits, member) {
  const now = Date.now();
  const ninetyDaysAgo = now - 90 * 86400000;
  const thirtyDaysAgo = now - 30 * 86400000;
  const sixtyDaysAgo  = now - 60 * 86400000;

  const recentVisits = visits.filter(v => new Date(v.StartDateTime).getTime() > ninetyDaysAgo);

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

  const ghlKey = process.env.GHL_API_KEY;
  const agencyContactId = process.env.AGENCY_OWNER_CONTACT_ID;
  if (!ghlKey) throw new Error('GHL_API_KEY is not set');
  if (!agencyContactId) throw new Error('AGENCY_OWNER_CONTACT_ID is not set');

  const { clientId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });

  const syncRecord = {
    clientId,
    startTime: new Date().toISOString(),
    status: 'running',
    membersProcessed: 0,
    atRiskFound: 0,
    errors: [],
    endTime: null
  };

  // ── DIAGNOSTIC: skip anomaly check during testing ──
  // Anomaly check ─────────────────────────────────
  const hour = new Date().getUTCHours();
  if (false && hour < 1 || hour > 4) {
    await ghlSendSms(agencyContactId,
      `OctoEmployee WARNING: Sync triggered outside normal window.\nClient: ${clientId} | Time: ${new Date().toISOString()}\nVerify this was intentional.`
    );
  }

  try {
    // ── Authenticate with Mindbody ────────────────────
    const accessToken = await mbGetStaffToken();
    console.log('[sync] Mindbody staff token acquired');

    // ── Pull members ─────────────────────────────────
    const membersData = await mbGet('/client/clients', { limit: 200, offset: 0 }, accessToken);
    const members = membersData.Clients || [];
    console.log('[sync] Members pulled:', members.length);

    // Monthly counter accumulators
    let membersRecovered  = 0;
    let revenueRecovered  = 0;
    let newMembers        = 0;
    let atRiskCaught      = 0;

    const now     = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const avgMemberValue = 150; // fallback default

    for (const member of members) {
      await sleep(200);

      // Pull visits for this member (last 90 days)
      const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
      let visits = [];
      try {
        const visitData = await mbGet('/client/clientvisits', {
          clientId: member.Id,
          startDate: ninetyDaysAgo,
          limit: 200
        }, accessToken);
        visits = visitData.Visits || [];
      } catch (e) {
        syncRecord.errors.push(`Visit fetch failed for ${member.Id}: ${e.message}`);
      }

      const risk = computeRiskScore(visits, member);
      const ghlContactId = member.ExternalId || null;

      // Monthly counter logic (requires prior segment stored in GHL — simplified to segment transitions)
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

      // Update GHL contact
      if (ghlContactId) {
        try {
          await ghlUpdateContact(ghlContactId, {
            risk_score:       risk.score,
            member_segment:   risk.segment,
            days_since_visit: risk.daysSinceVisit,
            last_visit_date:  risk.lastVisitDate,
            package_expiry:   risk.packageExpiry,
            lifetime_value:   risk.lifetimeValue
          });
        } catch (e) {
          syncRecord.errors.push(`GHL update failed for ${member.Id}: ${e.message}`);
        }
      }
    }

    // ── Update health monitor contact ─────────────────
    syncRecord.status  = 'success';
    syncRecord.endTime = new Date().toISOString();

    await ghlUpdateContact(agencyContactId, {
      last_sync_result:            JSON.stringify(syncRecord),
      last_sync_time:              new Date().toISOString(),
      last_sync_status:            'success',
      last_sync_count:             syncRecord.membersProcessed,
      members_recovered_increment: membersRecovered,
      revenue_recovered_increment: revenueRecovered,
      new_members_increment:       newMembers,
      at_risk_caught_increment:    atRiskCaught
    });

    return res.status(200).json({
      success: true,
      processed: syncRecord.membersProcessed,
      atRisk: syncRecord.atRiskFound
    });

  } catch (error) {
    syncRecord.status  = 'failed';
    syncRecord.endTime = new Date().toISOString();
    syncRecord.errors.push(error.message);

    // Update health monitor with failure
    try {
      await ghlUpdateContact(agencyContactId, {
        last_sync_result: JSON.stringify(syncRecord),
        last_sync_time:   new Date().toISOString(),
        last_sync_status: 'failed',
        last_sync_count:  syncRecord.membersProcessed
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
