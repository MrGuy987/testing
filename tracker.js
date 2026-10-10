
(() => {
  "use strict";

  const API_URL = "https://testing.mrguy987.workers.dev/api/event";
  const SESSION_KEY = "visitor_dashboard_session";
  const CONSENT_KEY = "visitor_dashboard_consent_v2";

  let sessionId = null;
  let consentGranted = false;
  let cameraStream = null;
  let screenStream = null;
  let controls = null;

  const $ = id => document.getElementById(id);

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

  function getPlatform() {
    const ua = navigator.userAgent || "";
    const platform = navigator.userAgentData?.platform ||
      navigator.platform || "";

    if (/CrOS/i.test(ua) || /ChromeOS/i.test(platform)) return "ChromeOS";
    if (/Android/i.test(ua)) return "Android";
    if (/iPhone|iPad|iPod/i.test(ua) ||
        (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return "iOS";
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return "Windows";
    if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return "macOS";
    if (/Linux/i.test(platform) || /Linux/i.test(ua)) return "Linux";
    return "Other / unknown";
  }

  function getDeviceInfo() {
    let timezone = "";
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {}

    let referrer = "";
    try {
      if (document.referrer) referrer = new URL(document.referrer).origin;
    } catch {}

    return {
      platform: getPlatform(),
      screenWidth: Number(screen.width) || null,
      screenHeight: Number(screen.height) || null,
      colorDepth: Number(screen.colorDepth) || null,
      language: navigator.language || "",
      timezone,
      referrer
    };
  }

  async function sendEvent(type, label = "") {
    if (!consentGranted || !sessionId) return;

    const event = {
      type,
      eventType: type,
      sessionId,
      page: location.pathname,
      timestamp: new Date().toISOString(),
      label: String(label).slice(0, 100),
      consent: true,
      ...getDeviceInfo()
    };

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event)
      });

      if (!response.ok) {
        console.warn("Analytics request failed:", response.status);
      }
    } catch (error) {
      console.warn("Analytics request failed:", error);
    }
  }

  function saveConsent(accepted) {
    try {
      localStorage.setItem(
        CONSENT_KEY,
        accepted ? "accepted" : "declined"
      );
    } catch {}

    consentGranted = accepted;

    if (accepted) {
      sessionId = getSessionId();
      sendEvent("page_view");
      createFeatureControls();
    } else {
      stopCamera();
      stopScreenShare();
      controls?.remove();
      controls = null;
    }
  }

  function button(text, callback) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = text;

    Object.assign(el.style, {
      padding: "9px 12px",
      border: "1px solid #444b60",
      borderRadius: "7px",
      background: "#252a3a",
      color: "#fff",
      cursor: "pointer",
      fontSize: "14px"
    });

    el.addEventListener("click", callback);
    return el;
  }

  function createConsentBanner() {
    if ($("visitor-consent-banner")) return;

    const banner = document.createElement("div");
    banner.id = "visitor-consent-banner";

    Object.assign(banner.style, {
      position: "fixed",
      bottom: "16px",
      left: "16px",
      right: "16px",
      zIndex: "999999",
      maxWidth: "560px",
      margin: "0 auto",
      padding: "18px",
      borderRadius: "12px",
      background: "#171923",
      color: "#fff",
      fontFamily: "Arial,sans-serif",
      fontSize: "14px",
      lineHeight: "1.5",
      boxShadow: "0 4px 24px rgba(0,0,0,.35)"
    });

    const message = document.createElement("p");
    message.textContent =
      "Optional analytics records page visits and general device information. " +
      "Limited keyboard analytics records only selected key categories outside text-entry fields, " +
      "never typed text or passwords. Camera and screen sharing are separate optional actions " +
      "and require your permission. You can decline analytics and still use this website.";
    message.style.margin = "0 0 14px";

    const actions = document.createElement("div");
    Object.assign(actions.style, {
      display: "flex",
      gap: "10px",
      flexWrap: "wrap"
    });

    actions.append(
      button("Accept analytics", () => {
        saveConsent(true);
        banner.remove();
      }),
      button("Decline", () => {
        saveConsent(false);
        banner.remove();
      })
    );

    banner.append(message, actions);
    document.body.appendChild(banner);
  }

  function createFeatureControls() {
    if (!consentGranted || $("visitor-feature-controls")) return;

    controls = document.createElement("section");
    controls.id = "visitor-feature-controls";

    Object.assign(controls.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      width: "min(340px, calc(100vw - 32px))",
      maxHeight: "75vh",
      overflowY: "auto",
      zIndex: "999998",
      padding: "14px",
      border: "1px solid #41485c",
      borderRadius: "12px",
      background: "#171923",
      color: "#fff",
      font: "14px/1.5 Arial,sans-serif",
      boxShadow: "0 4px 24px rgba(0,0,0,.3)"
    });

    const heading = document.createElement("h3");
    heading.textContent = "Optional privacy controls";
    heading.style.margin = "0 0 8px";

    const note = document.createElement("p");
    note.textContent =
      "Camera and screen sharing start only when you select a button. " +
      "This page does not transmit video or remotely control your device.";
    note.style.margin = "0 0 12px";

    const cameraPreview = document.createElement("video");
    cameraPreview.autoplay = true;
    cameraPreview.muted = true;
    cameraPreview.playsInline = true;
    cameraPreview.hidden = true;
    cameraPreview.style.width = "100%";
    cameraPreview.style.marginTop = "10px";
    cameraPreview.style.borderRadius = "8px";

    const screenPreview = document.createElement("video");
    screenPreview.autoplay = true;
    screenPreview.muted = true;
    screenPreview.playsInline = true;
    screenPreview.hidden = true;
    screenPreview.style.width = "100%";
    screenPreview.style.marginTop = "10px";
    screenPreview.style.borderRadius = "8px";

    const status = document.createElement("p");
    status.setAttribute("aria-live", "polite");
    status.style.margin = "10px 0";

    const cameraStart = button("Enable webcam preview", async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        status.textContent = "Camera access is unavailable. Use HTTPS in a supported browser.";
        return;
      }

      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });

        cameraPreview.srcObject = cameraStream;
        cameraPreview.hidden = false;
        status.textContent = "Camera is active. Video stays on this device.";
        cameraStart.disabled = true;
        cameraStop.disabled = false;
      } catch {
        status.textContent = "Camera permission was denied or the camera is unavailable.";
      }
    });

    const cameraStop = button("Stop webcam", () => {
      stopCamera();
      cameraPreview.hidden = true;
      status.textContent = "Camera stopped.";
      cameraStart.disabled = false;
      cameraStop.disabled = true;
    });
    cameraStop.disabled = true;

    const screenStart = button("Share screen", async () => {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        status.textContent = "Screen sharing is unavailable in this browser.";
        return;
      }

      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false
        });

        screenPreview.srcObject = screenStream;
        screenPreview.hidden = false;
        status.textContent =
          "Screen sharing is active and previewed on this page. It is not being sent to an administrator.";
        screenStart.disabled = true;
        screenStop.disabled = false;

        screenStream.getVideoTracks()[0]?.addEventListener("ended", () => {
          stopScreenShare();
          screenPreview.hidden = true;
          status.textContent = "Screen sharing stopped.";
          screenStart.disabled = false;
          screenStop.disabled = true;
        }, { once: true });
      } catch {
        status.textContent = "Screen sharing was cancelled or permission was denied.";
      }
    });

    const screenStop = button("Stop screen sharing", () => {
      stopScreenShare();
      screenPreview.hidden = true;
      status.textContent = "Screen sharing stopped.";
      screenStart.disabled = false;
      screenStop.disabled = true;
    });
    screenStop.disabled = true;

    const close = button("Close controls", () => {
      stopCamera();
      stopScreenShare();
      controls.remove();
      controls = null;
    });

    controls.append(
      heading,
      note,
      cameraStart,
      cameraStop,
      cameraPreview,
      screenStart,
      screenStop,
      screenPreview,
      status,
      close
    );

    document.body.appendChild(controls);
  }

  function stopCamera() {
    cameraStream?.getTracks().forEach(track => track.stop());
    cameraStream = null;

    const video = controls?.querySelector("video");
    if (video && video.srcObject && video.srcObject !== screenStream) {
      video.srcObject = null;
    }
  }

  function stopScreenShare() {
    screenStream?.getTracks().forEach(track => track.stop());
    screenStream = null;
  }

  // Record only selected non-text-entry key categories.
  // Never record characters typed into forms or contenteditable elements.
  const safeKeys = new Set([
    "Enter", "Escape", "Tab", "ArrowUp", "ArrowDown",
    "ArrowLeft", "ArrowRight"
  ]);

  document.addEventListener("keydown", event => {
    if (!consentGranted || event.repeat || event.isComposing) return;

    const target = event.target;
    if (
      target instanceof Element &&
      (target.closest("input, textarea, select, [contenteditable='true']") ||
       target.closest("[data-private-input]"))
    ) {
      return;
    }

    if (safeKeys.has(event.key)) {
      sendEvent("keyboard_interaction", event.key);
    }
  }, { passive: true });

  // Optional page visibility heartbeat; no text or form contents are collected.
  document.addEventListener("visibilitychange", () => {
    if (consentGranted && document.visibilityState === "visible") {
      sendEvent("heartbeat");
    }
  });

  function initialize() {
    consentGranted = hasConsent();

    if (consentGranted) {
      sessionId = getSessionId();
      sendEvent("page_view");
      createFeatureControls();
    } else {
      createConsentBanner();
    }
  }

  window.visitorTracker = {
    track(type, label = "") {
      if (!["page_view", "click", "heartbeat"].includes(type)) return;
      sendEvent(type, label);
    },

    getConsent() {
      return consentGranted;
    },

    withdrawConsent() {
      saveConsent(false);
      controls?.remove();
      controls = null;
    }
  };

  window.addEventListener("pagehide", () => {
    stopCamera();
    stopScreenShare();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
