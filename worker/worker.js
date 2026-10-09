
const MAX_EVENTS = 5000;
const MAX_BODY_BYTES = 4000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "";

    const cors = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
      "Vary": "Origin",
      "Cache-Control": "no-store"
    };

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...cors
        }
      });

    if (request.method === "OPTIONS") {
      if (origin !== allowedOrigin) {
        return json({ error: "Origin not allowed" }, 403);
      }
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        const result = await env.DB
          .prepare("SELECT COUNT(*) AS count FROM visitor_sessions")
          .first();

        return json({
          ok: true,
          databaseConfigured: true,
          visitorSessions: result.count
        });
      }

      if (url.pathname === "/api/event" && request.method === "POST") {
        if (!allowedOrigin || origin !== allowedOrigin) {
          return json({ error: "Origin not allowed" }, 403);
        }

        const length = Number(request.headers.get("Content-Length") || 0);
        if (length > MAX_BODY_BYTES) {
          return json({ error: "Request too large" }, 413);
        }

        const input = await request.json();

        if (JSON.stringify(input).length > MAX_BODY_BYTES) {
          return json({ error: "Request too large" }, 413);
        }

        const event = validateEvent(input);
        if (!event) {
          return json({ error: "Invalid event or consent missing" }, 400);
        }

        await appendEvent(env, request, event);
        return json({ ok: true }, 202);
      }

      if (url.pathname === "/api/dashboard" && request.method === "GET") {
        if (
          !env.ADMIN_KEY ||
          request.headers.get("X-Admin-Key") !== env.ADMIN_KEY
        ) {
          return json({ error: "Invalid admin key" }, 401);
        }

        return json(await readDashboard(env));
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error("Worker error:", error);
      return json({
        error: error.publicMessage || "Server error"
      }, error.status || 500);
    }
  }
};

function validateEvent(input) {
  if (!input || typeof input !== "object" || input.consent !== true) {
    return null;
  }

  if (!["page_view", "click", "heartbeat"].includes(input.type)) {
    return null;
  }

  const sessionId = String(input.sessionId || "");
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) {
    return null;
  }

  const page = String(input.page || "/").split("?")[0].slice(0, 250);
  if (!page.startsWith("/") || page.startsWith("//")) {
    return null;
  }

  const timestamp = Date.parse(input.timestamp);
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() - timestamp) > 10 * 60 * 1000
  ) {
    return null;
  }

  return {
    type: input.type,
    sessionId,
    page,
    timestamp: Math.floor(timestamp / 1000),
    label: input.type === "click"
      ? String(input.label || "")
          .replace(/[\r\n\t]/g, " ")
          .slice(0, 80)
      : ""
  };
}

async function appendEvent(env, request, event) {
  // Associate visitor records with the first registered dashboard user.
  const owner = await env.DB
    .prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
    .first();

  if (!owner) {
    const error = new Error("Create a dashboard user before collecting events.");
    error.status = 503;
    error.publicMessage = "No dashboard user is registered yet.";
    throw error;
  }

  const userId = owner.id;
  const platform = getPlatform(request.headers.get("User-Agent") || "");
  const now = event.timestamp;
  const details = event.label ? JSON.stringify({ label: event.label }) : null;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO visitor_sessions (
        id, user_id, started_at, last_seen_at, consent_at,
        platform, current_page, active
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        last_seen_at = MAX(visitor_sessions.last_seen_at, excluded.last_seen_at),
        current_page = excluded.current_page,
        active = 1
      WHERE visitor_sessions.user_id = excluded.user_id
    `).bind(
      event.sessionId, userId, now, now, now,
      platform, event.page
    ),

    env.DB.prepare(`
      INSERT INTO events (
        id, visitor_session_id, user_id, event_type,
        page, created_at, details_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), event.sessionId, userId,
      event.type, event.page, now, details
    )
  ]);

  if (event.type === "page_view") {
    await env.DB.prepare(`
      DELETE FROM events
      WHERE user_id = ?
        AND id IN (
          SELECT id FROM events
          WHERE user_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT -1 OFFSET ?
        )
    `).bind(userId, userId, MAX_EVENTS).run();
  }
}

function getPlatform(ua) {
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/CrOS/i.test(ua)) return "ChromeOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Macintosh|Mac OS/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Other";
}

async function readDashboard(env) {
  const owner = await env.DB
    .prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
    .first();

  if (!owner) {
    return { sessions: {}, events: [], version: 1, updatedAt: new Date().toISOString() };
  }

  const sessionsResult = await env.DB.prepare(`
    SELECT
      s.id, s.current_page, s.started_at, s.last_seen_at,
      COUNT(CASE WHEN e.event_type = 'page_view' THEN 1 END) AS page_views
    FROM visitor_sessions s
    LEFT JOIN events e ON e.visitor_session_id = s.id
    WHERE s.user_id = ?
    GROUP BY s.id
    ORDER BY s.last_seen_at DESC
  `).bind(owner.id).all();

  const eventsResult = await env.DB.prepare(`
    SELECT id, visitor_session_id, event_type, page, created_at, details_json
    FROM events
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(owner.id, MAX_EVENTS).all();

  const sessions = {};

  for (const s of sessionsResult.results) {
    sessions[s.id] = {
      id: s.id,
      currentPage: s.current_page,
      firstSeen: new Date(s.started_at * 1000).toISOString(),
      lastSeen: new Date(s.last_seen_at * 1000).toISOString(),
      pageViews: s.page_views,
      active: Date.now() / 1000 - s.last_seen_at < 120
    };
  }

  const events = eventsResult.results.map(e => {
    let label = "";
    try {
      label = JSON.parse(e.details_json || "{}").label || "";
    } catch {}

    return {
      id: e.id,
      sessionId: e.visitor_session_id,
      type: e.event_type,
      page: e.page,
      timestamp: new Date(e.created_at * 1000).toISOString(),
      label
    };
  });

  return {
    sessions,
    events,
    version: 1,
    updatedAt: new Date().toISOString()
  };
}