'use strict';

// ── Socket ───────────────────────────────────────────────────────────────────
const socket = io();

// ── State ────────────────────────────────────────────────────────────────────
let loggedIn = false;
let sessions = [];
let selectedId = null;
let peerConns = {};       // sessionId -> RTCPeerConnection
let warnTarget = null;
let refreshTimer = null;

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const authScreen = $('auth-screen');
const adminApp   = $('admin');
const sessList   = $('sess-list');
const prevVideo  = $('prev-video');
const prevLive   = $('prev-live');
const prevPh     = $('prev-ph');
const prevInfo   = $('prev-info');
const prevBtns   = $('prev-btns');
const prevName   = $('prev-name');
const prevSid    = $('prev-sid');
const warnModal  = $('warn-modal');

// ── Clock ─────────────────────────────────────────────────────────────────────
setInterval(() => {
  $('tb-clock').textContent = new Date().toLocaleTimeString('en-GB');
}, 1000);

// ════════════════════════════════════════════════
//  LOGIN
// ════════════════════════════════════════════════
$('auth-inp').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const pw = $('auth-inp').value.trim();
  if (!pw) return;
  const btn = $('auth-btn');
  btn.textContent = 'Checking...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const data = await res.json();

    if (data.ok) {
      loggedIn = true;
      authScreen.style.display = 'none';
      adminApp.classList.add('show');
      socket.emit('admin_join');
      startAutoRefresh();
      toast('success', '✅ Access Granted', 'Welcome to the Admin Control Panel.');
    } else {
      $('auth-err').classList.add('show');
      $('auth-inp').value = '';
      $('auth-inp').focus();
    }
  } catch (e) {
    $('auth-err').textContent = 'Server error. Is the server running?';
    $('auth-err').classList.add('show');
  }

  btn.textContent = 'ACCESS PANEL';
  btn.disabled = false;
}

// ════════════════════════════════════════════════
//  SOCKET EVENTS
// ════════════════════════════════════════════════
socket.on('admin_joined_ok', () => {
  console.log('Admin socket confirmed');
});

socket.on('admin_update', ({ sessions: data, stats }) => {
  sessions = data || [];
  renderStats(stats);
  renderSessions(sessions);
});

// WebRTC: incoming offer from a user (or when admin connects to a session that already has an offer)
socket.on('webrtc_offer', async ({ sessionId, offer }) => {
  // only process if we are currently watching this session
  if (sessionId !== selectedId) return;
  await createAnswer(sessionId, offer);
});

socket.on('webrtc_ice', async ({ sessionId, candidate, fromAdmin }) => {
  if (!fromAdmin && peerConns[sessionId] && candidate) {
    try { await peerConns[sessionId].addIceCandidate(new RTCIceCandidate(candidate)); } catch(e){}
  }
});

socket.on('disconnect', () => toast('warn', '⚡ Disconnected', 'Lost server connection.'));
socket.on('reconnect', () => {
  if (loggedIn) { socket.emit('admin_join'); toast('success', '✅ Reconnected', 'Back online.'); }
});

// ════════════════════════════════════════════════
//  WebRTC — answer user's offer
// ════════════════════════════════════════════════
async function createAnswer(sessionId, offer) {
  // close old connection for same session
  if (peerConns[sessionId]) { peerConns[sessionId].close(); delete peerConns[sessionId]; }

  const pc = new RTCPeerConnection(ICE);
  peerConns[sessionId] = pc;

  pc.ontrack = e => {
    if (e.streams && e.streams[0]) {
      prevVideo.srcObject = e.streams[0];
      prevVideo.classList.add('show');
      prevLive.classList.add('show');
      prevPh.style.display = 'none';
      updatePreviewInfo(sessionId);
      toast('success', '🖥️ Feed Connected', 'Live screen stream is active.');
    }
  };

  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('webrtc_ice', { sessionId, candidate: e.candidate, fromAdmin: true });
    }
  };

  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    if ((st === 'disconnected' || st === 'failed') && selectedId === sessionId) {
      clearPreview();
      toast('warn', '📡 Feed Lost', 'Stream disconnected.');
      delete peerConns[sessionId];
    }
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc_answer', { sessionId, answer });
  } catch(e) {
    console.error('WebRTC answer error:', e);
    toast('error', 'WebRTC Error', 'Could not establish video stream.');
  }
}

function updatePreviewInfo(sessionId) {
  const s = sessions.find(x => x.id === sessionId);
  if (s) {
    prevName.textContent = s.userName;
    prevSid.textContent = 'ID: ' + sessionId;
    prevInfo.style.display = 'block';
    prevBtns.style.display = 'flex';
    $('prev-kick').onclick = () => doKick(sessionId);
  }
}

// ════════════════════════════════════════════════
//  ADMIN ACTIONS (called from rendered buttons)
// ════════════════════════════════════════════════
function doView(sessionId) {
  selectedId = sessionId;
  socket.emit('admin_watch', { sessionId });
  // highlight
  document.querySelectorAll('.scard').forEach(el => el.classList.remove('sel'));
  const el = document.querySelector('[data-id="'+sessionId+'"]');
  if (el) el.classList.add('sel');
  toast('info', '👁 Connecting...', 'Requesting live screen feed.');
}

function doStop(sessionId) {
  if (!confirm('Force-end this session? The player will be notified.')) return;
  socket.emit('admin_stop_session', { sessionId });
  if (selectedId === sessionId) clearPreview();
  toast('warn', '⏹ Session Ended', 'Session was force-stopped.');
}

