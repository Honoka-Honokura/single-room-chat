// server.js
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const io = new Server(http);

// public フォルダを静的配信
app.use(express.static("public"));

// 1部屋だけ使うので、部屋名は固定
const ROOM_NAME = "main-room";

// 接続中ユーザー一覧: { socket.id: { name, color } }
const users = {};

// 「入力中」のユーザー一覧: Set<socket.id>
const typingUsers = new Set();

// チャットログ（メモリ上に一時保存）: { time, name, text, color }[]
const chatLog = [];

// 最大人数
const MAX_USERS = 10;

// 10分（ミリ秒）
const AUTO_LEAVE_MS = 10 * 60 * 1000;

// 連投制限（1秒）
const MIN_INTERVAL_MS = 1000;

// clientId ごとの最後のアクション時刻（発言 or ダイス）
const lastActionTimeByClientId = {};

// 共通の連投チェック関数
function checkRateLimit(clientId) {
    if (!clientId) return 0;

    const now  = Date.now();
    const last = lastActionTimeByClientId[clientId] || 0;
    const diff = now - last;

    if (diff < MIN_INTERVAL_MS) {
        // 残り待ち時間を返す（ミリ秒）
        return MIN_INTERVAL_MS - diff;
    }

    // OK のときは「今」を記録して 0 を返す
    lastActionTimeByClientId[clientId] = now;
    return 0;
}

// ★ socket.id → clientId の対応
const socketClientIds = {};

// ★ clientId ごとの「最後に *意図せず* 退室した時刻」
//   （ブラウザ閉じなどの disconnect 専用）
const lastLeaveByClientId = {};

// ★ URL貼りすぎ防止
const URL_REGEX = /(https?:\/\/[^\s]+)/gi;
const MAX_URLS_PER_MESSAGE = 3; // 1メッセージ内の最大URL数

// ★ 危険・スパムとみなすドメイン（必要に応じて調整）
const BLOCKED_URL_DOMAINS = [
    "bit.ly",
    "t.co",
    "discord.gg",
    "goo.gl",
    "tinyurl.com"
];

// ★ NGワードチェック用の正規化
function normalizeForCheck(text) {
    if (!text) return "";
    return text
        .toString()
        .normalize("NFKC")   // 全角/半角などを揃える
        .toLowerCase();      // 英字は小文字に
}

// ★ NGワードリスト（必要に応じて調整してOK）
// normalize後の文字列で扱う前提
const NG_WORDS = [
    // 暴力・犯罪系
    "殺す", "死ね", "自殺", "じさつ", "誘拐", "ゆうかい",

    // 差別・侮辱（※必要に応じて調整）
    "障害者", "知的障害", "ガイジ", "池沼",

    // 過度な暴言
    "バカ", "アホ", "消えろ", 

    // スパム/詐欺系
    "投資しませんか", "簡単に稼げ", "出会い系", "出会いサイト",

    // ポルノ・スパム系（マイルドに）
    "sex", "porn" 
];

// NGワード判定（正規化＋単純リストのみ）
function containsNgWord(text) {
    const normalized = normalizeForCheck(text);

    // NG_WORDS の部分一致のみで判定
    return NG_WORDS.some(word => normalized.includes(word));
}

// ===========================
// 個人情報（メール・電話番号）の検出
// ===========================

// メールアドレスっぽい文字列
const EMAIL_REGEX =
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// 日本の電話番号っぽい書式いろいろ
const PHONE_REGEXES = [
    // 090-1234-5678 / 03-1234-5678 など ハイフンあり
    /0\d{1,4}-\d{1,4}-\d{3,4}/,
    // 09012345678 / 0312345678 など ハイフンなし 10〜11桁
    /\b0\d{9,10}\b/
];

// テキスト内に個人情報が含まれているか？
function containsPersonalInfo(text) {
    if (!text) return false;

    const normalized = normalizeForCheck(text);

    if (EMAIL_REGEX.test(normalized)) return true;

    for (const re of PHONE_REGEXES) {
        if (re.test(normalized)) return true;
    }
    return false;
}

// ===========================
// 無操作タイマー用
// ===========================

// 最終アクティビティ時刻: { socket.id: timestamp(ms) }
const lastActivityTimes = {};
// 10分（ミリ秒）
const INACTIVITY_LIMIT_MS = 10 * 60 * 1000;

// アクティビティ記録ヘルパー
function touchActivity(socketId) {
    lastActivityTimes[socketId] = Date.now();
}

function getTimeString() {
    return new Date().toLocaleTimeString("ja-JP", {
        timeZone: "Asia/Tokyo",
        hour: "2-digit",
        minute: "2-digit"
    });
}

// 全員にオンラインユーザー一覧を送信
function broadcastUserList() {
    const userList = Object.values(users).map(u => u.name);
    io.to(ROOM_NAME).emit("user-list", userList);
}

// 「入力中ユーザー」一覧を送信
function broadcastTypingUsers() {
    const names = Array.from(typingUsers)
        .map(id => users[id]?.name)
        .filter(Boolean);
    io.to(ROOM_NAME).emit("typing-users", names);
}

