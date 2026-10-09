(() => {
  // Replace this with your deployed Cloudflare Worker URL.
  const API_BASE = "https://testing.mrguy987.workers.dev";

  const $ = id => document.getElementById(id);
  let adminKey = "";
  let selectedSession = "";
  let refreshTimer = null;
  let currentData = null;

  async function api(path) {
    const response = await fetch(API_BASE + path, {
      headers: { "X-Admin-Key": adminKey },
      cache: "no-store"
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.error || `Request failed (${response.status})`);
    }

    return result;
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function pagePath(value) {
    try {
      const url = new URL(value, location.origin);
      return url.pathname + url.search;
    } catch {
      return "/";
    }
  }

  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Unknown"
      : date.toLocaleString();
  }

  function timeAgo(value) {
    const seconds = Math.max(
      0,
      Math.floor((Date.now() - new Date(value).getTime()) / 1000)
    );

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;

    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function setConnection(connected, message) {
    $("connection").textContent = message;
    $("connection").classList.toggle("online", connected);
  }

  $("loginForm").addEventListener("submit", async event => {
    event.preventDefault();

    adminKey = $("adminKey").value;
    $("loginError").textContent = "";

    try {
      await refresh();

      $("loginPanel").hidden = true;
      $("dashboard").hidden = false;
      setConnection(true, "Connected");

      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        refresh().catch(error => {
          setConnection(false, error.message);
        });
      }, 15000);
    } catch (error) {
      adminKey = "";
      $("loginError").textContent = error.message;
    }
  });

  $("refreshBtn").addEventListener("click", () => {
    refresh().catch(error => setConnection(false, error.message));
  });

  $("logoutBtn").addEventListener("click", () => {
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

  function render() {
    const sessions = Object.values(currentData.sessions || {})
      .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));

    const events = Array.isArray(currentData.events)
      ? currentData.events
      : [];

    const online = sessions.filter(session =>
      Date.now() - Date.parse(session.lastSeen) < 120000
    ).length;

    $("onlineCount").textContent = online;
    $("pageViews").textContent =
      events.filter(event => event.type === "page_view").length;
    $("sessionCount").textContent = sessions.length;
    $("eventCount").textContent = events.length;
    $("updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;

    $("sessionsBody").innerHTML = sessions.length
      ? sessions.map(session => {
          const isOnline =
            Date.now() - Date.parse(session.lastSeen) < 120000;

          return `
            <tr class="selectable ${selectedSession === session.id ? "selected" : ""}"
                data-session="${escapeHTML(session.id)}">
              <td><span class="session-id">${escapeHTML(session.id.slice(0, 12))}…</span></td>
              <td>${escapeHTML(pagePath(session.currentPage))}</td>
              <td>${escapeHTML(timeAgo(session.lastSeen))}</td>
              <td>${Number(session.pageViews || 0)}</td>
              <td>
                <span class="pill ${isOnline ? "" : "offline"}">
                  ${isOnline ? "Online" : "Offline"}
                </span>
              </td>
            </tr>`;
        }).join("")
      : `<tr><td colspan="5">No sessions yet. Accept the tracking notice on the website to test it.</td></tr>`;

    document.querySelectorAll("[data-session]").forEach(row => {
      row.addEventListener("click", () => {
        selectedSession = row.dataset.session;
        render();
      });
    });

    renderTimeline(events);
    renderPopularPages(events);
  }

  function renderTimeline(events) {
    const sessionEvents = events
      .filter(event => event.sessionId === selectedSession)
      .slice(-100)
      .reverse();

    $("selectedSessionLabel").textContent = selectedSession
      ? `Session ${selectedSession}`
      : "Select a session above.";

    if (!selectedSession) {
      $("timeline").innerHTML =
        '<p class="muted">No session selected.</p>';
      return;
    }

    $("timeline").innerHTML = sessionEvents.length
      ? sessionEvents.map(event => `
          <div class="event">
            <div class="event-time">${escapeHTML(formatTime(event.timestamp))}</div>
            <div class="event-dot"></div>
            <div>
              <strong>${escapeHTML(event.type.replaceAll("_", " "))}</strong>
              <p>${escapeHTML(pagePath(event.page))}${event.label
                ? " · " + escapeHTML(event.label)
                : ""}</p>
            </div>
          </div>
        `).join("")
      : '<p class="muted">No events for this session.</p>';
  }

  function renderPopularPages(events) {
    const counts = {};

    events.filter(event => event.type === "page_view")
      .forEach(event => {
        const path = pagePath(event.page);
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
      : '<p class="muted">No page views recorded yet.</p>';
  }
})();