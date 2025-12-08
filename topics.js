// topics.js
// お題ガチャ用：topics.json に永続化する版

const fs   = require("fs");
const path = require("path");

// server.js と同じ階層の topics.json を使う
const TOPIC_FILE_PATH = path.join(__dirname, "topics.json");

// メモリ上のお題リスト
let topics = [];

// デフォルトのお題（最初だけ使われる）
function getDefaultTopics() {
    return [
        { id: 1, text: "最近いちばんエロかった出来事を、R指定にならない範囲で教えて", weight: 1 },
        { id: 2, text: "相手に言ってみたいセリフを3つ並べて、その中で一番言ってほしいものを選んでもらう", weight: 1 },
        { id: 3, text: "今の気分を『お酒の種類』で例えて、その理由も添えて説明して", weight: 1 },
    ];
}

// topics.json を読み込む
function loadTopics() {
    try {
        if (!fs.existsSync(TOPIC_FILE_PATH)) {
            // ファイルが無ければデフォルトで作成
            topics = getDefaultTopics();
            saveTopics();
            return;
        }

        const json = fs.readFileSync(TOPIC_FILE_PATH, "utf8");
        const data = JSON.parse(json);

        if (!Array.isArray(data)) {
            throw new Error("topics.json is not array");
        }

        // id / text / weight を正規化
        let maxId = 0;
        topics = data.map((raw, index) => {
            const id = typeof raw.id === "number" && Number.isFinite(raw.id)
                ? raw.id
                : index + 1;
            if (id > maxId) maxId = id;

            const text = (raw.text || "").toString().trim();
            const wRaw = Number(raw.weight);
            const weight = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 1;

            return { id, text, weight };
        });

        // 万が一 text が空ばかりだったらデフォルトに差し替える
        if (!topics.some(t => t.text && t.text.length > 0)) {
            topics = getDefaultTopics();
            saveTopics();
        }
    } catch (err) {
        console.error("[topics] Failed to load topics.json:", err);
        topics = getDefaultTopics();
        saveTopics();
    }
}

// topics.json に書き込む
function saveTopics() {
    try {
        const json = JSON.stringify(topics, null, 2);
        fs.writeFileSync(TOPIC_FILE_PATH, json, "utf8");
    } catch (err) {
        console.error("[topics] Failed to save topics.json:", err);
    }
}

// 管理画面用：お題一覧を返す
function getTopics() {
    return topics;
}

// 管理画面用：お題を追加する
function addTopic(text, weight = 1) {
    const cleanText = (text || "").toString().trim();
    if (!cleanText) {
        throw new Error("text is required");
    }

    const w = Number(weight);
    const safeWeight = Number.isFinite(w) && w > 0 ? w : 1;

    const maxId = topics.reduce((max, t) => Math.max(max, t.id || 0), 0);
    const id = maxId + 1;

    const topic = { id, text: cleanText, weight: safeWeight };
    topics.push(topic);
    saveTopics();
    return topic;
}

// 管理画面用：お題を更新する
function updateTopic(id, fields) {
    const idx = topics.findIndex(t => t.id === id);
    if (idx === -1) {
        throw new Error("topic not found");
    }

    const target = topics[idx];

    if (fields.text !== undefined) {
        const cleanText = (fields.text || "").toString().trim();
        if (!cleanText) {
            throw new Error("text is required");
        }
        target.text = cleanText;
    }

    if (fields.weight !== undefined) {
        const w = Number(fields.weight);
        const safeWeight = Number.isFinite(w) && w > 0 ? w : 1;
        target.weight = safeWeight;
    }

    topics[idx] = target;
    saveTopics();
    return target;
}

// 管理画面用：お題を削除する
function deleteTopic(id) {
    const idx = topics.findIndex(t => t.id === id);
    if (idx === -1) {
        throw new Error("topic not found");
    }
    const removed = topics.splice(idx, 1)[0];
    saveTopics();
    return removed;
}

// ガチャ用：重みに応じてランダムに1件返す
function drawTopic() {
    if (!topics.length) return null;

    const totalWeight = topics.reduce((sum, t) => sum + t.weight, 0);
    const r = Math.random() * totalWeight;

    let acc = 0;
    for (const t of topics) {
        acc += t.weight;
        if (r <= acc) {
            return t;
        }
    }
    // 保険
    return topics[topics.length - 1];
}

// 起動時に一度だけ読み込む
loadTopics();

module.exports = {
    getTopics,
    addTopic,
    updateTopic,
    deleteTopic,
    drawTopic,
};
