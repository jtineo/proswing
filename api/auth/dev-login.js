// TEMPORARY — remove this file once GHL SMS is configured
// Issues a session cookie directly using ADMIN_TOKEN — no PIN required
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminToken = process.env.ADMIN_TOKEN;
  const authSecret = process.env.AUTH_SECRET;
  if (!adminToken) return res.status(500).json({ error: 'ADMIN_TOKEN not set' });
  if (!authSecret) return res.status(500).json({ error: 'AUTH_SECRET not set' });

  // Require ADMIN_TOKEN
  const provided = req.headers['x-admin-token'] || '';
  let authorized = false;
  try {
    authorized = crypto.timingSafeEqual(Buffer.from(adminToken), Buffer.from(provided));
  } catch { authorized = false; }
  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

  // Load user by phone
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const digits = String(phone).replace(/\D/g, '');
  const normalized = digits.length === 10 ? '+1' + digits
    : digits.length === 11 && digits[0] === '1' ? '+' + digits
    : null;
  if (!normalized) return res.status(400).json({ error: 'Invalid phone' });

  const usersPath = path.join(__dirname, '../../config/users.json');
  const config = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  const user = config.users.find(u => u.phone === normalized && u.active === true);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const roles = config.roles;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    userId:      user.id,
    name:        user.name,
    role:        user.role,
    permissions: roles[user.role],
    clientId:    config.clientId,
    iat:         now,
    exp:         now + 2592000
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig     = crypto.createHmac('sha256', authSecret).update(encoded).digest('hex');
  const token   = encoded + '.' + sig;

  res.setHeader('Set-Cookie',
    `octo_session=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000; Path=/`
  );

  return res.status(200).json({
    success: true,
    note: 'TEMPORARY — remove api/auth/dev-login.js once GHL SMS is live',
    user: { name: user.name, role: user.role, permissions: roles[user.role] }
  });
}
