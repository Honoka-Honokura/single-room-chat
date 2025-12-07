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

// 時刻文字列を作る関数
function getTimeString() {
    return new Date().toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit"
    });
}

// 全員にオンラインユーザー一覧を送信（名前だけ）
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

io.on("connection", (socket) => {
    console.log("connected:", socket.id);

    // 接続直後に、現在のオンラインユーザー一覧をその人に送る
    const currentUsers = Object.values(users).map(u => u.name);
    socket.emit("user-list", currentUsers);

    // 入室リクエスト
    // 旧バージョン互換のため payload は string か { name, color } を許容
    socket.on("join", (payload) => {
        // すでに入ってたら無視
        if (users[socket.id]) return;

        // 人数制限
        const currentCount = Object.keys(users).length;
        if (currentCount >= MAX_USERS) {
            socket.emit("room-full");
            return;
        }

        let name  = "";
        let color = null;

        if (typeof payload === "string") {
            // 互換用：昔のクライアントは name だけ送ってくる
            name = payload;
        } else if (payload && typeof payload === "object") {
            name  = payload.name;
            color = payload.color;
        }

        // 名前が空なら仮名
        const displayName = name && String(name).trim()
            ? String(name).trim()
            : "user-" + Math.floor(Math.random() * 1000);

        // 色は文字列が来ていればそのまま保持（なければ null）
        const bubbleColor = (typeof color === "string" && color.trim())
            ? color.trim()
            : null;

        // 登録（name + color）
        users[socket.id] = { name: displayName, color: bubbleColor };
        socket.join(ROOM_NAME);

        console.log(displayName, "joined with color:", bubbleColor);

        // システムメッセージ（入室）
        io.to(ROOM_NAME).emit("system-message", {
            time: getTimeString(),
            text: `「${displayName}」さんが入室しました。`
        });

        // すでにチャットログがあれば、その入室した人にだけまとめて送る
        if (chatLog.length > 0) {
            socket.emit("chat-log", chatLog);
        }

        // ユーザー一覧更新
        broadcastUserList();
    });

    // 名前変更
    socket.on("change-name", (newName) => {
        const user = users[socket.id];
        if (!user) return;

        const oldName = user.name;
        const trimmed = newName.trim();
        if (!trimmed || trimmed === oldName) return;

        user.name = trimmed;

        io.to(ROOM_NAME).emit("system-message", {
            time: getTimeString(),
            text: `「${oldName}」さんは名前を「${trimmed}」に変更しました。`
        });

        broadcastUserList();
    });

    // メッセージ送信
    socket.on("send-message", (msg) => {
        const user = users[socket.id];
        if (!user) return;

        const text = msg.trim();
        if (!text) return;

        const time  = getTimeString();
        const color = user.color || null;   // ★ ユーザーに設定された色

        // チャットログに保存（color も一緒に）
        chatLog.push({
            time,
            name: user.name,
            text,
            color
        });

        // ログが増えすぎないように最新50件だけ残す
        if (chatLog.length > 50) {
            chatLog.shift();
        }

        // 全員に送信（color も一緒に届ける）
        io.to(ROOM_NAME).emit("chat-message", {
            time,
            name: user.name,
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

        delete users[socket.id];
        typingUsers.delete(socket.id);
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
        if (user) {
            const leftName = user.name;
            delete users[socket.id];
            typingUsers.delete(socket.id);

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
        }

        console.log("disconnected:", socket.id);
    });
});

http.listen(3000, () => {
    console.log("Server running at http://localhost:3000");
});
