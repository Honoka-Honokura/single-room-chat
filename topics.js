// topics.js（部屋別 永続化版）
// topics.<room>.json を使う

const fs = require("fs");
const path = require("path");

function topicFilePath(room) {
  const r = String(room || "main").trim() || "main";
  return path.join(__dirname, `topics.${r}.json`);
}

// ルームごとにメモリ保持
const topicsByRoom = new Map();

function getDefaultTopics() {
  return [
    { id: 1, text: "最近いちばんエロかった出来事を、R指定にならない範囲で教えて", weight: 1 },
    { id: 2, text: "相手に言ってみたいセリフを3つ並べて、その中で一番言ってほしいものを選んでもらう", weight: 1 },
    { id: 3, text: "今の気分を『お酒の種類』で例えて、その理由も添えて説明して", weight: 1 },
  ];
}

function loadTopics(room) {
  const file = topicFilePath(room);

  try {
    if (!fs.existsSync(file)) {
      const def = getDefaultTopics();
      topicsByRoom.set(room, def);
      saveTopics(room);
      return;
    }

    const json = fs.readFileSync(file, "utf8");
    const data = JSON.parse(json);

    if (!Array.isArray(data)) throw new Error("topics file is not array");

    let maxId = 0;
    const topics = data.map((raw, index) => {
      const id = typeof raw.id === "number" && Number.isFinite(raw.id) ? raw.id : index + 1;
      if (id > maxId) maxId = id;

      const text = (raw.text || "").toString().trim();
      const wRaw = Number(raw.weight);
      const weight = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 1;

      return { id, text, weight };
    });

    if (!topics.some((t) => t.text && t.text.length > 0)) {
      topicsByRoom.set(room, getDefaultTopics());
      saveTopics(room);
      return;
    }

    topicsByRoom.set(room, topics);
  } catch (err) {
    console.error(`[topics] Failed to load topics for room=${room}:`, err);
    topicsByRoom.set(room, getDefaultTopics());
    saveTopics(room);
  }
}

function saveTopics(room) {
  const file = topicFilePath(room);
  const topics = topicsByRoom.get(room) || [];

  try {
    const json = JSON.stringify(topics, null, 2);
    fs.writeFileSync(file, json, "utf8");
  } catch (err) {
    console.error(`[topics] Failed to save topics for room=${room}:`, err);
  }
}

function ensureRoom(room) {
  const r = String(room || "main").trim() || "main";
  if (!topicsByRoom.has(r)) loadTopics(r);
  return r;
}

// 一覧
function getTopics(room) {
  const r = ensureRoom(room);
  return topicsByRoom.get(r) || [];
}

// 追加
function addTopic(room, text, weight = 1) {
  const r = ensureRoom(room);

  const cleanText = (text || "").toString().trim();
  if (!cleanText) throw new Error("text is required");

  const w = Number(weight);
  const safeWeight = Number.isFinite(w) && w > 0 ? w : 1;

  const topics = topicsByRoom.get(r) || [];
  const maxId = topics.reduce((max, t) => Math.max(max, t.id || 0), 0);
  const id = maxId + 1;

  const topic = { id, text: cleanText, weight: safeWeight };
  topics.push(topic);
  topicsByRoom.set(r, topics);
  saveTopics(r);

  return topic;
}

// 更新
function updateTopic(room, id, fields) {
  const r = ensureRoom(room);
  const topics = topicsByRoom.get(r) || [];

  const idx = topics.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error("topic not found");

  const target = topics[idx];

  if (fields.text !== undefined) {
    const cleanText = (fields.text || "").toString().trim();
    if (!cleanText) throw new Error("text is required");
    target.text = cleanText;
  }

  if (fields.weight !== undefined) {
    const w = Number(fields.weight);
    const safeWeight = Number.isFinite(w) && w > 0 ? w : 1;
    target.weight = safeWeight;
  }

  topics[idx] = target;
  topicsByRoom.set(r, topics);
  saveTopics(r);

  return target;
}

// 削除
function deleteTopic(room, id) {
  const r = ensureRoom(room);
  const topics = topicsByRoom.get(r) || [];

  const idx = topics.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error("topic not found");

  const removed = topics.splice(idx, 1)[0];
  topicsByRoom.set(r, topics);
  saveTopics(r);

  return removed;
}

// ガチャ
function drawTopic(room) {
  const r = ensureRoom(room);
  const topics = topicsByRoom.get(r) || [];
  if (!topics.length) return null;

  const totalWeight = topics.reduce((sum, t) => sum + t.weight, 0);
  const rand = Math.random() * totalWeight;

  let acc = 0;
  for (const t of topics) {
    acc += t.weight;
    if (rand <= acc) return t;
  }
  return topics[topics.length - 1];
}

module.exports = {
  getTopics,
  addTopic,
  updateTopic,
  deleteTopic,
  drawTopic,
};
