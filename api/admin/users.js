import crypto from 'crypto';

// Module-level in-memory user store (extends config/users.json at startup)
// In production, replace with Vercel KV for persistence across cold starts.
let usersCache = null;

function loadUsers() {
  if (usersCache) return usersCache;
  // Dynamic import of fs to avoid issues — use synchronous read
  const fs   = require('fs');
  const path = require('path');
  const usersPath = path.join(process.cwd(), 'config', 'users.json');
  try {
    usersCache = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  } catch {
    usersCache = { clientId: '', clientName: '', users: [], roles: {} };
  }
  return usersCache;
}

function verifyAdminToken(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) throw new Error('ADMIN_TOKEN is not set');
  const provided = req.headers['x-admin-token'] || '';
  if (!provided) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(adminToken), Buffer.from(provided));
  } catch {
    return false;
  }
}

function maskPhone(phone) {
  // Show only last 4 digits: ***-***-XXXX
  const digits = String(phone).replace(/\D/g, '');
  return '***-***-' + digits.slice(-4);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!verifyAdminToken(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, user } = req.body || {};

  if (!action) return res.status(400).json({ error: 'action is required' });

  const config = loadUsers();

  switch (action) {
    case 'list': {
      const masked = config.users.map(u => ({
        id:           u.id,
        name:         u.name,
        phone:        maskPhone(u.phone),
        role:         u.role,
        active:       u.active,
        addedDate:    u.addedDate,
        ghlContactId: u.ghlContactId
      }));
      return res.status(200).json({ users: masked });
    }

    case 'add': {
      if (!user?.name || !user?.phone || !user?.role) {
        return res.status(400).json({ error: 'user.name, user.phone, and user.role are required' });
      }
      if (!config.roles[user.role]) {
        return res.status(400).json({ error: `Invalid role. Valid roles: ${Object.keys(config.roles).join(', ')}` });
      }

      const digits = String(user.phone).replace(/\D/g, '');
      let normalized;
      if (digits.length === 10)                      normalized = '+1' + digits;
      else if (digits.length === 11 && digits[0] === '1') normalized = '+' + digits;
      else return res.status(400).json({ error: 'Invalid phone number format' });

      const exists = config.users.find(u => u.phone === normalized);
      if (exists) {
        if (exists.active) return res.status(409).json({ error: 'User with this phone already exists' });
        // Re-activate if previously removed
        exists.active    = true;
        exists.role      = user.role;
        exists.name      = user.name;
        if (user.ghlContactId) exists.ghlContactId = user.ghlContactId;
        return res.status(200).json({ success: true, action: 'reactivated', id: exists.id });
      }

      const newUser = {
        id:           'user-' + Date.now(),
        name:         user.name,
        phone:        normalized,
        role:         user.role,
        ghlContactId: user.ghlContactId || '',
        active:       true,
        addedDate:    new Date().toISOString().split('T')[0]
      };
      config.users.push(newUser);
      return res.status(200).json({ success: true, action: 'added', id: newUser.id });
    }

    case 'remove': {
      if (!user?.phone) return res.status(400).json({ error: 'user.phone is required' });

      const digits = String(user.phone).replace(/\D/g, '');
      let normalized;
      if (digits.length === 10)                        normalized = '+1' + digits;
      else if (digits.length === 11 && digits[0] === '1') normalized = '+' + digits;
      else return res.status(400).json({ error: 'Invalid phone number format' });

      const target = config.users.find(u => u.phone === normalized);
      if (!target) return res.status(404).json({ error: 'User not found' });

      target.active = false;
      return res.status(200).json({ success: true, action: 'deactivated', id: target.id });
    }

    default:
      return res.status(400).json({ error: 'Invalid action. Use: add, remove, or list' });
  }
}
