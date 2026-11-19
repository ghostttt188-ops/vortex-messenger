function formatLocalTime(isoStr, fallback = "") {
  if (!isoStr) return fallback;
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});
const REACTION_EMOJIS = ["👍", "🌪️", "⚠️", "🚨"];

let currentUser = localStorage.getItem("vortex_callsign") || "";
let currentStatus = localStorage.getItem("vortex_status") || "En Route";
let soundEnabled = localStorage.getItem("vortex_sound") !== "off";
let fieldLiteMode = localStorage.getItem("vortex_lite") === "on";
let isAdmin = false;
let isOwner = false;
let myAvatarUrl = null;
let avatarCache = {};
let activeThreadId = 1;
let threads = [];
let unreadCounts = {};
let seenMap = {};
let alertMode = false;
let replyTarget = null;
let typingTimeout = null;
let isTyping = false;
let sessionStarted = false;

let tacticalMap = null;
let radarLayer = null;
let radarEnabled = true;
let mapLayerGroup = null;
let mediaRecorder = null;
let audioChunks = [];

const loginModal = document.getElementById("loginModal");
const callsignInput = document.getElementById("callsignInput");
const joinBtn = document.getElementById("joinBtn");
const myDisplayName = document.getElementById("myDisplayName");
const myAvatar = document.getElementById("myAvatar");
const avatarInput = document.getElementById("avatarInput");
const adminBadge = document.getElementById("adminBadge");
const adminControlsSection = document.getElementById("adminControlsSection");
const myStatusSelect = document.getElementById("myStatusSelect");
const soundToggleBtn = document.getElementById("soundToggleBtn");
const fieldLiteBtn = document.getElementById("fieldLiteBtn");
const fieldLiteBanner = document.getElementById("fieldLiteBanner");
const lockedBanner = document.getElementById("lockedBanner");
const exportLogBtn = document.getElementById("exportLogBtn");
const threadList = document.getElementById("threadList");
const threadSearch = document.getElementById("threadSearch");
const offlineBanner = document.getElementById("offlineBanner");
const pinnedBanner = document.getElementById("pinnedBanner");
const pinnedText = document.getElementById("pinnedText");
const unpinBtn = document.getElementById("unpinBtn");
const messageFeed = document.getElementById("messageFeed");
const replyBar = document.getElementById("replyBar");
const replyTargetSender = document.getElementById("replyTargetSender");
const replyTargetSnippet = document.getElementById("replyTargetSnippet");
const cancelReplyBtn = document.getElementById("cancelReplyBtn");
const composerForm = document.getElementById("composerForm");
const messageInput = document.getElementById("messageInput");
const activeThreadName = document.getElementById("activeThreadName");
const activeThreadAvatar = document.getElementById("activeThreadAvatar");
const infoThreadTitle = document.getElementById("infoThreadTitle");
const infoAvatar = document.getElementById("infoAvatar");
const typingBar = document.getElementById("typingBar");
const typingText = document.getElementById("typingText");
const onlineStrip = document.getElementById("onlineStrip");
const onlineRoster = document.getElementById("onlineRoster");
const onlineCount = document.getElementById("onlineCount");

function renderAvatarContent(name, url) {
  const resolved = url || avatarCache[(name || "").toLowerCase()] || null;
  if (resolved) {
    return `<img class="avatar-img" src="${escapeHtml(resolved)}" alt="${escapeHtml(name)}" />`;
  }
  return initials(name);
}

function syncMyAvatarUi() {
  myAvatar.innerHTML = renderAvatarContent(currentUser, myAvatarUrl);
}

// Square center-crop & compress for crisp circular avatars from phone/laptop galleries
function cropSquareAvatarFile(file, size = 320, quality = 0.84) {
  return new Promise((resolve) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.src = e.target.result;
    };
    img.onload = () => {
      const minSide = Math.min(img.width, img.height);
      const sx = Math.floor((img.width - minSide) / 2);
      const sy = Math.floor((img.height - minSide) / 2);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(file);
            return;
          }
          resolve(new File([blob], "avatar.jpg", { type: "image/jpeg" }));
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

document.getElementById("myAvatarBtn").addEventListener("click", () => {
  if (!currentUser) return;
  avatarInput.click();
});
document.getElementById("drawerChangeAvatarBtn").addEventListener("click", () => {
  if (!currentUser) return;
  avatarInput.click();
});

avatarInput.addEventListener("change", async () => {
  const file = avatarInput.files[0];
  if (!file || !currentUser) return;

  const cropped = await cropSquareAvatarFile(file);
  const formData = new FormData();
  formData.append("username", currentUser);
  formData.append("file", cropped);

  const res = await fetch("/api/avatar", { method: "POST", body: formData });
  const data = await res.json();
  if (data.avatar_url) {
    myAvatarUrl = data.avatar_url;
    avatarCache[currentUser.toLowerCase()] = myAvatarUrl;
    syncMyAvatarUi();
    await selectThread(activeThreadId);
  }
  avatarInput.value = "";
});

function syncAdminUi() {
  if (isAdmin) {
    adminBadge.textContent = isOwner ? "OWNER" : "ADMIN";
    adminBadge.classList.remove("hidden");
    adminControlsSection.classList.remove("hidden");
  } else {
    adminBadge.classList.add("hidden");
    adminControlsSection.classList.add("hidden");
  }
}

function syncFieldLiteUi() {
  fieldLiteBtn.classList.toggle("active-lite", fieldLiteMode);
  fieldLiteBanner.classList.toggle("hidden", !fieldLiteMode);
}
syncFieldLiteUi();

fieldLiteBtn.addEventListener("click", () => {
  fieldLiteMode = !fieldLiteMode;
  localStorage.setItem("vortex_lite", fieldLiteMode ? "on" : "off");
  syncFieldLiteUi();
  selectThread(activeThreadId);
});

function requestNotifyPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function maybeNotifyAlert(msg) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const thread = threads.find((t) => Number(t.id) === Number(msg.thread_id));
  const isDm = thread && !thread.is_group;
  const isHighPriority = msg.msg_type === "alert" || msg.msg_type === "nws" || isDm;
  if (!isHighPriority) return;
  if (document.visibilityState === "visible" && Number(msg.thread_id) === Number(activeThreadId) && msg.msg_type !== "nws") return;

  const title = msg.msg_type === "nws"
    ? "🌪️ AUTOMATED NWS WARNING"
    : msg.msg_type === "alert"
      ? `🚨 PRIORITY ALERT — ${msg.sender}`
      : `💬 ${thread ? thread.name : msg.sender}`;
  const body = (msg.body || "").replace(/<[^>]*>/g, "") || "New field update";
  try {
    new Notification(title, { body: body.slice(0, 140) });
  } catch (e) {}
}

