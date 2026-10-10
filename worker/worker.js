
const ACTIVE_WINDOW_SECONDS = 120;
const MAX_REQUEST_BYTES = 16_384;
const MAX_SESSIONS = 200;
const MAX_EVENTS = 500;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Admin-Key, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function errorResponse(message, status) {
  return jsonResponse({ error: message }, status);
}

function validString(value, maxLength = 2048) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
  );
}

function validPage(page) {
  return (
    typeof page === "string" &&
    page.length > 0 &&
    page.length <= 2048 &&
    page.startsWith("/") &&
    !page.startsWith("//")
  );
}

function parseTimestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const milliseconds =
    typeof value === "number" ? value : Date.parse(value);

  if (!Number.isFinite(milliseconds)) {
    return null;
  }

  const seconds = Math.floor(milliseconds / 1000);
  const now = Math.floor(Date.now() / 1000);

  if (seconds < now - 60 * 60 * 24 * 30 || seconds > now + 300) {
    return null;
  }

  return seconds;
}

function makeId() {
  return crypto.randomUUID();
}

function boundedText(value, maxLength) {
  if (typeof value !== "string") return null;

  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) return null;

  return cleaned;
}

function boundedInteger(value, min, max) {
  const number = Number(value);

  if (
    !Number.isInteger(number) ||
    number < min ||
    number > max
  ) {
    return null;
  }

  return number;
}

