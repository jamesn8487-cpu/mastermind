// ── Rate limiter ──
const rateLimitMap = new Map();
function getRateLimit(key, max=20) {
  const now = Date.now(), windowMs = 60000;
  if (!rateLimitMap.has(key)) { rateLimitMap.set(key, { count:1, resetAt:now+windowMs }); return {allowed:true}; }
  const e = rateLimitMap.get(key);
  if (now > e.resetAt) { rateLimitMap.set(key, { count:1, resetAt:now+windowMs }); return {allowed:true}; }
  if (e.count >= max) return {allowed:false, retryAfter:Math.ceil((e.resetAt-now)/1000)};
  e.count++; return {allowed:true};
}

const ALLOWED_ORIGINS = ['https://mastermind-one-pi.vercel.app','http://localhost:3000'];
const ALLOWED_MODELS = ['claude-haiku-4-5-20251001','claude-sonnet-4-20250514','claude-opus-4-20250514'];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Vary','Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const ipLimit = getRateLimit(`ip:${ip}`, 30);
  if (!ipLimit.allowed) return res.status(429).json({error:`Rate limited. Retry in ${ipLimit.retryAfter}s.`});

  // ── Clerk auth ──
  const authHeader = req.headers.authorization;
  let clerkUserId = null;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const clerkRes = await fetch('https://api.clerk.com/v1/tokens/verify', {
        method:'POST',
        headers:{'Authorization':`Bearer ${process.env.CLERK_SECRET_KEY}`,'Content-Type':'application/json'},
        body: JSON.stringify({token: authHeader.split(' ')[1]}),
      });
      if (clerkRes.ok) { const d = await clerkRes.json(); clerkUserId = d.sub || d.user_id; }
    } catch(e) {}
  }

  // Guest: only 3 AI calls per minute per IP
  if (!clerkUserId) {
    const guestLimit = getRateLimit(`guest:${ip}`, 3);
    if (!guestLimit.allowed) return res.status(401).json({error:'guest_limit_reached', message:'Sign in to keep learning.'});
  } else {
    const userLimit = getRateLimit(`user:${clerkUserId}`, 20);
    if (!userLimit.allowed) return res.status(429).json({error:`Rate limited. Retry in ${userLimit.retryAfter}s.`});
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({error:'Server misconfiguration'});

  const body = req.body;
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return res.status(400).json({error:'Invalid request'});
  if (body.messages.length > 40) return res.status(400).json({error:'Too many messages'});
  if (JSON.stringify(body).length > 100000) return res.status(400).json({error:'Request too large'});

  const model = body.model || 'claude-sonnet-4-20250514';
  if (!ALLOWED_MODELS.includes(model)) return res.status(400).json({error:'Model not allowed'});

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({model, max_tokens:Math.min(body.max_tokens||1000,4000), messages:body.messages, ...(body.system?{system:body.system}:{})}),
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch(err) {
    return res.status(500).json({error:'Failed to contact AI service'});
  }
}
