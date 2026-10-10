(() => {
  'use strict';

  const API_BASE = 'https://testing.mrguy987.workers.dev';
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  let adminKey = '';
  let selectedSession = null;
  let refreshTimer = null;
  let currentData = null;
  let supportId = null;
  let supportPoll = null;
  let signalTimer = null;

  const adminPCs = {};
  const seenSignals = new Set();
  const pendingCandidates = {
    camera: [],
    screen: []
  };
  const remoteStreams = {};

  const $ = id => document.getElementById(id);

  // Click the visitor's webcam preview to enlarge it.
  const remoteCamera = $('remoteCamera');

  remoteCamera.style.cursor = 'pointer';
  remoteCamera.title = 'Click to view fullscreen';

  remoteCamera.addEventListener('click', async () => {
    if (!remoteCamera.srcObject) {
      $('supportStatus').textContent =
        'The visitor is not currently sharing their webcam.';
      return;
    }

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await remoteCamera.requestFullscreen();
      }
    } catch (error) {
      $('supportStatus').textContent =
        'Could not open fullscreen: ' + error.message;
    }
  });


  const esc = value =>
    String(value ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));

  const field = (obj, ...keys) => {
    for (const k of keys) {
      if (obj && obj[k] !== undefined && obj[k] !== null) {
        return obj[k];
      }
    }

    return '';
  };

  const fmtTime = value => {
    const n = Number(value);

    if (!n) return '—';

    return new Date(n < 1e12 ? n * 1000 : n)
      .toLocaleString();
  };

  async function api(path, options = {}) {
    const response = await fetch(API_BASE + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey,
        ...(options.headers || {})
      }
    });

    let data = {};

    try {
      data = await response.json();
    } catch {}

    if (!response.ok || data.ok === false) {
      throw new Error(
        data.error || `Request failed (${response.status})`
      );
    }

    return data;
  }

  function isOnline(s) {
    const t = Number(
      field(s, 'last_seen_at', 'lastSeenAt')
    ) * 1000;

    return Boolean(
      t &&
      Date.now() - t < 120000 &&
      Number(field(s, 'active')) !== 0 &&
      field(s, 'active') !== false
    );
  }

  function resetSupport(message = 'No support session active.') {
    if (supportPoll) clearInterval(supportPoll);
    if (signalTimer) clearInterval(signalTimer);

    supportPoll = null;
    signalTimer = null;
    supportId = null;

    for (const pc of Object.values(adminPCs)) {
      try {
        pc.close();
      } catch {}
    }

    for (const k of Object.keys(adminPCs)) {
      delete adminPCs[k];
    }

    for (const k of Object.keys(remoteStreams)) {
      delete remoteStreams[k];
    }

    for (const k of Object.keys(pendingCandidates)) {
      pendingCandidates[k] = [];
    }

    seenSignals.clear();

    $('remoteCamera').srcObject = null;
    $('remoteScreen').srcObject = null;
    $('supportStatus').textContent = message;
    $('endSupportBtn').disabled = true;
  }

  async function requestSupport(sessionId) {
    try {
      resetSupport('Creating support request…');

      const d = await api('/api/support/request', {
        method: 'POST',
        body: JSON.stringify({
          visitorSessionId: sessionId
        })
      });

      supportId = d.supportId;

      $('supportStatus').textContent =
        `Request sent for ${sessionId}. Waiting for the visitor to approve it.`;

      $('endSupportBtn').disabled = false;

      supportPoll = setInterval(checkSupportStatus, 1500);
      signalTimer = setInterval(pollSignals, 1000);

      await checkSupportStatus();
    } catch (e) {
      $('supportStatus').textContent =
        'Could not request support: ' + e.message;
    }
  }

  async function checkSupportStatus() {
    if (!supportId) return;

    try {
      const d = await api(
        '/api/support/status?id=' +
        encodeURIComponent(supportId)
      );

      const s = d.support.status;

      if (s === 'pending') {
        $('supportStatus').textContent =
          'Waiting for the visitor to approve the support request…';
      } else if (s === 'approved') {
        $('supportStatus').textContent =
          'Visitor approved. Waiting for the visitor to start sharing media…';
      } else if (s === 'connected') {
        $('supportStatus').textContent =
          'Support connection established or being negotiated.';
      } else if (s === 'denied') {
        resetSupport('The visitor rejected the support request.');
      } else if (s === 'ended') {
        resetSupport('Support session ended or expired.');
      }
    } catch (e) {
      $('supportStatus').textContent =
        'Support status error: ' + e.message;
    }
  }

  async function sendSignal(type, payload) {
    if (!supportId) return;

    await api('/api/support/signal', {
      method: 'POST',
      body: JSON.stringify({
        supportId,
        signalType: type,
        payload
      })
    });
  }

  function pcFor(media) {
    if (adminPCs[media]) return adminPCs[media];

    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS
    });

    adminPCs[media] = pc;

    pc.onicecandidate = e => {
      if (e.candidate) {
        sendSignal('ice-candidate', {
          media,
          candidate: e.candidate.toJSON()
        }).catch(err => {
          $('supportStatus').textContent =
            'ICE signal error: ' + err.message;
        });
      }
    };

    pc.ontrack = e => {
      const stream = e.streams[0];

      if (stream) {
        remoteStreams[media] = stream;

        const video = media === 'camera'
          ? $('remoteCamera')
          : $('remoteScreen');

        video.srcObject = stream;
        video.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        $('supportStatus').textContent =
          'Connected. Viewing only the media the visitor chose to share.';
      }

      if (pc.connectionState === 'failed') {
        $('supportStatus').textContent =
          'WebRTC connection failed. This network may require a TURN server.';
      }
    };

    return pc;
  }

  async function processSignal(s) {
    const p = s.payload || {};
    const media = p.media;

    if (!['camera', 'screen'].includes(media)) return;

    const pc = pcFor(media);

    if (s.signalType === 'offer' && p.description) {
      if (!pc.currentRemoteDescription) {
        await pc.setRemoteDescription(p.description);

        for (const candidate of pendingCandidates[media]) {
          try {
            await pc.addIceCandidate(candidate);
          } catch {}
        }

        pendingCandidates[media] = [];

        const answer = await pc.createAnswer();

        await pc.setLocalDescription(answer);

        await sendSignal('answer', {
          media,
          description: pc.localDescription.toJSON()
        });
      }
    } else if (
      s.signalType === 'ice-candidate' &&
      p.candidate
    ) {
      if (pc.remoteDescription) {
        try {
          await pc.addIceCandidate(p.candidate);
        } catch {}
      } else {
        pendingCandidates[media].push(p.candidate);
      }
    }
  }

  async function pollSignals() {
    if (!supportId) return;

    try {
      const d = await api(
        '/api/support/signals?id=' +
        encodeURIComponent(supportId)
      );

      for (const s of d.signals || []) {
        if (seenSignals.has(s.id)) continue;

        seenSignals.add(s.id);

        if (
          s.sender === 'visitor' &&
          ['offer', 'ice-candidate'].includes(s.signalType)
        ) {
          try {
            await processSignal(s);
          } catch (e) {
            $('supportStatus').textContent =
              'WebRTC negotiation error: ' + e.message;
          }
        }
      }
    } catch (e) {
      if (!/not approved/i.test(e.message)) {
        $('supportStatus').textContent =
          'Signal polling error: ' + e.message;
      }
    }
  }

  async function endSupport() {
    if (!supportId) return;

    const id = supportId;

    try {
      await api('/api/support/end', {
        method: 'POST',
        body: JSON.stringify({ supportId: id })
      });
    } catch {}

    resetSupport('Support session ended.');
  }

  function render() {
    if (!currentData) return;

    const st = currentData.stats || {};

    $('onlineCount').textContent = st.online ?? 0;
    $('pageViews').textContent = st.pageViews ?? 0;
    $('sessionCount').textContent = st.sessions ?? 0;
    $('eventCount').textContent = st.events ?? 0;

    $('updated').textContent =
      'Updated ' + fmtTime(currentData.updatedAt);

    const sessions = [...(currentData.sessions || [])]
      .sort((a, b) =>
        Number(field(b, 'last_seen_at')) -
        Number(field(a, 'last_seen_at'))
      );

    $('sessionsBody').innerHTML = sessions.length
      ? sessions.map(s => {
          const id = field(s, 'id');
          const platform = field(s, 'platform') || '—';

          const screen =
            field(s, 'screen_width') &&
            field(s, 'screen_height')
              ? `${s.screen_width} × ${s.screen_height}`
              : '—';

          return `<tr>
            <td><code>${esc(id)}</code></td>
            <td>${esc(field(s, 'current_page') || '—')}</td>
            <td>${esc(platform)}</td>
            <td>${esc(screen)}</td>
            <td>${esc(field(s, 'language') || '—')}</td>
            <td>${esc(fmtTime(field(s, 'last_seen_at')))}</td>
            <td>${esc(field(s, 'views') || 0)}</td>
            <td>
              <span class="status-pill ${isOnline(s) ? 'online' : 'offline'}">
                ${isOnline(s) ? 'Online' : 'Offline'}
              </span>
            </td>
            <td>
              <button
                class="button secondary request-support"
                data-session="${esc(id)}">
                Request support
              </button>
            </td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="9">No visitor sessions yet.</td></tr>';

    $('sessionsBody')
      .querySelectorAll('.request-support')
      .forEach(btn => {
        btn.addEventListener('click', () =>
          requestSupport(btn.dataset.session)
        );
      });

    const evs = currentData.events || [];

    const selected =
      selectedSession ||
      field(sessions[0] || {}, 'id');

    if (selected) {
      selectedSession = selected;

      $('selectedSessionLabel').textContent =
        'Session: ' + selected;

      const relevant = evs.filter(e =>
        field(e, 'visitor_session_id', 'sessionId') === selected
      );

      $('timeline').innerHTML = relevant.length
        ? relevant.slice(0, 100).map(e => `
            <div class="timeline-item">
              <strong>${esc(field(e, 'event_type', 'eventType') || 'event')}</strong>
              <span>${esc(field(e, 'page') || '')}</span>
              <small>${esc(fmtTime(field(e, 'created_at', 'timestamp')))}</small>
            </div>
          `).join('')
        : '<p class="muted">No events for this session.</p>';
    } else {
      $('selectedSessionLabel').textContent = 'No session selected.';
      $('timeline').innerHTML =
        '<p class="muted">No session selected.</p>';
    }

    const pages = currentData.pages || [];

    $('popularPages').innerHTML = pages.length
      ? pages.map(p => `
          <div class="popular-item">
            <span>${esc(p.page)}</span>
            <strong>${esc(p.views)}</strong>
          </div>
        `).join('')
      : '<p class="muted">No page views yet.</p>';
  }

  async function refresh() {
    try {
      currentData = await api('/api/dashboard');

      $('connection').textContent = 'Connected';
      $('connection').classList.add('connected');

      render();
    } catch (e) {
      $('connection').textContent = 'Disconnected';
      $('connection').classList.remove('connected');

      throw e;
    }
  }

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();

    adminKey = $('adminKey').value;

    try {
      await refresh();

      $('loginPanel').hidden = true;
      $('dashboard').hidden = false;
      $('loginError').textContent = '';

      if (refreshTimer) clearInterval(refreshTimer);

      refreshTimer = setInterval(
        () => refresh().catch(() => {}),
        15000
      );
    } catch (err) {
      $('loginError').textContent = err.message;
      adminKey = '';
    }
  });

  $('refreshBtn').addEventListener('click', () => {
    refresh().catch(() => {
      $('connection').textContent = 'Disconnected';
    });
  });

  $('logoutBtn').addEventListener('click', () => {
    if (refreshTimer) clearInterval(refreshTimer);

    resetSupport('Signed out.');

    adminKey = '';
    $('adminKey').value = '';
    $('dashboard').hidden = true;
    $('loginPanel').hidden = false;
    $('connection').textContent = 'Disconnected';
  });

  $('endSupportBtn').addEventListener('click', endSupport);
})();