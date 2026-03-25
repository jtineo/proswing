import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseSessionToken(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('octo_session='));
  if (!match) return null;
  return match.slice('octo_session='.length);
}

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) throw new Error('AUTH_SECRET is not set');

  const token = parseSessionToken(req.headers.cookie);
  if (!token) return res.status(401).json({ valid: false });

  // Split at the last "."
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return res.status(401).json({ valid: false });

  const encodedPayload = token.slice(0, lastDot);
  const storedSig      = token.slice(lastDot + 1);

  // Re-derive and compare signature
  const derivedSig = crypto
    .createHmac('sha256', authSecret)
    .update(encodedPayload)
    .digest('hex');

  try {
    if (!crypto.timingSafeEqual(Buffer.from(derivedSig, 'hex'), Buffer.from(storedSig, 'hex'))) {
      return res.status(401).json({ valid: false });
    }
  } catch {
    return res.status(401).json({ valid: false });
  }

  // Decode payload
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
  } catch {
    return res.status(401).json({ valid: false });
  }

  // Check expiry
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    return res.status(401).json({ valid: false });
  }

  // Confirm user is still active in users.json
  const usersPath = path.join(__dirname, '../../config/users.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  } catch {
    return res.status(401).json({ valid: false });
  }

  const user = config.users.find(u => u.id === payload.userId && u.active === true);
  if (!user) return res.status(401).json({ valid: false });

  return res.status(200).json({
    valid: true,
    user: {
      name:        payload.name,
      role:        payload.role,
      permissions: payload.permissions,
      clientId:    payload.clientId
    }
  });
}
