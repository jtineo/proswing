import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level in-memory user store (extends config/users.json at startup)
let usersCache = null;

function loadUsers() {
  if (usersCache) return usersCache;
  const usersPath = path.join(__dirname, '../../config/users.json');
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

function maskEmail(email) {
  // Show only domain: ***@domain.com
  const parts = String(email).split('@');
  return '***@' + (parts[1] || 'unknown');
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
        email:        maskEmail(u.email || ''),
        role:         u.role,
        active:       u.active,
        addedDate:    u.addedDate,
        ghlContactId: u.ghlContactId
      }));
      return res.status(200).json({ users: masked });
    }

    case 'add': {
      if (!user?.name || !user?.email || !user?.role) {
        return res.status(400).json({ error: 'user.name, user.email, and user.role are required' });
      }
      if (!config.roles[user.role]) {
        return res.status(400).json({ error: `Invalid role. Valid roles: ${Object.keys(config.roles).join(', ')}` });
      }

      const normalized = user.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }

      const exists = config.users.find(u => u.email?.toLowerCase() === normalized);
      if (exists) {
        if (exists.active) return res.status(409).json({ error: 'User with this email already exists' });
        // Re-activate if previously removed
        exists.active    = true;
        exists.role      = user.role;
        exists.name      = user.name;
        if (user.ghlContactId) exists.ghlContactId = user.ghlContactId;
        if (user.phone) exists.phone = user.phone;
        return res.status(200).json({ success: true, action: 'reactivated', id: exists.id });
      }

      const newUser = {
        id:           'user-' + Date.now(),
        name:         user.name,
        email:        normalized,
        phone:        user.phone || '',
        role:         user.role,
        ghlContactId: user.ghlContactId || '',
        active:       true,
        addedDate:    new Date().toISOString().split('T')[0]
      };
      config.users.push(newUser);
      return res.status(200).json({ success: true, action: 'added', id: newUser.id });
    }

    case 'remove': {
      if (!user?.email) return res.status(400).json({ error: 'user.email is required' });

      const normalized = user.email.trim().toLowerCase();
      const target = config.users.find(u => u.email?.toLowerCase() === normalized);
      if (!target) return res.status(404).json({ error: 'User not found' });

      target.active = false;
      return res.status(200).json({ success: true, action: 'deactivated', id: target.id });
    }

    default:
      return res.status(400).json({ error: 'Invalid action. Use: add, remove, or list' });
  }
}
