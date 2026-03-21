// ── Simple in-memory rate limiter (resets on cold start) ──
const rateLimitMap = new Map();

function getRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxRequests = 10; // max 10 requests per minute per IP

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  const entry = rateLimitMap.get(ip);

  if (now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count++;
  return { allowed: true };
}

// ── Allowed origins ──
const ALLOWED_ORIGINS = [
  'https://mastermind-one-pi.vercel.app',
  'http://localhost:3000',
];

export default async function handler(req, res) {

  // ── CORS — only allow your own domain ──
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Rate limiting by IP ──
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const { allowed, retryAfter } = getRateLimit(ip);
  if (!allowed) {
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({ error: `Too many requests. Try again in ${retryAfter}s.` });
  }

  // ── Validate API key ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfiguration' });

  // ── Validate request body ──
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid request body' });
  if (!Array.isArray(body.messages) || body.messages.length === 0) return res.status(400).json({ error: 'Messages required' });
  if (body.messages.length > 40) return res.status(400).json({ error: 'Too many messages' });

  // ── Enforce safe model + token limits ──
  const ALLOWED_MODELS = [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
  ];
  const model = body.model || 'claude-sonnet-4-20250514';
  if (!ALLOWED_MODELS.includes(model)) return res.status(400).json({ error: 'Model not allowed' });

  const maxTokens = Math.min(body.max_tokens || 1000, 4000); // hard cap at 4000

  // ── Enforce payload size ──
  const payloadSize = JSON.stringify(body).length;
  if (payloadSize > 100000) return res.status(400).json({ error: 'Request too large' });

  // ── Build safe request ──
  const safeBody = {
    model,
    max_tokens: maxTokens,
    messages: body.messages,
    ...(body.system ? { system: body.system } : {}),
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(safeBody),
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to contact AI service' });
  }
}