function doKick(sessionId) {
  if (!confirm('Remove this player from the platform?')) return;
  socket.emit('admin_kick', { sessionId });
  if (selectedId === sessionId) clearPreview();
  toast('error', '🚫 Player Kicked', 'Player has been removed.');
}

function openWarnModal(sessionId) {
  warnTarget = sessionId;
  const s = sessions.find(x => x.id === sessionId);
  $('wm-target').textContent = 'To: ' + (s ? s.userName : sessionId);
  $('wm-text').value = '⚠️ Admin Warning: Please follow all platform rules or your session will be terminated.';
  warnModal.classList.add('show');
}

function closeWarnModal() {
  warnModal.classList.remove('show');
  warnTarget = null;
}

function sendWarn() {
  if (!warnTarget) return;
  const msg = $('wm-text').value.trim();
  if (!msg) return;
  socket.emit('admin_warn', { sessionId: warnTarget, msg });
  closeWarnModal();
  toast('success', '⚠️ Warning Sent', 'Player has been notified.');
}

function stopPreview() {
  if (selectedId && peerConns[selectedId]) {
    peerConns[selectedId].close();
    delete peerConns[selectedId];
  }
  clearPreview();
  toast('info', 'Preview stopped.', '');
}

function clearPreview() {
  prevVideo.srcObject = null;
  prevVideo.classList.remove('show');
  prevLive.classList.remove('show');
  prevPh.style.display = 'block';
  prevInfo.style.display = 'none';
  prevBtns.style.display = 'none';
  selectedId = null;
  document.querySelectorAll('.scard').forEach(el => el.classList.remove('sel'));
}

// ════════════════════════════════════════════════
//  RENDER
// ════════════════════════════════════════════════
function renderStats(stats) {
  if (!stats) return;
  $('s-total').textContent   = stats.total;
  $('s-active').textContent  = stats.active;
  $('s-waiting').textContent = stats.waiting;
  $('s-disc').textContent    = stats.disconnected;
}

function renderSessions(data) {
  $('pane-sub').textContent = data.length
    ? data.length + ' session' + (data.length !== 1 ? 's' : '') + ' total'
    : 'Waiting for connections...';

  if (!data.length) {
    sessList.innerHTML = `<div class="empty"><div class="empty-ico">📡</div><p>No sessions yet.<br>Waiting for players...</p></div>`;
    return;
  }

  sessList.innerHTML = data.map(s => {
    const dead   = s.status === 'disconnected';
    const active = s.status === 'active';
    const ini    = s.userName.replace('Player_','').slice(0,2);
    const dur    = fmtDur(s.duration);
    const joined = new Date(s.joinTime).toLocaleTimeString('en-GB');
    const isSel  = s.id === selectedId ? 'sel' : '';
    const isDead = dead ? 'dead' : '';

    return `
    <div class="scard ${isSel} ${isDead}" data-id="${s.id}">
      <div class="scard-top">
        <div class="scard-player">
          <div class="scard-av">${esc(ini)}</div>
          <div>
            <div class="scard-name">${esc(s.userName)}</div>
            <div class="scard-id">${s.id}</div>
          </div>
        </div>
        <span class="pill ${s.status}">${
          s.status === 'active'       ? '● LIVE' :
          s.status === 'waiting'      ? '◌ WAITING' :
          '✕ DISCONNECTED'
        }</span>
      </div>
      <div class="scard-meta">
        <span>🕐 Joined ${joined}</span>
        <span>⏱ ${dur}</span>
        ${s.adminWatching ? '<span class="watching">👁 Admin watching</span>' : ''}
        ${s.warnings > 0  ? `<span class="warned">⚠️ ${s.warnings} warn${s.warnings>1?'s':''}</span>` : ''}
      </div>
      <div class="scard-btns">
        <button class="ab view" onclick="doView('${s.id}')" ${!active?'disabled':''}>👁 View</button>
        <button class="ab warn" onclick="openWarnModal('${s.id}')" ${dead?'disabled':''}>⚠️ Warn</button>
        <button class="ab stop" onclick="doStop('${s.id}')" ${dead?'disabled':''}>⏹ Stop</button>
        <button class="ab kick" onclick="doKick('${s.id}')" ${dead?'disabled':''}>🚫 Kick</button>
      </div>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════════════
//  AUTO REFRESH
// ════════════════════════════════════════════════
function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => socket.emit('admin_refresh'), 4000);
}

function doRefresh() {
  const btn = $('tb-refresh');
  btn.classList.add('spin');
  socket.emit('admin_refresh');
  setTimeout(() => btn.classList.remove('spin'), 700);
}

// ── warn modal close on backdrop ────────────────────────────────────────────
warnModal.addEventListener('click', e => { if (e.target === warnModal) closeWarnModal(); });

// ════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════
function fmtDur(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  if (h > 0) return h+'h '+m+'m';
  if (m > 0) return m+'m '+sec+'s';
  return sec+'s';
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
let tc = 0;
function toast(type, title, msg) {
  const c = $('toasts');
  const icons = {success:'✅',warn:'⚠️',error:'❌',info:'ℹ️'};
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span class="ti">${icons[type]||'ℹ️'}</span>
    <div><div class="tt">${title}</div><div class="tm">${msg}</div></div>`;
  c.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 4200);
}