function getOutbox() {
  try {
    return JSON.parse(localStorage.getItem("vortex_outbox") || "[]");
  } catch (e) {
    return [];
  }
}

function setOutbox(items) {
  localStorage.setItem("vortex_outbox", JSON.stringify(items));
}

function enqueueMessage(payload) {
  const queue = getOutbox();
  queue.push(payload);
  setOutbox(queue);
}

function flushOutbox() {
  if (!socket.connected) return;
  const queue = getOutbox();
  if (!queue.length) return;
  queue.forEach((item) => socket.emit("send_message", item));
  setOutbox([]);
}

function dispatchMessage(payload) {
  if (socket.connected) {
    socket.emit("send_message", payload);
  } else {
    enqueueMessage(payload);
    appendMessage({
      ...payload,
      id: "queued-" + Date.now(),
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      reactions: [],
    });
  }
}

function compressImageFile(file, maxDim = 1280, quality = 0.76) {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/") || file.type === "image/gif") {
      resolve(file);
      return;
    }
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.src = e.target.result;
    };
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(file);
            return;
          }
          const compressed = new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
            type: "image/jpeg",
          });
          resolve(compressed);
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

if ([...myStatusSelect.options].some((o) => o.value === currentStatus)) {
  myStatusSelect.value = currentStatus;
}
myStatusSelect.addEventListener("change", () => {
  currentStatus = myStatusSelect.value;
  localStorage.setItem("vortex_status", currentStatus);
  if (currentUser) {
    socket.emit("update_status", { username: currentUser, status: currentStatus });
  }
});

