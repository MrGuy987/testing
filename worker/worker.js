
'use strict';

const ALLOWED_ORIGINS = [
  'https://mrguy987.github.io'
];

const ACTIVE_WINDOW_SECONDS = 120;
const SUPPORT_TTL_SECONDS = 300;
const MAX_REQUEST_BYTES = 32768;
const MAX_EVENTS = 500;

const EVENT_TYPES = new Set([
  'page_view',
  'click',
  'heartbeat',
  'keyboard_interaction'
]);

const SIGNAL_TYPES = new Set([
  'offer',
  'answer',
  'ice-candidate'
]);

const SUPPORT_STATUSES = new Set([
  'pending',
  'approved',
  'connected',
  'ended',
  'denied'
]);

function corsHeaders(request) {
  const origin = request.headers.get('Origin');

  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, X-Admin-Key, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };

  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

function jsonResponse(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function errorResponse(request, message, status = 400) {
  return jsonResponse(request, {
    ok: false,
    error: message
  }, status);
}

function optionsResponse(request) {
  if (!ALLOWED_ORIGINS.includes(request.headers.get('Origin'))) {
    return new Response(null, { status: 403 });
  }

  return new Response(null, {
    status: 204,
    headers: corsHeaders(request)
  });
}

async function readJSON(request) {
  const length = Number(request.headers.get('Content-Length') || 0);

  if (length > MAX_REQUEST_BYTES) {
    throw new Error('Request body is too large.');
  }

  const text = await request.text();

  if (text.length > MAX_REQUEST_BYTES) {
    throw new Error('Request body is too large.');
  }

  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error('Invalid JSON.');
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function randomId() {
  return crypto.randomUUID();
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return Array.from(bytes, b =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(hash), b =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

async function tokenHash(token) {
  return sha256(token);
}

function getBearerToken(request) {
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : '';
}

function requireAdmin(request, env) {
  const supplied = request.headers.get('X-Admin-Key');
  return Boolean(
    supplied &&
    env.ADMIN_KEY &&
    supplied === env.ADMIN_KEY
  );
}

function requireDatabase(env) {
  if (!env.DB) {
    throw new Error('The D1 binding named DB is missing.');
  }
}

function validString(value, maxLength = 2048) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength;
}

async function getFirstUserId(env) {
  const result = await env.DB
    .prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1')
    .first();

  return result?.id || null;
}

async function getVisitorSession(env, sessionId) {
  return env.DB
    .prepare('SELECT * FROM visitor_sessions WHERE id = ?')
    .bind(sessionId)
    .first();
}

async function handleHealth(request, env) {
  requireDatabase(env);

  return jsonResponse(request, {
    ok: true,
    service: 'visitor-dashboard-api',
    databaseConfigured: true,
    timestamp: new Date().toISOString()
  });
}

async function handleEvent(request, env) {
  const body = await readJSON(request);

  if (body.consent !== true) {
    return errorResponse(
      request,
      'Explicit visitor consent is required.',
      403
    );
  }

  const eventType = body.eventType || body.event_type;

  if (!EVENT_TYPES.has(eventType)) {
    return errorResponse(request, 'Invalid event type.');
  }

  let sessionId = body.sessionId || body.session_id;

  if (!validString(sessionId, 128)) {
    sessionId = randomId();
  }

  const page = typeof body.page === 'string'
    ? body.page.slice(0, 2048)
    : '';

  const metadata = body.metadata &&
    typeof body.metadata === 'object'
    ? body.metadata
    : body;

  const userId = await getFirstUserId(env);

  if (!userId) {
    return errorResponse(
      request,
      'No user exists in the users table. Create an account first.',
      500
    );
  }

  const now = nowSeconds();

  const existing = await getVisitorSession(env, sessionId);

  if (existing && existing.user_id !== userId) {
    return errorResponse(request, 'Invalid visitor session.', 403);
  }

  if (!existing) {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    let ipHash = null;

    if (ip && env.IP_HASH_SALT) {
      ipHash = await sha256(env.IP_HASH_SALT + ':' + ip);
    }

    const cf = request.cf || {};

    await env.DB.prepare(`
      INSERT INTO visitor_sessions (
        id, user_id, started_at, last_seen_at, consent_at,
        user_agent, platform, screen_width, screen_height,
        color_depth, language, timezone, current_page,
        referrer, ip_hash, country, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      sessionId,
      userId,
      now,
      now,
      now,
      (request.headers.get('User-Agent') || '').slice(0, 1000),
      String(metadata.platform || '').slice(0, 128),
      Number(metadata.screenWidth || metadata.screen_width) || null,
      Number(metadata.screenHeight || metadata.screen_height) || null,
      Number(metadata.colorDepth || metadata.color_depth) || null,
      String(metadata.language || '').slice(0, 128),
      String(metadata.timezone || '').slice(0, 128),
      page,
      String(metadata.referrer || '').slice(0, 2048),
      ipHash,
      String(cf.country || '').slice(0, 8)
    ).run();
  } else {
    await env.DB.prepare(`
      UPDATE visitor_sessions
      SET last_seen_at = ?,
          current_page = ?,
          active = 1
      WHERE id = ?
    `).bind(now, page, sessionId).run();
  }

  const eventId = randomId();

  await env.DB.prepare(`
    INSERT INTO events (
      id, visitor_session_id, user_id,
      event_type, page, created_at, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    eventId,
    sessionId,
    userId,
    eventType,
    page,
    now,
    JSON.stringify(body.details || {})
  ).run();

  // Keep event storage bounded.
  if (eventType === 'page_view') {
    await env.DB.prepare(`
      DELETE FROM events
      WHERE id IN (
        SELECT id FROM events
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      )
    `).bind(MAX_EVENTS * 100).run();
  }

  return jsonResponse(request, {
    ok: true,
    sessionId,
    eventId
  });
}

async function handleDashboard(request, env) {
  if (!requireAdmin(request, env)) {
    return errorResponse(request, 'Unauthorised.', 401);
  }

  const now = nowSeconds();
  const cutoff = now - ACTIVE_WINDOW_SECONDS;

  const sessionsResult = await env.DB.prepare(`
    SELECT
      vs.*,
      (
        SELECT COUNT(*)
        FROM events e
        WHERE e.visitor_session_id = vs.id
          AND e.event_type = 'page_view'
      ) AS views
    FROM visitor_sessions vs
    ORDER BY vs.last_seen_at DESC
    LIMIT 500
  `).all();

  const sessions = (sessionsResult.results || []).map(s => ({
    ...s,
    active: Number(s.last_seen_at) >= cutoff ? 1 : 0
  }));

  const eventsResult = await env.DB.prepare(`
    SELECT *
    FROM events
    ORDER BY created_at DESC
    LIMIT 500
  `).all();

  const events = eventsResult.results || [];

  const pagesResult = await env.DB.prepare(`
    SELECT page, COUNT(*) AS views
    FROM events
    WHERE event_type = 'page_view'
    GROUP BY page
    ORDER BY views DESC
    LIMIT 20
  `).all();

  const statsResult = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM visitor_sessions) AS sessions,
      (SELECT COUNT(*) FROM events
        WHERE event_type = 'page_view') AS pageViews,
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM visitor_sessions
        WHERE last_seen_at >= ?) AS online
  `).bind(cutoff).first();

  return jsonResponse(request, {
    ok: true,
    updatedAt: Date.now(),
    stats: {
      online: Number(statsResult?.online || 0),
      pageViews: Number(statsResult?.pageViews || 0),
      sessions: Number(statsResult?.sessions || 0),
      events: Number(statsResult?.events || 0)
    },
    sessions,
    events,
    pages: pagesResult.results || []
  });
}

async function handleSupportRequest(request, env) {
  if (!requireAdmin(request, env)) {
    return errorResponse(request, 'Unauthorised.', 401);
  }

  const body = await readJSON(request);
  const visitorSessionId = body.visitorSessionId;

  if (!validString(visitorSessionId, 128)) {
    return errorResponse(request, 'Invalid visitor session ID.');
  }

  const visitor = await getVisitorSession(env, visitorSessionId);

  if (!visitor) {
    return errorResponse(request, 'Visitor session not found.', 404);
  }

  const now = nowSeconds();

  // End previous active requests for this visitor.
  await env.DB.prepare(`
    UPDATE support_sessions
    SET status = 'ended', updated_at = ?
    WHERE visitor_session_id = ?
      AND status IN ('pending', 'approved', 'connected')
  `).bind(now, visitorSessionId).run();

  const supportId = randomId();

  await env.DB.prepare(`
    INSERT INTO support_sessions (
      id, visitor_session_id, status,
      visitor_token_hash, created_at, updated_at, expires_at
    ) VALUES (?, ?, 'pending', NULL, ?, ?, ?)
  `).bind(
    supportId,
    visitorSessionId,
    now,
    now,
    now + SUPPORT_TTL_SECONDS
  ).run();

  return jsonResponse(request, {
    ok: true,
    supportId,
    status: 'pending',
    expiresAt: now + SUPPORT_TTL_SECONDS
  });
}

async function getSupportSession(env, supportId) {
  return env.DB.prepare(`
    SELECT * FROM support_sessions WHERE id = ?
  `).bind(supportId).first();
}

async function visitorOwnsSupport(request, support, body = {}) {
  const token =
    getBearerToken(request) ||
    (typeof body.token === 'string' ? body.token : '');

  if (!token || !support.visitor_token_hash) return false;

  const hash = await tokenHash(token);

  return hash === support.visitor_token_hash;
}

async function handleSupportPending(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('sessionId');

  if (!validString(sessionId, 128)) {
    return errorResponse(request, 'Missing visitor session ID.');
  }

  const visitor = await getVisitorSession(env, sessionId);

  if (!visitor) {
    return jsonResponse(request, {
      ok: true,
      pending: false
    });
  }

  const now = nowSeconds();

  await env.DB.prepare(`
    UPDATE support_sessions
    SET status = 'ended', updated_at = ?
    WHERE visitor_session_id = ?
      AND expires_at <= ?
      AND status IN ('pending', 'approved', 'connected')
  `).bind(now, sessionId, now).run();

  const support = await env.DB.prepare(`
    SELECT *
    FROM support_sessions
    WHERE visitor_session_id = ?
      AND status = 'pending'
      AND expires_at > ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(sessionId, now).first();

  if (!support) {
    return jsonResponse(request, {
      ok: true,
      pending: false
    });
  }

  // Reuse the same token after the first claim, when possible.
  // The original token cannot be recovered from its hash, so a
  // claimed request is not offered to another page.
  if (support.visitor_token_hash) {
    return jsonResponse(request, {
      ok: true,
      pending: false
    });
  }

  const token = randomToken();
  const hash = await tokenHash(token);

  const updated = await env.DB.prepare(`
    UPDATE support_sessions
    SET visitor_token_hash = ?, updated_at = ?
    WHERE id = ?
      AND visitor_token_hash IS NULL
      AND status = 'pending'
  `).bind(hash, now, support.id).run();

  if (!updated.meta?.changes) {
    return jsonResponse(request, {
      ok: true,
      pending: false
    });
  }

  return jsonResponse(request, {
    ok: true,
    pending: true,
    supportId: support.id,
    token,
    expiresAt: support.expires_at
  });
}

async function handleSupportStatus(request, env) {
  const url = new URL(request.url);
  const supportId = url.searchParams.get('id');

  if (!validString(supportId, 128)) {
    return errorResponse(request, 'Missing support ID.');
  }

  const support = await getSupportSession(env, supportId);

  if (!support) {
    return errorResponse(request, 'Support session not found.', 404);
  }

  const body = request.method === 'POST'
    ? await readJSON(request)
    : {};

  const isAdmin = requireAdmin(request, env);
  const isVisitor = await visitorOwnsSupport(request, support, body);

  if (!isAdmin && !isVisitor) {
    return errorResponse(request, 'Unauthorised.', 401);
  }

  if (
    support.expires_at <= nowSeconds() &&
    ['pending', 'approved', 'connected'].includes(support.status)
  ) {
    await env.DB.prepare(`
      UPDATE support_sessions
      SET status = 'ended', updated_at = ?
      WHERE id = ?
    `).bind(nowSeconds(), supportId).run();

    support.status = 'ended';
  }

  return jsonResponse(request, {
    ok: true,
    support: {
      id: support.id,
      visitorSessionId: support.visitor_session_id,
      status: support.status,
      createdAt: support.created_at,
      updatedAt: support.updated_at,
      expiresAt: support.expires_at
    }
  });
}

async function handleSupportDecision(request, env) {
  const body = await readJSON(request);
  const supportId = body.supportId || body.id;
  const decision = body.decision;

  if (!validString(supportId, 128)) {
    return errorResponse(request, 'Missing support ID.');
  }

  if (!['approved', 'denied'].includes(decision)) {
    return errorResponse(request, 'Decision must be approved or denied.');
  }

  const support = await getSupportSession(env, supportId);

  if (!support) {
    return errorResponse(request, 'Support session not found.', 404);
  }

  if (!(await visitorOwnsSupport(request, support, body))) {
    return errorResponse(request, 'Unauthorised.', 401);
  }

  if (support.status !== 'pending') {
    return errorResponse(
      request,
      'This support request is no longer pending.',
      409
    );
  }

  if (support.expires_at <= nowSeconds()) {
    await env.DB.prepare(`
      UPDATE support_sessions
      SET status = 'ended', updated_at = ?
      WHERE id = ?
    `).bind(nowSeconds(), supportId).run();

    return errorResponse(request, 'Support request has expired.', 410);
  }

  const now = nowSeconds();

  await env.DB.prepare(`
    UPDATE support_sessions
    SET status = ?, updated_at = ?
    WHERE id = ?
  `).bind(decision, now, supportId).run();

  return jsonResponse(request, {
    ok: true,
    status: decision
  });
}

async function handleSupportSignal(request, env) {
  const body = await readJSON(request);

  const supportId = body.supportId || body.id;
  const signalType = body.signalType;
  const payload = body.payload;

  if (!validString(supportId, 128)) {
    return errorResponse(request, 'Missing support ID.');
  }

  if (!SIGNAL_TYPES.has(signalType)) {
    return errorResponse(request, 'Invalid signal type.');
  }

  if (!payload || typeof payload !== 'object') {
    return errorResponse(request, 'Missing signal payload.');
  }

  if (JSON.stringify(payload).length > 20000) {
    return errorResponse(request, 'Signal payload is too large.');
  }

  const support = await getSupportSession(env, supportId);

  if (!support) {
    return errorResponse(request, 'Support session not found.', 404);
  }

  const isAdmin = requireAdmin(request, env);
  const isVisitor = await visitorOwnsSupport(request, support, body);

  if (!isAdmin && !isVisitor) {
    return errorResponse(request, 'Unauthorised.', 401);
  }

  if (!['approved', 'connected'].includes(support.status)) {
    return errorResponse(
      request,
      'Support session is not approved.',
      409
    );
  }

  if (support.expires_at <= nowSeconds()) {
    return errorResponse(request, 'Support session has expired.', 410);
  }

  const sender = isAdmin ? 'admin' : 'visitor';
  const id = randomId();
  const now = nowSeconds();

  await env.DB.prepare(`
    INSERT INTO support_signals (
      id, support_session_id, sender,
      signal_type, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    supportId,
    sender,
    signalType,
    JSON.stringify(payload),
    now
  ).run();

  if (support.status === 'approved') {
    await env.DB.prepare(`
      UPDATE support_sessions
      SET status = 'connected', updated_at = ?
      WHERE id = ? AND status = 'approved'
    `).bind(now, supportId).run();
  }

  return jsonResponse(request, {
    ok: true,
    signalId: id
  });
}

async function handleSupportSignals(request, env) {
  const url = new URL(request.url);
  const supportId = url.searchParams.get('id');

  if (!validString(supportId, 128)) {
    return errorResponse(request, 'Missing support ID.');
  }

  const support = await getSupportSession(env, supportId);

  if (!support) {
    return errorResponse(request, 'Support session not found.', 404);
  }

  const body = request.method === 'POST'
    ? await readJSON(request)
    : {};

  const isAdmin = requireAdmin(request, env);
  const isVisitor = await visitorOwnsSupport(request, support, body);

  if (!isAdmin && !isVisitor) {
    return errorResponse(request, 'Unauthorised.', 401);
  }

  const result = await env.DB.prepare(`
    SELECT id, sender, signal_type, payload_json, created_at
    FROM support_signals
    WHERE support_session_id = ?
    ORDER BY created_at ASC
    LIMIT 300
  `).bind(supportId).all();

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

  return jsonResponse(request, {
    ok: true,
    signals
  });
}

async function handleSupportEnd(request, env) {
  const body = await readJSON(request);
  const supportId = body.supportId || body.id;

  if (!validString(supportId, 128)) {
    return errorResponse(request, 'Missing support ID.');
  }

  const support = await getSupportSession(env, supportId);

  if (!support) {
    return errorResponse(request, 'Support session not found.', 404);
  }

  const isAdmin = requireAdmin(request, env);
  const isVisitor = await visitorOwnsSupport(request, support, body);

  if (!isAdmin && !isVisitor) {
    return errorResponse(request, 'Unauthorised.', 401);
  }

  await env.DB.prepare(`
    UPDATE support_sessions
    SET status = 'ended', updated_at = ?
    WHERE id = ?
  `).bind(nowSeconds(), supportId).run();

  return jsonResponse(request, {
    ok: true,
    status: 'ended'
  });
}

async function routeRequest(request, env) {
  requireDatabase(env);

  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'GET' && path === '/api/health') {
    return handleHealth(request, env);
  }

  if (request.method === 'POST' && path === '/api/event') {
    return handleEvent(request, env);
  }

  if (request.method === 'GET' && path === '/api/dashboard') {
    return handleDashboard(request, env);
  }

  if (request.method === 'POST' && path === '/api/support/request') {
    return handleSupportRequest(request, env);
  }

  if (request.method === 'GET' && path === '/api/support/pending') {
    return handleSupportPending(request, env);
  }

  if (
    (request.method === 'GET' || request.method === 'POST') &&
    path === '/api/support/status'
  ) {
    return handleSupportStatus(request, env);
  }

  if (request.method === 'POST' && path === '/api/support/decision') {
    return handleSupportDecision(request, env);
  }

  if (request.method === 'POST' && path === '/api/support/signal') {
    return handleSupportSignal(request, env);
  }

  if (
    (request.method === 'GET' || request.method === 'POST') &&
    path === '/api/support/signals'
  ) {
    return handleSupportSignals(request, env);
  }

  if (request.method === 'POST' && path === '/api/support/end') {
    return handleSupportEnd(request, env);
  }

  return errorResponse(request, 'Not found.', 404);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return optionsResponse(request);
    }

    try {
      return await routeRequest(request, env);
    } catch (error) {
      console.error('Worker error:', error);

      const status = /too large/i.test(error.message) ? 413 : 500;

      return errorResponse(
        request,
        status === 413
          ? 'Request body is too large.'
          : 'Internal server error.',
        status
      );
    }
  }
};
d