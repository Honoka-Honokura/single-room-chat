// server.js（/r/:slug 複数部屋・完全分離版）
require("dotenv").config();
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));

const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ★ Socket.io：スマホ/タブ切替での不安定さを少しでも軽減
const io = new Server(http, {
  pingInterval: 25000,
  pingTimeout: 45000,
  transports: ["websocket", "polling"],
  upgradeTimeout: 20000,
  perMessageDeflate: false,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

// public フォルダを静的配信
app.use(express.static("public"));
// JSONボディを受け取るため
app.use(express.json());

// ★ キャッシュ対策（HTML/JS/CSS）
app.use((req, res, next) => {
  if (
    req.path === "/" ||
    req.path.startsWith("/r/") ||
    req.path.endsWith(".html") ||
    req.path.endsWith(".js") ||
    req.path.endsWith(".css")
  ) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

// ===========================
// ★ ルーム許可リスト（存在バレ防止）
// ===========================
const ALLOWED_ROOMS = new Set(
  String(process.env.ROOM_SLUGS || "main")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function normalizeRoomSlug(slug) {
  const s = String(slug || "main").trim();
  // slugの安全化（変な文字を落とす）
  const safe = s.replace(/[^a-zA-Z0-9_-]/g, "");
  return safe || "main";
}

function isRoomAllowed(slug) {
  const r = normalizeRoomSlug(slug);
  return ALLOWED_ROOMS.has(r);
}

// / で mainへ
app.get("/", (req, res) => {
  res.redirect("/r/main");
});

// /r/:slug で部屋を切り分け（存在しないslugは404）
app.get("/r/:slug", (req, res) => {
  const room = normalizeRoomSlug(req.params.slug);
  if (!isRoomAllowed(room)) return res.status(404).send("Not Found");

  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===========================
// ★ お題ガチャ（部屋別）
// ===========================
const { drawTopic, getTopics, addTopic, updateTopic, deleteTopic } = require("./topics");
const TOPIC_COOLDOWN_MS = 5000;

// ===========================
// ★ moderation / ban 永続化（全ルーム共通）
// ===========================
const MODERATION_FILE = path.join(__dirname, "moderation.json");
const BANLIST_FILE = path.join(__dirname, "banlist.json");

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("JSON read error:", filePath, e);
    return fallback;
  }
}
function writeJsonSafe(filePath, obj) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}
function uid() {
  return crypto.randomBytes(8).toString("hex");
}

let moderation = readJsonSafe(MODERATION_FILE, {
  maxMsgLen: 300,
  minIntervalMs: 1000,
  maxUrlsPerMsg: 3,
  blockPII: true,
  ngWords: [],
  ngRegexes: [],
});

let banlist = readJsonSafe(BANLIST_FILE, { items: [] });

let compiledNgRegexes = [];
function normalizeForCheck(text) {
  if (!text) return "";
  return text.toString().normalize("NFKC").toLowerCase();
}
function compileModerationRegexes() {
  compiledNgRegexes = [];
  for (const s of moderation.ngRegexes || []) {
    try {
      compiledNgRegexes.push(new RegExp(String(s), "i"));
    } catch (e) {
      console.warn("Invalid regex skipped:", s);
    }
  }
}
compileModerationRegexes();

function cleanupExpiredBans() {
  const now = Date.now();
  banlist.items = (banlist.items || []).filter((it) => !it.expiresAt || it.expiresAt > now);
  writeJsonSafe(BANLIST_FILE, banlist);
}

function getSocketIp(socket) {
  const xf = socket.handshake.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return socket.handshake.address || "";
}

function isBanned(clientId, ip) {
  cleanupExpiredBans();
  for (const it of banlist.items || []) {
    if (it.type === "clientId" && clientId && it.value === clientId) return true;
    if (it.type === "ip" && ip && it.value === ip) return true;
  }
  return false;
}

function containsNgWordByModeration(text) {
  const normalized = normalizeForCheck(text);

  // 単語（部分一致）
  for (const w of moderation.ngWords || []) {
    const nw = normalizeForCheck(w);
    if (nw && normalized.includes(nw)) return true;
  }

  // 正規表現
  for (const re of compiledNgRegexes) {
    try {
      if (re.test(String(text))) return true;
    } catch (_) {}
  }
  return false;
}

// URL貼りすぎ防止
const URL_REGEX = /(https?:\/\/[^\s]+)/gi;
const BLOCKED_URL_DOMAINS = ["bit.ly", "t.co", "discord.gg", "goo.gl", "tinyurl.com"];

// 個人情報検出
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_REGEXES = [/0\d{1,4}-\d{1,4}-\d{3,4}/, /\b0\d{9,10}\b/];

function containsPersonalInfo(text) {
  if (!text) return false;
  const normalized = normalizeForCheck(text);
  if (EMAIL_REGEX.test(normalized)) return true;
  for (const re of PHONE_REGEXES) {
    if (re.test(normalized)) return true;
  }
  return false;
}

// 時刻文字列
function getTimeString() {
  return new Date().toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 性別記号
function applyGenderMark(name, gender) {
  const base = String(name || "").trim();
  if (base.endsWith("♂") || base.endsWith("♀")) return base;
  if (gender === "male") return base + "♂";
  if (gender === "female") return base + "♀";
  return base;
}

// ===========================
// ★ ルームごとの状態（完全分離）
// ===========================
const rooms = new Map();
function getRoomState(roomSlug) {
  const room = normalizeRoomSlug(roomSlug);
  if (!rooms.has(room)) {
    rooms.set(room, {
      users: {},                 // { socketId: { name, color, gender } }
      typingUsers: new Set(),    // Set<socketId>
      chatLog: [],               // {id,type,time,...} 最大50
      nextMessageId: 1,
      pollWaiters: new Set(),    // { sinceId, res, timer }
      lastActivityTimes: {},     // { socketId: time }
    });
  }
  return rooms.get(room);
}

// ロングポーリング設定
const POLL_TIMEOUT_MS = 25000;

// 最大人数（部屋ごと）
const MAX_USERS = 10;

// 無操作タイムアウト（部屋ごと）
const INACTIVITY_LIMIT_MS = 10 * 60 * 1000; // 10分

// ★ グローバル（ルーム跨ぎで共有）
// socket.id -> clientId
const socketClientIds = {};

// 再入室判定（clientId×room）
const lastLeaveByClientIdRoom = {}; // { [clientId]: { [room]: time } }

// 連投制限（clientId×room）
const lastActionTimeByKey = {}; // { ["room:clientId"]: time }

// お題ガチャクールダウン（clientId×room）
const lastTopicTimeByKey = {}; // { ["room:clientId"]: time }

function keyOf(room, clientId) {
  return `${room}:${clientId}`;
}

function checkRateLimit(room, clientId) {
  if (!clientId) return 0;
  const now = Date.now();
  const k = keyOf(room, clientId);
  const last = lastActionTimeByKey[k] || 0;
  const diff = now - last;

  const min = Number(moderation?.minIntervalMs ?? 1000);
  if (diff < min) return min - diff;

  lastActionTimeByKey[k] = now;
  return 0;
}

function pushLog(room, entry) {
  const st = getRoomState(room);

  const e = { id: st.nextMessageId++, ...entry };
  st.chatLog.push(e);
  if (st.chatLog.length > 50) st.chatLog.shift();

  // ロングポーリング待機者に新着を返す
  for (const w of Array.from(st.pollWaiters)) {
    const news = st.chatLog.filter((m) => m.id > w.sinceId);
    if (news.length > 0) {
      clearTimeout(w.timer);
      st.pollWaiters.delete(w);
      w.res.json({ ok: true, messages: news, serverTime: Date.now() });
    }
  }

  return e;
}

/**
 * emitLog(type, payload, opts)
 * type: "system" | "chat" | "dice" | "topic"
 */
function emitLog(type, payload, opts = {}) {
  const room = normalizeRoomSlug(opts.room || "main");
  const time = getTimeString();

  const saved = pushLog(room, { type, time, ...payload });

  if (type === "topic") {
    io.to(room).emit("topic-result", {
      id: saved.id,
      time,
      topic: saved.topic,
      drawnBy: saved.name,
    });
    return saved;
  }

  if (type === "system") {
    io.to(room).emit("system-message", {
      id: saved.id,
      time,
      text: saved.text,
    });
    return saved;
  }

  // chat / dice は chat-message に統一
  io.to(room).emit("chat-message", {
    id: saved.id,
    time,
    name: saved.name,
    text: saved.text,
    fromId: opts.fromId || null,
    color: saved.color || null,
  });

  return saved;
}

function emitSystem(room, text) {
  return emitLog("system", { text }, { room });
}

function broadcastUserList(room) {
  const r = normalizeRoomSlug(room);
  const st = getRoomState(r);
  const userList = Object.values(st.users).map((u) => u.name);
  io.to(r).emit("user-list", userList);
}

function broadcastTypingUsers(room) {
  const r = normalizeRoomSlug(room);
  const st = getRoomState(r);
  const names = Array.from(st.typingUsers)
    .map((id) => st.users[id]?.name)
    .filter(Boolean);
  io.to(r).emit("typing-users", names);
}

function touchActivity(room, socketId) {
  const st = getRoomState(room);
  st.lastActivityTimes[socketId] = Date.now();
}

// 参照ヘッダから room を推定（入室前のオンライン人数表示用）
function getRoomFromHandshake(socket) {
  try {
    const ref = socket.handshake.headers.referer || "";
    const u = new URL(ref);
    const m = u.pathname.match(/^\/r\/([^\/]+)/);
    if (m && m[1]) return normalizeRoomSlug(decodeURIComponent(m[1]));
  } catch (_) {}
  return "main";
}

// ===========================
// ★ 無操作チェック（全ルーム走査）
// ===========================
setInterval(() => {
  const now = Date.now();

  for (const [room, st] of rooms.entries()) {
    for (const [socketId, last] of Object.entries(st.lastActivityTimes)) {
      if (now - last < INACTIVITY_LIMIT_MS) continue;

      const user = st.users[socketId];
      if (!user) {
        delete st.lastActivityTimes[socketId];
        continue;
      }

      const leftName = user.name;

      delete st.users[socketId];
      st.typingUsers.delete(socketId);
      delete st.lastActivityTimes[socketId];

      const clientId = socketClientIds[socketId];
      if (clientId) {
        delete socketClientIds[socketId];
        lastLeaveByClientIdRoom[clientId] = lastLeaveByClientIdRoom[clientId] || {};
        lastLeaveByClientIdRoom[clientId][room] = Date.now();
      }

      const s = io.sockets.sockets.get(socketId);
      if (s) {
        s.leave(room);
        s.emit("force-leave", { reason: "timeout" });
      }

      emitSystem(room, `「${leftName}」さんは一定時間操作がなかったため退室しました。`);
      broadcastUserList(room);
      broadcastTypingUsers(room);

      if (Object.keys(st.users).length === 0) {
        st.chatLog.length = 0;
        st.typingUsers.clear();
        console.log(`[${room}] All users left. chatLog cleared (by auto-timeout).`);
      }
    }
  }
}, 60 * 1000);

// ===========================
// 管理用シンプルAPI
// ===========================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error("❌ ADMIN_PASSWORD is not set in .env");
  process.exit(1);
}

function requireAdmin(req, res) {
  const password =
    req.query.password ||
    req.headers["x-admin-password"] ||
    (req.body && req.body.password);

  if (password !== ADMIN_PASSWORD) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return true;
}

// ===========================
// ★ 管理者：オンライン一覧（room指定）
// GET /api/admin/online?room=main
// ===========================
app.get("/api/admin/online", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const room = normalizeRoomSlug(req.query.room || "main");
  if (!isRoomAllowed(room)) return res.status(404).json({ error: "room not found" });

  const st = getRoomState(room);
  const list = [];

  for (const [socketId, u] of Object.entries(st.users)) {
    const s = io.sockets.sockets.get(socketId);
    const ip = s ? getSocketIp(s) : "";
    list.push({
      room,
      socketId,
      name: u.name,
      color: u.color || null,
      clientId: socketClientIds[socketId] || null,
      ip,
    });
  }

  res.json({ ok: true, users: list });
});

// ===========================
// ★ 管理者：BAN＆キック（roomとsocketIdを指定）
// POST /api/ban/online { room, socketId, mode, minutes, reason }
// ===========================
function adminKickSocket(room, socketId, reasonText = "BAN") {
  const r = normalizeRoomSlug(room);
  const st = getRoomState(r);

  const user = st.users[socketId];
  const s = io.sockets.sockets.get(socketId);

  if (!user) {
    if (s) s.disconnect(true);
    return { ok: false, message: "user not found" };
  }

  const name = user.name;

  delete st.users[socketId];
  st.typingUsers.delete(socketId);
  delete st.lastActivityTimes[socketId];

  const clientId = socketClientIds[socketId];
  if (clientId) {
    delete socketClientIds[socketId];
    lastLeaveByClientIdRoom[clientId] = lastLeaveByClientIdRoom[clientId] || {};
    lastLeaveByClientIdRoom[clientId][r] = Date.now();
  }

  if (s) {
    s.leave(r);
    s.emit("force-leave", { reason: reasonText });
    s.disconnect(true);
  }

  emitSystem(r, `「${name}」さんは管理者により退出されました。`);
  broadcastUserList(r);
  broadcastTypingUsers(r);

  if (Object.keys(st.users).length === 0) {
    st.chatLog.length = 0;
    st.typingUsers.clear();
    console.log(`[${r}] All users left. chatLog cleared.`);
  }

  return { ok: true };
}

app.post("/api/ban/online", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { room, socketId, mode, minutes, reason } = req.body || {};
  const r = normalizeRoomSlug(room || "main");
  if (!isRoomAllowed(r)) return res.status(404).json({ error: "room not found" });
  if (!socketId) return res.status(400).json({ error: "socketId required" });

  const s = io.sockets.sockets.get(socketId);
  const clientId = socketClientIds[socketId] || null;
  const ip = s ? getSocketIp(s) : "";

  if (!clientId && !ip) return res.status(404).json({ error: "target not found" });

  const m = ["clientId", "ip", "both"].includes(mode) ? mode : "clientId";
  const durMin = Number(minutes || 0);
  const expiresAt = durMin > 0 ? Date.now() + durMin * 60 * 1000 : null;

  cleanupExpiredBans();

  function addBan(type, value) {
    if (!value) return;
    const exists = (banlist.items || []).some(
      (it) => it.type === type && it.value === value && (!it.expiresAt || it.expiresAt > Date.now())
    );
    if (exists) return;

    const item = {
      id: uid(),
      type,
      value,
      reason: typeof reason === "string" ? reason.trim() : "",
      expiresAt,
      createdAt: Date.now(),
    };
    banlist.items.push(item);
  }

  banlist.items = banlist.items || [];

  if (m === "clientId" || m === "both") addBan("clientId", clientId);
  if (m === "ip" || m === "both") addBan("ip", ip);

  writeJsonSafe(BANLIST_FILE, banlist);

  const kick = adminKickSocket(r, socketId, "banned");

  res.json({
    ok: true,
    banned: { mode: m, clientId, ip, expiresAt },
    kick,
  });
});

// ===========================
// ★ moderation 管理API（全ルーム共通）
// ===========================
app.get("/api/moderation", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(moderation);
});

app.put("/api/moderation", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const b = req.body || {};
  moderation = {
    maxMsgLen: Number(b.maxMsgLen ?? 300),
    minIntervalMs: Number(b.minIntervalMs ?? 1000),
    maxUrlsPerMsg: Number(b.maxUrlsPerMsg ?? 3),
    blockPII: !!b.blockPII,
    ngWords: Array.isArray(b.ngWords) ? b.ngWords.map(String) : [],
    ngRegexes: Array.isArray(b.ngRegexes) ? b.ngRegexes.map(String) : [],
  };

  writeJsonSafe(MODERATION_FILE, moderation);
  compileModerationRegexes();
  res.json({ ok: true });
});