// ===========================
// 一定時間無操作ユーザーを自動退室させるチェック
// ===========================
setInterval(() => {
    const now = Date.now();

    for (const [socketId, last] of Object.entries(lastActivityTimes)) {
        if (now - last < INACTIVITY_LIMIT_MS) continue;

        const user = users[socketId];
        if (!user) {
            // 既に退室済みならクリーンアップだけ
            delete lastActivityTimes[socketId];
            continue;
        }

        const leftName = user.name;

        // サーバー側の状態を削除
        delete users[socketId];
        typingUsers.delete(socketId);
        delete lastActivityTimes[socketId];

        // clientId ベースの情報も必要ならここで掃除
        const clientId = socketClientIds[socketId];
        if (clientId) {
            delete socketClientIds[socketId];
        }

        const s = io.sockets.sockets.get(socketId);
        if (s) {
            s.leave(ROOM_NAME);
            // クライアントに「自動退室された」ことを通知
            s.emit("force-leave", { reason: "timeout" });
        }

        // 他のユーザーにシステムメッセージ
        io.to(ROOM_NAME).emit("system-message", {
            time: getTimeString(),
            text: `「${leftName}」さんは一定時間操作がなかったため退室しました。`
        });

        broadcastUserList();
        broadcastTypingUsers();

        // 全員いなくなったらチャットログをクリア
        if (Object.keys(users).length === 0) {
            chatLog.length = 0;
            typingUsers.clear();
            console.log("All users left. chatLog cleared (by auto-timeout).");
        }
    }
}, 60 * 1000); // 1分ごとにチェック

