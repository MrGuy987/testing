const ACTIVE_WINDOW_SECONDS = 120;
const MAX_REQUEST_BYTES = 32768;
const MAX_SESSIONS = 10000;
const MAX_EVENTS = 500;
const SUPPORT_TTL_SECONDS = 300;
const ALLOWED_ORIGIN = "https://mrguy987.github.io";

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Admin-Key, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  }

  return headers;
}

function jsonResponse(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(request ? corsHeaders(request) : {})
    }
  });
}

function errorResponse(message, status = 400, request) {
  return jsonResponse({ ok: false, error: message }, status, request);
}

function validString(value, max = 200) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max;
}

function validPage(value) {
  return typeof value === "string" &&
    value.length <= 2048 &&
    value.startsWith("/");
}

function parseTimestamp(value) {
  const n = Number(value);

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : Math.floor(Date.now() / 1000);
}

function makeId() {
  return crypto.randomUUID();
}

async function readJson(request, limit = MAX_REQUEST_BYTES) {
  const len = Number(request.headers.get("Content-Length") || 0);

  if (len > limit) {
    throw new Error("Request body is too large.");
  }

  const text = await request.text();

  if (text.length > limit) {
    throw new Error("Request body is too large.");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(hash)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

function adminAuthorized(request, env) {
  const supplied = request.headers.get("X-Admin-Key") || "";

  return Boolean(
    env.ADMIN_KEY &&
    supplied &&
    supplied === env.ADMIN_KEY
  );
}

function bearer(request) {
  const value = request.headers.get("Authorization") || "";

  return value.startsWith("Bearer ")
    ? value.slice(7)
    : "";
}

async function supportAuth(request, env, supportId) {
  if (adminAuthorized(request, env)) {
    const adminRow = await env.DB.prepare(
      `SELECT id, status, expires_at
       FROM support_sessions
       WHERE id = ?
       LIMIT 1`
    ).bind(supportId).first();

    return adminRow
      ? { role: "admin", row: adminRow }
      : null;
  }

  const token = bearer(request);

  if (!token || !validString(supportId, 100)) {
    return null;
  }

  const tokenHash = await sha256(token);

  const row = await env.DB.prepare(
    `SELECT id, status, expires_at
     FROM support_sessions
     WHERE id = ?
       AND visitor_token_hash = ?
     LIMIT 1`
  ).bind(supportId, tokenHash).first();

  if (
    !row ||
    row.expires_at < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }

  return { role: "visitor", row };
}

function originAllowed(request) {
  const origin = request.headers.get("Origin");

  return !origin || origin === ALLOWED_ORIGIN;
}

async function handleHealth(request, env) {
  if (!env.DB) {
    return errorResponse(
      "Database binding DB is missing.",
      500,
      request
    );
  }

  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM visitor_sessions"
  ).first();

  return jsonResponse({
    ok: true,
    sessions: Number(row?.total || 0),
    time: Date.now()
  }, 200, request);
}

async function handleEvent(request, env) {
  if (!env.DB) {
    return errorResponse(
      "Database binding DB is missing.",
      500,
      request
    );
  }

  let body;

  try {
    body = await readJson(request, 16384);
  } catch (e) {
    return errorResponse(e.message, 413, request);
  }

  if (body.consent !== true) {
    return errorResponse("Consent is required.", 403, request);
  }

  if (!validString(body.sessionId, 100)) {
    return errorResponse("Invalid sessionId.", 400, request);
  }

  const allowedTypes = new Set([
    "page_view",
    "click",
    "heartbeat",
    "keyboard_interaction"
  ]);

  if (!allowedTypes.has(body.eventType)) {
    return errorResponse("Invalid eventType.", 400, request);
  }

  if (!validPage(body.page)) {
    return errorResponse("Invalid page.", 400, request);
  }

  const now = parseTimestamp(body.timestamp);

  const user = await env.DB.prepare(
    "SELECT id FROM users ORDER BY created_at ASC LIMIT 1"
  ).first();

  if (!user) {
    return errorResponse(
      "No dashboard user exists yet.",
      500,
      request
    );
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM visitor_sessions WHERE id = ? LIMIT 1"
  ).bind(body.sessionId).first();

  if (!existing) {
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM visitor_sessions"
    ).first();

    if (Number(count?.total || 0) >= MAX_SESSIONS) {
      return errorResponse(
        "Session storage limit reached.",
        429,
        request
      );
    }

    const meta =
      body.metadata && typeof body.metadata === "object"
        ? body.metadata
        : body;

    const rawIp = request.headers.get("CF-Connecting-IP") || "";

    const ipHash = rawIp
      ? await sha256(
          String(env.IP_HASH_SALT || "visitor-dashboard") +
          "|" +
          rawIp
        )
      : null;

    const country =
      request.cf && request.cf.country
        ? String(request.cf.country).slice(0, 8)
        : null;

    await env.DB.prepare(
      `INSERT INTO visitor_sessions
      (
        id, user_id, started_at, last_seen_at, consent_at,
        user_agent, platform, screen_width, screen_height,
        color_depth, language, timezone, current_page,
        referrer, ip_hash, country, active
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).bind(
      body.sessionId,
      user.id,
      now,
      now,
      now,
      String(meta.userAgent || "").slice(0, 500),
      String(meta.platform || "").slice(0, 100),
      Number(meta.screenWidth) || null,
      Number(meta.screenHeight) || null,
      Number(meta.colorDepth) || null,
      String(meta.language || "").slice(0, 100),
      String(meta.timezone || "").slice(0, 100),
      body.page,
      String(meta.referrer || "").slice(0, 2048),
      ipHash,
      country
    ).run();
  } else {
    await env.DB.prepare(
      `UPDATE visitor_sessions
       SET last_seen_at = ?, current_page = ?, active = 1
       WHERE id = ?`
    ).bind(now, body.page, body.sessionId).run();
  }

  const eventId = makeId();

  const details = {
    label: validString(body.label, 300)
      ? body.label
      : ""
  };

  await env.DB.prepare(
    `INSERT INTO events
    (
      id, visitor_session_id, user_id,
      event_type, page, created_at, details_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    eventId,
    body.sessionId,
    user.id,
    body.eventType,
    body.page,
    now,
    JSON.stringify(details)
  ).run();

  await env.DB.prepare(
    `DELETE FROM events
     WHERE id IN (
       SELECT id FROM events
       ORDER BY created_at DESC
       LIMIT -1 OFFSET ?
     )`
  ).bind(MAX_EVENTS * 100).run();

  return jsonResponse({
    ok: true,
    recorded: true,
    eventId
  }, 200, request);
}

async function handleDashboard(request, env) {
  if (!adminAuthorized(request, env)) {
    return errorResponse("Unauthorised.", 401, request);
  }

  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `UPDATE visitor_sessions
     SET active = 0
     WHERE last_seen_at < ?`
  ).bind(now - ACTIVE_WINDOW_SECONDS).run();

  const sessionsResult = await env.DB.prepare(
    `SELECT
      s.id,
      s.started_at,
      s.last_seen_at,
      s.current_page,
      s.platform,
      s.screen_width,
      s.screen_height,
      s.color_depth,
      s.language,
      s.timezone,
      s.country,
      s.ip_hash,
      s.active,
      (
        SELECT COUNT(*)
        FROM events e
        WHERE e.visitor_session_id = s.id
          AND e.event_type = 'page_view'
      ) AS views
     FROM visitor_sessions s
     ORDER BY s.last_seen_at DESC
     LIMIT 200`
  ).all();

  const eventsResult = await env.DB.prepare(
    `SELECT
      id,
      visitor_session_id,
      event_type,
      page,
      created_at,
      details_json
     FROM events
     ORDER BY created_at DESC
     LIMIT 500`
  ).all();

  const pagesResult = await env.DB.prepare(
    `SELECT page, COUNT(*) AS views
     FROM events
     WHERE event_type = 'page_view'
     GROUP BY page
     ORDER BY views DESC
     LIMIT 20`
  ).all();

  const totalSessions = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM visitor_sessions"
  ).first();

  const totalEvents = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events"
  ).first();

  const totalViews = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE event_type = 'page_view'"
  ).first();

  const sessions = (sessionsResult.results || []).map(s => ({
    ...s,
    online:
      Number(s.active) === 1 &&
      now - Number(s.last_seen_at) <= ACTIVE_WINDOW_SECONDS
  }));

  const events = (eventsResult.results || []).map(e => {
    let details = {};

    try {
      details = JSON.parse(e.details_json || "{}");
    } catch {}

    return {
      ...e,
      sessionId: e.visitor_session_id,
      eventType: e.event_type,
      timestamp: e.created_at,
      details,
      label: details.label || ""
    };
  });

  return jsonResponse({
    ok: true,
    updatedAt: now,
    stats: {
      online: sessions.filter(s => s.online).length,
      pageViews: Number(totalViews?.n || 0),
      sessions: Number(totalSessions?.n || 0),
      events: Number(totalEvents?.n || 0)
    },
    sessions,
    events,
    pages: pagesResult.results || []
  }, 200, request);
}