// ===========================
// ★ BAN 管理API（全ルーム共通）
// ===========================
app.get("/api/ban", (req, res) => {
  if (!requireAdmin(req, res)) return;
  cleanupExpiredBans();
  res.json({ items: banlist.items || [] });
});

app.post("/api/ban", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { type, value, reason, expiresAt } = req.body || {};
  if (!["clientId", "ip"].includes(type)) {
    return res.status(400).json({ error: "type must be clientId or ip" });
  }
  if (!value || typeof value !== "string") {
    return res.status(400).json({ error: "value required" });
  }

  cleanupExpiredBans();

  const item = {
    id: uid(),
    type,
    value: value.trim(),
    reason: typeof reason === "string" ? reason.trim() : "",
    expiresAt: expiresAt ? Number(expiresAt) : null,
    createdAt: Date.now(),
  };

  banlist.items = banlist.items || [];
  banlist.items.push(item);
  writeJsonSafe(BANLIST_FILE, banlist);

  res.json({ ok: true, item });
});

app.delete("/api/ban/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const id = String(req.params.id || "");
  banlist.items = (banlist.items || []).filter((it) => it.id !== id);
  writeJsonSafe(BANLIST_FILE, banlist);
  res.json({ ok: true });
});

// ===========================
// ★ お題API（部屋別）
// room=xxx を指定（省略時 main）
// ===========================
app.get("/api/topics", (req, res) => {
  const password = req.query.password || req.headers["x-admin-password"];
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "forbidden" });

  const room = normalizeRoomSlug(req.query.room || "main");
  if (!isRoomAllowed(room)) return res.status(404).json({ error: "room not found" });

  res.json(getTopics(room));
});

