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
// 管理用シンプルAPI（ここを先に定義！）
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
// ★ お題ガチャ（部屋別）
// ===========================
const {
  drawTopic,
  getTopics,
  getAllTopics, // ★ /api/admin/topics
  addTopic,
  updateTopic,
  deleteTopic,
} = require("./topics");

const TOPIC_COOLDOWN_MS = 5000;

// ===========================
// ★ 管理者：許可ルーム一覧
// GET /api/admin/rooms?password=...
// ===========================
app.get("/api/admin/rooms", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ rooms: Array.from(ALLOWED_ROOMS) });
});

// ===========================
// ★ 管理者：全お題一覧（全ルーム）
// GET /api/admin/topics?password=...
// ===========================
app.get("/api/admin/topics", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(getAllTopics());
});

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

  for (const w of moderation.ngWords || []) {
    const nw = normalizeForCheck(w);
    if (nw && normalized.includes(nw)) return true;
  }
  for (const re of compiledNgRegexes) {
    try {
      if (re.test(String(text))) return true;
    } catch (_) {}
  }
  return false;
}

const URL_REGEX = /(https?:\/\/[^\s]+)/gi;
const BLOCKED_URL_DOMAINS = ["bit.ly", "t.co", "discord.gg", "goo.gl", "tinyurl.com"];

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

function getTimeString() {
  return new Date().toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function applyGenderMark(name, gender) {
  const base = String(name || "").trim();
  if (base.endsWith("♂") || base.endsWith("♀")) return base;
  if (gender === "male") return base + "♂";
  if (gender === "female") return base + "♀";
  return base;
}

// =====================================================
// ✅ ここが今回の肝：部屋状態管理 + emit + poll + 連投制限
// =====================================================
const MAX_USERS = 10;
const INACTIVITY_LIMIT_MS = 10 * 60 * 1000;
const POLL_TIMEOUT_MS = 25 * 1000;

// roomStates[room] = { users, typingUsers, chatLog, lastActivityTimes, pollWaiters, nextMsgId }
const roomStates = new Map();

// socket.id -> clientId
const socketClientIds = {};
// clientId -> { roomSlug: lastLeaveAt }
const lastLeaveByClientIdRoom = {};
// お題ガチャのクールダウン用
const lastTopicTimeByKey = {};
// 連投制限用
const lastActionTimeByKey = {};

function keyOf(room, clientId) {
  return `${room}::${clientId}`;
}

function getRoomState(room) {
  const r = normalizeRoomSlug(room || "main");
  if (!roomStates.has(r)) {
    roomStates.set(r, {
      users: {},                 // { socket.id: { name, color, gender } }
      typingUsers: new Set(),    // Set<socket.id>
      chatLog: [],               // [{id,type,time,name,text,color,topic,fromId?}]
      lastActivityTimes: {},     // { socket.id: timestamp }
      pollWaiters: new Set(),    // Set<{sinceId,res,timer}>
      nextMsgId: 1,
    });
  }
  return roomStates.get(r);
}

function touchActivity(room, socketId) {
  const st = getRoomState(room);
  st.lastActivityTimes[socketId] = Date.now();
}

function broadcastUserList(room) {
  const st = getRoomState(room);
  const list = Object.values(st.users).map((u) => u.name);
  io.to(room).emit("user-list", list);
}

function broadcastTypingUsers(room) {
  const st = getRoomState(room);
  const names = [];
  for (const sid of st.typingUsers) {
    const u = st.users[sid];
    if (u?.name) names.push(u.name);
  }
  io.to(room).emit("typing-users", names);
}

function flushPollWaiters(room) {
  const st = getRoomState(room);
  if (!st.pollWaiters || st.pollWaiters.size === 0) return;

  for (const waiter of Array.from(st.pollWaiters)) {
    const news = st.chatLog.filter((m) => m.id > waiter.sinceId);
    if (news.length > 0) {
      clearTimeout(waiter.timer);
      st.pollWaiters.delete(waiter);
      try {
        waiter.res.json({ ok: true, messages: news, serverTime: Date.now() });
      } catch (_) {}
    }
  }
}

function emitSystem(room, text) {
  const st = getRoomState(room);
  const msg = {
    id: st.nextMsgId++,
    type: "system",
    time: getTimeString(),
    text: String(text || ""),
  };

  st.chatLog.push(msg);
  if (st.chatLog.length > 50) st.chatLog.shift();

  io.to(room).emit("system-message", msg);
  flushPollWaiters(room);
}

function emitLog(type, payload, meta = {}) {
  const room = normalizeRoomSlug(meta.room || "main");
  const st = getRoomState(room);

  const msg = {
    id: st.nextMsgId++,
    type: type || "chat",
    time: getTimeString(),
    ...payload,
  };

  // 送信者socket.id（自分判定用）
  if (meta.fromId) msg.fromId = meta.fromId;

  st.chatLog.push(msg);
  if (st.chatLog.length > 50) st.chatLog.shift();

  io.to(room).emit("chat-message", msg);
  flushPollWaiters(room);
}

function checkRateLimit(room, clientId) {
  const minInterval = Number(moderation?.minIntervalMs ?? 1000);
  if (minInterval <= 0) return 0;

  const k = keyOf(room, clientId || "anon");
  const now = Date.now();
  const last = lastActionTimeByKey[k] || 0;
  const diff = now - last;

  if (diff < minInterval) return minInterval - diff;

  lastActionTimeByKey[k] = now;
  return 0;
}

function getRoomFromHandshake(socket) {
  try {
    const ref = socket.handshake.headers.referer || "";
    const m = String(ref).match(/\/r\/([^\/\?#]+)/);
    return normalizeRoomSlug(m ? m[1] : "main");
  } catch (_) {
    return "main";
  }
}

// ===========================
// ★ お題API（部屋別）
// ===========================

// GET /api/topics?password=...&room=main
app.get("/api/topics", (req, res) => {
  const password = req.query.password || req.headers["x-admin-password"];
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "forbidden" });

  const room = normalizeRoomSlug(req.query.room || "main");
  if (!isRoomAllowed(room)) return res.status(404).json({ error: "room not found" });

  res.json(getTopics(room));
});

// POST /api/topics { password, text, weight, rooms }
app.post("/api/topics", (req, res) => {
  const { password, text, weight, rooms } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "forbidden" });

  try {
    const topic = addTopic("main", text, weight, rooms);
    res.status(201).json(topic);
  } catch (err) {
    console.error("Failed to add topic:", err);
    res.status(400).json({ error: err.message || "bad request" });
  }
});

