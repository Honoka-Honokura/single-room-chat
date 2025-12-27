// topics.js（部屋別 永続化 + 重み付きお題ガチャ）
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
  // ここはお好みで上限調整OK
  if (t.length > 200) throw new Error("text is too long (max 200)");
  return t;
}

// ---------- storage shape ----------
// topics.json はこうなる：
// {
//   "main": [ { "id": 1, "text": "お題", "weight": 1 }, ... ],
//   "night": [ ... ]
// }
function loadAll() {
  const data = readJsonSafe(TOPICS_FILE, {});
  // 旧形式（配列）からの自動移行
  // [ "aaa", "bbb" ] だったら main に入れる
  if (Array.isArray(data)) {
    const migrated = {
      main: data
        .map((t, i) => ({
          id: i + 1,
          text: String(t ?? "").trim(),
          weight: 1,
        }))
        .filter((x) => x.text),
    };
    writeJsonSafe(TOPICS_FILE, migrated);
    return migrated;
  }
  // 変な形でも最低限オブジェクトに
  if (!data || typeof data !== "object") return {};
  return data;
}

function saveAll(all) {
  writeJsonSafe(TOPICS_FILE, all);
}

function ensureRoom(all, room) {
  const r = normalizeRoomSlug(room);
  if (!all[r]) all[r] = [];
  if (!Array.isArray(all[r])) all[r] = [];
  return r;
}

function nextId(list) {
  let max = 0;
  for (const t of list) {
    const id = Number(t?.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max + 1;
}

// ---------- public API ----------
function getTopics(room) {
  const all = loadAll();
  const r = ensureRoom(all, room);
  // 返すだけ。必要ならソート
  return all[r].slice().sort((a, b) => (a.id || 0) - (b.id || 0));
}

function addTopic(room, text, weight) {
  const all = loadAll();
  const r = ensureRoom(all, room);

  const t = sanitizeText(text);
  const w = clampInt(weight ?? 1, 1, 100, 1);

  const list = all[r];
  const item = { id: nextId(list), text: t, weight: w };
  list.push(item);

  saveAll(all);
  return item;
}

function updateTopic(room, id, patch = {}) {
  const all = loadAll();
  const r = ensureRoom(all, room);

  const tid = Number(id);
  if (!Number.isInteger(tid)) throw new Error("invalid id");

  const list = all[r];
  const idx = list.findIndex((t) => Number(t.id) === tid);
  if (idx === -1) throw new Error("topic not found");

  if (patch.text !== undefined) {
    list[idx].text = sanitizeText(patch.text);
  }
  if (patch.weight !== undefined) {
    list[idx].weight = clampInt(patch.weight, 1, 100, 1);
  }

  saveAll(all);
  return list[idx];
}

function deleteTopic(room, id) {
  const all = loadAll();
  const r = ensureRoom(all, room);

  const tid = Number(id);
  if (!Number.isInteger(tid)) throw new Error("invalid id");

  const list = all[r];
  const idx = list.findIndex((t) => Number(t.id) === tid);
  if (idx === -1) throw new Error("topic not found");

  const removed = list.splice(idx, 1)[0];
  saveAll(all);
  return removed;
}

function drawTopic(room) {
  const all = loadAll();
  const r = ensureRoom(all, room);
  const list = all[r].filter((t) => t && String(t.text || "").trim());

  if (list.length === 0) return null;

  // 重み付き抽選（weight が大きいほど出やすい）
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
