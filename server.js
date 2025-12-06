const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const io = new Server(http);

// public フォルダを静的配信
app.use(express.static("public"));

// 1部屋だけ使うので、部屋名は固定
const ROOM_NAME = "main-room";

// 接続中ユーザー一覧: { socket.id: { name } }
const users = {};

// 「入力中」のユーザー一覧: Set<socket.id>
const typingUsers = new Set();

// チャットログ（メモリ上に一時保存）
const chatLog = [];  // { time, name, text } を順番に入れていく

// 最大人数
const MAX_USERS = 10;

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

io.on("connection", (socket) => {
    console.log("connected:", socket.id);

    // 入室リクエスト
    socket.on("join", (name) => {
        // すでに入ってたら無視
        if (users[socket.id]) return;

        // 人数制限
        const currentCount = Object.keys(users).length;
        if (currentCount >= MAX_USERS) {
            socket.emit("room-full");
            return;
        }

        // 名前が空なら仮名
        const displayName = name && name.trim()
            ? name.trim()
            : "user-" + Math.floor(Math.random() * 1000);

        // 登録
        users[socket.id] = { name: displayName };
        socket.join(ROOM_NAME);

        console.log(displayName, "joined");

        // システムメッセージ（入室）
        io.to(ROOM_NAME).emit("system-message", {
            time: getTimeString(),
            text: `「${displayName}」さんが入室しました。`
        });

        // ★ すでにチャットログがあれば、その入室した人にだけまとめて送る
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

        // システムメッセージ（名前変更）
        io.to(ROOM_NAME).emit("system-message", {
            time: getTimeString(),
            text: `「${oldName}」さんは名前を「${trimmed}」に変更しました。`
        });

        // ユーザー一覧更新
        broadcastUserList();
    });

    // メッセージ送信
    socket.on("send-message", (msg) => {
        const user = users[socket.id];
        if (!user) return;

        const text = msg.trim();
        if (!text) return;

        const time = getTimeString();

        // ★ チャットログに保存
        chatLog.push({
            time,
            name: user.name,
            text
        });

        // ログが増えすぎないように、例えば最新200件だけ残す
        if (chatLog.length > 200) {
            chatLog.shift(); // 一番古いのを消す
        }

        // いつもどおり全員に送信
        io.to(ROOM_NAME).emit("chat-message", {
            time,
            name: user.name,
            text,
            fromId: socket.id
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


        // 退室
    socket.on("leave", () => {
        const user = users[socket.id];
        if (!user) return;

        const leftName = user.name;

        // ユーザー管理から削除して部屋から抜ける
        delete users[socket.id];
        typingUsers.delete(socket.id);
        socket.leave(ROOM_NAME);

        // システムメッセージ（退室）
        io.to(ROOM_NAME).emit("system-message", {
            time: getTimeString(),
            text: `「${leftName}」さんが退室しました。`
        });

        // ユーザー一覧・入力中一覧を更新
        broadcastUserList();
        broadcastTypingUsers();

                // ★ 全員いなくなったらチャットログをクリア
        if (Object.keys(users).length === 0) {
            chatLog.length = 0;      // 配列を空にする
            typingUsers.clear();      // 念のため入力中情報もリセット
            console.log("All users left. chatLog cleared.");
        }
    });


    // 切断
    socket.on("disconnect", () => {
        const user = users[socket.id];
        if (user) {
            const leftName = user.name;
            delete users[socket.id];
            typingUsers.delete(socket.id);

            // システムメッセージ（退室）
            io.to(ROOM_NAME).emit("system-message", {
                time: getTimeString(),
                text: `「${leftName}」さんが退室しました。`
            });

            broadcastUserList();
            broadcastTypingUsers();

                    // ★ 全員いなくなったらチャットログをクリア
        if (Object.keys(users).length === 0) {
            chatLog.length = 0;      // 配列を空にする
            typingUsers.clear();      // 念のため入力中情報もリセット
            console.log("All users left. chatLog cleared.");
        }
        }

        console.log("disconnected:", socket.id);
    });
});

http.listen(3000, () => {
    console.log("Server running at http://localhost:3000");
});
