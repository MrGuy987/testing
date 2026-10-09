const DATA_PATH = "data/visitors.json";
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

    if (request.method === "OPTIONS") {
      if (origin !== allowedOrigin) {
        return json({ error: "Origin not allowed" }, 403, cors);
      }
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true }, 200, cors);
      }

      if (url.pathname === "/api/event" && request.method === "POST") {
        if (!allowedOrigin || origin !== allowedOrigin) {
          return json({ error: "Origin not allowed" }, 403, cors);
        }

        const length = Number(request.headers.get("Content-Length") || 0);
        if (length > MAX_BODY_BYTES) {
          return json({ error: "Request too large" }, 413, cors);
        }

        const input = await request.json();
        const event = validateEvent(input);

        if (!event) {
          return json({ error: "Invalid event" }, 400, cors);
        }

        await appendEvent(env, event);
        return json({ ok: true }, 202, cors);
      }

      if (url.pathname === "/api/dashboard" && request.method === "GET") {
        if (!env.ADMIN_KEY ||
            request.headers.get("X-Admin-Key") !== env.ADMIN_KEY) {
          return json({ error: "Invalid admin key" }, 401, cors);
        }

        const data = await readData(env);
        return json(data, 200, cors);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      console.error("Worker error:", error.message);

      return json({
        error: error.publicMessage || "Server error"
      }, error.status || 500, cors);
    }
  }
};

function json(value, status, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function validateEvent(input) {
  if (!input || typeof input !== "object") return null;

  if (!["page_view", "click", "heartbeat"].includes(input.type)) {
    return null;
  }

  const sessionId = String(input.sessionId || "");

  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) {
    return null;
  }

  // Record paths only, not query parameters that might contain sensitive data.
  let page = String(input.page || "/").split("?")[0].slice(0, 250);

  if (!page.startsWith("/") || page.startsWith("//")) {
    return null;
  }

  const timestamp = Date.parse(input.timestamp);

  if (!Number.isFinite(timestamp) ||
      Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
    return null;
  }

  return {
    type: input.type,
    sessionId,
    page,
    timestamp: new Date(timestamp).toISOString(),
    label: input.type === "click"
      ? String(input.label || "").replace(/[\r\n\t]/g, " ").slice(0, 80)
      : ""
  };
}

function githubUrl(path) {
  return `https://api.github.com/repos/${encodeURIComponent("OWNER_PLACEHOLDER")}/${encodeURIComponent("REPO_PLACEHOLDER")}/contents/${path}`;
}

async function githubRequest(env, path, options = {}) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "visitor-control-centre",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const error = new Error(`GitHub API returned ${response.status}`);
    error.status = response.status === 404 ? 500 : 502;
    error.publicMessage =
      "Could not access the visitor JSON file. Check the GitHub token, file path and repository settings.";
    throw error;
  }

  return response.json();
}

function decodeBase64Utf8(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, character =>
    character.charCodeAt(0)
  );
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }

  return btoa(binary);
}

async function readData(env) {
  const file = await githubRequest(env, DATA_PATH);
  const data = JSON.parse(decodeBase64Utf8(file.content));

  if (!data.sessions || !Array.isArray(data.events)) {
    throw new Error("Invalid visitor JSON structure");
  }

  return { ...data, _sha: file.sha };
}

async function appendEvent(env, event) {
  // A conflicting write is retried. This helps with simultaneous events,
  // but GitHub is not a transactional database.
  for (let attempt = 0; attempt < 4; attempt++) {
    const data = await readData(env);
    const sha = data._sha;
    delete data._sha;

    let session = data.sessions[event.sessionId];

    if (!session) {
      session = {
        id: event.sessionId,
        currentPage: event.page,
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        pageViews: 0
      };
    }

    session.currentPage = event.page;
    session.lastSeen = event.timestamp;

    if (event.type === "page_view") {
      session.pageViews++;
    }

    data.sessions[event.sessionId] = session;
    data.events.push(event);

    if (data.events.length > MAX_EVENTS) {
      data.events = data.events.slice(-MAX_EVENTS);
    }

    data.version = 1;
    data.updatedAt = new Date().toISOString();

    const body = {
      message: `Update visitor activity (${event.type})`,
      content: encodeBase64Utf8(JSON.stringify(data, null, 2)),
      sha
    };

    if (env.GITHUB_BRANCH) {
      body.branch = env.GITHUB_BRANCH;
    }

    const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${DATA_PATH}`;

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "visitor-control-centre",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (response.ok) return;

    if ((response.status === 409 || response.status === 422) &&
        attempt < 3) {
      continue;
    }

    const error = new Error(`GitHub write returned ${response.status}`);
    error.status = 502;
    error.publicMessage =
      "Could not save visitor activity. Check the GitHub token and try again.";
    throw error;
  }

  const error = new Error("Too many simultaneous writes");
  error.status = 503;
  error.publicMessage =
    "Visitor activity is busy. Please try again shortly.";
  throw error;
}