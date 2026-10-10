
(() => {
  const API_BASE = "https://testing.mrguy987.workers.dev";

  const $ = id => document.getElementById(id);

  let adminKey = "";
  let selectedSession = "";
  let refreshTimer = null;
  let currentData = null;

  const field = (obj, ...keys) => {
    for (const key of keys) {
      if (obj?.[key] !== undefined && obj[key] !== null) {
        return obj[key];
      }
    }
    return null;
  };

  const sessionIdOf = s =>
    String(field(s, "id", "sessionId", "session_id") ?? "");

  const lastSeenOf = s =>
    field(s, "lastSeen", "last_seen_at", "lastSeenAt");

  const pageOf = s =>
    field(s, "currentPage", "current_page", "page") ?? "/";

  const eventSessionId = e =>
    String(field(e, "sessionId", "session_id", "visitor_session_id") ?? "");

  const eventType = e =>
    String(field(e, "type", "eventType", "event_type") ?? "unknown");

  const eventTime = e =>
    field(e, "timestamp", "createdAt", "created_at");

  const eventPage = e =>
    field(e, "page", "currentPage", "current_page") ?? "/";

  const escapeHTML = value =>
    String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);

  function pagePath(value) {
    try {
      return new URL(String(value || "/"), location.origin).pathname;
    } catch {
      return "/";
    }
  }

  function validDate(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatTime(value) {
    const date = validDate(value);
    return date ? date.toLocaleString() : "Unknown";
  }

  function timeAgo(value) {
    const date = validDate(value);
    if (!date) return "Unknown";

    const seconds = Math.max(
      0,
      Math.floor((Date.now() - date.getTime()) / 1000)
    );

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;

    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function isOnline(session) {
    const date = validDate(lastSeenOf(session));
    return Boolean(
      date && Date.now() - date.getTime() < 120000 &&
      field(session, "active") !== 0 &&
      field(session, "active") !== false
    );
  }

  function setConnection(connected, message) {
    if (!$("connection")) return;

    $("connection").textContent = message;
    $("connection").classList.toggle("online", connected);
  }

  async function api(path) {
    const response = await fetch(API_BASE + path, {
      headers: { "X-Admin-Key": adminKey },
      cache: "no-store"
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || result.ok === false) {
      throw new Error(result.error || `Request failed (${response.status})`);
    }

    return result;
  }

  $("loginForm")?.addEventListener("submit", async event => {
    event.preventDefault();

    adminKey = $("adminKey").value.trim();
    $("loginError").textContent = "";

    try {
      await refresh();

      $("loginPanel").hidden = true;
      $("dashboard").hidden = false;
      setConnection(true, "Connected");

      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        refresh().catch(error => setConnection(false, error.message));
      }, 15000);
    } catch (error) {
      adminKey = "";
      $("loginError").textContent = error.message;
    }
  });

  $("refreshBtn")?.addEventListener("click", () => {
    refresh().catch(error => setConnection(false, error.message));
  });

  $("logoutBtn")?.addEventListener("click", () => {
    clearInterval(refreshTimer);
    refreshTimer = null;
    adminKey = "";
    currentData = null;
    selectedSession = "";

    $("adminKey").value = "";
    $("dashboard").hidden = true;
    $("loginPanel").hidden = false;
    $("loginError").textContent = "";

    setConnection(false, "Disconnected");
  });

  async function refresh() {
    currentData = await api("/api/dashboard");
    render();
    setConnection(true, "Connected");
  }

  function getSessions() {
    const raw = currentData?.sessions ?? [];

    return (Array.isArray(raw) ? raw : Object.values(raw))
      .filter(session => session && typeof session === "object")
      .sort((a, b) => {
        const aTime = validDate(lastSeenOf(a))?.getTime() ?? 0;
        const bTime = validDate(lastSeenOf(b))?.getTime() ?? 0;
        return bTime - aTime;
      });
  }

  function getEvents() {
    const raw = currentData?.events ?? [];
    return Array.isArray(raw) ? raw : Object.values(raw);
  }

  function render() {
    if (!currentData) return;

    const sessions = getSessions();
    const events = getEvents();

    const online = sessions.filter(isOnline).length;

    $("onlineCount").textContent = online;
    $("pageViews").textContent = events.filter(
      event => eventType(event) === "page_view"
    ).length;
    $("sessionCount").textContent = sessions.length;
    $("eventCount").textContent = events.length;
    $("updated").textContent =
      `Updated ${new Date().toLocaleTimeString()}`;

    const sessionRows = sessions.map(session => {
      const id = sessionIdOf(session);
      const onlineNow = isOnline(session);
      const screenWidth = field(session, "screenWidth", "screen_width");
      const screenHeight = field(session, "screenHeight", "screen_height");
      const colourDepth = field(session, "colorDepth", "color_depth");
      const platform = field(session, "platform", "operatingSystem", "operating_system");
      const language = field(session, "language");
      const timezone = field(session, "timezone");
      const country = field(session, "country");
      const ipHash = field(session, "ipHash", "ip_hash");
      const pageViews = Number(field(session, "pageViews", "page_views") ?? 0);

      return `
        <tr class="selectable ${selectedSession === id ? "selected" : ""}"
            data-session="${escapeHTML(id)}">
          <td><span class="session-id">${escapeHTML(id.slice(0, 12))}${id.length > 12 ? "…" : ""}</span></td>
          <td>${escapeHTML(pagePath(pageOf(session)))}</td>
          <td>${escapeHTML(platform || "Unknown")}</td>
          <td>${screenWidth && screenHeight
            ? `${escapeHTML(screenWidth)} × ${escapeHTML(screenHeight)}`
            : "Unknown"}</td>
          <td>${colourDepth ? `${escapeHTML(colourDepth)}-bit` : "Unknown"}</td>
          <td>${escapeHTML(language || "Unknown")}</td>
          <td>${escapeHTML(timezone || "Unknown")}</td>
          <td>${escapeHTML(country || "Unknown")}</td>
          <td>${ipHash ? "Hashed" : "Unavailable"}</td>
          <td>${escapeHTML(timeAgo(lastSeenOf(session)))}</td>
          <td>${Number.isFinite(pageViews) ? pageViews : 0}</td>
          <td><span class="pill ${onlineNow ? "" : "offline"}">${onlineNow ? "Online" : "Offline"}</span></td>
        </tr>`;
    });

    $("sessionsBody").innerHTML = sessionRows.length
      ? sessionRows.join("")
      : `<tr><td colspan="12">No sessions yet. Accept the tracking notice on the website to test it.</td></tr>`;

    document.querySelectorAll("#sessionsBody [data-session]").forEach(row => {
      row.addEventListener("click", () => {
        selectedSession = row.dataset.session;
        render();
      });
    });

    renderSessionDetails(sessions);
    renderTimeline(events);
    renderPopularPages(events);
  }

  function renderSessionDetails(sessions) {
    const container = $("sessionDetails");
    if (!container) return;

    const session = sessions.find(s => sessionIdOf(s) === selectedSession);

    if (!session) {
      container.innerHTML = `<p class="muted">Select a session to view its details.</p>`;
      return;
    }

    const details = [
      ["Session ID", sessionIdOf(session)],
      ["First seen", formatTime(field(session, "startedAt", "started_at", "createdAt", "created_at"))],
      ["Last seen", formatTime(lastSeenOf(session))],
      ["Current page", pageOf(session)],
      ["Referrer", field(session, "referrer") || "Unknown"],
      ["Operating system", field(session, "platform", "operatingSystem", "operating_system") || "Unknown"],
      ["Screen size", field(session, "screenWidth", "screen_width") && field(session, "screenHeight", "screen_height")
        ? `${field(session, "screenWidth", "screen_width")} × ${field(session, "screenHeight", "screen_height")}`
        : "Unknown"],
      ["Language", field(session, "language") || "Unknown"],
      ["Timezone", field(session, "timezone") || "Unknown"],
      ["Country", field(session, "country") || "Unknown"]
    ];

    container.innerHTML = details.map(([label, value]) => `
      <div class="detail-row">
        <strong>${escapeHTML(label)}</strong>
        <span>${escapeHTML(value)}</span>
      </div>
    `).join("");
  }

  function renderTimeline(events) {
    const sessionEvents = events
      .filter(event => eventSessionId(event) === selectedSession)
      .sort((a, b) => {
        const at = validDate(eventTime(a))?.getTime() ?? 0;
        const bt = validDate(eventTime(b))?.getTime() ?? 0;
        return bt - at;
      })
      .slice(0, 100);

    if ($("selectedSessionLabel")) {
      $("selectedSessionLabel").textContent = selectedSession
        ? `Session ${selectedSession}`
        : "Select a session above.";
    }

    if ($("timelineSessionLabel")) {
      $("timelineSessionLabel").textContent = selectedSession
        ? `Timeline: ${selectedSession}`
        : "No session selected";
    }

    if (!selectedSession) {
      $("timeline").innerHTML = `<p class="muted">No session selected.</p>`;
      return;
    }

    $("timeline").innerHTML = sessionEvents.length
      ? sessionEvents.map(event => {
          const type = eventType(event);
          const label = field(event, "label", "details", "details_json");

          return `
            <div class="event">
              <div class="event-time">${escapeHTML(formatTime(eventTime(event)))}</div>
              <div class="event-dot"></div>
              <div>
                <strong>${escapeHTML(type.replaceAll("_", " "))}</strong>
                <p>${escapeHTML(pagePath(eventPage(event)))}${label
                  ? " · " + escapeHTML(typeof label === "string" ? label : JSON.stringify(label))
                  : ""}</p>
              </div>
            </div>`;
        }).join("")
      : `<p class="muted">No events for this session.</p>`;
  }

  function renderPopularPages(events) {
    const counts = {};

    events
      .filter(event => eventType(event) === "page_view")
      .forEach(event => {
        const path = pagePath(eventPage(event));
        counts[path] = (counts[path] || 0) + 1;
      });

    const pages = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const maximum = Math.max(1, ...pages.map(([, count]) => count));

    $("popularPages").innerHTML = pages.length
      ? pages.map(([page, count]) => `
          <div class="popular-row">
            <span>${escapeHTML(page)}</span>
            <div class="bar">
              <span style="width:${count / maximum * 100}%"></span>
            </div>
            <strong>${count}</strong>
          </div>
        `).join("")
      : `<p class="muted">No page views recorded yet.</p>`;
  }
})();