async function hashIpAddress(request, env) {
  // Cloudflare supplies this header. Never accept an IP supplied
  // by the visitor's JavaScript.
  const ip = request.headers.get("CF-Connecting-IP");

  // Without a secret salt, do not store an IP-derived identifier.
  if (!ip || !env.IP_HASH_SALT) return null;

  const input = new TextEncoder().encode(
    `${env.IP_HASH_SALT}:${ip}`
  );

  const digest = await crypto.subtle.digest("SHA-256", input);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function getDashboardUser(db) {
  return await db
    .prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
    .first();
}

async function handleHealth(env) {
  if (!env.DB) {
    return jsonResponse({
      ok: true,
      databaseConfigured: false,
      visitorSessions: 0
    });
  }

  try {
    const result = await env.DB
      .prepare("SELECT COUNT(*) AS total FROM visitor_sessions")
      .first();

    return jsonResponse({
      ok: true,
      databaseConfigured: true,
      visitorSessions: Number(result?.total ?? 0)
    });
  } catch (error) {
    console.error("Health check failed:", error);
    return errorResponse("Database health check failed.", 500);
  }
}

async function handleEvent(request, env) {
  if (!env.DB) {
    return errorResponse("Database is not configured.", 503);
  }

  const contentLength = Number(
    request.headers.get("Content-Length") || 0
  );

  if (contentLength > MAX_REQUEST_BYTES) {
    return errorResponse("Request body is too large.", 413);
  }

  let body;

  try {
    const rawBody = await request.text();

    if (rawBody.length > MAX_REQUEST_BYTES) {
      return errorResponse("Request body is too large.", 413);
    }

    body = JSON.parse(rawBody);
  } catch {
    return errorResponse("Invalid JSON request body.", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("Invalid request body.", 400);
  }

  if (body.consent !== true) {
    return errorResponse("Visitor consent is required.", 400);
  }

  const sessionId = body.sessionId;
  const eventType = body.eventType || body.type;
  const page = body.page;
  const timestamp = parseTimestamp(body.timestamp);

  if (!validString(sessionId, 100)) {
    return errorResponse("Invalid sessionId.", 400);
  }

const allowedTypes = new Set([
  "page_view",
  "click",
  "heartbeat",
  "keyboard_interaction"
]);

  if (!validString(eventType, 40) || !allowedTypes.has(eventType)) {
    return errorResponse("Unsupported event type.", 400);
  }

  if (!validPage(page)) {
    return errorResponse("Invalid page path.", 400);
  }

  if (timestamp === null) {
    return errorResponse("Invalid event timestamp.", 400);
  }

  const user = await getDashboardUser(env.DB);

  if (!user) {
    return errorResponse("No dashboard user is registered yet.", 503);
  }

  const now = Math.floor(Date.now() / 1000);
  const userAgent = (
    request.headers.get("User-Agent") || ""
  ).slice(0, 512);

  // Accept only bounded browser-reported values.
  const platform = boundedText(body.platform, 40);
  const screenWidth = boundedInteger(body.screenWidth, 1, 100000);
  const screenHeight = boundedInteger(body.screenHeight, 1, 100000);
  const colorDepth = boundedInteger(body.colorDepth, 1, 128);
  const language = boundedText(body.language, 35);
  const timezone = boundedText(body.timezone, 100);
  const referrer = boundedText(body.referrer, 512);

  // Country is provided by Cloudflare, not by the visitor's payload.
  const countryHeader = request.headers.get("CF-IPCountry");
  const country =
    countryHeader && /^[A-Z]{2}$/.test(countryHeader)
      ? countryHeader
      : null;

  let ipHash = null;

  try {
    ipHash = await hashIpAddress(request, env);
  } catch (error) {
    // Tracking can continue without an IP hash.
    console.error("IP hashing failed; skipping IP hash.");
  }

  try {
    const existingSession = await env.DB
      .prepare(
        "SELECT user_id FROM visitor_sessions WHERE id = ? LIMIT 1"
      )
      .bind(sessionId)
      .first();

    if (existingSession && existingSession.user_id !== user.id) {
      return errorResponse("Session ID conflict.", 409);
    }

    if (!existingSession) {
      const count = await env.DB
        .prepare(
          "SELECT COUNT(*) AS total FROM visitor_sessions WHERE user_id = ?"
        )
        .bind(user.id)
        .first();

      if (Number(count?.total ?? 0) >= 10000) {
        return errorResponse(
          "Visitor session storage limit reached.",
          429
        );
      }
    }

    const eventId = makeId();

    const statements = [
      env.DB.prepare(`
        INSERT INTO visitor_sessions (
          id,
          user_id,
          started_at,
          last_seen_at,
          consent_at,
          user_agent,
          platform,
          screen_width,
          screen_height,
          color_depth,
          language,
          timezone,
          current_page,
          referrer,
          ip_hash,
          country,
          active
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          user_agent = excluded.user_agent,
          platform = COALESCE(excluded.platform, visitor_sessions.platform),
          screen_width = COALESCE(excluded.screen_width, visitor_sessions.screen_width),
          screen_height = COALESCE(excluded.screen_height, visitor_sessions.screen_height),
          color_depth = COALESCE(excluded.color_depth, visitor_sessions.color_depth),
          language = COALESCE(excluded.language, visitor_sessions.language),
          timezone = COALESCE(excluded.timezone, visitor_sessions.timezone),
          current_page = excluded.current_page,
          referrer = COALESCE(excluded.referrer, visitor_sessions.referrer),
          ip_hash = COALESCE(excluded.ip_hash, visitor_sessions.ip_hash),
          country = COALESCE(excluded.country, visitor_sessions.country),
          active = 1
        WHERE visitor_sessions.user_id = excluded.user_id
      `).bind(
        sessionId,
        user.id,
        now,
        now,
        now,
        userAgent,
        platform,
        screenWidth,
        screenHeight,
        colorDepth,
        language,
        timezone,
        page,
        referrer,
        ipHash,
        country
      ),

      env.DB.prepare(`
        INSERT INTO events (
          id,
          visitor_session_id,
          user_id,
          event_type,
          page,
          created_at,
          details_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        eventId,
        sessionId,
        user.id,
        eventType,
        page,
        timestamp,
        JSON.stringify({
          label: typeof body.label === "string"
            ? body.label.slice(0, 200)
            : ""
        })
      )
    ];

    await env.DB.batch(statements);

    return jsonResponse({
      ok: true,
      recorded: true,
      eventId
    }, 201);
  } catch (error) {
    console.error("Event recording failed:", error);
    return errorResponse("Could not record visitor event.", 500);
  }
}

async function handleDashboard(request, env) {
  if (!env.DB) {
    return errorResponse("Database is not configured.", 503);
  }

  if (!env.ADMIN_KEY) {
    return errorResponse(
      "Admin authentication is not configured.",
      503
    );
  }

  const suppliedKey = request.headers.get("X-Admin-Key");

  if (!suppliedKey || suppliedKey !== env.ADMIN_KEY) {
    return errorResponse("Invalid or missing admin key.", 401);
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const activeSince = now - ACTIVE_WINDOW_SECONDS;

    const [
      sessionResult,
      eventResult,
      pageResult,
      countResult
    ] = await Promise.all([
      env.DB.prepare(`
        SELECT
          vs.id,
          vs.user_id,
          vs.started_at,
          vs.last_seen_at,
          vs.consent_at,
          vs.user_agent,
          vs.platform,
          vs.screen_width,
          vs.screen_height,
          vs.color_depth,
          vs.language,
          vs.timezone,
          vs.current_page,
          vs.referrer,
          vs.ip_hash,
          vs.country,
          vs.active,
          COUNT(CASE WHEN e.event_type = 'page_view' THEN 1 END)
            AS views,
          COUNT(e.id) AS event_count,
          CASE
            WHEN vs.last_seen_at >= ? THEN 1
            ELSE 0
          END AS online
        FROM visitor_sessions vs
        LEFT JOIN events e ON e.visitor_session_id = vs.id
        GROUP BY vs.id
        ORDER BY vs.last_seen_at DESC
        LIMIT ?
      `).bind(activeSince, MAX_SESSIONS).all(),

      env.DB.prepare(`
        SELECT
          id,
          visitor_session_id AS session_id,
          user_id,
          event_type,
          page,
          created_at,
          details_json
        FROM events
        ORDER BY created_at DESC
        LIMIT ?
      `).bind(MAX_EVENTS).all(),

      env.DB.prepare(`
        SELECT page, COUNT(*) AS views
        FROM events
        WHERE event_type = 'page_view'
        GROUP BY page
        ORDER BY views DESC
        LIMIT 100
      `).all(),

      env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM visitor_sessions) AS sessions,
          (SELECT COUNT(*) FROM events) AS events,
          (
            SELECT COUNT(*)
            FROM visitor_sessions
            WHERE last_seen_at >= ?
          ) AS online,
          (
            SELECT COUNT(*)
            FROM events
            WHERE event_type = 'page_view'
          ) AS pageViews
      `).bind(activeSince).first()
    ]);

    const sessions = (sessionResult.results || []).map((row) => ({
      ...row,
      views: Number(row.views || 0),
      event_count: Number(row.event_count || 0),
      online: Boolean(row.online),
      status: row.last_seen_at >= activeSince ? "Online" : "Offline"
    }));

    const events = (eventResult.results || []).map((row) => {
      let details = {};

      try {
        details = row.details_json
          ? JSON.parse(row.details_json)
          : {};
      } catch {
        details = {};
      }

      return { ...row, details };
    });

    const pages = (pageResult.results || []).map((row) => ({
      page: row.page,
      views: Number(row.views || 0)
    }));

    return jsonResponse({
      ok: true,
      updatedAt: now,
      stats: {
        online: Number(countResult?.online || 0),
        pageViews: Number(countResult?.pageViews || 0),
        sessions: Number(countResult?.sessions || 0),
        events: Number(countResult?.events || 0)
      },
      sessions,
      events,
      pages
    });
  } catch (error) {
    console.error("Dashboard query failed:", error);
    return errorResponse("Could not load dashboard data.", 500);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return await handleHealth(env);
      }

      if (url.pathname === "/api/event" && request.method === "POST") {
        return await handleEvent(request, env);
      }

      if (
        url.pathname === "/api/dashboard" &&
        request.method === "GET"
      ) {
        return await handleDashboard(request, env);
      }

      if (url.pathname === "/" && request.method === "GET") {
        return jsonResponse({
          name: "Visitor Control Centre API",
          ok: true,
          endpoints: [
            "/api/health",
            "/api/event",
            "/api/dashboard"
          ]
        });
      }

      return errorResponse("Endpoint not found.", 404);
    } catch (error) {
      console.error("Unhandled Worker error:", error);
      return errorResponse("Internal server error.", 500);
    }
  }
};
