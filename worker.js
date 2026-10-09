const encoder = new TextEncoder();
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_BODY = 12_000;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}
function corsHeaders(origin, env) {
  const allowed = env.ALLOWED_ORIGIN || "";
  if (!origin || origin !== allowed) return {};
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "vary": "Origin",
  };
}
function randomHex(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function passwordHash(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g), b => parseInt(b, 16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, key, 256);
  return [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function validEmail(v) {
  return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function validId(v) { return typeof v === "string" && /^[a-f0-9-]{20,80}$/i.test(v); }
function cleanString(v, max = 500) {
  if (typeof v !== "string") return null;
  return v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}
function safePage(v) {
  if (typeof v !== "string" || v.length > 1500) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // Strip query and fragment to avoid storing accidental tokens or personal data in URLs.
    return `${u.origin}${u.pathname}`.slice(0, 1000);
  } catch { return null; }
}
async function readBody(request) {
  const len = Number(request.headers.get("content-length") || "0");
  if (len > MAX_BODY) throw new Error("BODY_TOO_LARGE");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("BODY_TOO_LARGE");
  return JSON.parse(text || "{}");
}
function bearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}
async function requireUser(request, env) {
  const token = bearer(request);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT users.id, users.email, sessions.id AS session_id
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
  ).bind(tokenHash, now).first();
  if (row) await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(now, row.session_id).run();
  return row || null;
}
async function newSession(env, userId) {
  const token = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(3600, Math.min(2592000, Number(env.SESSION_TTL_SECONDS || 604800)));
  await env.DB.prepare(
    "INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?,?)"
  ).bind(crypto.randomUUID(), userId, await sha256(token), now, now + ttl, now).run();
  return token;
}
async function rateCheck(env, key, limit = 10) {
  // Simple durable per-key throttle. Also configure Cloudflare edge rate limiting for production.
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / 60);
  const row = await env.DB.prepare("SELECT hits FROM rate_limits WHERE key = ? AND bucket = ?").bind(key, bucket).first();
  if (row && row.hits >= limit) return false;
  await env.DB.prepare(
    "INSERT INTO rate_limits (key,bucket,hits) VALUES (?,?,1) ON CONFLICT(key,bucket) DO UPDATE SET hits = hits + 1"
  ).bind(key, bucket).run();
  return true;
}
async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    const h = corsHeaders(origin, env);
    if (!h["access-control-allow-origin"]) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: { ...h, "access-control-max-age": "600" } });
  }
  if (origin && origin !== (env.ALLOWED_ORIGIN || "")) return json({ error: "Origin not allowed" }, 403);
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const h = corsHeaders(origin, env);
  try {
    if (path === "/api/health" && request.method === "GET") return json({ ok: true }, 200, h);

    if (path === "/api/auth/signup" && request.method === "POST") {
      const body = await readBody(request);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = body.password;
      if (!validEmail(email) || typeof password !== "string" || password.length < 12 || password.length > 128) {
        return json({ error: "Use a valid email and a password between 12 and 128 characters." }, 400, h);
      }
      const ipKey = await sha256(request.headers.get("cf-connecting-ip") || "unknown");
      if (!await rateCheck(env, `signup:${ipKey}`, 5)) return json({ error: "Too many attempts. Try again later." }, 429, h);
      const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
      if (exists) return json({ error: "An account with that email already exists." }, 409, h);
      const id = crypto.randomUUID();
      const salt = randomHex(16);
      const hash = await passwordHash(password, salt);
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare("INSERT INTO users (id,email,password_salt,password_hash,created_at) VALUES (?,?,?,?,?)")
        .bind(id, email, salt, hash, now).run();
      const token = await newSession(env, id);
      return json({ token, user: { id, email, isAdmin: email === (env.ADMIN_EMAIL || "").toLowerCase() } }, 201, h);
    }

    if (path === "/api/auth/login" && request.method === "POST") {
      const body = await readBody(request);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = body.password;
      if (!validEmail(email) || typeof password !== "string" || password.length > 128) return json({ error: "Invalid email or password." }, 400, h);
      const ipKey = await sha256(request.headers.get("cf-connecting-ip") || "unknown");
      if (!await rateCheck(env, `login:${ipKey}`, 10)) return json({ error: "Too many attempts. Try again later." }, 429, h);
      const user = await env.DB.prepare("SELECT id,email,password_salt,password_hash FROM users WHERE email = ?").bind(email).first();
      if (!user || await passwordHash(password, user.password_salt) !== user.password_hash) {
        return json({ error: "Invalid email or password." }, 401, h);
      }
      const token = await newSession(env, user.id);
      return json({ token, user: { id: user.id, email: user.email, isAdmin: user.email === (env.ADMIN_EMAIL || "").toLowerCase() } }, 200, h);
    }

    if (path === "/api/auth/logout" && request.method === "POST") {
      const token = bearer(request);
      if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
      return json({ ok: true }, 200, h);
    }

    const user = await requireUser(request, env);
    if (!user) return json({ error: "Sign in required." }, 401, h);

    if (path === "/api/me" && request.method === "GET") {
      return json({ user: { id: user.id, email: user.email, isAdmin: user.email === (env.ADMIN_EMAIL || "").toLowerCase() } }, 200, h);
    }

    if (path === "/api/telemetry" && request.method === "POST") {
      const body = await readBody(request);
      if (body.consent !== true) return json({ error: "Consent is required." }, 400, h);
      if (!validId(body.visitorSessionId)) return json({ error: "Invalid visitor session." }, 400, h);
      const now = Math.floor(Date.now() / 1000);
      const page = safePage(body.page);
      const referrer = safePage(body.referrer);
      const ua = cleanString(request.headers.get("user-agent"), 400);
      const platform = cleanString(body.platform, 100);
      const language = cleanString(body.language, 40);
      const timezone = cleanString(body.timezone, 100);
      const sw = Number.isInteger(body.screenWidth) ? Math.max(0, Math.min(20000, body.screenWidth)) : null;
      const sh = Number.isInteger(body.screenHeight) ? Math.max(0, Math.min(20000, body.screenHeight)) : null;
      const cd = Number.isInteger(body.colorDepth) ? Math.max(0, Math.min(128, body.colorDepth)) : null;
      const ip = request.headers.get("cf-connecting-ip") || "";
      const ipHash = ip ? await sha256(ip) : null;
      const country = cleanString(request.headers.get("cf-ipcountry"), 2);
      const prior = await env.DB.prepare("SELECT id FROM visitor_sessions WHERE id = ? AND user_id = ?")
        .bind(body.visitorSessionId, user.id).first();
      if (!prior) {
        await env.DB.prepare(
          `INSERT INTO visitor_sessions
          (id,user_id,started_at,last_seen_at,consent_at,user_agent,platform,screen_width,screen_height,color_depth,language,timezone,current_page,referrer,ip_hash,country,active)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
        ).bind(body.visitorSessionId, user.id, now, now, now, ua, platform, sw, sh, cd, language, timezone, page, referrer, ipHash, country).run();
      } else {
        await env.DB.prepare(
          `UPDATE visitor_sessions SET last_seen_at=?, user_agent=?, platform=?, screen_width=?, screen_height=?, color_depth=?, language=?, timezone=?, current_page=?, referrer=?, ip_hash=?, country=?, active=1
           WHERE id=? AND user_id=?`
        ).bind(now, ua, platform, sw, sh, cd, language, timezone, page, referrer, ipHash, country, body.visitorSessionId, user.id).run();
      }
      const eventType = ["page_view", "heartbeat", "click"].includes(body.eventType) ? body.eventType : "heartbeat";
      let details = null;
      if (eventType === "click" && body.details && typeof body.details === "object") {
        details = JSON.stringify({ label: cleanString(body.details.label, 80) });
      }
      await env.DB.prepare(
        "INSERT INTO events (id,visitor_session_id,user_id,event_type,page,created_at,details_json) VALUES (?,?,?,?,?,?,?)"
      ).bind(crypto.randomUUID(), body.visitorSessionId, user.id, eventType, page, now, details).run();
      return json({ ok: true, serverTime: now }, 200, h);
    }

    if (path === "/api/consent/revoke" && request.method === "POST") {
      const body = await readBody(request);
      if (!validId(body.visitorSessionId)) return json({ error: "Invalid visitor session." }, 400, h);
      await env.DB.prepare("UPDATE visitor_sessions SET active=0 WHERE id=? AND user_id=?").bind(body.visitorSessionId, user.id).run();
      return json({ ok: true }, 200, h);
    }

    if (path === "/api/dashboard" && request.method === "GET") {
      if (user.email !== (env.ADMIN_EMAIL || "").toLowerCase()) return json({ error: "Admin access required." }, 403, h);
      const sessions = await env.DB.prepare(
        `SELECT vs.id, u.email, vs.started_at, vs.last_seen_at, vs.user_agent, vs.platform,
         vs.screen_width, vs.screen_height, vs.color_depth, vs.language, vs.timezone, vs.current_page,
         vs.referrer, vs.ip_hash, vs.country, vs.active
         FROM visitor_sessions vs JOIN users u ON u.id=vs.user_id
         WHERE vs.last_seen_at >= ? ORDER BY vs.last_seen_at DESC LIMIT 100`
      ).bind(Math.floor(Date.now()/1000) - 86400).all();
      const events = await env.DB.prepare(
        `SELECT e.id, u.email, e.event_type, e.page, e.created_at, e.details_json
         FROM events e JOIN users u ON u.id=e.user_id
         ORDER BY e.created_at DESC LIMIT 100`
      ).all();
      const now = Math.floor(Date.now()/1000);
      const recent = (sessions.results || []).map(s => ({ ...s, connected: s.active === 1 && now - s.last_seen_at <= 25 }));
      return json({ sessions: recent, events: events.results || [], serverTime: now }, 200, h);
    }

    if (path === "/api/account/delete" && request.method === "POST") {
      const body = await readBody(request);
      if (body.confirm !== true) return json({ error: "Confirmation required." }, 400, h);
      await env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.id).run();
      return json({ ok: true }, 200, h);
    }

    return json({ error: "Not found." }, 404, h);
  } catch (error) {
    if (error && error.message === "BODY_TOO_LARGE") return json({ error: "Request too large." }, 413, h);
    if (error instanceof SyntaxError) return json({ error: "Invalid JSON." }, 400, h);
    // Avoid returning database or internal error details to clients.
    return json({ error: "Server error." }, 500, h);
  }
}
export default {
  async fetch(request, env) {
    return handle(request, env);
  }
};
