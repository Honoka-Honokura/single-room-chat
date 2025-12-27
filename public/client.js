/* =========================
   client.js  (multi-room)
   - /r/:slug をURLから取得
   - join / log / poll を roomSlug 付きで扱う（join以外は不要）
   - lastSeenId / seenIds を部屋ごとに分離
========================= */

// ★ 二重起動ガード
if (window.__LVCHAT_CLIENT_LOADED__) {
  console.warn("client.js already initialized. Skip.");
} else {
  window.__LVCHAT_CLIENT_LOADED__ = true;
}

// =========================
// ★ 現在の部屋slugをURLから取得
//   /r/main なら "main"
// =========================
function getRoomSlugFromPath() {
  const m = location.pathname.match(/^\/r\/([^\/?#]+)/);
  if (!m) return "main";
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}
const roomSlug = getRoomSlugFromPath();

// =========================
// ★ ブラウザごとのクライアントID
// =========================
let clientId = localStorage.getItem("chatClientId");
if (!clientId) {
  clientId = "c-" + Math.random().toString(36).slice(2);
  localStorage.setItem("chatClientId", clientId);
}

/* ユーザーごとの色決定 ------------------ */
function hashStringToNumber(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
function getColorForName(name) {
  const colors = [
    "#FFEBEE", "#FFF3E0", "#FFFDE7", "#E8F5E9",
    "#E3F2FD", "#F3E5F5", "#E0F7FA", "#FBE9E7"
  ];
  if (!name) return "#FFFFFF";
  const num = hashStringToNumber(name);
  const index = num % colors.length;
  return colors[index];
}
function darkenColor(hex, amount = 0.35) {
  const num = parseInt(hex.replace("#", ""), 16);
  let r = (num >> 16) & 255;
  let g = (num >> 8) & 255;
  let b = num & 255;

  r = Math.floor(r * (1 - amount));
  g = Math.floor(g * (1 - amount));
  b = Math.floor(b * (1 - amount));

  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b)
    .toString(16)
    .slice(1);
}

/* 要素取得 ------------------------------ */
const socket = io({
  transports: ["websocket", "polling"],
  timeout: 20000,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 800,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.3
});

const nameInput = document.getElementById("nameInput");
const joinBtn = document.getElementById("joinBtn");
const renameBtn = document.getElementById("renameBtn");
const leaveBtn = document.getElementById("leaveBtn");
const openColorChangeBtn = document.getElementById("openColorChangeBtn");
const msgInput = document.getElementById("msgInput");
const sendBtn = document.getElementById("sendBtn");
const chatLog = document.getElementById("chatLog");
const userListDiv = document.getElementById("userList");
const typingInfo = document.getElementById("typingInfo");
const statusText = document.getElementById("statusText");
const joinRow = document.getElementById("joinRow");
const afterJoinControls = document.querySelector(".after-join-controls");
const inputRow = document.querySelector(".input-row");
const infoBeforeJoin = document.getElementById("chatInfoBeforeJoin");
const preLoginNotice = document.getElementById("preLoginNotice");
const templateButtons = document.querySelectorAll(".template-btn");

const roll1d6Btn = document.getElementById("roll1d6Btn");
const roll2d6Btn = document.getElementById("roll2d6Btn");
const topicRouletteBtn = document.getElementById("topicRouletteBtn");

const mobileMenuBtn = document.getElementById("mobileMenuBtn");
const mobileMenu = document.getElementById("mobileMenu");
const mobileMenuUserListBtn = document.getElementById("mobileMenuUserListBtn");
const mobileMenuChangeNameBtn = document.getElementById("mobileMenuChangeNameBtn");
const mobileMenuLeaveBtn = document.getElementById("mobileMenuLeaveBtn");
const mobileMenuColorBtn = document.getElementById("mobileMenuColorBtn");

const footer = document.querySelector(".footer");
const colorRow = document.querySelector(".color-row");
const colorChangeArea = document.getElementById("colorChangeArea");
const colorChangeWrapper = document.getElementById("colorChangeWrapper");

const mobileUserOverlay = document.getElementById("mobileUserOverlay");
const mobileUserClose = document.getElementById("mobileUserClose");
const mobileUserList = document.getElementById("mobileUserList");

// 吹き出し色のラジオボタン
const colorInputs = document.querySelectorAll('input[name="bubbleColor"]');

// ★ 性別（入室前に選択）
function getSelectedGender() {
  const el = document.querySelector('input[name="gender"]:checked');
  return el ? el.value : "";
}

/* 状態 ------------------------------ */
let joined = false;
let mySocketId = null;
let typingTimeout = null;
let isTyping = false;

let shouldAutoJoin = false;
let lastKnownName = "";
let lastKnownGender = "";
let lastKnownColor = null;

// 現在色（入室前も保持）
let currentColor = (() => {
  const checked = document.querySelector('input[name="bubbleColor"]:checked');
  return checked ? checked.value : null;
})();
let pendingColor = null;

/* =========================
   ✅ 部屋ごとに lastSeenId を分離
========================= */
const LS_LAST_SEEN_ID_KEY = `lvchat_lastSeenId:${roomSlug}`;

let lastSeenId = Number(localStorage.getItem(LS_LAST_SEEN_ID_KEY) || 0);
if (!Number.isFinite(lastSeenId) || lastSeenId < 0) lastSeenId = 0;

const seenIds = new Set();
let pollRunning = false;
let pollAbort = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function rememberSeen(id) {
  if (!id || !Number.isFinite(id)) return;
  seenIds.add(id);

  if (id > lastSeenId) {
    lastSeenId = id;
    localStorage.setItem(LS_LAST_SEEN_ID_KEY, String(lastSeenId));
  }

  if (seenIds.size > 300) {
    const arr = Array.from(seenIds).sort((a,b)=>a-b);
    const keep = arr.slice(-200);
    seenIds.clear();
    for (const x of keep) seenIds.add(x);
  }
}

async function fetchJson(url, opts) {
  const res = await fetch(url, { cache: "no-store", ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function clearChatDom() {
  chatLog.innerHTML = "";
}
function trimChatDom() {
  const max = 50;
  while (chatLog.children.length > max) {
    chatLog.removeChild(chatLog.firstElementChild);
  }
}
function scrollBottom() {
  chatLog.scrollTop = chatLog.scrollHeight;
}

/* 表示（共通） ------------------------------ */
function renderSystem(item) {
  const div = document.createElement("div");
  div.className = "system-message";
  div.textContent = `[${item.time}] ${item.text}`;
  chatLog.append(div);
}

function renderTopic(item) {
  const wrapper = document.createElement("div");
  wrapper.className = "system-message topic-message";

  const header = document.createElement("div");
  header.className = "topic-header";
  header.innerHTML = `
    <span class="topic-label">お仕置きガチャ</span>
    <span class="topic-meta">[${item.time}] ${item.name}さんが引きました</span>
  `;

  const body = document.createElement("div");
  body.className = "topic-body";
  body.textContent = item.topic;

  wrapper.appendChild(header);
  wrapper.appendChild(body);

  chatLog.append(wrapper);
}

function renderChatLike(item, isSelf = false) {
  const row = document.createElement("div");
  row.className = "message-row " + (isSelf ? "self" : "other");

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = `[${item.time}] ${item.name}`;

  const msgDiv = document.createElement("div");
  msgDiv.className = "message " + (isSelf ? "message-self" : "message-other");
  msgDiv.textContent = item.text;

  const userColor = item.color || getColorForName(item.name);
  msgDiv.style.backgroundColor = userColor;
  msgDiv.style.setProperty("--bubble-color", userColor);
  meta.style.color = darkenColor(userColor, 0.35);

  row.appendChild(meta);
  row.appendChild(msgDiv);
  chatLog.append(row);
}

function renderLogItem(item, fromSocket = false) {
  if (item.id) {
    if (seenIds.has(item.id)) return;
    rememberSeen(item.id);
  }

  if (item.type === "system") {
    renderSystem(item);
  } else if (item.type === "topic") {
    renderTopic(item);
  } else {
    const isSelf = fromSocket && item.fromId && (item.fromId === mySocketId);
    renderChatLike(item, isSelf);
  }

  trimChatDom();
  scrollBottom();
}

/* ログ同期（初回/復帰用） ------------------------------ */
async function syncFullLog() {
  const data = await fetchJson(`/api/log?room=${encodeURIComponent(roomSlug)}`);
  const messages = Array.isArray(data.messages) ? data.messages : [];

  if (!joined) {
    for (const m of messages) {
      if (m.id) rememberSeen(m.id);
    }
    return;
  }

  clearChatDom();
  seenIds.clear();

  for (const m of messages) {
    renderLogItem(m, false);
  }
}

/* ロングポーリング開始/停止 ------------------------------ */
async function startPollLoop() {
  if (pollRunning) return;
  pollRunning = true;
  pollAbort = new AbortController();

  while (pollRunning) {
    try {
      if (!joined) {
        await sleep(1000);
        continue;
      }

      const url = `/api/poll?room=${encodeURIComponent(roomSlug)}&since=${lastSeenId}`;
      const data = await fetchJson(url, { signal: pollAbort.signal });

      const messages = Array.isArray(data.messages) ? data.messages : [];
      for (const m of messages) {
        renderLogItem(m, false);
      }

      if (messages.length === 0) {
        await sleep(150);
      }
    } catch (e) {
      await sleep(1000);
    }
  }
}

function stopPollLoop() {
  pollRunning = false;
  if (pollAbort) {
    try { pollAbort.abort(); } catch {}
  }
  pollAbort = null;
}

/* 吹き出し色変更UI ------------------------------ */
function closeColorChangeUI() {
  colorChangeArea.style.display = "none";
  footer.insertBefore(colorRow, inputRow);
  if (joined) colorRow.style.display = "none";
  colorChangeWrapper.innerHTML = "";
}
function applyColorChange() {
  if (!joined) return;

  const selected = document.querySelector('input[name="bubbleColor"]:checked');
  const newColor = selected ? selected.value : pendingColor || currentColor;
  if (!newColor) return;

  currentColor = newColor;
  lastKnownColor = newColor;

  // ✅ 入室後は roomSlug 不要
  socket.emit("change-color", newColor);

  closeColorChangeUI();
}
function cancelColorChange() {
  pendingColor = null;
  closeColorChangeUI();
}

/* UIユーティリティ ------------------------------ */
function setTyping(flag) {
  if (isTyping === flag) return;
  isTyping = flag;

  // ✅ booleanだけ送る
  socket.emit("typing", flag);
}

function closeMobileMenu() {
  if (mobileMenu && mobileMenuBtn) {
    mobileMenu.classList.remove("open");
    mobileMenuBtn.classList.remove("open");
    mobileMenuBtn.setAttribute("aria-expanded", "false");
  }
}

/* ====== イベント：スマホメニュー ====== */
if (mobileMenuBtn && mobileMenu) {
  mobileMenuBtn.addEventListener("click", () => {
    const isOpen = mobileMenu.classList.toggle("open");
    mobileMenuBtn.classList.toggle("open", isOpen);
    mobileMenuBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });
}
if (mobileMenuUserListBtn && mobileUserOverlay) {
  mobileMenuUserListBtn.addEventListener("click", () => {
    mobileUserOverlay.style.display = "flex";
    closeMobileMenu();
  });
}
if (mobileMenuChangeNameBtn && renameBtn) {
  mobileMenuChangeNameBtn.addEventListener("click", () => {
    renameBtn.click();
    closeMobileMenu();
  });
}
if (mobileMenuColorBtn && openColorChangeBtn) {
  mobileMenuColorBtn.addEventListener("click", () => {
    openColorChangeBtn.click();
    closeMobileMenu();
  });
}
if (mobileMenuLeaveBtn && leaveBtn) {
  mobileMenuLeaveBtn.addEventListener("click", () => {
    leaveBtn.click();
    closeMobileMenu();
  });
}

if (mobileUserClose && mobileUserOverlay) {
  mobileUserClose.addEventListener("click", () => {
    mobileUserOverlay.style.display = "none";
  });
}
if (mobileUserOverlay) {
  mobileUserOverlay.addEventListener("click", (e) => {
    if (e.target === mobileUserOverlay) {
      mobileUserOverlay.style.display = "none";
    }
  });
}

/* ====== 色ラジオの挙動 ====== */
colorInputs.forEach(input => {
  input.addEventListener("change", () => {
    const val = input.value;
    if (!joined) {
      currentColor = val;
      lastKnownColor = currentColor;
    } else {
      pendingColor = val;
    }
  });
});

/* ====== Socket.io：接続系 ====== */
socket.on("connect", async () => {
  mySocketId = socket.id;
  statusText.textContent = joined ? "接続中" : "未入室";

  try { await syncFullLog(); } catch {}

  if (joined && shouldAutoJoin) {
    const fallbackName = nameInput.value.trim() || "";
    const sendName = lastKnownName || fallbackName;
    const sendColor = lastKnownColor || currentColor || null;
    const sendGender = lastKnownGender || getSelectedGender() || "";

    socket.emit("join", {
      roomSlug,
      name: sendName,
      color: sendColor,
      clientId,
      gender: sendGender
    });
  }
});

socket.on("disconnect", () => {
  statusText.textContent = joined ? "切断中…（復帰中）" : "未入室";
});

socket.on("room-full", () => {
  alert("この部屋は満員です（10人まで）");
});

/* ====== Socket.io：受信 ====== */
socket.on("chat-message", (payload) => {
  renderLogItem(payload, true);
});

socket.on("system-message", (payload) => {
  if (!joined) return;

  if (payload && payload.id) {
    renderLogItem({
      id: payload.id,
      type: "system",
      time: payload.time,
      text: payload.text,
      color: null
    }, true);
    return;
  }

  renderSystem({ time: payload.time, text: payload.text });
  trimChatDom();
  scrollBottom();
});

socket.on("rate-limit", ({ waitMs }) => {
  const sec = Math.ceil(waitMs / 1000);
  typingInfo.textContent = `送信間隔が短すぎます。あと ${sec} 秒待ってください。`;

  setTimeout(() => {
    if (typingInfo.textContent.startsWith("送信間隔が短すぎます")) {
      typingInfo.textContent = "";
    }
  }, 2000);
});

socket.on("user-list", (names) => {
  if (!Array.isArray(names) || names.length === 0) {
    userListDiv.textContent = "誰もいません";
    statusText.textContent = joined ? "オンライン: 0 / 10" : "未入室";
    if (mobileUserList) mobileUserList.textContent = "誰もいません";
    return;
  }

  userListDiv.innerHTML = names.map(n => `・${n}`).join("<br>");

  if (joined) {
    statusText.textContent = `オンライン: ${names.length} / 10`;
  } else {
    statusText.textContent = `未入室（オンライン: ${names.length} / 10）`;
  }

  if (mobileUserList) {
    mobileUserList.innerHTML = names.map(n => `・${n}`).join("<br>");
  }
});

socket.on("typing-users", (names) => {
  if (!names || names.length === 0) {
    typingInfo.textContent = "";
    return;
  }
  const text = (names.length === 1)
    ? `${names[0]}さんが入力中…`
    : `${names.join("さん、")}さんが入力中…`;
  typingInfo.textContent = text;
});

socket.on("force-leave", () => {
  if (!joined) return;

  joined = false;
  document.body.classList.remove("joined");

  shouldAutoJoin = false;
  lastKnownName = "";
  lastKnownGender = "";
  lastKnownColor = null;

  inputRow.style.display = "none";

  joinRow.style.display = "flex";
  joinBtn.disabled = false;
  joinBtn.style.display = "inline-block";

  renameBtn.disabled = true;
  leaveBtn.disabled = true;
  openColorChangeBtn.disabled = true;
  afterJoinControls.style.display = "none";

  msgInput.disabled = true;
  sendBtn.disabled = true;

  document.querySelector(".template-row").style.display = "none";
  templateButtons.forEach(btn => btn.disabled = true);

  if (roll1d6Btn) roll1d6Btn.disabled = true;
  if (roll2d6Btn) roll2d6Btn.disabled = true;
  if (topicRouletteBtn) topicRouletteBtn.disabled = true;

  if (infoBeforeJoin) infoBeforeJoin.style.display = "block";
  if (preLoginNotice) preLoginNotice.style.display = "block";
  chatLog.style.display = "none";
  chatLog.innerHTML = "";

  typingInfo.textContent = "";
  statusText.textContent = "未入室";

  pendingColor = null;
  colorChangeArea.style.display = "none";
  if (footer && colorRow && inputRow) {
    footer.insertBefore(colorRow, inputRow);
    colorRow.style.display = "flex";
  }

  alert("10分間操作がなかったため、自動的に退室しました。");
});

/* ====== 入室・退室・入力 ====== */
joinBtn.addEventListener("click", async () => {
  if (joined) return;

  const name = nameInput.value.trim() || "";

  const gender = getSelectedGender();
  if (!gender) {
    alert("性別（男性/女性）を選択してください。");
    return;
  }

  const checked = document.querySelector('input[name="bubbleColor"]:checked');
  currentColor = checked ? checked.value : currentColor;
  const color = currentColor;

  // ✅ joinだけ roomSlug を送る
  socket.emit("join", { roomSlug, name, color, clientId, gender });

  shouldAutoJoin = true;
  if (name) lastKnownName = name;
  lastKnownGender = gender;
  lastKnownColor = color;

  joined = true;

  inputRow.style.display = "flex";
  if (colorRow) colorRow.style.display = "none";

  document.body.classList.add("joined");
  joinRow.style.display = "none";
  joinBtn.disabled = true;
  joinBtn.style.display = "none";

  renameBtn.disabled = false;
  leaveBtn.disabled = false;
  openColorChangeBtn.disabled = false;
  afterJoinControls.style.display = "flex";

  msgInput.disabled = false;
  sendBtn.disabled = false;

  if (roll1d6Btn) roll1d6Btn.disabled = false;
  if (roll2d6Btn) roll2d6Btn.disabled = false;
  if (topicRouletteBtn) topicRouletteBtn.disabled = false;

  document.querySelector(".template-row").style.display = "flex";
  templateButtons.forEach(btn => btn.disabled = false);

  if (infoBeforeJoin) infoBeforeJoin.style.display = "none";
  if (preLoginNotice) preLoginNotice.style.display = "none";
  chatLog.style.display = "block";

  if (!name) nameInput.placeholder = "名前はあとから変更できます";

  try { await syncFullLog(); } catch {}
});

nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});

renameBtn.addEventListener("click", () => {
  const current = nameInput.value.trim() || "";
  const newName = prompt("新しい名前を入力してください", current);
  if (!newName) return;

  const trimmed = newName.trim();
  if (!trimmed || trimmed === current) return;

  // ✅ 文字列だけ送る
  socket.emit("change-name", trimmed);

  nameInput.value = trimmed;
  lastKnownName = trimmed;
});

leaveBtn.addEventListener("click", () => {
  if (!joined) return;

  // ✅ 引数なし
  socket.emit("leave");

  inputRow.style.display = "none";

  joined = false;
  document.body.classList.remove("joined");

  shouldAutoJoin = false;
  lastKnownName = "";
  lastKnownGender = "";
  lastKnownColor = null;

  joinRow.style.display = "flex";
  joinBtn.disabled = false;
  joinBtn.style.display = "inline-block";

  renameBtn.disabled = true;
  leaveBtn.disabled = true;
  openColorChangeBtn.disabled = true;
  afterJoinControls.style.display = "none";

  msgInput.disabled = true;
  sendBtn.disabled = true;

  if (roll1d6Btn) roll1d6Btn.disabled = true;
  if (roll2d6Btn) roll2d6Btn.disabled = true; // ✅ バグ修正
  if (topicRouletteBtn) topicRouletteBtn.disabled = true;

  document.querySelector(".template-row").style.display = "none";
  templateButtons.forEach(btn => btn.disabled = true);

  if (infoBeforeJoin) infoBeforeJoin.style.display = "block";
  if (preLoginNotice) preLoginNotice.style.display = "block";
  chatLog.style.display = "none";

  chatLog.innerHTML = "";
  typingInfo.textContent = "";
  statusText.textContent = "未入室";

  pendingColor = null;
  colorChangeArea.style.display = "none";
  if (footer && colorRow && inputRow) {
    footer.insertBefore(colorRow, inputRow);
    colorRow.style.display = "flex";
  }
});

/* 色変更UI（入室後） */
openColorChangeBtn.addEventListener("click", () => {
  if (!joined) return;

  const baseColor = currentColor || lastKnownColor;
  if (baseColor) {
    colorInputs.forEach(input => { input.checked = (input.value === baseColor); });
    pendingColor = baseColor;
  }

  colorChangeWrapper.appendChild(colorRow);
  colorRow.style.display = "flex";

  const applyBtn = document.createElement("button");
  applyBtn.textContent = "決定";
  applyBtn.classList.add("color-change-btn");

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "キャンセル";
  cancelBtn.classList.add("color-change-btn");

  colorChangeWrapper.appendChild(applyBtn);
  colorChangeWrapper.appendChild(cancelBtn);

  colorChangeArea.style.display = "block";

  applyBtn.addEventListener("click", applyColorChange);
  cancelBtn.addEventListener("click", cancelColorChange);
});

/* 送信 */
sendBtn.addEventListener("click", () => {
  const text = msgInput.value.trim();
  if (!text) return;

  // ✅ roomSlug不要
  socket.emit("send-message", { text });

  msgInput.value = "";
  setTyping(false);
});

msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    sendBtn.click();
  } else {
    setTyping(true);
  }
});

msgInput.addEventListener("keyup", () => {
  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => setTyping(false), 1500);
});

/* 定型文 */
templateButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const text = btn.dataset.text;
    socket.emit("send-message", { text }); // ✅ roomSlug不要
  });
});

/* ダイス */
if (roll1d6Btn) {
  roll1d6Btn.addEventListener("click", () => {
    if (!joined) return;
    socket.emit("roll-1d6"); // ✅ 引数なし
  });
}
if (roll2d6Btn) {
  roll2d6Btn.addEventListener("click", () => {
    if (!joined) return;
    socket.emit("roll-dice"); // ✅ 引数なし
  });
}

/* お題ガチャ */
if (topicRouletteBtn) {
  topicRouletteBtn.addEventListener("click", () => {
    if (!joined) return;
    socket.emit("draw-topic"); // ✅ 引数なし
  });
}

/* ====== 復帰強化 ====== */
async function forceResync() {
  if (joined) {
    try { await syncFullLog(); } catch {}
  }
  if (!socket.connected) {
    try { socket.connect(); } catch {}
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") forceResync();
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) forceResync();
});
window.addEventListener("online", () => {
  forceResync();
});

// pollは常時起動（入室してない時は待つ）
startPollLoop();