function sendSafetyCheckin(mode) {
  if (!currentUser) return;
  if (mode === "mayday" && !window.confirm("Broadcast MAYDAY / Assistance Request to the active channel?")) {
    return;
  }

  const emitCheckin = (coords = "") => {
    if (mode === "safe") {
      currentStatus = "🛡️ Sheltered / Safe";
      localStorage.setItem("vortex_status", currentStatus);
      myStatusSelect.value = currentStatus;
    }
    socket.emit("safety_checkin", {
      username: currentUser,
      thread_id: activeThreadId,
      mode,
      coords,
    });
  };

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => emitCheckin(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`),
      () => emitCheckin(""),
      { timeout: 4000 }
    );
  } else {
    emitCheckin("");
  }
}

document.getElementById("safeCheckinBtn").addEventListener("click", () => sendSafetyCheckin("safe"));
document.getElementById("maydayBtn").addEventListener("click", () => sendSafetyCheckin("mayday"));

function syncSoundButton() {
  soundToggleBtn.textContent = soundEnabled ? "🔊" : "🔇";
}
syncSoundButton();

soundToggleBtn.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem("vortex_sound", soundEnabled ? "on" : "off");
  syncSoundButton();
});

exportLogBtn.addEventListener("click", () => {
  window.location.href = `/api/threads/${activeThreadId}/export`;
});

document.getElementById("exportReportsCsvBtn").addEventListener("click", () => {
  window.location.href = "/api/reports/export.csv";
});

document.getElementById("globalBroadcastBtn").addEventListener("click", () => {
  if (!isAdmin) return;
  const text = window.prompt("Enter All-Hands Broadcast (posts to EVERY channel):");
  if (text && text.trim()) {
    socket.emit("global_broadcast", { body: text.trim() });
  }
});

document.getElementById("toggleLockThreadBtn").addEventListener("click", () => {
  if (!isAdmin) return;
  socket.emit("toggle_lock", { thread_id: activeThreadId });
});

document.getElementById("syncNwsBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("nwsSyncStatus");
  const states = document.getElementById("nwsStatesInput").value.trim();
  statusEl.textContent = "Querying NWS active alerts...";
  try {
    const res = await fetch("/api/nws/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ states }),
    });
    const data = await res.json();
    statusEl.textContent = `Synced (${(data.states || []).join(",")}): ${data.inserted || 0} new warning(s)`;
    await loadThreads();
  } catch (e) {
    statusEl.textContent = "NWS sync failed — check connection.";
  }
});

const tacticalMapModal = document.getElementById("tacticalMapModal");
const toggleRadarLayerBtn = document.getElementById("toggleRadarLayerBtn");

async function loadTacticalMapData() {
  if (!tacticalMap || !mapLayerGroup) return;
  mapLayerGroup.clearLayers();

  const res = await fetch("/api/map-data");
  if (!res.ok) return;
  const data = await res.json();

  (data.polygons || []).forEach((p) => {
    const isTor = (p.event || "").toLowerCase().includes("tornado");
    const color = isTor ? "#ff2a4b" : "#f59e0b";
    try {
      L.geoJSON(p.geometry, {
        style: {
          color,
          weight: 2,
          fillColor: color,
          fillOpacity: 0.22,
        },
      })
        .bindPopup(`<strong>🚨 ${escapeHtml(p.event)}</strong><br/>${escapeHtml(p.area || "")}<br/><small>${escapeHtml(p.headline || "")}</small>`)
        .addTo(mapLayerGroup);
    } catch (e) {}
  });

  (data.reports || []).forEach((r) => {
    L.circleMarker([r.lat, r.lon], {
      radius: 8,
      color: "#fbbf24",
      fillColor: "#f59e0b",
      fillOpacity: 0.9,
      weight: 2,
    })
      .bindPopup(
        `<strong>📋 ${escapeHtml(r.phenomenon)}</strong> (${escapeHtml(r.magnitude)})<br/>` +
        `Spotter: ${escapeHtml(r.spotter)} • ${escapeHtml(formatLocalTime(r.created_at_iso, r.timestamp || ""))}<br/>` +
        `${escapeHtml(r.location_text)}<br/><small>${escapeHtml(r.notes)}</small>`
      )
      .addTo(mapLayerGroup);
  });

  (data.spotters || []).forEach((s) => {
    L.circleMarker([s.lat, s.lon], {
      radius: 9,
      color: "#ffffff",
      fillColor: "#39ff14",
      fillOpacity: 0.95,
      weight: 2,
    })
      .bindPopup(`<strong>🟢 ${escapeHtml(s.username)}</strong><br/>Status: ${escapeHtml(s.status)}`)
      .addTo(mapLayerGroup);
  });
}

document.getElementById("openMapBtn").addEventListener("click", async () => {
  tacticalMapModal.classList.remove("hidden");
  if (!tacticalMap && typeof L !== "undefined") {
    tacticalMap = L.map("tacticalMapCanvas").setView([33.17, -86.25], 7);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 18,
      className: "dark-osm-tiles",
    }).addTo(tacticalMap);

    radarLayer = L.tileLayer.wms("https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r.cgi", {
      layers: "nexrad-n0r-900913",
      format: "image/png",
      transparent: true,
      opacity: 0.55,
      attribution: "NEXRAD IEM",
    }).addTo(tacticalMap);

    mapLayerGroup = L.layerGroup().addTo(tacticalMap);
  }
  setTimeout(() => {
    if (tacticalMap) tacticalMap.invalidateSize();
    loadTacticalMapData();
  }, 120);
});

document.getElementById("closeMapBtn").addEventListener("click", () => {
  tacticalMapModal.classList.add("hidden");
});
document.getElementById("refreshMapBtn").addEventListener("click", loadTacticalMapData);
toggleRadarLayerBtn.addEventListener("click", () => {
  if (!tacticalMap || !radarLayer) return;
  radarEnabled = !radarEnabled;
  if (radarEnabled) {
    radarLayer.addTo(tacticalMap);
    toggleRadarLayerBtn.textContent = "📡 Radar: ON";
  } else {
    tacticalMap.removeLayer(radarLayer);
    toggleRadarLayerBtn.textContent = "📡 Radar: OFF";
  }
});

const fieldReportModal = document.getElementById("fieldReportModal");
document.getElementById("openReportModalBtn").addEventListener("click", () => {
  fieldReportModal.classList.remove("hidden");
});
document.getElementById("cancelReportBtn").addEventListener("click", () => {
  fieldReportModal.classList.add("hidden");
});
document.getElementById("fillReportGpsBtn").addEventListener("click", () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    const coords = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
    document.getElementById("reportGpsHidden").value = coords;
    const locInput = document.getElementById("reportLocation");
    if (!locInput.value.trim()) {
      locInput.value = `GPS ${coords}`;
    }
  });
});

document.getElementById("submitReportBtn").addEventListener("click", async () => {
  const phenomenon = document.getElementById("reportPhenomenon").value;
  const magnitude = document.getElementById("reportMagnitude").value.trim() || "Observed";
  const location_text = document.getElementById("reportLocation").value.trim();
  const gps_coords = document.getElementById("reportGpsHidden").value.trim();
  const notes = document.getElementById("reportNotes").value.trim();

  if (!location_text) {
    alert("Enter a county, city, highway, or click 📍 GPS.");
    return;
  }

  const res = await fetch("/api/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      thread_id: activeThreadId,
      spotter: currentUser || "Spotter",
      phenomenon,
      magnitude,
      location_text,
      gps_coords,
      notes,
    }),
  });
  if (res.ok) {
    document.getElementById("reportMagnitude").value = "";
    document.getElementById("reportLocation").value = "";
    document.getElementById("reportGpsHidden").value = "";
    document.getElementById("reportNotes").value = "";
    fieldReportModal.classList.add("hidden");
  }
});

const pttBtn = document.getElementById("pttBtn");
async function startPttRecording(e) {
  e.preventDefault();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("Microphone recording is not supported in this browser.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) audioChunks.push(ev.data);
    };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      pttBtn.classList.remove("recording");
      if (!audioChunks.length) return;
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      if (blob.size < 800) return;

      const formData = new FormData();
      formData.append("file", blob, "ptt_memo.webm");
      const res = await fetch("/api/upload-audio", { method: "POST", body: formData });
      const data = await res.json();
      if (data.url) {
        dispatchMessage({
          thread_id: activeThreadId,
          sender: currentUser || "Spotter",
          body: "🎙️ Push-to-Talk Voice Memo",
          msg_type: "audio",
          media_url: data.url,
        });
      }
    };
    mediaRecorder.start();
    pttBtn.classList.add("recording");
  } catch (err) {
    alert("Microphone permission denied or unavailable.");
  }
}

function stopPttRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
}

pttBtn.addEventListener("mousedown", startPttRecording);
pttBtn.addEventListener("mouseup", stopPttRecording);
pttBtn.addEventListener("mouseleave", stopPttRecording);
pttBtn.addEventListener("touchstart", startPttRecording, { passive: false });
pttBtn.addEventListener("touchend", stopPttRecording);

function initials(name) {
  return (name || "VG").slice(0, 2).toUpperCase();
}

function playPing() {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(740, ctx.currentTime);
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.09);
  } catch (e) {}
}

myDisplayName.style.cursor = "pointer";
myDisplayName.title = "Click to change callsign";
myDisplayName.addEventListener("click", () => {
  localStorage.removeItem("vortex_callsign");
  callsignInput.value = currentUser;
  loginModal.classList.remove("hidden");
});

async function refreshMyProfile() {
  if (!currentUser) return;
  try {
    const res = await fetch(`/api/whoami?username=${encodeURIComponent(currentUser)}`);
    if (res.ok) {
      const info = await res.json();
      isAdmin = Boolean(info.is_admin);
      isOwner = Boolean(info.is_owner);
      myAvatarUrl = info.avatar_url || null;
      if (myAvatarUrl) {
        avatarCache[currentUser.toLowerCase()] = myAvatarUrl;
      }
      syncAdminUi();
      syncMyAvatarUi();
    }
  } catch (e) {}
}

async function startSession(name) {
  currentUser = (name || "").trim();
  if (!currentUser) return;
  sessionStarted = true;
  localStorage.setItem("vortex_callsign", currentUser);
  myDisplayName.textContent = currentUser;
  syncMyAvatarUi();
  loginModal.classList.add("hidden");
  requestNotifyPermission();
  await refreshMyProfile();

  socket.emit("register_user", {
    username: currentUser,
    thread_id: activeThreadId,
    status: currentStatus,
  });
  flushOutbox();

  await loadThreads();
  const targetId = threads.some((t) => t.id === activeThreadId)
    ? activeThreadId
    : (threads[0] ? threads[0].id : 1);
  await selectThread(targetId);
}

if (currentUser) {
  startSession(currentUser);
}

joinBtn.addEventListener("click", () => {
  if (callsignInput.value.trim()) startSession(callsignInput.value);
});
callsignInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && callsignInput.value.trim()) startSession(callsignInput.value);
});

function setReplyTarget(target) {
  replyTarget = target;
  if (!target) {
    replyBar.classList.add("hidden");
    return;
  }
  replyTargetSender.textContent = target.sender;
  replyTargetSnippet.textContent = target.snippet;
  replyBar.classList.remove("hidden");
  messageInput.focus();
}

cancelReplyBtn.addEventListener("click", () => setReplyTarget(null));

function renderPinnedBanner(pinnedObj) {
  if (!pinnedObj) {
    pinnedBanner.classList.add("hidden");
    pinnedText.textContent = "";
    return;
  }
  const cleanBody = (pinnedObj.body || "").replace(/<[^>]*>/g, "") || "[Media]";
  pinnedText.textContent = `${pinnedObj.sender}: ${cleanBody}`;
  pinnedBanner.dataset.msgId = pinnedObj.id;
  pinnedBanner.classList.remove("hidden");
}

unpinBtn.addEventListener("click", () => {
  const msgId = parseInt(pinnedBanner.dataset.msgId || "0", 10);
  if (msgId > 0) {
    socket.emit("toggle_pin", { message_id: msgId, thread_id: activeThreadId });
  }
});

async function loadThreads() {
  const res = await fetch("/api/threads");
  if (!res.ok) return;
  threads = await res.json();
  renderThreads(threadSearch.value);
}

function renderThreads(filter = "") {
  const q = (filter || "").toLowerCase();
  threadList.innerHTML = "";
  threads
    .filter((t) => t.name.toLowerCase().includes(q))
    .forEach((t) => {
      const unread = unreadCounts[t.id] || 0;
      const lockIcon = t.is_locked ? "🔒 " : "";
      const div = document.createElement("div");
      div.className = `thread-item ${t.id === activeThreadId ? "active" : ""}`;
      div.dataset.id = t.id;
      div.innerHTML = `
        <div class="avatar">${initials(t.name)}</div>
        <div class="thread-meta">
          <div class="thread-top">
            <span class="thread-name">${lockIcon}${escapeHtml(t.name)}</span>
            <span class="thread-time">${formatLocalTime(t.last_time_iso, t.last_time || "")}</span>
          </div>
          <div class="thread-bottom">
            <span class="thread-preview">${escapeHtml(t.preview || "")}</span>
            ${unread > 0 ? `<span class="unread-badge">${unread}</span>` : ""}
          </div>
        </div>
      `;
      div.addEventListener("click", () => selectThread(t.id));
      threadList.appendChild(div);
    });
}

threadSearch.addEventListener("input", (e) => renderThreads(e.target.value));

async function openDmWith(targetUser) {
  if (!currentUser || targetUser === currentUser) return;
  const res = await fetch("/api/dm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_a: currentUser, user_b: targetUser }),
  });
  const dm = await res.json();
  if (dm.id) {
    await loadThreads();
    selectThread(dm.id);
  }
}

async function selectThread(threadId) {
  activeThreadId = Number(threadId);
  unreadCounts[activeThreadId] = 0;
  setReplyTarget(null);

  if (!threads.length) {
    await loadThreads();
  }

  const thread = threads.find((t) => Number(t.id) === activeThreadId) || { name: "Team Convoy (Main)" };
  activeThreadName.textContent = (thread.is_locked ? "🔒 " : "") + thread.name;
  infoThreadTitle.textContent = thread.name;
  activeThreadAvatar.textContent = initials(thread.name);
  infoAvatar.textContent = initials(thread.name);

  document.getElementById("sidebar").classList.add("hidden-mobile");
  renderThreads(threadSearch.value);

  socket.emit("join_thread", {
    username: currentUser || "Spotter",
    thread_id: activeThreadId,
    status: currentStatus,
  });

  const res = await fetch(`/api/threads/${activeThreadId}/messages`);
  if (!res.ok) return;
  const data = await res.json();
  lockedBanner.classList.toggle("hidden", !data.is_locked);
  renderPinnedBanner(data.pinned || null);

  seenMap = {};
  (data.seen_by || []).forEach((s) => {
    seenMap[s.username] = s.last_message_id;
  });

  messageFeed.innerHTML = "";
  (data.messages || []).forEach(appendMessage);
  updateSeenIndicator();

  if (data.messages && data.messages.length > 0 && currentUser) {
    const lastId = data.messages[data.messages.length - 1].id;
    socket.emit("mark_seen", {
      thread_id: activeThreadId,
      username: currentUser,
      last_message_id: lastId,
    });
  }
}

function renderReactionsHtml(reactions = []) {
  if (!reactions.length) return "";
  return reactions
    .map((r) => {
      const reacted = (r.users || []).includes(currentUser) ? "reacted" : "";
      return `<button type="button" class="react-pill ${reacted}" data-emoji="${r.emoji}" title="${escapeHtml((r.users || []).join(", "))}">${r.emoji} <span>${r.count}</span></button>`;
    })
    .join("");
}

function buildBubbleInnerHtml(msg) {
  const quoteHtml = msg.reply_preview
    ? `<div class="quote-box">${escapeHtml(msg.reply_preview)}</div>`
    : "";

  let contentHtml = "";
  if (msg.msg_type === "image" && msg.media_url) {
    if (fieldLiteMode) {
      contentHtml = `${msg.body ? `<div>${escapeHtml(msg.body)}</div>` : ""}<button type="button" class="lite-media-btn" data-media-type="image" data-url="${msg.media_url}">📶 Tap to load compressed photo</button>`;
    } else {
      contentHtml = `${msg.body ? `<div>${escapeHtml(msg.body)}</div>` : ""}<img src="${msg.media_url}" alt="Field upload" />`;
    }
  } else if (msg.msg_type === "audio" && msg.media_url) {
    if (fieldLiteMode) {
      contentHtml = `<div>${escapeHtml(msg.body || "🎙️ Voice Memo")}</div><button type="button" class="lite-media-btn" data-media-type="audio" data-url="${msg.media_url}">📶 Tap to load voice memo</button>`;
    } else {
      contentHtml = `<div>${escapeHtml(msg.body || "🎙️ Voice Memo")}</div><audio controls preload="none" src="${msg.media_url}"></audio>`;
    }
  } else if (msg.msg_type === "location") {
    contentHtml = msg.body;
  } else {
    contentHtml = escapeHtml(msg.body);
  }
  return `${quoteHtml}${contentHtml}`;
}

function bindRowActions(row, msg) {
  row.querySelectorAll(".lite-media-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const url = btn.dataset.url;
      if (btn.dataset.mediaType === "image") {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "Field upload";
        btn.replaceWith(img);
      } else {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = url;
        btn.replaceWith(audio);
      }
    });
  });

  row.querySelectorAll(".react-choice, .react-pill").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      socket.emit("toggle_reaction", {
        message_id: msg.id,
        thread_id: activeThreadId,
        username: currentUser,
        emoji: btn.dataset.emoji,
      });
    });
  });

  const replyBtn = row.querySelector(".reply-msg-btn");
  if (replyBtn) {
    replyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const snippet = (msg.body || "").replace(/<[^>]*>/g, "") || "[Media]";
      setReplyTarget({
        id: msg.id,
        sender: msg.sender,
        snippet: snippet.slice(0, 80),
      });
    });
  }

  const editBtn = row.querySelector(".edit-msg-btn");
  if (editBtn) {
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const updated = window.prompt("Edit message:", msg.body || "");
      if (updated && updated.trim() && updated.trim() !== msg.body) {
        socket.emit("edit_message", {
          message_id: msg.id,
          thread_id: activeThreadId,
          username: currentUser,
          body: updated.trim(),
        });
      }
    });
  }

  const pinBtn = row.querySelector(".pin-msg-btn");
  if (pinBtn) {
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      socket.emit("toggle_pin", {
        message_id: msg.id,
        thread_id: activeThreadId,
      });
    });
  }

  const delBtn = row.querySelector(".delete-msg-btn");
  if (delBtn) {
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      socket.emit("delete_message", {
        message_id: msg.id,
        thread_id: activeThreadId,
        username: currentUser,
      });
    });
  }
}

function appendMessage(msg) {
  if (!msg || !msg.id) return;
  if (messageFeed.querySelector(`.msg-row[data-msg-id="${msg.id}"]`)) return;

  if (msg.sender_avatar && msg.sender) {
    avatarCache[msg.sender.toLowerCase()] = msg.sender_avatar;
  }

  const mine = msg.sender === currentUser;
  const row = document.createElement("div");
  row.className = `msg-row ${mine ? "mine" : "theirs"}`;
  row.dataset.msgId = msg.id;

  let bubbleClass = "bubble";
  if (msg.msg_type === "alert") bubbleClass += " alert-bubble";
  if (msg.msg_type === "nws") bubbleClass += " nws-bubble";
  if (msg.msg_type === "report") bubbleClass += " report-bubble";
  if (msg.msg_type === "location") bubbleClass += " location-bubble";

  const pickerButtons = REACTION_EMOJIS
    .map((em) => `<button type="button" class="react-choice" data-emoji="${em}">${em}</button>`)
    .join("");

  const pinLabel = msg.is_pinned ? "Unpin" : "Pin";
  const editedHtml = msg.edited_at ? `<span class="edited-tag">edited</span>` : "";
  const editBtnHtml = (mine && !["location", "nws", "audio"].includes(msg.msg_type))
    ? `<button type="button" class="action-link-btn edit-msg-btn">Edit</button>`
    : "";
  const canDelete = mine || isAdmin;
  const deleteBtnHtml = canDelete
    ? `<button type="button" class="action-link-btn delete-msg-btn">Delete</button>`
    : "";

  const senderHeaderHtml = !mine
    ? `<div class="msg-sender-row">
         <span class="avatar mini-avatar">${renderAvatarContent(msg.sender, msg.sender_avatar)}</span>
         <span class="msg-sender">${escapeHtml(msg.sender)}</span>
       </div>`
    : "";

  row.innerHTML = `
    ${senderHeaderHtml}
    <div class="${bubbleClass}">${buildBubbleInnerHtml(msg)}</div>
    <div class="reaction-pills">${renderReactionsHtml(msg.reactions)}</div>
    <div class="reaction-picker">${pickerButtons}</div>
    <div class="msg-meta">
      <span>${formatLocalTime(msg.created_at_iso, msg.timestamp || "")}</span>
      ${editedHtml}
      <button type="button" class="action-link-btn reply-msg-btn">Reply</button>
      ${editBtnHtml}
      <button type="button" class="action-link-btn pin-msg-btn">${pinLabel}</button>
      ${deleteBtnHtml}
    </div>
  `;
  bindRowActions(row, msg);
  messageFeed.appendChild(row);
  messageFeed.scrollTop = messageFeed.scrollHeight;
}

function updateSeenIndicator() {
  const old = document.getElementById("seenLine");
  if (old) old.remove();

  const mineRows = messageFeed.querySelectorAll(".msg-row.mine");
  if (!mineRows.length) return;
  const lastMine = mineRows[mineRows.length - 1];
  const lastMineId = parseInt(lastMine.dataset.msgId, 10);
  if (!lastMineId) return;

  const viewers = Object.entries(seenMap)
    .filter(([user, id]) => user !== currentUser && id >= lastMineId)
    .map(([user]) => user);

  if (viewers.length > 0) {
    const seenEl = document.createElement("div");
    seenEl.id = "seenLine";
    seenEl.className = "seen-line";
    seenEl.textContent = `Seen by ${viewers.join(", ")}`;
    messageFeed.appendChild(seenEl);
    messageFeed.scrollTop = messageFeed.scrollHeight;
  }
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

messageInput.addEventListener("focus", () => {
  setTimeout(() => {
    messageFeed.scrollTop = messageFeed.scrollHeight;
  }, 250);
});

composerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const body = messageInput.value.trim();
  if (!body) return;
  if (!currentUser) {
    loginModal.classList.remove("hidden");
    return;
  }

  const payload = {
    thread_id: activeThreadId,
    sender: currentUser,
    body,
    msg_type: alertMode ? "alert" : "text",
    reply_to_id: replyTarget ? replyTarget.id : null,
    reply_preview: replyTarget ? `${replyTarget.sender}: ${replyTarget.snippet}` : null,
  };

  dispatchMessage(payload);
  messageInput.value = "";
  setReplyTarget(null);
  stopTypingNow();
});

function stopTypingNow() {
  if (isTyping) {
    isTyping = false;
    socket.emit("typing", { thread_id: activeThreadId, sender: currentUser, is_typing: false });
  }
}

messageInput.addEventListener("input", () => {
  if (!currentUser) return;
  if (!isTyping) {
    isTyping = true;
    socket.emit("typing", { thread_id: activeThreadId, sender: currentUser, is_typing: true });
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(stopTypingNow, 1500);
});

const alertModeBtn = document.getElementById("alertModeBtn");
alertModeBtn.addEventListener("click", () => {
  alertMode = !alertMode;
  alertModeBtn.classList.toggle("active-alert", alertMode);
  messageInput.placeholder = alertMode ? "PRIORITY ALERT MESSAGE..." : "Aa";
});

document.getElementById("shareGpsBtn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    alert("GPS not supported on this browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = Number(pos.coords.latitude.toFixed(5));
      const lon = Number(pos.coords.longitude.toFixed(5));
      const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
      dispatchMessage({
        thread_id: activeThreadId,
        sender: currentUser || "Spotter",
        body: `📍 Field Position: ${lat}, ${lon} — <a href="${mapsUrl}" target="_blank">Open Map</a>`,
        msg_type: "location",
        lat,
        lon,
      });
    },
    () => alert("Unable to read GPS location. Check browser location permissions.")
  );
});

const attachBtn = document.getElementById("attachBtn");
const imageInput = document.getElementById("imageInput");
attachBtn.addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", async () => {
  const rawFile = imageInput.files[0];
  if (!rawFile) return;

  const compressedFile = await compressImageFile(rawFile);
  const formData = new FormData();
  formData.append("file", compressedFile);

  const res = await fetch("/api/upload", { method: "POST", body: formData });
  const data = await res.json();
  if (data.url) {
    dispatchMessage({
      thread_id: activeThreadId,
      sender: currentUser || "Spotter",
      body: messageInput.value.trim(),
      msg_type: "image",
      media_url: data.url,
    });
    messageInput.value = "";
  }
  imageInput.value = "";
});

document.querySelectorAll(".quick-msg[data-msg]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!currentUser) return;
    dispatchMessage({
      thread_id: activeThreadId,
      sender: currentUser,
      body: btn.dataset.msg,
      msg_type: "text",
    });
  });
});

const newThreadModal = document.getElementById("newThreadModal");
document.getElementById("openNewThreadBtn").addEventListener("click", () => {
  newThreadModal.classList.remove("hidden");
});
document.getElementById("cancelThreadBtn").addEventListener("click", () => {
  newThreadModal.classList.add("hidden");
});
document.getElementById("createThreadBtn").addEventListener("click", async () => {
  const name = document.getElementById("newThreadName").value.trim();
  const is_group = document.getElementById("newThreadIsGroup").checked;
  if (!name) return;
  const res = await fetch("/api/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, is_group }),
  });
  const created = await res.json();
  document.getElementById("newThreadName").value = "";
  newThreadModal.classList.add("hidden");
  await loadThreads();
  selectThread(created.id);
});

document.getElementById("mobileBackBtn").addEventListener("click", () => {
  document.getElementById("sidebar").classList.remove("hidden-mobile");
});
document.getElementById("toggleInfoBtn").addEventListener("click", () => {
  document.getElementById("infoDrawer").classList.toggle("open-mobile");
});

document.addEventListener("click", (e) => {
  const drawer = document.getElementById("infoDrawer");
  const toggleBtn = document.getElementById("toggleInfoBtn");
  if (
    drawer.classList.contains("open-mobile") &&
    !drawer.contains(e.target) &&
    !toggleBtn.contains(e.target)
  ) {
    drawer.classList.remove("open-mobile");
  }
});

socket.on("disconnect", () => {
  offlineBanner.classList.remove("hidden");
});

socket.on("connect", () => {
  offlineBanner.classList.add("hidden");
  if (sessionStarted && currentUser) {
    socket.emit("register_user", {
      username: currentUser,
      thread_id: activeThreadId,
      status: currentStatus,
    });
    socket.emit("join_thread", {
      username: currentUser,
      thread_id: activeThreadId,
      status: currentStatus,
    });
    flushOutbox();
  }
});

socket.on("avatar_updated", (data) => {
  if (data && data.username && data.avatar_url) {
    avatarCache[data.username.toLowerCase()] = data.avatar_url;
    if (data.username.toLowerCase() === currentUser.toLowerCase()) {
      myAvatarUrl = data.avatar_url;
      syncMyAvatarUi();
    }
    selectThread(activeThreadId);
  }
});

socket.on("role_assigned", (data) => {
  if (data.username && data.username.toLowerCase() === currentUser.toLowerCase()) {
    isAdmin = Boolean(data.is_admin);
    isOwner = Boolean(data.is_owner);
    syncAdminUi();
    selectThread(activeThreadId);
  }
});

socket.on("system_notice", (data) => {
  if (data && data.message) alert(data.message);
});

socket.on("thread_lock_updated", (data) => {
  const t = threads.find((item) => Number(item.id) === Number(data.thread_id));
  if (t) {
    t.is_locked = Boolean(data.is_locked);
    renderThreads(threadSearch.value);
  }
  if (Number(data.thread_id) === Number(activeThreadId)) {
    lockedBanner.classList.toggle("hidden", !data.is_locked);
    activeThreadName.textContent = (data.is_locked ? "🔒 " : "") + (t ? t.name : activeThreadName.textContent.replace(/^🔒\s*/, ""));
  }
});

socket.on("new_message", (msg) => {
  if (Number(msg.thread_id) === Number(activeThreadId)) {
    appendMessage(msg);
    if (msg.sender !== currentUser) {
      playPing();
      maybeNotifyAlert(msg);
      socket.emit("mark_seen", {
        thread_id: activeThreadId,
        username: currentUser,
        last_message_id: msg.id,
      });
    }
    updateSeenIndicator();
  } else if (msg.sender !== currentUser) {
    unreadCounts[msg.thread_id] = (unreadCounts[msg.thread_id] || 0) + 1;
    playPing();
    maybeNotifyAlert(msg);
    renderThreads(threadSearch.value);
  }
});

socket.on("message_edited", (msg) => {
  if (Number(msg.thread_id) !== Number(activeThreadId)) return;
  const row = messageFeed.querySelector(`.msg-row[data-msg-id="${msg.id}"]`);
  if (!row) return;
  const bubble = row.querySelector(".bubble");
  if (bubble) bubble.innerHTML = buildBubbleInnerHtml(msg);
  const meta = row.querySelector(".msg-meta");
  if (meta && msg.edited_at && !meta.querySelector(".edited-tag")) {
    const firstSpan = meta.querySelector("span");
    if (firstSpan) {
      const ed = document.createElement("span");
      ed.className = "edited-tag";
      ed.textContent = "edited";
      firstSpan.insertAdjacentElement("afterend", ed);
    }
  }
  bindRowActions(row, msg);
});

socket.on("pin_updated", (data) => {
  if (Number(data.thread_id) !== Number(activeThreadId)) return;
  renderPinnedBanner(data.pinned || null);
  messageFeed.querySelectorAll(".msg-row").forEach((row) => {
    const pinBtn = row.querySelector(".pin-msg-btn");
    if (!pinBtn) return;
    const isThisPinned = data.pinned_id && parseInt(row.dataset.msgId, 10) === data.pinned_id;
    pinBtn.textContent = isThisPinned ? "Unpin" : "Pin";
  });
});

socket.on("message_deleted", (data) => {
  if (Number(data.thread_id) === Number(activeThreadId)) {
    const row = messageFeed.querySelector(`.msg-row[data-msg-id="${data.message_id}"]`);
    if (row) row.remove();
    if (data.was_pinned) {
      renderPinnedBanner(null);
    }
    updateSeenIndicator();
  }
});

socket.on("thread_preview_after_delete", (data) => {
  const t = threads.find((item) => Number(item.id) === Number(data.thread_id));
  if (t) {
    t.preview = data.preview;
    t.last_time = data.last_time;
    renderThreads(threadSearch.value);
  }
});

socket.on("reaction_updated", (data) => {
  if (Number(data.thread_id) !== Number(activeThreadId)) return;
  const row = messageFeed.querySelector(`.msg-row[data-msg-id="${data.message_id}"]`);
  if (!row) return;
  const pillsBox = row.querySelector(".reaction-pills");
  pillsBox.innerHTML = renderReactionsHtml(data.reactions);
  bindRowActions(row, { id: data.message_id });
});

socket.on("thread_preview_update", (msg) => {
  const t = threads.find((item) => Number(item.id) === Number(msg.thread_id));
  if (t) {
    t.preview = msg.msg_type === "image"
      ? `${msg.sender}: [Photo]`
      : msg.msg_type === "audio"
        ? `${msg.sender}: 🎙️ Voice Memo`
        : `${msg.sender}: ${(msg.body || "").replace(/<[^>]*>/g, "")}`;
    t.last_time = formatLocalTime(msg.created_at_iso, msg.timestamp || "");
    renderThreads(threadSearch.value);
  }
});

socket.on("thread_created", (t) => {
  if (!threads.some((item) => Number(item.id) === Number(t.id))) {
    threads.push(t);
    renderThreads(threadSearch.value);
  }
});

socket.on("typing_status", (data) => {
  if (Number(data.thread_id) !== Number(activeThreadId)) return;
  if (data.is_typing) {
    typingText.textContent = `${data.sender} is typing...`;
    typingBar.classList.remove("hidden");
  } else {
    typingBar.classList.add("hidden");
  }
});

socket.on("seen_update", (data) => {
  if (Number(data.thread_id) !== Number(activeThreadId)) return;
  seenMap[data.username] = data.last_message_id;
  updateSeenIndicator();
});

socket.on("presence_update", (data) => {
  const users = data.online_users || [];
  onlineCount.textContent = users.length;

  users.forEach((u) => {
    if (u && u.username && u.avatar_url) {
      avatarCache[u.username.toLowerCase()] = u.avatar_url;
    }
  });

  onlineStrip.innerHTML = users
    .map((u) => {
      const name = typeof u === "string" ? u : u.username;
      const st = typeof u === "string" ? "En Route" : (u.status || "En Route");
      const avUrl = u.avatar_url || avatarCache[name.toLowerCase()] || null;
      const overdue = Boolean(u.overdue);
      const canDm = name !== currentUser;
      return `<div class="online-chip ${overdue ? "overdue" : ""}" style="cursor:${canDm ? "pointer" : "default"}" data-dm-user="${canDm ? escapeHtml(name) : ""}"><div class="avatar">${renderAvatarContent(name, avUrl)}</div><span>${escapeHtml(name.split(" ")[0])}</span><span class="chip-status">${overdue ? "⚠️ OVERDUE" : escapeHtml(st)}</span></div>`;
    })
    .join("");

  onlineStrip.querySelectorAll("[data-dm-user]").forEach((el) => {
    if (el.dataset.dmUser) {
      el.addEventListener("click", () => openDmWith(el.dataset.dmUser));
    }
  });

  onlineRoster.innerHTML = users
    .map((u) => {
      const name = typeof u === "string" ? u : u.username;
      const st = typeof u === "string" ? "En Route" : (u.status || "En Route");
      const avUrl = u.avatar_url || avatarCache[name.toLowerCase()] || null;
      const overdue = Boolean(u.overdue);
      const userIsAdmin = Boolean(u.is_admin);
      const userIsOwner = Boolean(u.is_owner);
      const localCi = formatLocalTime(u.last_checkin_iso, u.last_checkin || "");
      const ciTime = localCi ? ` • Check-in ${localCi}` : "";
      const roleTag = userIsOwner
        ? `<span class="roster-role-badge">OWNER</span>`
        : userIsAdmin
          ? `<span class="roster-role-badge">ADMIN</span>`
          : "";

      const dmBtn = name !== currentUser
        ? `<button type="button" class="roster-mini-btn roster-dm-btn" data-user="${escapeHtml(name)}">DM</button>`
        : "";

      const promoteBtn = (isAdmin && name !== currentUser && !userIsOwner)
        ? `<button type="button" class="roster-mini-btn roster-admin-btn" data-target="${escapeHtml(name)}" data-make-admin="${userIsAdmin ? "0" : "1"}">${userIsAdmin ? "Remove Admin" : "Make Admin"}</button>`
        : "";

      const tagText = overdue ? `⚠️ OVERDUE (${u.mins_since_checkin}m ago)` : `${st}${ciTime}`;
      return `<li class="roster-item">
        <div class="roster-row-top">
          <span class="avatar mini-avatar">${renderAvatarContent(name, avUrl)}</span>
          <span class="dot-online"></span>
          <span>${escapeHtml(name)}</span>
          ${roleTag}
        </div>
        <span class="roster-status-tag ${overdue ? "overdue-tag" : ""}">${escapeHtml(tagText)}</span>
        ${(dmBtn || promoteBtn) ? `<div class="roster-actions-row">${dmBtn}${promoteBtn}</div>` : ""}
      </li>`;
    })
    .join("");

  onlineRoster.querySelectorAll(".roster-dm-btn").forEach((btn) => {
    btn.addEventListener("click", () => openDmWith(btn.dataset.user));
  });

  onlineRoster.querySelectorAll(".roster-admin-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      socket.emit("set_user_admin", {
        target_user: btn.dataset.target,
        make_admin: btn.dataset.makeAdmin === "1",
      });
    });
  });
});
