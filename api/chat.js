import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';

const CLIENT_NAME = 'ProSwing Athletic Training';

const REVENUE_KEYWORDS = ['revenue', 'mrr', 'money', 'income', 'profit', 'earnings'];

function parseSessionToken(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('octo_session='));
  if (!match) return null;
  return match.slice('octo_session='.length);
}

function verifySession(token, secret) {
  // Split at the LAST dot to separate encodedPayload from signature
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return null;

  const encodedPayload = token.slice(0, lastDot);
  const storedSig      = token.slice(lastDot + 1);

  // Re-derive signature
  const derivedSig = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('hex');

  // Constant-time comparison
  try {
    if (!crypto.timingSafeEqual(Buffer.from(derivedSig, 'hex'), Buffer.from(storedSig, 'hex'))) return null;
  } catch {
    return null;
  }

  // Decode payload
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
  } catch {
    return null;
  }

  // Check expiry
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth ────────────────────────────────────────
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) throw new Error('AUTH_SECRET is not set');

  const token = parseSessionToken(req.headers.cookie);
  if (!token) return res.status(401).json({ error: 'Session expired. Please log in.' });

  const payload = verifySession(token, authSecret);
  if (!payload) return res.status(401).json({ error: 'Session expired. Please log in.' });

  // ── Permission check ────────────────────────────
  const { question } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question is required' });
  }

  const lowerQ = question.toLowerCase();
  if (!payload.permissions?.canViewRevenue && REVENUE_KEYWORDS.some(kw => lowerQ.includes(kw))) {
    return res.status(403).json({ error: 'Revenue data requires owner access.' });
  }

  // ── Claude API call ─────────────────────────────
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const client = new Anthropic({ apiKey: anthropicKey });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: `You are the AI business coach for ${CLIENT_NAME}. Answer using real member data when provided in context. Keep responses under 120 words for mobile readability. End every response with one clear recommended action. Use specific member names and dollar amounts when available. Never use business jargon.`,
    messages: [{ role: 'user', content: question }]
  });

  const answer = message.content?.[0]?.text || 'No response received.';
  return res.status(200).json({ answer });
}
