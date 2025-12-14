// server.js
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");

// ★ Socket.io：スマホ/タブ切替での不安定さを少しでも軽減
const io = new Server(http, {
  pingInterval: 20000,
  pingTimeout: 20000,
  transports: ["websocket", "polling"],
});

// ★ お題ガチャ用のモジュール（永続化＋編集・削除対応）
const { drawTopic, getTopics, addTopic, updateTopic, deleteTopic } = require("./topics");

// ★ お題ガチャ専用クールダウン（ミリ秒）
const TOPIC_COOLDOWN_MS = 5000; // 5秒

// ★ キャッシュ対策（HTML/JS/CSS）
app.use((req, res, next) => {
  if (
    req.path === "/" ||
    req.path.endsWith(".html") ||
    req.path.endsWith(".js") ||
    req.path.endsWith(".css")
  ) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

// public フォルダを静的配信
app.use(express.static("public"));
// JSONボディを受け取るため
app.use(express.json());

// 1部屋だけ使うので、部屋名は固定
const ROOM_NAME = "main-room";

// 接続中ユーザー一覧: { socket.id: { name, color } }
const users = {};

// 「入力中」のユーザー一覧: Set<socket.id>
const typingUsers = new Set();

// チャットログ（メモリ上に一時保存）
const chatLog = [];

// ★ ログに連番IDを付ける（ポーリングの差分取得に使う）
let nextMessageId = 1;

// ★ ロングポーリング待機者
const pollWaiters = new Set(); // { sinceId, res, timer }
const POLL_TIMEOUT_MS = 25000; // 25秒

// 最大人数
const MAX_USERS = 10;

// 10分（ミリ秒）
const AUTO_LEAVE_MS = 10 * 60 * 1000;

// 連投制限（1秒）
const MIN_INTERVAL_MS = 1000;

// clientId ごとの最後のアクション時刻
const lastActionTimeByClientId = {};

// ★ お題ガチャ専用：clientId ごとの最後のガチャ時間
const lastTopicTimeByClientId = {};

// ★ socket.id → clientId の対応
const socketClientIds = {};

// ★ clientId ごとの「最後に *意図せず* 退室した時刻」
const lastLeaveByClientId = {};

// URL貼りすぎ防止
const URL_REGEX = /(https?:\/\/[^\s]+)/gi;
const MAX_URLS_PER_MESSAGE = 3;

// 危険・スパムとみなすドメイン
const BLOCKED_URL_DOMAINS = ["bit.ly", "t.co", "discord.gg", "goo.gl", "tinyurl.com"];

// NGワードチェック用
function normalizeForCheck(text) {
  if (!text) return "";
  return text.toString().normalize("NFKC").toLowerCase();
}

const NG_WORDS = [
  "殺す",
  "死ね",
  "自殺",
  "じさつ",
  "誘拐",
  "ゆうかい",
  "障害者",
  "知的障害",
  "ガイジ",
  "池沼",
  "バカ",
  "アホ",
  "消えろ",
  "投資しませんか",
  "簡単に稼げ",
  "出会い系",
  "出会いサイト",
  "sex",
  "porn",
];

function containsNgWord(text) {
  const normalized = normalizeForCheck(text);
  return NG_WORDS.some((word) => normalized.includes(word));
}

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

// 無操作タイマー
const lastActivityTimes = {};
const INACTIVITY_LIMIT_MS = 10 * 60 * 1000;

function touchActivity(socketId) {
  lastActivityTimes[socketId] = Date.now();
}

// 時刻文字列
function getTimeString() {
  return new Date().toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 共通の連投チェック関数
function checkRateLimit(clientId) {
  if (!clientId) return 0;

  const now = Date.now();
  const last = lastActionTimeByClientId[clientId] || 0;
  const diff = now - last;

  if (diff < MIN_INTERVAL_MS) {
    return MIN_INTERVAL_MS - diff;
  }

  lastActionTimeByClientId[clientId] = now;
  return 0;
}

// ★ chatLogに追加しつつ、ロングポーリング待機者にも配る
function pushLog(entry) {
  const e = {
    id: nextMessageId++,
    ...entry,
  };

  chatLog.push(e);
  if (chatLog.length > 50) chatLog.shift();

  // ロングポーリング待機者に新着を返す
  for (const w of Array.from(pollWaiters)) {
    const news = chatLog.filter((m) => m.id > w.sinceId);
    if (news.length > 0) {
      clearTimeout(w.timer);
      pollWaiters.delete(w);
      w.res.json({ ok: true, messages: news, serverTime: Date.now() });
    }
  }

  return e;
}

/**
 * ✅ emitLog(type, payload)
 * - pushLogで必ずidを付ける
 * - Socketイベントもここで統一して送る
 *
 * type: "system" | "chat" | "dice" | "topic"
 * payload:
 *   system: { text }
 *   chat/dice: { name, text, color }
 *   topic: { name, topic }
 *
 * opts:
 *   { fromId?: string, room?: string }
 */
function emitLog(type, payload, opts = {}) {
  const time = getTimeString();
  const room = opts.room || ROOM_NAME;

  const saved = pushLog({
    type,
    time,
    ...payload,
  });

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

// ★ 互換用（読みやすさのため残す）
function emitSystem(text) {
  return emitLog("system", { text });
}

function broadcastUserList() {
  const userList = Object.values(users).map((u) => u.name);
  io.to(ROOM_NAME).emit("user-list", userList);
}

function broadcastTypingUsers() {
  const names = Array.from(typingUsers)
    .map((id) => users[id]?.name)
    .filter(Boolean);
  io.to(ROOM_NAME).emit("typing-users", names);
}

// 無操作チェック
setInterval(() => {
  const now = Date.now();

  for (const [socketId, last] of Object.entries(lastActivityTimes)) {
    if (now - last < INACTIVITY_LIMIT_MS) continue;

    const user = users[socketId];
    if (!user) {
      delete lastActivityTimes[socketId];
      continue;
    }

    const leftName = user.name;
    delete users[socketId];
    typingUsers.delete(socketId);
    delete lastActivityTimes[socketId];

    const clientId = socketClientIds[socketId];
    if (clientId) {
      delete socketClientIds[socketId];
    }

    const s = io.sockets.sockets.get(socketId);
    if (s) {
      s.leave(ROOM_NAME);
      s.emit("force-leave", { reason: "timeout" });
    }

    emitSystem(`「${leftName}」さんは一定時間操作がなかったため退室しました。`);

    broadcastUserList();
    broadcastTypingUsers();

    if (Object.keys(users).length === 0) {
      chatLog.length = 0;
      typingUsers.clear();
      console.log("All users left. chatLog cleared (by auto-timeout).");
    }
  }
}, 60 * 1000);

// ===========================
// 管理用シンプルAPI
// ===========================

// ★ 本番では .env などで外出し推奨
const ADMIN_PASSWORD = "090919Honoka";

// 一覧取得
app.get("/api/topics", (req, res) => {
  const password = req.query.password || req.headers["x-admin-password"];
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "forbidden" });
  }
  res.json(getTopics());
});

// 追加
app.post("/api/topics", (req, res) => {
  const { password, text, weight } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "forbidden" });
  }
  try {
    const topic = addTopic(text, weight);
    res.status(201).json(topic);
  } catch (err) {
    console.error("Failed to add topic:", err);
    res.status(400).json({ error: err.message || "bad request" });
  }
});

