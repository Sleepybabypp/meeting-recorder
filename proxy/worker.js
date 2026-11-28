/* ตัวกลางเก็บคีย์ Gemini สำหรับแอป "สรุปประชุม" (Cloudflare Worker)
   แอปส่งคำขอมาที่นี่แทนการส่งไป Google ตรงๆ แล้ว Worker ใส่คีย์ให้
   คีย์อยู่ในตัวแปรลับ GEMINI_KEY ของ Cloudflare ไม่มีในโค้ดและไม่มีใน GitHub

   กันคนนอกใช้โควตา:
   - รับเฉพาะคำขอจากเว็บที่อยู่ใน ALLOWED_ORIGINS
   - รับเฉพาะ path ที่แอปใช้ (interactions และรายชื่อโมเดล)
   - จำกัดขนาดไฟล์ และจำกัดจำนวนครั้งต่อ IP ต่อนาที
   ทั้งหมดนี้กันได้ระดับพื้นฐาน คนที่ตั้งใจจริงยังปลอม Origin ได้ ให้ตั้งงบหรือดูการใช้ใน Google AI Studio ไว้ด้วย */

const ALLOWED_ORIGINS = [
  'https://sleepybabypp.github.io',
  'http://localhost:8770',
];
const GOOGLE = 'https://generativelanguage.googleapis.com';
const MAX_BYTES = 20 * 1024 * 1024;      // ไฟล์เสียงหนึ่งช่วงไม่เกิน ~14 MB (base64 แล้วราว 19 MB)
const PER_MINUTE = 90;                   // คำขอต่อ IP ต่อนาที (รวมการเช็กสถานะงานถอดเสียงด้วย)
const hits = new Map();

function cors(origin){
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const fail = (status, message, h) => new Response(JSON.stringify({error: {code: status, message}}), {status, headers: {...h, 'Content-Type': 'application/json'}});

function limited(ip){
  const now = Date.now(), win = hits.get(ip) || [];
  const recent = win.filter(t => now - t < 60000);
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > PER_MINUTE;
}

export default {
  async fetch(req, env){
    const origin = req.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.includes(origin)) return fail(403, 'origin not allowed', {});
    const h = cors(origin);
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: h});
    if (!env.GEMINI_KEY) return fail(500, 'proxy has no GEMINI_KEY', h);

    const url = new URL(req.url);
    const okPath = (req.method === 'POST' && url.pathname === '/v1beta/interactions')
      || (req.method === 'GET' && /^\/v1beta\/interactions\/[\w-]+$/.test(url.pathname))
      || (req.method === 'GET' && url.pathname === '/v1beta/models');
    if (!okPath) return fail(404, 'not found', h);

    const len = +(req.headers.get('Content-Length') || 0);
    if (len > MAX_BYTES) return fail(413, 'file too large', h);

    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    if (env.LIMITER) {                     // ตัวจำกัดของ Cloudflare (ถ้าเพิ่ม binding ไว้) แม่นกว่าตัวนับในหน่วยความจำ
      const {success} = await env.LIMITER.limit({key: ip});
      if (!success) return fail(429, 'too many requests, wait a moment', h);
    } else if (limited(ip)) return fail(429, 'too many requests, wait a moment', h);

    const r = await fetch(GOOGLE + url.pathname + url.search, {
      method: req.method,
      headers: {'x-goog-api-key': env.GEMINI_KEY, 'Content-Type': 'application/json'},
      body: req.method === 'POST' ? req.body : undefined,
    });
    const out = new Headers(h);
    out.set('Content-Type', r.headers.get('Content-Type') || 'application/json');
    return new Response(r.body, {status: r.status, headers: out});
  },
};
