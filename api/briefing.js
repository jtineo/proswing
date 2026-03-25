import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const GHL_BASE = 'https://rest.gohighlevel.com/v1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function verifyAdminToken(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) throw new Error('ADMIN_TOKEN is not set');
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return false;
  const provided = authHeader.slice(7);
  try {
    return crypto.timingSafeEqual(Buffer.from(adminToken), Buffer.from(provided));
  } catch {
    return false;
  }
}

async function ghlGetContact(contactId) {
  const ghlKey = process.env.GHL_API_KEY;
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    headers: { 'Authorization': `Bearer ${ghlKey}` }
  });
  if (!res.ok) throw new Error(`GHL getContact failed: ${res.status}`);
  return res.json();
}

async function ghlSearchContacts(tag) {
  const ghlKey     = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) throw new Error('GHL_LOCATION_ID is not set');

  const res = await fetch(`${GHL_BASE}/contacts/?locationId=${locationId}&tags=${encodeURIComponent(tag)}&limit=10`, {
    headers: { 'Authorization': `Bearer ${ghlKey}` }
  });
  if (!res.ok) throw new Error(`GHL search failed: ${res.status}`);
  return res.json();
}

async function ghlSendSms(contactId, message) {
  const ghlKey = process.env.GHL_API_KEY;
  const res = await fetch(`${GHL_BASE}/conversations/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghlKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type: 'SMS', contactId, message })
  });
  if (!res.ok) throw new Error(`GHL sendSms failed: ${res.status}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!verifyAdminToken(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ghlKey          = process.env.GHL_API_KEY;
  const agencyContactId = process.env.AGENCY_OWNER_CONTACT_ID;
  const anthropicKey    = process.env.ANTHROPIC_API_KEY;
  if (!ghlKey)          throw new Error('GHL_API_KEY is not set');
  if (!agencyContactId) throw new Error('AGENCY_OWNER_CONTACT_ID is not set');
  if (!anthropicKey)    throw new Error('ANTHROPIC_API_KEY is not set');

  const { clientId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });

  // ── Load users.json ───────────────────────────────
  const usersPath = path.join(__dirname, '../config/users.json');
  const config    = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  const owner     = config.users.find(u => u.role === 'owner' && u.active);
  if (!owner) throw new Error('No active owner found in users.json');

  // ── Pull current metrics from GHL ─────────────────
  const monitorContact = await ghlGetContact(agencyContactId);
  const fields = monitorContact?.customField || {};

  const membersRecovered    = Number(fields.members_recovered_this_month    || 0);
  const revenueRecovered    = Number(fields.revenue_recovered_this_month    || 0);
  const newMembers          = Number(fields.new_members_this_month          || 0);
  const atRiskCaught        = Number(fields.at_risk_caught_this_month       || 0);
  const lastSyncStatus      = fields.last_sync_status || 'unknown';
  const lastSyncTime        = fields.last_sync_time   || 'never';

  // ── Pull at-risk members ──────────────────────────
  let atRiskNames = [];
  try {
    const atRiskData = await ghlSearchContacts('at-risk');
    const contacts   = atRiskData?.contacts || [];
    atRiskNames = contacts
      .sort((a, b) => (b.customField?.lifetime_value || 0) - (a.customField?.lifetime_value || 0))
      .slice(0, 5)
      .map(c => c.firstName || 'Unknown');
  } catch (e) {
    console.error('At-risk fetch failed (non-fatal):', e.message);
  }

  const today     = new Date();
  const dayName   = today.toLocaleString('en-US', { weekday: 'long' });
  const dateFmt   = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  const contextText = [
    `Today: ${dayName}, ${dateFmt}`,
    `Members recovered this month: ${membersRecovered}`,
    `Revenue recovered this month: $${revenueRecovered.toLocaleString()}`,
    `New members this month: ${newMembers}`,
    `At-risk members caught: ${atRiskCaught}`,
    `Last sync status: ${lastSyncStatus} (${lastSyncTime})`,
    atRiskNames.length > 0 ? `Top at-risk members right now: ${atRiskNames.join(', ')}` : 'No at-risk members currently'
  ].join('\n');

  // ── Generate briefing with Claude ─────────────────
  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: `You are the OctoEmployee AI sending a Monday morning briefing to a fitness studio owner. Be energetic but brief. Lead with a specific win or concern. Give exactly 3 things to focus on today. Use real numbers. No jargon. Under 400 characters total.`,
    messages: [{ role: 'user', content: contextText }]
  });

  const briefingText = msg.content?.[0]?.text || '';
  const smsMessage   = `OctoEmployee — Monday Briefing\n\n${briefingText}`;

  // ── Send SMS to owner ─────────────────────────────
  try {
    await ghlSendSms(owner.ghlContactId, smsMessage);
  } catch (e) {
    console.error('Briefing SMS failed (non-fatal):', e.message);
  }

  return res.status(200).json({ success: true, briefing: briefingText });
}