async function handleSupportRequest(request, env) {
  if (!adminAuthorized(request, env)) {
    return errorResponse("Unauthorised.", 401, request);
  }

  let body;

  try {
    body = await readJson(request, 4096);
  } catch (e) {
    return errorResponse(e.message, 413, request);
  }

  if (!validString(body.visitorSessionId, 100)) {
    return errorResponse(
      "Invalid visitor session ID.",
      400,
      request
    );
  }

  const visitor = await env.DB.prepare(
    "SELECT id FROM visitor_sessions WHERE id = ? LIMIT 1"
  ).bind(body.visitorSessionId).first();

  if (!visitor) {
    return errorResponse(
      "That visitor session no longer exists.",
      404,
      request
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const id = makeId();

  await env.DB.prepare(
    `UPDATE support_sessions
     SET status = 'ended', updated_at = ?
     WHERE visitor_session_id = ?
       AND status IN ('pending', 'approved', 'connected')`
  ).bind(now, body.visitorSessionId).run();

  await env.DB.prepare(
    `INSERT INTO support_sessions
    (
      id, visitor_session_id, status, visitor_token_hash,
      created_at, updated_at, expires_at
    )
    VALUES (?, ?, 'pending', NULL, ?, ?, ?)`
  ).bind(
    id,
    body.visitorSessionId,
    now,
    now,
    now + SUPPORT_TTL_SECONDS
  ).run();

  return jsonResponse({
    ok: true,
    supportId: id,
    status: "pending",
    expiresAt: now + SUPPORT_TTL_SECONDS
  }, 200, request);
}

async function handleSupportPending(request, env) {
  const sessionId =
    new URL(request.url).searchParams.get("sessionId") || "";

  if (!validString(sessionId, 100)) {
    return errorResponse(
      "Invalid visitor session ID.",
      400,
      request
    );
  }

  const now = Math.floor(Date.now() / 1000);

  const row = await env.DB.prepare(
    `SELECT id, status, visitor_token_hash, expires_at, created_at
     FROM support_sessions
     WHERE visitor_session_id = ?
       AND status = 'pending'
       AND expires_at >= ?
     ORDER BY created_at DESC
     LIMIT 1`
  ).bind(sessionId, now).first();

  if (!row) {
    return jsonResponse({
      ok: true,
      requestPending: false
    }, 200, request);
  }

  if (row.visitor_token_hash) {
    return jsonResponse({
      ok: true,
      requestPending: true,
      supportId: row.id,
      claimed: true
    }, 200, request);
  }

  const token = makeId() + makeId();
  const hash = await sha256(token);

  const result = await env.DB.prepare(
    `UPDATE support_sessions
     SET visitor_token_hash = ?, updated_at = ?
     WHERE id = ?
       AND visitor_token_hash IS NULL
       AND status = 'pending'`
  ).bind(hash, now, row.id).run();

  if (
    !result.meta ||
    Number(result.meta.changes || 0) !== 1
  ) {
    return jsonResponse({
      ok: true,
      requestPending: true,
      supportId: row.id,
      claimed: true
    }, 200, request);
  }

  return jsonResponse({
    ok: true,
    requestPending: true,
    supportId: row.id,
    visitorToken: token,
    expiresAt: row.expires_at
  }, 200, request);
}

async function handleSupportStatus(request, env) {
  const id = new URL(request.url).searchParams.get("id") || "";
  const auth = await supportAuth(request, env, id);

  if (!auth) {
    return errorResponse(
      "Unauthorised support session.",
      401,
      request
    );
  }

  const row = await env.DB.prepare(
    `SELECT
      id, status, visitor_session_id,
      created_at, updated_at, expires_at
     FROM support_sessions
     WHERE id = ?
     LIMIT 1`
  ).bind(id).first();

  if (!row) {
    return errorResponse(
      "Support session not found.",
      404,
      request
    );
  }

  if (
    row.expires_at < Math.floor(Date.now() / 1000) &&
    !["ended", "denied"].includes(row.status)
  ) {
    await env.DB.prepare(
      `UPDATE support_sessions
       SET status = 'ended', updated_at = ?
       WHERE id = ?`
    ).bind(Math.floor(Date.now() / 1000), id).run();

    row.status = "ended";
  }

  return jsonResponse({
    ok: true,
    support: row
  }, 200, request);
}

async function handleSupportDecision(request, env) {
  let body;

  try {
    body = await readJson(request, 4096);
  } catch (e) {
    return errorResponse(e.message, 413, request);
  }

  if (
    !validString(body.supportId, 100) ||
    !["approved", "denied"].includes(body.decision)
  ) {
    return errorResponse("Invalid decision.", 400, request);
  }

  const auth = await supportAuth(
    request,
    env,
    body.supportId
  );

  if (!auth || auth.role !== "visitor") {
    return errorResponse(
      "Only the visitor can approve or deny.",
      401,
      request
    );
  }

  if (auth.row.status !== "pending") {
    return errorResponse(
      "This request is no longer pending.",
      409,
      request
    );
  }

  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `UPDATE support_sessions
     SET status = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`
  ).bind(
    body.decision,
    now,
    body.supportId
  ).run();

  return jsonResponse({
    ok: true,
    status: body.decision
  }, 200, request);
}

async function handleSupportSignal(request, env) {
  let body;

  try {
    body = await readJson(request, 28000);
  } catch (e) {
    return errorResponse(e.message, 413, request);
  }

  if (
    !validString(body.supportId, 100) ||
    !["offer", "answer", "ice-candidate"].includes(body.signalType) ||
    !body.payload ||
    typeof body.payload !== "object"
  ) {
    return errorResponse("Invalid signal.", 400, request);
  }

  const auth = await supportAuth(
    request,
    env,
    body.supportId
  );

  if (!auth) {
    return errorResponse(
      "Unauthorised support session.",
      401,
      request
    );
  }

  if (!["approved", "connected"].includes(auth.row.status)) {
    return errorResponse(
      "Support session is not approved.",
      409,
      request
    );
  }

  const payloadText = JSON.stringify(body.payload);

  if (payloadText.length > 24000) {
    return errorResponse(
      "Signal payload is too large.",
      413,
      request
    );
  }

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM support_signals
     WHERE support_session_id = ?`
  ).bind(body.supportId).first();

  if (Number(count?.n || 0) >= 200) {
    return errorResponse(
      "Signal limit reached; restart the support session.",
      429,
      request
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const id = makeId();

  await env.DB.prepare(
    `INSERT INTO support_signals
    (
      id, support_session_id, sender,
      signal_type, payload_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    body.supportId,
    auth.role,
    body.signalType,
    payloadText,
    now
  ).run();

  await env.DB.prepare(
    `UPDATE support_sessions
     SET status = 'connected', updated_at = ?
     WHERE id = ? AND status = 'approved'`
  ).bind(now, body.supportId).run();

  return jsonResponse({
    ok: true,
    id
  }, 200, request);
}

async function handleSupportSignals(request, env) {
  const id = new URL(request.url).searchParams.get("id") || "";
  const auth = await supportAuth(request, env, id);

  if (!auth) {
    return errorResponse(
      "Unauthorised support session.",
      401,
      request
    );
  }

  const result = await env.DB.prepare(
    `SELECT id, sender, signal_type, payload_json, created_at
     FROM support_signals
     WHERE support_session_id = ?
     ORDER BY created_at ASC, id ASC
     LIMIT 200`
  ).bind(id).all();

  const signals = (result.results || []).map(s => {
    let payload = {};

    try {
      payload = JSON.parse(s.payload_json);
    } catch {}

    return {
      id: s.id,
      sender: s.sender,
      signalType: s.signal_type,
      payload,
      createdAt: s.created_at
    };
  });

  return jsonResponse({
    ok: true,
    signals
  }, 200, request);
}

async function handleSupportEnd(request, env) {
  let body;

  try {
    body = await readJson(request, 4096);
  } catch (e) {
    return errorResponse(e.message, 413, request);
  }

  if (!validString(body.supportId, 100)) {
    return errorResponse("Invalid support ID.", 400, request);
  }

  const auth = await supportAuth(
    request,
    env,
    body.supportId
  );

  if (!auth) {
    return errorResponse(
      "Unauthorised support session.",
      401,
      request
    );
  }

  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `UPDATE support_sessions
     SET status = 'ended', updated_at = ?
     WHERE id = ?`
  ).bind(now, body.supportId).run();

  return jsonResponse({
    ok: true,
    status: "ended"
  }, 200, request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!originAllowed(request)) {
        return new Response(null, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: corsHeaders(request)
      });
    }

    if (!originAllowed(request)) {
      return errorResponse(
        "Origin not allowed.",
        403,
        request
      );
    }

    try {
      if (
        request.method === "GET" &&
        url.pathname === "/api/health"
      ) {
        return await handleHealth(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/event"
      ) {
        return await handleEvent(request, env);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/dashboard"
      ) {
        if (!env.DB) {
          return errorResponse(
            "Database binding DB is missing.",
            500,
            request
          );
        }

        return await handleDashboard(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/support/request"
      ) {
        return await handleSupportRequest(request, env);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/support/pending"
      ) {
        return await handleSupportPending(request, env);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/support/status"
      ) {
        return await handleSupportStatus(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/support/decision"
      ) {
        return await handleSupportDecision(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/support/signal"
      ) {
        return await handleSupportSignal(request, env);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/support/signals"
      ) {
        return await handleSupportSignals(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/support/end"
      ) {
        return await handleSupportEnd(request, env);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        return jsonResponse({
          ok: true,
          name: "Visitor Dashboard API",
          support: true
        }, 200, request);
      }

      return errorResponse("Not found.", 404, request);
    } catch (error) {
      return errorResponse(
        error?.message || "Internal server error.",
        500,
        request
      );
    }
  }
};