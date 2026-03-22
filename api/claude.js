// ── KV-backed rate limiter with in-memory fallback ──
//
// Uses Vercel KV (Redis) when KV_REST_API_URL + KV_REST_API_TOKEN are set.
// Falls back to in-memory if KV is not configured or a KV call fails.
// This means rate limits work correctly across all serverless instances.
//
// To enable KV: run `vercel kv create mastermind-rl` in your project,
// then `vercel env pull` to get the env vars locally.

// ── In-memory fallback (per-instance, resets on cold start) ──
const _memMap = new Map();
function _memRateLimit(key, max) {
  const now = Date.now(), windowMs = 60000;
  const e = _memMap.get(key);
  if (!e || now > e.resetAt) {
    _memMap.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }
  if (e.count >= max) return { allowed: false, retryAfter: Math.ceil((e.resetAt - now) / 1000) };
  e.count++;
  return { allowed: true };
}

// ── KV rate limiter (atomic, cross-instance, persistent across cold starts) ──
async function _kvRateLimit(key, max) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null; // KV not configured — signal fallback

  try {
    // Atomically increment and get the new value
    const incrRes = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!incrRes.ok) return null;
    const { result: count } = await incrRes.json();

    // On first increment, set the 60-second TTL (fire-and-forget)
    if (count === 1) {
      fetch(`${url}/expire/${encodeURIComponent(key)}/60`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }

    if (count > max) {
      // Get TTL to calculate retryAfter
      let retryAfter = 60;
      try {
        const ttlRes = await fetch(`${url}/ttl/${encodeURIComponent(key)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (ttlRes.ok) {
          const { result: ttl } = await ttlRes.json();
          if (ttl > 0) retryAfter = ttl;
        }
      } catch {}
      return { allowed: false, retryAfter };
    }

    return { allowed: true };
  } catch {
    return null; // KV error — signal fallback
  }
}

// ── Unified rate limit function ──
async function rateLimit(key, max) {
  const kvResult = await _kvRateLimit(key, max);
  if (kvResult !== null) return kvResult;      // KV worked, use it
  return _memRateLimit(key, max);              // Fall back to in-memory
}

const ALLOWED_ORIGINS = ['https://mastermind-one-pi.vercel.app', 'http://localhost:3000'];
const ALLOWED_MODELS  = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514'];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

  // IP-level burst protection (30/min) — runs for all requests
  const ipLimit = await rateLimit(`rl:ip:${ip}`, 30);
  if (!ipLimit.allowed) return res.status(429).json({ error: `Rate limited. Retry in ${ipLimit.retryAfter}s.` });

  // ── Clerk auth ──
  const authHeader = req.headers.authorization;
  let clerkUserId = null;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const clerkRes = await fetch('https://api.clerk.com/v1/tokens/verify', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: authHeader.split(' ')[1] }),
      });
      if (clerkRes.ok) { const d = await clerkRes.json(); clerkUserId = d.sub || d.user_id; }
    } catch {}
  }

  // Guest: 3 AI calls per minute per IP
  if (!clerkUserId) {
    const guestLimit = await rateLimit(`rl:guest:${ip}`, 3);
    if (!guestLimit.allowed) return res.status(401).json({ error: 'guest_limit_reached', message: 'Sign in to keep learning.' });
  } else {
    // Signed-in: 20 calls per minute per user
    const userLimit = await rateLimit(`rl:user:${clerkUserId}`, 20);
    if (!userLimit.allowed) return res.status(429).json({ error: `Rate limited. Retry in ${userLimit.retryAfter}s.` });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfiguration' });

  const body = req.body;
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return res.status(400).json({ error: 'Invalid request' });
  if (body.messages.length > 40) return res.status(400).json({ error: 'Too many messages' });
  if (JSON.stringify(body).length > 100000) return res.status(400).json({ error: 'Request too large' });

  const model = body.model || 'claude-sonnet-4-20250514';
  if (!ALLOWED_MODELS.includes(model)) return res.status(400).json({ error: 'Model not allowed' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: Math.min(body.max_tokens || 1000, 4000),
        messages: body.messages,
        ...(body.system ? { system: body.system } : {}),
      }),
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch {
    return res.status(500).json({ error: 'Failed to contact AI service' });
  }
}
