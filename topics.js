// topics.js（全件表示＋ルーム割り当て方式 / 永続化 / 重み付きガチャ）
const fs = require("fs");
const path = require("path");

const TOPICS_FILE = path.join(__dirname, "topics.json");

function normalizeRoomSlug(slug) {
  const s = String(slug || "main").trim();
  const safe = s.replace(/[^a-zA-Z0-9_-]/g, "");
  return safe || "main";
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("topics.json read error:", e);
    return fallback;
  }
}

function writeJsonSafe(filePath, obj) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function clampInt(n, min, max, def) {
  const x = Number(n);
  if (!Number.isFinite(x)) return def;
  const v = Math.floor(x);
  return Math.max(min, Math.min(max, v));
}

function sanitizeText(text) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("text is required");
  if (t.length > 200) throw new Error("text is too long (max 200)");
  return t;
}

function sanitizeRooms(rooms) {
  // 共通(*)は不要：空は「どこにも所属しない」扱いにする
  if (!Array.isArray(rooms)) return [];
  const arr = rooms.map((r) => normalizeRoomSlug(r)).filter(Boolean);
  return Array.from(new Set(arr));
}

function nextId(list) {
  let max = 0;
  for (const t of list) {
    const id = Number(t?.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max + 1;
}

// 新形式 topics.json：
// [
//   { "id": 1, "text": "お題", "weight": 1, "rooms": ["main","night"] },
//   ...
// ]
function loadAll() {
  const data = readJsonSafe(TOPICS_FILE, []);

  // 旧形式（部屋別オブジェクト）→移行
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const migrated = [];
    let gid = 1;
    for (const [roomKey, list] of Object.entries(data)) {
      const room = normalizeRoomSlug(roomKey);
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const text = String(item?.text ?? "").trim();
        if (!text) continue;
        const weight = clampInt(item?.weight ?? 1, 1, 100, 1);
        migrated.push({ id: gid++, text, weight, rooms: [room] });
      }
    }
    writeJsonSafe(TOPICS_FILE, migrated);
    return migrated;
  }

  // 旧形式（配列の文字列）→ main 扱いで移行
  if (Array.isArray(data) && data.every((x) => typeof x === "string")) {
    const migrated = data
      .map((t, i) => ({
        id: i + 1,
        text: String(t ?? "").trim(),
        weight: 1,
        rooms: ["main"],
      }))
      .filter((x) => x.text);
    writeJsonSafe(TOPICS_FILE, migrated);
    return migrated;
  }

  // すでに新形式（配列 of object）
  if (Array.isArray(data)) {
    const normalized = data
      .map((t) => {
        if (!t || typeof t !== "object") return null;
        const id = Number(t.id);
        if (!Number.isFinite(id)) return null;
        const text = String(t.text ?? "").trim();
        if (!text) return null;
        const weight = clampInt(t.weight ?? 1, 1, 100, 1);
        const rooms = sanitizeRooms(t.rooms);
        return { id, text, weight, rooms };
      })
      .filter(Boolean);

    // 不正データが混じってたら整形保存
    if (normalized.length !== data.length) writeJsonSafe(TOPICS_FILE, normalized);
    return normalized;
  }

  return [];
}

function saveAll(all) {
  writeJsonSafe(TOPICS_FILE, all);
}

function getAllTopics() {
  return loadAll().slice().sort((a, b) => (a.id || 0) - (b.id || 0));
}

function getTopics(room) {
  const r = normalizeRoomSlug(room);
  return loadAll()
    .filter((t) => Array.isArray(t.rooms) && t.rooms.includes(r))
    .slice()
    .sort((a, b) => (a.id || 0) - (b.id || 0));
}

function addTopic(room, text, weight, rooms) {
  const all = loadAll();
  const t = sanitizeText(text);
  const w = clampInt(weight ?? 1, 1, 100, 1);

  // rooms が渡ってきたらそれを採用。なければ従来通り room だけ所属
  const rs = Array.isArray(rooms) ? sanitizeRooms(rooms) : [normalizeRoomSlug(room)];

  const item = { id: nextId(all), text: t, weight: w, rooms: rs };
  all.push(item);
  saveAll(all);
  return item;
}

function updateTopic(room, id, patch = {}) {
  const all = loadAll();
  const tid = Number(id);
  if (!Number.isInteger(tid)) throw new Error("invalid id");

  const idx = all.findIndex((t) => Number(t.id) === tid);
  if (idx === -1) throw new Error("topic not found");

  if (patch.text !== undefined) all[idx].text = sanitizeText(patch.text);
  if (patch.weight !== undefined) all[idx].weight = clampInt(patch.weight, 1, 100, 1);
  if (patch.rooms !== undefined) all[idx].rooms = sanitizeRooms(patch.rooms);

  saveAll(all);
  return all[idx];
}

function deleteTopic(room, id) {
  const all = loadAll();
  const tid = Number(id);
  if (!Number.isInteger(tid)) throw new Error("invalid id");

  const idx = all.findIndex((t) => Number(t.id) === tid);
  if (idx === -1) throw new Error("topic not found");

  const removed = all.splice(idx, 1)[0];
  saveAll(all);
  return removed;
}

function drawTopic(room) {
  const r = normalizeRoomSlug(room);
  const list = loadAll().filter(
    (t) => t && String(t.text || "").trim() && Array.isArray(t.rooms) && t.rooms.includes(r)
  );
  if (list.length === 0) return null;

  let total = 0;
  const weights = list.map((t) => {
    const w = clampInt(t.weight ?? 1, 1, 100, 1);
    total += w;
    return w;
  });

  let rnd = Math.floor(Math.random() * total) + 1;
  for (let i = 0; i < list.length; i++) {
    rnd -= weights[i];
    if (rnd <= 0) return list[i];
  }
  return list[list.length - 1];
}

module.exports = {
  drawTopic,
  getTopics,
  getAllTopics,     // ★追加
  addTopic,
  updateTopic,
  deleteTopic,
};
