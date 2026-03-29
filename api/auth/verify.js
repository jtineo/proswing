import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pinStore } from './request.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function normalizeEmail(raw) {
  if (!raw || typeof raw !== 'string') return null;
  return raw.trim().toLowerCase();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const pinStoreSecret = process.env.PIN_STORE_SECRET;
  const authSecret     = process.env.AUTH_SECRET;
  if (!pinStoreSecret) throw new Error('PIN_STORE_SECRET is not set');
  if (!authSecret)     throw new Error('AUTH_SECRET is not set');

  const { email, pin } = req.body || {};
  const normalized = normalizeEmail(email);

  if (!normalized || !pin) {
    return res.status(400).json({ error: 'email and pin are required' });
  }

  // ── Look up PIN record ────────────────────────────
  const record = pinStore.get(normalized);

  if (!record) {
    return res.status(401).json({ error: 'PIN not found. Request a new one.' });
  }

  if (Date.now() > record.expiry) {
    pinStore.delete(normalized);
    return res.status(401).json({ error: 'PIN expired. Request a new one.' });
  }

  record.attempts++;

  if (record.attempts >= 5) {
    pinStore.delete(normalized);
    return res.status(401).json({ error: 'Too many incorrect attempts. Request a new PIN.' });
  }

  // ── Hash submitted PIN and compare ───────────────
  const submittedHash = crypto
    .createHmac('sha256', pinStoreSecret)
    .update(pin + normalized)
    .digest('hex');

  let isMatch = false;
  try {
    isMatch = crypto.timingSafeEqual(
      Buffer.from(submittedHash, 'hex'),
      Buffer.from(record.hash,   'hex')
    );
  } catch {
    isMatch = false;
  }

  if (!isMatch) {
    return res.status(401).json({
      error:        'Incorrect PIN',
      attemptsLeft: 5 - record.attempts
    });
  }

  // ── Success — delete PIN immediately (single-use) ─
  pinStore.delete(normalized);

  // ── Build session token ───────────────────────────
  const usersPath = path.join(__dirname, '../../config/users.json');
  const config    = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  const user      = config.users.find(
    u => u.email?.toLowerCase() === normalized && u.active === true
  );

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  const roles = config.roles;
  const now   = Math.floor(Date.now() / 1000);

  const payload = {
    userId:      user.id,
    name:        user.name,
    role:        user.role,
    permissions: roles[user.role],
    clientId:    config.clientId,
    iat:         now,
    exp:         now + 2592000 // 30 days
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig     = crypto
    .createHmac('sha256', authSecret)
    .update(encoded)
    .digest('hex');
  const token   = encoded + '.' + sig;

  res.setHeader(
    'Set-Cookie',
    `octo_session=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000; Path=/`
  );

  return res.status(200).json({
    success: true,
    user: {
      name:        user.name,
      role:        user.role,
      permissions: roles[user.role]
    }
  });
}
