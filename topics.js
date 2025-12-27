// topics.js（複数ルーム対応 / 永続化 / 重み付きガチャ / 自動移行）
const fs = require("fs");
const path = require("path");

const TOPICS_FILE = path.join(__dirname, "topics.json");

// ---------- utils ----------
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

function sanitizeRooms(rooms, fallbackRoom = "main") {
  // rooms が未指定 or 変な形なら fallbackRoom だけにする
  let arr = [];
  if (Array.isArray(rooms)) arr = rooms;
  else if (typeof rooms === "string" && rooms.trim()) arr = rooms.split(","); // 念のため
  arr = arr.map((r) => normalizeRoomSlug(r)).filter(Boolean);

  // 空なら fallback
  if (arr.length === 0) arr = [normalizeRoomSlug(fallbackRoom)];

  // 重複除去
  return Array.from(new Set(arr));
}

function nextGlobalId(list) {
  let max = 0;
  for (const t of list) {
    const id = Number(t?.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max + 1;
}

// ---------- storage ----------
// 新形式 topics.json：
// [
//   { "id": 1, "text": "お題", "weight": 2, "rooms": ["main","night"] },
//   ...
// ]
function loadAll() {
  const data = readJsonSafe(TOPICS_FILE, []);

  // すでに新形式（配列 of object）なら整形して返す
  if (Array.isArray(data)) {
    // 旧形式：[ "aaa", "bbb" ] → main に移行
    if (data.every((x) => typeof x === "string")) {
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

    // 配列だけど中身がバラバラでも一応整える
    const normalized = data
      .map((t) => {
        if (!t || typeof t !== "object") return null;
        const id = Number(t.id);
        if (!Number.isFinite(id)) return null;
        const text = String(t.text ?? "").trim();
        if (!text) return null;
        const weight = clampInt(t.weight ?? 1, 1, 100, 1);
        const rooms = sanitizeRooms(t.rooms, "main");
        return { id, text, weight, rooms };
      })
      .filter(Boolean);

    // もし正規化で変化したら保存しておく
    if (normalized.length !== data.length) {
      writeJsonSafe(TOPICS_FILE, normalized);
    }
    return normalized;
  }

  // 旧形式（部屋ごとのオブジェクト）から移行
  // {
  //   "main": [ {id,text,weight}, ... ],
  //   "night": [ ... ]
  // }
  if (data && typeof data === "object") {
    const migrated = [];
    let gid = 1;

    for (const [roomKey, list] of Object.entries(data)) {
      const room = normalizeRoomSlug(roomKey);
      if (!Array.isArray(list)) continue;

      for (const item of list) {
        if (!item) continue;
        const text = String(item.text ?? "").trim();
        if (!text) continue;
        const weight = clampInt(item.weight ?? 1, 1, 100, 1);

        migrated.push({
          id: gid++,
          text,
          weight,
          rooms: [room],
        });
      }
    }

    writeJsonSafe(TOPICS_FILE, migrated);
    return migrated;
  }

  return [];
}

function saveAll(all) {
  writeJsonSafe(TOPICS_FILE, all);
}

function findById(all, id) {
  const tid = Number(id);
  if (!Number.isInteger(tid)) throw new Error("invalid id");
  const idx = all.findIndex((t) => Number(t.id) === tid);
  if (idx === -1) throw new Error("topic not found");
  return { tid, idx, topic: all[idx] };
}

// ---------- public API ----------
function getTopics(room) {
  const all = loadAll();
  const r = normalizeRoomSlug(room);
  return all
    .filter((t) => Array.isArray(t.rooms) && t.rooms.includes(r))
    .slice()
    .sort((a, b) => (a.id || 0) - (b.id || 0));
}

function addTopic(room, text, weight, rooms) {
  const all = loadAll();
  const baseRoom = normalizeRoomSlug(room);
  const t = sanitizeText(text);
  const w = clampInt(weight ?? 1, 1, 100, 1);

  const rs = sanitizeRooms(rooms, baseRoom);

  const item = { id: nextGlobalId(all), text: t, weight: w, rooms: rs };
  all.push(item);

  saveAll(all);
  return item;
}

function updateTopic(room, id, patch = {}) {
  const all = loadAll();
  const r = normalizeRoomSlug(room);

  const { idx, topic } = findById(all, id);

  if (patch.text !== undefined) {
    topic.text = sanitizeText(patch.text);
  }
  if (patch.weight !== undefined) {
    topic.weight = clampInt(patch.weight, 1, 100, 1);
  }
  if (patch.rooms !== undefined) {
    topic.rooms = sanitizeRooms(patch.rooms, r);
  }

  all[idx] = topic;
  saveAll(all);
  return topic;
}

function deleteTopic(room, id) {
  const all = loadAll();
  const r = normalizeRoomSlug(room);

  const { idx, topic } = findById(all, id);



  const removed = all.splice(idx, 1)[0];
  saveAll(all);
  return removed;
}

function drawTopic(room) {
  const all = loadAll();
  const r = normalizeRoomSlug(room);

  const list = all.filter(
    (t) =>
      t &&
      String(t.text || "").trim() &&
      Array.isArray(t.rooms) &&
      t.rooms.includes(r)
  );

  if (list.length === 0) return null;

  // 重み付き抽選
  let total = 0;
  const weights = list.map((t) => {
    const w = clampInt(t.weight ?? 1, 1, 100, 1);
    total += w;
    return w;
  });

  let rnd = Math.floor(Math.random() * total) + 1; // 1..total
  for (let i = 0; i < list.length; i++) {
    rnd -= weights[i];
    if (rnd <= 0) return list[i];
  }
  return list[list.length - 1];
}

module.exports = {
  drawTopic,
  getTopics,
  addTopic,
  updateTopic,
  deleteTopic,
};