// 更新
app.put("/api/topics/:id", (req, res) => {
  const { password, text, weight } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "forbidden" });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "invalid id" });
  }

  try {
    const topic = updateTopic(id, { text, weight });
    res.json(topic);
  } catch (err) {
    console.error("Failed to update topic:", err);
    res.status(400).json({ error: err.message || "bad request" });
  }
});

// 削除
app.delete("/api/topics/:id", (req, res) => {
  const password =
    req.query.password || req.headers["x-admin-password"] || (req.body && req.body.password);

  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "forbidden" });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "invalid id" });
  }

  try {
    const removed = deleteTopic(id);
    res.json({ ok: true, removed });
  } catch (err) {
    console.error("Failed to delete topic:", err);
    res.status(400).json({ error: err.message || "bad request" });
  }
});

// ===========================
// ★ ロングポーリング用API（ルブル寄り）
// ===========================

// 初回：最新ログ取得
app.get("/api/log", (req, res) => {
  res.json({ ok: true, messages: chatLog, serverTime: Date.now() });
});

// 差分：新着が来るまで最大25秒待つ
app.get("/api/poll", (req, res) => {
  const sinceId = Number(req.query.since || 0);

  // 既に新着があるなら即返す
  const news = chatLog.filter((m) => m.id > sinceId);
  if (news.length > 0) {
    return res.json({ ok: true, messages: news, serverTime: Date.now() });
  }

  // なければ待つ
  const waiter = {
    sinceId,
    res,
    timer: setTimeout(() => {
      pollWaiters.delete(waiter);
      res.json({ ok: true, messages: [], serverTime: Date.now() });
    }, POLL_TIMEOUT_MS),
  };
  pollWaiters.add(waiter);

  // 途中でクライアントが切れたら掃除
  req.on("close", () => {
    clearTimeout(waiter.timer);
    pollWaiters.delete(waiter);
  });
});