// ===========================
// Socket.io メイン処理
// ===========================
io.on("connection", (socket) => {
    console.log("connected:", socket.id);

    // 接続直後に、現在のオンラインユーザー一覧をその人に送る
    const currentUsers = Object.values(users).map(u => u.name);
    socket.emit("user-list", currentUsers);

    // 入室リクエスト
    // 旧仕様: join("名前")
    // 新仕様: join({ name, color, clientId })
    socket.on("join", (payload) => {
        if (users[socket.id]) return;  // すでに入ってたら無視

        // 人数制限
        const currentCount = Object.keys(users).length;
        if (currentCount >= MAX_USERS) {
            socket.emit("room-full");
            return;
        }

        let rawName  = "";
        let color    = null;
        let clientId = null;

        if (typeof payload === "string" || payload === undefined || payload === null) {
            rawName = payload || "";
        } else {
            rawName  = payload.name  || "";
            color    = payload.color || null;
            clientId = payload.clientId || null;
        }

        // clientId がない場合は socket.id を代わりに使う
        if (!clientId) {
            clientId = socket.id;
        }

        // この socket と clientId の対応を保存
        socketClientIds[socket.id] = clientId;

        // 名前が空なら仮名
        const displayName = rawName && rawName.trim()
            ? rawName.trim()
            : "user-" + Math.floor(Math.random() * 1000);

        // 登録
        users[socket.id] = {
            name:  displayName,
            color: color
        };
        socket.join(ROOM_NAME);

        console.log(displayName, "joined (clientId:", clientId, ")");

        // ★ 入室メッセージを出すかどうか判定
        const now = Date.now();
        let shouldAnnounceJoin = true;
        const lastLeave = lastLeaveByClientId[clientId];

        // 「意図しない切断（disconnect）から10分以内の再接続」は再入室メッセージを出さない
        if (lastLeave && (now - lastLeave) < AUTO_LEAVE_MS) {
            shouldAnnounceJoin = false;
        }

        if (shouldAnnounceJoin) {
            io.to(ROOM_NAME).emit("system-message", {
                time: getTimeString(),
                text: `「${displayName}」さんが入室しました。`
            });
        }

        // すでにチャットログがあれば、その入室した人にだけまとめて送る
        if (chatLog.length > 0) {
            socket.emit("chat-log", chatLog);
        }

        // ユーザー一覧更新
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

        io.to(ROOM_NAME).emit("system-message", {
            time: getTimeString(),
            text: `「${oldName}」さんは名前を「${trimmed}」に変更しました。`
        });

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

        // 任意：システムメッセージで他ユーザーに通知
        io.to(ROOM_NAME).emit("system-message", {
            time: getTimeString(),
            text: `「${user.name}」さんが吹き出し色を変更しました。`
        });
    });

    // メッセージ送信
    socket.on("send-message", (msg) => {
        const user = users[socket.id];
        if (!user) return;

        const text = (msg || "").toString().trim();
        if (!text) return;

        // 個人情報チェック（メール・電話番号）
        if (containsPersonalInfo(text)) {
            socket.emit("system-message", {
                time: getTimeString(),
                text: "個人情報（電話番号やメールアドレスなど）は送信できません。"
            });
            return;
        }

        // NGワードチェック
        if (containsNgWord(text)) {
            socket.emit("system-message", {
                time: getTimeString(),
                text: "NGワードが含まれているため、送信できません。"
            });
            return;
        }

        // URL貼りすぎチェック
        const urls = text.match(URL_REGEX) || [];
        if (urls.length > MAX_URLS_PER_MESSAGE) {
            socket.emit("system-message", {
                time: getTimeString(),
                text: `1つのメッセージに貼れるURLは最大 ${MAX_URLS_PER_MESSAGE} 件までです。`
            });
            return;
        }

        // 危険なドメインの URL をブロック
        if (urls.length > 0) {
            try {
                for (const raw of urls) {
                    const urlStr = raw.startsWith("http") ? raw : `http://${raw}`;
                    const u = new URL(urlStr);
                    const host = u.hostname.toLowerCase();

                    if (BLOCKED_URL_DOMAINS.some(domain => host === domain || host.endsWith("." + domain))) {
                        socket.emit("system-message", {
                            time: getTimeString(),
                            text: "安全のため、一部の短縮URLや招待リンクは送信できません。"
                        });
                        return;
                    }
                }
            } catch (e) {
                console.warn("URL parse error:", e);
            }
        }

        // ★ ここで共通の連投チェック（メッセージ & ダイス共通）
        const clientId = socketClientIds[socket.id] || socket.id; // 念のため fallback
        const waitMs = checkRateLimit(clientId);
        if (waitMs > 0) {
            socket.emit("rate-limit", { waitMs });
            return;
        }

        // ここまでOKなら送信を許可
        touchActivity(socket.id);

        const time = getTimeString();

        // チャットログに保存（色も一緒に）
        const logEntry = {
            time,
            name: user.name,
            text,
            color: user.color || null
        };
        chatLog.push(logEntry);

        if (chatLog.length > 50) {
            chatLog.shift();
        }

        // 全員に送信（色も一緒に送る）
        io.to(ROOM_NAME).emit("chat-message", {
            time,
            name: user.name,
            text,
            fromId: socket.id,
            color: user.color || null
        });
    });

    // 2D6 のダイスを振る
    socket.on("roll-dice", () => {
        const user = users[socket.id];
        if (!user) return;  // 未入室なら無視

        // ★ メッセージと同じ 1秒連投制限（clientId 単位）
        const clientId = socketClientIds[socket.id] || socket.id;
        const waitMs = checkRateLimit(clientId);
        if (waitMs > 0) {
            socket.emit("rate-limit", { waitMs });
            return;
        }

        const d1 = Math.floor(Math.random() * 6) + 1;
        const d2 = Math.floor(Math.random() * 6) + 1;
        const total = d1 + d2;

        const time  = getTimeString();
        const name  = user.name || "ななし";
        const color = user.color || "#FFFFFF";

        const text = `🎲 ${name} が 2D6 を振った：${d1} ＋ ${d2} ＝ ${total}`;

        // チャットログに追加
        chatLog.push({ time, name, text, color });
        if (chatLog.length > 50) {
            chatLog.shift();
        }

        // 通常のメッセージとして全員に送る
        io.to(ROOM_NAME).emit("chat-message", {
            time,
            name,
            text,
            fromId: socket.id,
            color
        });
    });

    // 入力中フラグ
    socket.on("typing", (isTyping) => {
        const user = users[socket.id];
        if (!user) return;

        if (isTyping) {
            typingUsers.add(socket.id);
            touchActivity(socket.id);   // 入力中も「操作」とみなす
        } else {
            typingUsers.delete(socket.id);
        }
        broadcastTypingUsers();
    });

    // 退室（明示的）
    socket.on("leave", () => {
        const user = users[socket.id];
        if (!user) return;

        const leftName = user.name;

        const clientId = socketClientIds[socket.id];
        if (clientId) {
            // 明示的退室なので、再入室時にメッセージを抑制しないよう
            // lastLeaveByClientId は更新しない設計
            delete socketClientIds[socket.id];
        }

        delete users[socket.id];
        typingUsers.delete(socket.id);
        delete lastActivityTimes[socket.id];

        socket.leave(ROOM_NAME);

        io.to(ROOM_NAME).emit("system-message", {
            time: getTimeString(),
            text: `「${leftName}」さんが退室しました。`
        });

        broadcastUserList();
        broadcastTypingUsers();

        // 全員いなくなったらチャットログをクリア
        if (Object.keys(users).length === 0) {
            chatLog.length = 0;
            typingUsers.clear();
            console.log("All users left. chatLog cleared.");
        }
    });

    // 切断（ブラウザ閉じなど）
    socket.on("disconnect", () => {
        const user = users[socket.id];

        // ★ ここが「意図しない退室」とみなす場所
        //    → この clientId に対して「最後の退室時刻」を記録
        const clientId = socketClientIds[socket.id];
        if (clientId) {
            lastLeaveByClientId[clientId] = Date.now();
            delete socketClientIds[socket.id];
        }

        if (user) {
            delete users[socket.id];
            typingUsers.delete(socket.id);
            delete lastActivityTimes[socket.id];

            // ※ disconnect では「退室しました」メッセージは出さない
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
