'use strict';

// ── Socket ──────────────────────────────────────────────────────────────────
const socket = io();

// ── State ───────────────────────────────────────────────────────────────────
let sessionId = null;
let sessionLink = null;
let stream = null;
let pc = null;
let timerInt = null;
let timerStart = null;
let sharing = false;

// ── DOM ──────────────────────────────────────────────────────────────────────
const btnShare   = document.getElementById('btn-share');
const card       = document.getElementById('session-card');
const linkEl     = document.getElementById('sc-link-text');
const timerEl    = document.getElementById('sc-timer');
const warnOver   = document.getElementById('warn-overlay');
const warnMsg    = document.getElementById('warn-msg');

// ── Loader ───────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  setTimeout(() => {
    document.getElementById('loader').classList.add('gone');
  }, 1700);
  loadLeaderboard();
});

// ════════════════════════════════════════════════
//  SCREEN SHARE
// ════════════════════════════════════════════════
async function startShare() {
  if (sharing) { stopShare(); return; }

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
  } catch (e) {
    toast('error', 'Permission Denied', 'You must allow screen capture to start a session.');
    return;
  }

  // track stopped by browser stop button
  stream.getVideoTracks()[0].onended = () => { if (sharing) stopShare(true); };

  // create session id locally
  sessionId = randomId();
  sessionLink = location.origin + '/?view=' + sessionId;

  // register with server
  const name = 'Player_' + Math.random().toString(36).substring(2,7).toUpperCase();
  socket.emit('user_register', { sessionId, userName: name });
  socket.emit('user_screen_live', { sessionId });

  // update UI
  sharing = true;
  linkEl.textContent = sessionLink;
  card.style.display = 'block';
  btnShare.classList.add('stopping');
  btnShare.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>Stop Sharing`;

  startTimer();
  toast('success', '🟢 Live', 'Your session is active. Admin is monitoring.');
}

function stopShare(fromBrowser = false) {
  sharing = false;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (pc) { pc.close(); pc = null; }
  stopTimer();
  card.style.display = 'none';
  btnShare.classList.remove('stopping');
  btnShare.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>Share Screen`;
  sessionId = null;
  if (!fromBrowser) toast('info', '⏹ Stopped', 'Screen sharing ended.');
}

// ════════════════════════════════════════════════
//  WebRTC — send stream to admin
// ════════════════════════════════════════════════
async function buildOffer() {
  if (!stream || !sessionId) return;
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  stream.getTracks().forEach(t => pc.addTrack(t, stream));

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('webrtc_ice', { sessionId, candidate: e.candidate, fromAdmin: false });
  };
  pc.oniceconnectionstatechange = () => {
    if (pc && (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected')) {
      toast('warn', 'Reconnecting...', 'Trying to restore admin connection.');
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc_offer', { sessionId, offer });
}

// ── Socket events ────────────────────────────────────────────────────────────
socket.on('admin_watching', () => {
  toast('info', '👁 Admin Connected', 'Admin is now viewing your screen.');
  buildOffer();
});

socket.on('webrtc_answer', async ({ answer }) => {
  if (pc) {
    try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); } catch(e){}
  }
});

socket.on('webrtc_ice', async ({ candidate, fromAdmin }) => {
  if (fromAdmin && pc) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e){}
  }
});

socket.on('got_warning', ({ msg }) => {
  warnMsg.textContent = msg;
  warnOver.classList.add('show');
  toast('warn', '⚠️ Warning', 'You received an admin warning.');
});

socket.on('force_stop', ({ msg }) => {
  toast('error', '🛑 Session Ended', msg);
  stopShare(true);
});

socket.on('kicked', ({ msg }) => {
  toast('error', '🚫 Removed', msg);
  stopShare(true);
  setTimeout(() => location.reload(), 3000);
});

// ── Timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
  timerStart = Date.now();
  timerInt = setInterval(() => {
    const s = Math.floor((Date.now() - timerStart) / 1000);
    timerEl.textContent =
      pad(Math.floor(s/3600)) + ':' + pad(Math.floor((s%3600)/60)) + ':' + pad(s%60);
  }, 1000);
}
function stopTimer() { clearInterval(timerInt); timerEl.textContent = '00:00:00'; }
function pad(n) { return String(n).padStart(2,'0'); }

// ── Copy link ─────────────────────────────────────────────────────────────────
function copyLink() {
  if (!sessionLink) return;
  navigator.clipboard.writeText(sessionLink).then(() => {
    const b = document.getElementById('btn-copy');
    b.textContent = 'COPIED!'; b.classList.add('ok');
    setTimeout(() => { b.textContent = 'COPY'; b.classList.remove('ok'); }, 2500);
    toast('success', 'Copied!', 'Session link copied to clipboard.');
  }).catch(() => toast('error', 'Failed', 'Could not copy link.'));
}

function closeWarn() { warnOver.classList.remove('show'); }

// ── Leaderboard ───────────────────────────────────────────────────────────────
async function loadLeaderboard() {
  const body = document.getElementById('lb-body');
  try {
    const r = await fetch('/api/leaderboard');
    const data = await r.json();
    const medals = {1:'🥇',2:'🥈',3:'🥉'};
    body.innerHTML = data.map(p => {
      const cls = p.rank <= 3 ? 'r'+p.rank : '';
      const ini = p.name.split(' ').map(w=>w[0]).join('').slice(0,2);
      const w = Math.round(((p.rating - 75) / 25) * 100);
      return `<div class="lb-row ${cls}">
        <div class="lb-rank">${p.rank<=3 ? medals[p.rank] : '#'+p.rank}</div>
        <div class="lb-player">
          <div class="lb-av">${ini}</div>
          <div><div class="lb-pname">${p.name}</div><div class="lb-club">${p.club}</div></div>
        </div>
        <div class="lb-flag">${p.flag}</div>
        <div class="lb-rating">
          <span class="lb-rnum">${p.rating}</span>
          <div class="rbar"><div class="rfill" style="width:${w}%"></div></div>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    body.innerHTML = '<div style="padding:30px;text-align:center;color:#3a4a5a">Failed to load.</div>';
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let tc = 0;
function toast(type, title, msg) {
  const c = document.getElementById('toasts');
  const id = 't'+(++tc);
  const icons = {success:'✅',warn:'⚠️',error:'❌',info:'ℹ️'};
  const el = document.createElement('div');
  el.className = 'toast '+type; el.id = id;
  el.innerHTML = `<span class="ti">${icons[type]||'ℹ️'}</span><div><div class="tt">${title}</div><div class="tm">${msg}</div></div>`;
  c.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 4500);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function randomId() { return Math.random().toString(36).substring(2,10).toUpperCase(); }

window.addEventListener('beforeunload', e => {
  if (sharing) { e.preventDefault(); e.returnValue = ''; }
});