// PUT /api/topics/:id { password, text, weight, rooms }
app.put("/api/topics/:id", (req, res) => {
  const { password, text, weight, rooms } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "forbidden" });

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  try {
    const topic = updateTopic("main", id, { text, weight, rooms });
    res.json(topic);
  } catch (err) {
    console.error("Failed to update topic:", err);
    res.status(400).json({ error: err.message || "bad request" });
  }
});

// DELETE /api/topics/:id?password=...&room=main
app.delete("/api/topics/:id", (req, res) => {
  const password =
    req.query.password || req.headers["x-admin-password"] || (req.body && req.body.password);

  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "forbidden" });

  const r = normalizeRoomSlug(req.query.room || (req.body && req.body.room) || "main");
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

  // 名前変更（✅ 文字列でも {name} でもOK）
  socket.on("change-name", (payload) => {
    const room = socket.data.roomSlug;
    if (!room || !isRoomAllowed(room)) return;

    const st = getRoomState(room);
    const user = st.users[socket.id];
    if (!user) return;

    const newName =
      (typeof payload === "object" && payload !== null) ? payload.name : payload;

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

  // 色変更（✅ 文字列でも {color} でもOK）
  socket.on("change-color", (payload) => {
    const room = socket.data.roomSlug;
    if (!room || !isRoomAllowed(room)) return;

    const st = getRoomState(room);
    const user = st.users[socket.id];
    if (!user) return;

    const newColor =
      (typeof payload === "object" && payload !== null) ? payload.color : payload;

    const c = (newColor || "").toString().trim();
    if (!c) return;

    user.color = c;
    touchActivity(room, socket.id);

    emitSystem(room, `「${user.name}」さんが吹き出し色を変更しました。`);
  });

  // メッセージ（✅ 文字列でも {text} でもOK）
  socket.on("send-message", (msg) => {
    try {
      const room = socket.data.roomSlug;
      if (!room || !isRoomAllowed(room)) return;

      const st = getRoomState(room);
      const user = st.users[socket.id];
      if (!user) return;

      const text = (typeof msg === "object" && msg !== null)
        ? String(msg.text || "").trim()
        : String(msg || "").trim();

      if (!text) return;

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
    emitLog("topic", { name, topic: drawn.text, color: null }, { fromId: socket.id, room });
  });

  // 入力中（✅ booleanでも {isTyping} でもOK）
  socket.on("typing", (payload) => {
    const room = socket.data.roomSlug;
    if (!room || !isRoomAllowed(room)) return;

    const st = getRoomState(room);
    const user = st.users[socket.id];
    if (!user) return;

    const isTyping =
      (typeof payload === "object" && payload !== null) ? !!payload.isTyping : !!payload;

    if (isTyping) {
      st.typingUsers.add(socket.id);
      touchActivity(room, socket.id);
    } else {
      st.typingUsers.delete(socket.id);
    }
    broadcastTypingUsers(room);
  });

  // 明示的退室（✅ 引数が来ても無視でOK）
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
