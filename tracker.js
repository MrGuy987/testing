(() => {
  const API_BASE = "https://REPLACE-WITH-YOUR-WORKER.workers.dev";
  const CONSENT_KEY = "visitorActivityConsent";
  const SESSION_KEY = "visitorActivitySession";

  function getSessionId() {
    let id = sessionStorage.getItem(SESSION_KEY);

    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, id);
    }

    return id;
  }

  async function sendEvent(type, label = "") {
    if (localStorage.getItem(CONSENT_KEY) !== "yes") return;

    try {
      await fetch(`${API_BASE}/api/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          sessionId: getSessionId(),
          page: location.pathname + location.search,
          timestamp: new Date().toISOString(),
          label: String(label).slice(0, 80)
        }),
        keepalive: true
      });
    } catch {
      // Tracking failures must not stop the website from working.
    }
  }

  function showConsentBanner() {
    const banner = document.getElementById("consentBanner");

    if (!banner || localStorage.getItem(CONSENT_KEY)) return;

    banner.hidden = false;

    document.getElementById("acceptTracking")
      ?.addEventListener("click", () => {
        localStorage.setItem(CONSENT_KEY, "yes");
        banner.hidden = true;
        sendEvent("page_view");
      });

    document.getElementById("rejectTracking")
      ?.addEventListener("click", () => {
        localStorage.setItem(CONSENT_KEY, "no");
        banner.hidden = true;
      });
  }

  document.addEventListener("DOMContentLoaded", showConsentBanner);

  if (localStorage.getItem(CONSENT_KEY) === "yes") {
    sendEvent("page_view");

    // Heartbeats indicate that an opted-in page is still active.
    setInterval(() => sendEvent("heartbeat"), 60000);
  }

  document.addEventListener("click", event => {
    if (localStorage.getItem(CONSENT_KEY) !== "yes") return;

    const element = event.target.closest("a, button, [data-track]");
    if (!element) return;

    // Do not collect clicks inside forms or on the consent controls.
    if (element.closest("form")) return;
    if (element.id === "acceptTracking" ||
        element.id === "rejectTracking") return;

    const label = (
      element.getAttribute("data-track") ||
      element.getAttribute("aria-label") ||
      element.innerText ||
      element.tagName
    ).trim().slice(0, 80);

    sendEvent("click", label);
  }, true);
})();