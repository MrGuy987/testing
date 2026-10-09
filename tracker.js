(() => {
  "use strict";

  const API_URL = "https://testing.mrguy987.workers.dev/api/event";
  const SESSION_KEY = "visitor_dashboard_session";
  const CONSENT_KEY = "visitor_dashboard_consent";

  let sessionId = null;
  let consentGranted = false;

  function getSessionId() {
    try {
      let id = sessionStorage.getItem(SESSION_KEY);

      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem(SESSION_KEY, id);
      }

      return id;
    } catch {
      return crypto.randomUUID();
    }
  }

  function hasConsent() {
    try {
      return localStorage.getItem(CONSENT_KEY) === "accepted";
    } catch {
      return false;
    }
  }

  function saveConsent(accepted) {
    try {
      localStorage.setItem(
        CONSENT_KEY,
        accepted ? "accepted" : "declined"
      );
    } catch {
      // Storage may be unavailable in some browser configurations.
    }

    consentGranted = accepted;

    if (accepted) {
      sessionId = getSessionId();
      sendEvent("page_view");
    }
  }

  async function sendEvent(type, label = "") {
    if (!consentGranted || !sessionId) return;

    const event = {
      type,
      eventType: type,
      sessionId,
      page: window.location.pathname,
      timestamp: new Date().toISOString(),
      label,
      consent: true
    };

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(event)
      });

      if (!response.ok) {
        console.error(
          "Visitor tracking failed:",
          response.status,
          await response.text()
        );
      }
    } catch (error) {
      console.error("Visitor tracking request failed:", error);
    }
  }

  function createConsentBanner() {
    if (document.getElementById("visitor-consent-banner")) return;

    const banner = document.createElement("div");
    banner.id = "visitor-consent-banner";

    Object.assign(banner.style, {
      position: "fixed",
      bottom: "16px",
      left: "16px",
      right: "16px",
      zIndex: "999999",
      maxWidth: "520px",
      margin: "0 auto",
      padding: "18px",
      borderRadius: "12px",
      background: "#171923",
      color: "#ffffff",
      fontFamily: "Arial, sans-serif",
      fontSize: "14px",
      lineHeight: "1.5",
      boxShadow: "0 4px 24px rgba(0,0,0,.35)"
    });

    const message = document.createElement("p");
    message.textContent =
      "Allow anonymous website activity tracking to help measure page visits. You can decline and still use this website.";
    message.style.margin = "0 0 14px";

    const buttons = document.createElement("div");
    Object.assign(buttons.style, {
      display: "flex",
      gap: "10px",
      flexWrap: "wrap"
    });

    function makeButton(text, background, callback) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;

      Object.assign(button.style, {
        padding: "9px 14px",
        border: "0",
        borderRadius: "7px",
        background,
        color: "#ffffff",
        cursor: "pointer",
        fontSize: "14px"
      });

      button.addEventListener("click", callback);
      return button;
    }

    buttons.append(
      makeButton("Accept", "#3978f6", () => {
        saveConsent(true);
        banner.remove();
      }),
      makeButton("Decline", "#343846", () => {
        saveConsent(false);
        banner.remove();
      })
    );

    banner.append(message, buttons);
    document.body.appendChild(banner);
  }

  function initialize() {
    consentGranted = hasConsent();

    if (consentGranted) {
      sessionId = getSessionId();
      sendEvent("page_view");
    } else {
      createConsentBanner();
    }
  }

  // Optional functions for recording additional events.
  window.visitorTracker = {
    track(type, label = "") {
      if (typeof type !== "string" || !type.trim()) return;
      sendEvent(type, String(label));
    },

    getConsent() {
      return consentGranted;
    },

    withdrawConsent() {
      saveConsent(false);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, {
      once: true
    });
  } else {
    initialize();
  }
})();