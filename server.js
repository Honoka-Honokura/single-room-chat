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

// ★ socket.id → clientId の対応
const socketClientIds = {};

// ★ clientId ごとの「最後に *意図せず* 退室した時刻」
//   （ブラウザ閉じなどの disconnect 専用）
const lastLeaveByClientId = {};

// ★ 連投防止用（前回メッセージ送信時刻）: { socket.id: timestamp(ms) }
const lastMessageTimes = {};
const MIN_INTERVAL_MS = 1000;  // 1秒に1通まで

// ★ URL貼りすぎ防止
const URL_REGEX = /(https?:\/\/[^\s]+)/gi;
const MAX_URLS_PER_MESSAGE = 3; // 1メッセージ内の最大URL数

// ★ NGワードリスト（必要に応じて調整してOK）
const NG_WORDS = [
    // 暴力・犯罪系
    "殺す", "死ね", "自殺", "誘拐", "テロ", "爆破",

    // 差別・侮辱
    "障害者", "ガイジ", "池沼", "知的障害", "キモい", "ハゲ",

    // 過度な暴言
    "バカ", "アホ", "消えろ",

    // スパム/詐欺系
    "crypto", "ビットコイン", "副業", "投資しませんか", "出会い系", "DMください", "line交換",

    // ポルノスパム用
    "porn", "sex"
];

// NGワード判定（簡易版）
function containsNgWord(text) {
    const lower = text.toLowerCase();
    return NG_WORDS.some(word => {
        if (!word) return false;
        return lower.includes(word.toLowerCase());
    });
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

    if (EMAIL_REGEX.test(text)) return true;

    for (const re of PHONE_REGEXES) {
        if (re.test(text)) return true;
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

// 時刻文字列を作る関数
function getTimeString() {
    return new Date().toLocaleTimeString("ja-JP", {
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
        delete lastMessageTimes[socketId];
        delete lastActivityTimes[socketId];

        const s = io.sockets.sockets.get(socketId);
        if (s) {
            s.leave(ROOM_NAME);
            // クライアントに「自動退室された」ことを通知
            s.emit("force-leave", { reason: "timeout" });
        }

        // 他のユーザーにシステムメッセージ（★これは残す）
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
        user.color = newColor || null;
        touchActivity(socket.id);
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

        // 連投防止チェック
        const now = Date.now();
        const last = lastMessageTimes[socket.id] || 0;
        if (now - last < MIN_INTERVAL_MS) {
            socket.emit("system-message", {
                time: getTimeString(),
                text: `連投防止のため、${MIN_INTERVAL_MS / 1000}秒待ってから送信してください。`
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

        // ここまでOKなら送信を許可
        lastMessageTimes[socket.id] = now;
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

        // ログが増えすぎないように最新50件だけ残す
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

        // ★ 手動退室では「再入室メッセージ抑制」の対象にしないので
        //     lastLeaveByClientId は触らない
        const clientId = socketClientIds[socket.id];
        delete socketClientIds[socket.id];

        delete users[socket.id];
        typingUsers.delete(socket.id);
        delete lastMessageTimes[socket.id];
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
            delete lastMessageTimes[socket.id];
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