app.put("/api/topics/:id", (req, res) => {
  const { password, text, weight, room, rooms } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "forbidden" });

  const r = normalizeRoomSlug(room || "main");
  if (!isRoomAllowed(r)) return res.status(404).json({ error: "room not found" });

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  try {
    const topic = updateTopic(r, id, { text, weight, rooms }); // ★ rooms を渡す
    res.json(topic);
  } catch (err) {
    console.error("Failed to update topic:", err);
    res.status(400).json({ error: err.message || "bad request" });
  }
});


app.put("/api/topics/:id", (req, res) => {
  const { password, text, weight, room } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "forbidden" });

  const r = normalizeRoomSlug(room || "main");
  if (!isRoomAllowed(r)) return res.status(404).json({ error: "room not found" });

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  try {
    const topic = updateTopic(r, id, { text, weight });
    res.json(topic);
  } catch (err) {
    console.error("Failed to update topic:", err);
    res.status(400).json({ error: err.message || "bad request" });
  }
});

app.delete("/api/topics/:id", (req, res) => {
  const password =
    req.query.password || req.headers["x-admin-password"] || (req.body && req.body.password);

  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "forbidden" });

  const r = normalizeRoomSlug((req.query.room || (req.body && req.body.room) || "main"));
  if (!isRoomAllowed(r)) return res.status(404).json({ error: "room not found" });

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  try {
    const removed = deleteTopic(r, id);
    res.json({ ok: true, removed });
  } catch (err) {
    console.error("Failed to delete topic:", err);
    res.status(400).json({ error: err.message || "bad request" });
  }
});