// ===========================
// Socket.io メイン処理
// ===========================
io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  const currentUsers = Object.values(users).map((u) => u.name);
  socket.emit("user-list", currentUsers);

  // 入室
  socket.on("join", (payload) => {
    if (users[socket.id]) return;

    const currentCount = Object.keys(users).length;
    if (currentCount >= MAX_USERS) {
      socket.emit("room-full");
      return;
    }

    let rawName = "";
    let color = null;
    let clientId = null;

    if (typeof payload === "string" || payload === undefined || payload === null) {
      rawName = payload || "";
    } else {
      rawName = payload.name || "";
      color = payload.color || null;
      clientId = payload.clientId || null;
    }

    if (!clientId) clientId = socket.id;
    socketClientIds[socket.id] = clientId;

    const displayName =
      rawName && rawName.trim() ? rawName.trim() : "user-" + Math.floor(Math.random() * 1000);

    users[socket.id] = { name: displayName, color };
    socket.join(ROOM_NAME);

    console.log(displayName, "joined (clientId:", clientId, ")");

    const now = Date.now();
    let shouldAnnounceJoin = true;
    const lastLeave = lastLeaveByClientId[clientId];

    if (lastLeave && now - lastLeave < AUTO_LEAVE_MS) {
      shouldAnnounceJoin = false;
    }

    if (shouldAnnounceJoin) {
      emitSystem(`「${displayName}」さんが入室しました。`);
    }

    // 過去ログを送る（id付き）
    if (chatLog.length > 0) {
      socket.emit("chat-log", chatLog);
    }

    broadcastUserList();
    touchActivity(socket.id);
  });

  // 名前変更
  socket.on("change-name", (newName) => {
    const user = users[socket.id];
    if (!user) return;

    const oldName = user.name;
    const trimmed = (newName || "").trim();
    if (!trimmed || trimmed === oldName) return;

    user.name = trimmed;
    touchActivity(socket.id);

    emitSystem(`「${oldName}」さんは名前を「${trimmed}」に変更しました。`);
    broadcastUserList();
  });

  // 吹き出し色の変更
  socket.on("change-color", (newColor) => {
    const user = users[socket.id];
    if (!user) return;

    const color = (newColor || "").toString().trim();
    if (!color) return;

    user.color = color;
    touchActivity(socket.id);

    emitSystem(`「${user.name}」さんが吹き出し色を変更しました。`);
  });

  // メッセージ送信
  socket.on("send-message", (msg) => {
    const user = users[socket.id];
    if (!user) return;

    const text = (msg || "").toString().trim();
    if (!text) return;

    // ここは「本人だけに出す警告」なのでログに残さない（idなしOK）
    if (containsPersonalInfo(text)) {
      socket.emit("system-message", {
        time: getTimeString(),
        text: "個人情報（電話番号やメールアドレスなど）は送信できません。",
      });
      return;
    }

    if (containsNgWord(text)) {
      socket.emit("system-message", {
        time: getTimeString(),
        text: "NGワードが含まれているため、送信できません。",
      });
      return;
    }

    const urls = text.match(URL_REGEX) || [];
    if (urls.length > MAX_URLS_PER_MESSAGE) {
      socket.emit("system-message", {
        time: getTimeString(),
        text: `1つのメッセージに貼れるURLは最大 ${MAX_URLS_PER_MESSAGE} 件までです。`,
      });
      return;
    }

    if (urls.length > 0) {
      try {
        for (const raw of urls) {
          const urlStr = raw.startsWith("http") ? raw : `http://${raw}`;
          const u = new URL(urlStr);
          const host = u.hostname.toLowerCase();

          if (BLOCKED_URL_DOMAINS.some((domain) => host === domain || host.endsWith("." + domain))) {
            socket.emit("system-message", {
              time: getTimeString(),
              text: "安全のため、一部の短縮URLや招待リンクは送信できません。",
            });
            return;
          }
        }
      } catch (e) {
        console.warn("URL parse error:", e);
      }
    }

    const clientId = socketClientIds[socket.id] || socket.id;
    const waitMs = checkRateLimit(clientId);
    if (waitMs > 0) {
      socket.emit("rate-limit", { waitMs });
      return;
    }

    touchActivity(socket.id);

    emitLog(
      "chat",
      {
        name: user.name,
        text,
        color: user.color || null,
      },
      { fromId: socket.id }
    );
  });

  // 2D6
  socket.on("roll-dice", () => {
    const user = users[socket.id];
    if (!user) return;

    const clientId = socketClientIds[socket.id] || socket.id;
    const waitMs = checkRateLimit(clientId);
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

    emitLog(
      "dice",
      {
        name,
        text,
        color,
      },
      { fromId: socket.id }
    );
  });

  // お題ガチャ
  socket.on("draw-topic", () => {
    const user = users[socket.id];
    if (!user) return;

    const clientId = socketClientIds[socket.id];
    if (!clientId) return;

    const now = Date.now();

    const last = lastTopicTimeByClientId[clientId] || 0;
    const diff = now - last;

    if (diff < TOPIC_COOLDOWN_MS) {
      const waitMs = TOPIC_COOLDOWN_MS - diff;
      socket.emit("rate-limit", { waitMs });
      return;
    }

    lastTopicTimeByClientId[clientId] = now;

    const drawn = drawTopic();
    if (!drawn) return;

    const name = user.name || "匿名";
    const topicText = drawn.text;

    emitLog("topic", {
      name,
      topic: topicText,
      color: null,
    });
  });

  // 入力中
  socket.on("typing", (isTyping) => {
    const user = users[socket.id];
    if (!user) return;

    if (isTyping) {
      typingUsers.add(socket.id);
      touchActivity(socket.id);
    } else {
      typingUsers.delete(socket.id);
    }
    broadcastTypingUsers();
  });

  // 明示的退室
  socket.on("leave", () => {
    const user = users[socket.id];
    if (!user) return;

    const leftName = user.name;

    const clientId = socketClientIds[socket.id];
    if (clientId) {
      delete socketClientIds[socket.id];
    }

    delete users[socket.id];
    typingUsers.delete(socket.id);
    delete lastActivityTimes[socket.id];

    socket.leave(ROOM_NAME);

    emitSystem(`「${leftName}」さんが退室しました。`);

    broadcastUserList();
    broadcastTypingUsers();

    if (Object.keys(users).length === 0) {
      chatLog.length = 0;
      typingUsers.clear();
      console.log("All users left. chatLog cleared.");
    }
  });

  // 切断
  socket.on("disconnect", () => {
    const user = users[socket.id];

    const clientId = socketClientIds[socket.id];
    if (clientId) {
      lastLeaveByClientId[clientId] = Date.now();
      delete socketClientIds[socket.id];
    }

    if (user) {
      delete users[socket.id];
      typingUsers.delete(socket.id);
      delete lastActivityTimes[socket.id];

      broadcastUserList();
      broadcastTypingUsers();

      if (Object.keys(users).length === 0) {
        chatLog.length = 0;
        typingUsers.clear();
        console.log("All users left. chatLog cleared.");
      }
    }

    console.log("disconnected:", socket.id);
  });
});

http.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});
