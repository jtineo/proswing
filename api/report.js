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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ghlGetContact(contactId) {
  const ghlKey = process.env.GHL_API_KEY;
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    headers: { 'Authorization': `Bearer ${ghlKey}` }
  });
  if (!res.ok) throw new Error(`GHL getContact failed: ${res.status}`);
  return res.json();
}

async function ghlUpdateContact(contactId, fields) {
  const ghlKey = process.env.GHL_API_KEY;
  await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${ghlKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ customField: fields })
  });
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

async function ghlAddNote(contactId, title, body) {
  const ghlKey = process.env.GHL_API_KEY;
  await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghlKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ title, body })
  });
}

function getField(contact, key, defaultVal = 0) {
  const fields = contact?.customField || {};
  return fields[key] ?? defaultVal;
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

function monthsBetween(startDateStr, endDate) {
  const start = new Date(startDateStr);
  return Math.max(1,
    (endDate.getFullYear() - start.getFullYear()) * 12 +
    (endDate.getMonth() - start.getMonth())
  );
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
  if (!ghlKey)          throw new Error('GHL_API_KEY is not set');
  if (!agencyContactId) throw new Error('AGENCY_OWNER_CONTACT_ID is not set');

  const { clientId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });

  try {
    // ── STEP 1 — Load users.json to find owner's GHL contact ──
    const usersPath = path.join(__dirname, '../config/users.json');
    const config    = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    const owner     = config.users.find(u => u.role === 'owner' && u.active);
    if (!owner) throw new Error('No active owner found in users.json');

    // ── STEP 1b — Pull metrics from GHL health monitor ────────
    const monitorContact = await ghlGetContact(agencyContactId);
    const f = (key, def = 0) => getField(monitorContact, key, def);

    const membersRecovered       = Number(f('members_recovered_this_month'));
    const revenueRecovered       = Number(f('revenue_recovered_this_month'));
    const newMembersThisMonth    = Number(f('new_members_this_month'));
    const atRiskCaught           = Number(f('at_risk_caught_this_month'));
    const prevMonthRevenue       = Number(f('prev_month_revenue_recovered'));
    const prevMonthMembers       = Number(f('prev_month_members_recovered'));
    const totalRevenueEver       = Number(f('total_revenue_recovered_ever'));
    const totalMembersSaved      = Number(f('total_members_saved_ever'));
    const serviceStartDate       = f('service_start_date', '2026-01-01');
    const avgMemberValue         = Number(f('avg_member_value', 150));
    const retainerAmount         = Number(f('retainer_amount', 2997));

    // ── STEP 2 — Compute metrics ──────────────────────────────
    const now          = new Date();
    const monthsActive = monthsBetween(serviceStartDate, now);
    const momChange    = revenueRecovered - prevMonthRevenue;
    const momFormatted = momChange >= 0 ? `+${formatCurrency(momChange)}` : `-${formatCurrency(Math.abs(momChange))}`;
    const roiMultiple  = ((totalRevenueEver + revenueRecovered) / (monthsActive * retainerAmount)).toFixed(1) + 'x';

    const monthName = now.toLocaleString('en-US', { month: 'long' });
    const year      = now.getFullYear();

    const metricsText = [
      `Month: ${monthName} ${year}`,
      `Months active: ${monthsActive}`,
      `Members recovered this month: ${membersRecovered}`,
      `Revenue recovered this month: ${formatCurrency(revenueRecovered)}`,
      `Month-over-month change: ${momFormatted}`,
      `New members this month: ${newMembersThisMonth}`,
      `At-risk members caught: ${atRiskCaught}`,
      `Total revenue recovered (all time): ${formatCurrency(totalRevenueEver + revenueRecovered)}`,
      `Total members saved (all time): ${totalMembersSaved + membersRecovered}`,
      `ROI multiple: ${roiMultiple}`,
      `Monthly retainer: ${formatCurrency(retainerAmount)}`,
      `Average member value: ${formatCurrency(avgMemberValue)}`
    ].join('\n');

    // ── STEP 3 — Generate report with Claude ──────────────────
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is not set');
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    let reportText;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 800,
          system: `You are the OctoEmployee AI writing a monthly performance report for a fitness studio owner. Write like a trusted advisor — warm and specific. Lead with the biggest win. Use real numbers. Write in short paragraphs. No bullet points. No headers. Never use: leverage, synergy, utilise, actionable. Total length must be under 900 characters. End with exactly one specific priority action for next month.`,
          messages: [{ role: 'user', content: metricsText }]
        });
        reportText = msg.content?.[0]?.text || '';
        break;
      } catch (e) {
        if (attempt === 0) {
          await sleep(5000);
          continue;
        }
        throw e;
      }
    }

    // ── STEP 4 — Send SMS to owner ────────────────────────────
    const smsMessage = `OctoEmployee — ${monthName} ${year}\n\n${reportText}`;
    try {
      await ghlSendSms(owner.ghlContactId, smsMessage);
    } catch (e) {
      console.error('SMS send failed (non-fatal):', e.message);
    }

    // ── STEP 5 — Store as GHL note on owner contact ───────────
    const noteBody = reportText + '\n\n---\nSource metrics:\n' + metricsText;
    try {
      await ghlAddNote(owner.ghlContactId, `OctoEmployee Report — ${monthName} ${year}`, noteBody);
    } catch (e) {
      console.error('GHL note failed (non-fatal):', e.message);
    }

    // ── STEP 6 — Update cumulative fields, reset monthly counters ─
    await ghlUpdateContact(agencyContactId, {
      total_revenue_recovered_ever:   totalRevenueEver + revenueRecovered,
      total_members_saved_ever:       totalMembersSaved + membersRecovered,
      prev_month_revenue_recovered:   revenueRecovered,
      prev_month_members_recovered:   membersRecovered,
      members_recovered_this_month:   0,
      revenue_recovered_this_month:   0,
      new_members_this_month:         0,
      at_risk_caught_this_month:      0
    });

    return res.status(200).json({ success: true, month: `${monthName} ${year}`, roi: roiMultiple });

  } catch (error) {
    // Alert agency owner
    try {
      const agencyContactId = process.env.AGENCY_OWNER_CONTACT_ID;
      if (agencyContactId) {
        await fetch(`${GHL_BASE}/conversations/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type: 'SMS',
            contactId: agencyContactId,
            message: `OctoEmployee REPORT FAILED\nClient: ${clientId}\nError: ${error.message.substring(0, 100)}`
          })
        });
      }
    } catch { /* best-effort */ }

    throw error;
  }
}