// ===========================
// ★ ロングポーリング用API（部屋別）
// ===========================
app.get("/api/log", (req, res) => {
  const room = normalizeRoomSlug(req.query.room || "main");
  if (!isRoomAllowed(room)) return res.status(404).json({ error: "room not found" });

  const st = getRoomState(room);
  res.json({ ok: true, messages: st.chatLog, serverTime: Date.now() });
});

app.get("/api/poll", (req, res) => {
  const room = normalizeRoomSlug(req.query.room || "main");
  if (!isRoomAllowed(room)) return res.status(404).json({ error: "room not found" });

  const st = getRoomState(room);
  const sinceId = Number(req.query.since || 0);

  const news = st.chatLog.filter((m) => m.id > sinceId);
  if (news.length > 0) {
    return res.json({ ok: true, messages: news, serverTime: Date.now() });
  }

  const waiter = {
    sinceId,
    res,
    timer: setTimeout(() => {
      st.pollWaiters.delete(waiter);
      res.json({ ok: true, messages: [], serverTime: Date.now() });
    }, POLL_TIMEOUT_MS),
  };

  st.pollWaiters.add(waiter);

  req.on("close", () => {
    clearTimeout(waiter.timer);
    st.pollWaiters.delete(waiter);
  });
});

// ===========================
// Socket.io メイン処理（部屋対応）
// ===========================
io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  // 入室前でもオンライン人数を出したいので、refererから部屋推定して送る
  const roomHint = getRoomFromHandshake(socket);
  if (isRoomAllowed(roomHint)) {
    const st = getRoomState(roomHint);
    const currentUsers = Object.values(st.users).map((u) => u.name);
    socket.emit("user-list", currentUsers);
  } else {
    socket.emit("user-list", []);
  }

  // 入室
  socket.on("join", (payload) => {
    // payload: { roomSlug, name, color, clientId, gender }
    let room = "main";
    let rawName = "";
    let color = null;
    let clientId = null;
    let gender = "";

    if (typeof payload === "string" || payload === undefined || payload === null) {
      rawName = payload || "";
    } else {
      room = normalizeRoomSlug(payload.roomSlug || "main");
      rawName = payload.name || "";
      color = payload.color || null;
      clientId = payload.clientId || null;
      gender = payload.gender || "";
    }

    if (!isRoomAllowed(room)) {
      socket.emit("system-message", { time: getTimeString(), text: "この部屋は存在しません。" });
      socket.disconnect(true);
      return;
    }

    const st = getRoomState(room);
    if (st.users[socket.id]) return;

    const currentCount = Object.keys(st.users).length;
    if (currentCount >= MAX_USERS) {
      socket.emit("room-full");
      return;
    }

    if (!clientId) clientId = socket.id;
    socketClientIds[socket.id] = clientId;

    // BAN判定
    const ip = getSocketIp(socket);
    if (isBanned(clientId, ip)) {
      socket.emit("system-message", { time: getTimeString(), text: "この端末（または回線）はBANされています。" });
      socket.disconnect(true);
      return;
    }

    const baseName =
      rawName && rawName.trim() ? rawName.trim() : "user-" + Math.floor(Math.random() * 1000);

    const displayName = applyGenderMark(baseName, gender);

    st.users[socket.id] = { name: displayName, color, gender };

    socket.join(room);
    socket.data.roomSlug = room;

    console.log(displayName, "joined room:", room, "(clientId:", clientId, ")");

    // 再入室判定（部屋別）
    const now = Date.now();
    let shouldAnnounceJoin = true;

    const lastLeaveMap = lastLeaveByClientIdRoom[clientId] || {};
    const lastLeave = lastLeaveMap[room];

    if (lastLeave && now - lastLeave < INACTIVITY_LIMIT_MS) {
      shouldAnnounceJoin = false;
    }

    if (shouldAnnounceJoin) {
      emitSystem(room, `「${displayName}」さんが入室しました。`);
    }

    // 過去ログを送る
    if (st.chatLog.length > 0) {
      socket.emit("chat-log", st.chatLog);
    }

    broadcastUserList(room);
    touchActivity(room, socket.id);
  });

  // 名前変更
  socket.on("change-name", (newName) => {
    const room = socket.data.roomSlug;
    if (!room || !isRoomAllowed(room)) return;

    const st = getRoomState(room);
    const user = st.users[socket.id];
    if (!user) return;

    const oldName = user.name;
    const base = (newName || "").trim();
    if (!base) return;

    const finalName = applyGenderMark(base, user.gender);
    if (finalName === oldName) return;

    user.name = finalName;
    touchActivity(room, socket.id);

    emitSystem(room, `「${oldName}」さんは名前を「${finalName}」に変更しました。`);
    broadcastUserList(room);
  });

  // 色変更
  socket.on("change-color", (newColor) => {
    const room = socket.data.roomSlug;
    if (!room || !isRoomAllowed(room)) return;

    const st = getRoomState(room);
    const user = st.users[socket.id];
    if (!user) return;

    const c = (newColor || "").toString().trim();
    if (!c) return;

    user.color = c;
    touchActivity(room, socket.id);

    emitSystem(room, `「${user.name}」さんが吹き出し色を変更しました。`);
  });

  // メッセージ
  socket.on("send-message", (msg) => {
    try {
      const room = socket.data.roomSlug;
      if (!room || !isRoomAllowed(room)) return;

      const st = getRoomState(room);
      const user = st.users[socket.id];
      if (!user) return;

      // ✅ 文字列でも {text} でもOKにする
      const text = (typeof msg === "object" && msg !== null)
        ? String(msg.text || "").trim()
        : String(msg || "").trim();

      if (!text) return;

      // 以降は今のままでOK（moderation/URL/連投制限など）
      const maxLen = Number(moderation?.maxMsgLen ?? 300);
      const maxUrls = Number(moderation?.maxUrlsPerMsg ?? 3);
      const blockPII = !!(moderation?.blockPII ?? true);

      if (maxLen > 0 && text.length > maxLen) {
        socket.emit("system-message", { time: getTimeString(), text: `長すぎます（最大 ${maxLen} 文字）` });
        return;
      }

      if (blockPII && containsPersonalInfo(text)) {
        socket.emit("system-message", { time: getTimeString(), text: "個人情報（電話番号やメールアドレスなど）は送信できません。" });
        return;
      }

      if (containsNgWordByModeration(text)) {
        socket.emit("system-message", { time: getTimeString(), text: "NGワードが含まれているため、送信できません。" });
        return;
      }

      const urls = text.match(URL_REGEX) || [];
      if (maxUrls >= 0 && urls.length > maxUrls) {
        socket.emit("system-message", { time: getTimeString(), text: `1つのメッセージに貼れるURLは最大 ${maxUrls} 件までです。` });
        return;
      }

      if (urls.length > 0) {
        for (const raw of urls) {
          const urlStr = raw.startsWith("http") ? raw : `http://${raw}`;
          const u = new URL(urlStr);
          const host = u.hostname.toLowerCase();
          if (BLOCKED_URL_DOMAINS.some((d) => host === d || host.endsWith("." + d))) {
            socket.emit("system-message", { time: getTimeString(), text: "安全のため、一部の短縮URLや招待リンクは送信できません。" });
            return;
          }
        }
      }

      const clientId = socketClientIds[socket.id] || socket.id;
      const waitMs = checkRateLimit(room, clientId);
      if (waitMs > 0) {
        socket.emit("rate-limit", { waitMs });
        return;
      }

      touchActivity(room, socket.id);
      emitLog("chat", { name: user.name, text, color: user.color || null }, { fromId: socket.id, room });

    } catch (err) {
      console.error("send-message error:", err);
      try {
        socket.emit("system-message", { time: getTimeString(), text: "送信処理でエラーが発生しました。時間をおいて再試行してください。" });
      } catch (_) {}
    }
  });


  // 1D6
  socket.on("roll-1d6", () => {
    const room = socket.data.roomSlug;
    if (!room || !isRoomAllowed(room)) return;

    const st = getRoomState(room);
    const user = st.users[socket.id];
    if (!user) return;

    const clientId = socketClientIds[socket.id] || socket.id;
    const waitMs = checkRateLimit(room, clientId);
    if (waitMs > 0) {
      socket.emit("rate-limit", { waitMs });
      return;
    }

    const d = Math.floor(Math.random() * 6) + 1;
    const name = user.name || "ななし";
    const color = user.color || "#FFFFFF";
    const text = `🎲 ${name} が 1D6 を振った：${d}`;

    emitLog("dice", { name, text, color }, { fromId: socket.id, room });
  });

  // 2D6
  socket.on("roll-dice", () => {
    const room = socket.data.roomSlug;
    if (!room || !isRoomAllowed(room)) return;

    const st = getRoomState(room);
    const user = st.users[socket.id];
    if (!user) return;

    const clientId = socketClientIds[socket.id] || socket.id;
    const waitMs = checkRateLimit(room, clientId);
    if (waitMs > 0) {
      socket.emit("rate-limit", { waitMs });
      return;
    }

    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const total = d1 + d2;

    const name = user.name || "ななし";
    const color = user.color || "#FFFFFF";
    const text = `🎲 ${name} が 2D6 を振った：${d1} ＋ ${d2} ＝ ${total}`;

    emitLog("dice", { name, text, color }, { fromId: socket.id, room });
  });

  // お題ガチャ（部屋別topics + クールダウン部屋別）
  socket.on("draw-topic", () => {
    const room = socket.data.roomSlug;
    if (!room || !isRoomAllowed(room)) return;

    const st = getRoomState(room);
    const user = st.users[socket.id];
    if (!user) return;

    const clientId = socketClientIds[socket.id];
    if (!clientId) return;

    const now = Date.now();
    const k = keyOf(room, clientId);
    const last = lastTopicTimeByKey[k] || 0;
    const diff = now - last;

    if (diff < TOPIC_COOLDOWN_MS) {
      socket.emit("rate-limit", { waitMs: TOPIC_COOLDOWN_MS - diff });
      return;
    }

    lastTopicTimeByKey[k] = now;

    const drawn = drawTopic(room);
    if (!drawn) return;

    const name = user.name || "匿名";
    emitLog("topic", { name, topic: drawn.text, color: null }, { room });
  });

  // 入力中
  socket.on("typing", (isTyping) => {
    const room = socket.data.roomSlug;
    if (!room || !isRoomAllowed(room)) return;

    const st = getRoomState(room);
    const user = st.users[socket.id];
    if (!user) return;

    if (isTyping) {
      st.typingUsers.add(socket.id);
      touchActivity(room, socket.id);
    } else {
      st.typingUsers.delete(socket.id);
    }
    broadcastTypingUsers(room);
  });

  // 明示的退室
  socket.on("leave", () => {
    const room = socket.data.roomSlug;
    if (!room || !isRoomAllowed(room)) return;

    const st = getRoomState(room);
    const user = st.users[socket.id];
    if (!user) return;

    const leftName = user.name;

    const clientId = socketClientIds[socket.id];
    if (clientId) {
      lastLeaveByClientIdRoom[clientId] = lastLeaveByClientIdRoom[clientId] || {};
      lastLeaveByClientIdRoom[clientId][room] = Date.now();
      delete socketClientIds[socket.id];
    }

    delete st.users[socket.id];
    st.typingUsers.delete(socket.id);
    delete st.lastActivityTimes[socket.id];

    socket.leave(room);
    emitSystem(room, `「${leftName}」さんが退室しました。`);

    broadcastUserList(room);
    broadcastTypingUsers(room);

    if (Object.keys(st.users).length === 0) {
      st.chatLog.length = 0;
      st.typingUsers.clear();
      console.log(`[${room}] All users left. chatLog cleared.`);
    }
  });

  // 切断
  socket.on("disconnect", () => {
    const room = socket.data.roomSlug;
    if (!room || !isRoomAllowed(room)) {
      console.log("disconnected:", socket.id);
      return;
    }

    const st = getRoomState(room);
    const user = st.users[socket.id];

    const clientId = socketClientIds[socket.id];
    if (clientId) {
      lastLeaveByClientIdRoom[clientId] = lastLeaveByClientIdRoom[clientId] || {};
      lastLeaveByClientIdRoom[clientId][room] = Date.now();
      delete socketClientIds[socket.id];
    }

    if (user) {
      delete st.users[socket.id];
      st.typingUsers.delete(socket.id);
      delete st.lastActivityTimes[socket.id];

      broadcastUserList(room);
      broadcastTypingUsers(room);

      if (Object.keys(st.users).length === 0) {
        st.chatLog.length = 0;
        st.typingUsers.clear();
        console.log(`[${room}] All users left. chatLog cleared.`);
      }
    }

    console.log("disconnected:", socket.id, "room:", room);
  });
});

http.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
  console.log("Allowed rooms:", Array.from(ALLOWED_ROOMS).join(", "));
});
