import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const GHL_BASE  = 'https://rest.gohighlevel.com/v1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Module-level rate limit stores ───────────────────
// { phone/ip -> { count, resetAt } }
const phoneRateMap = new Map();
const ipRateMap    = new Map();

// ── Module-level PIN store ────────────────────────────
// { normalizedPhone -> { hash, expiry, attempts } }
export const pinStore = new Map();

function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10)                    return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

function checkRateLimit(map, key, limit, windowMs) {
  const now    = Date.now();
  const record = map.get(key);
  if (!record || now > record.resetAt) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return false; // not limited
  }
  record.count++;
  return record.count > limit;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const pinStoreSecret = process.env.PIN_STORE_SECRET;
  const ghlKey         = process.env.GHL_API_KEY;
  if (!pinStoreSecret) throw new Error('PIN_STORE_SECRET is not set');
  if (!ghlKey)         throw new Error('GHL_API_KEY is not set');

  const { phone } = req.body || {};
  const normalized = normalizePhone(phone);

  if (!normalized || !/^\+1\d{10}$/.test(normalized)) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  // ── Rate limiting ─────────────────────────────────
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const WINDOW = 60 * 60 * 1000; // 60 minutes

  if (checkRateLimit(phoneRateMap, normalized, 3, WINDOW)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  if (checkRateLimit(ipRateMap, ip, 10, WINDOW)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  // ── User lookup ───────────────────────────────────
  const usersPath = path.join(__dirname, '../../config/users.json');
  const config    = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  const user      = config.users.find(u => u.phone === normalized && u.active === true);

  // Always return the same response to prevent enumeration
  const successResponse = { success: true, message: 'If authorized, a PIN is on the way.' };

  if (!user) {
    return res.status(200).json(successResponse);
  }

  // ── Generate and send PIN ─────────────────────────
  const pin     = String(Math.floor(100000 + Math.random() * 900000));
  const pinHash = crypto
    .createHmac('sha256', pinStoreSecret)
    .update(pin + normalized)
    .digest('hex');

  pinStore.set(normalized, {
    hash:    pinHash,
    expiry:  Date.now() + 600000, // 10 minutes
    attempts: 0
  });

  // Send via GHL SMS — NEVER log pin or phone
  const ghlRes = await fetch(`${GHL_BASE}/conversations/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghlKey}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      type:      'SMS',
      contactId: user.ghlContactId,
      message:   `Your OctoEmployee PIN: ${pin}\nExpires in 10 minutes.\nDo not share this code.`
    })
  });

  return res.status(200).json(successResponse);
}
