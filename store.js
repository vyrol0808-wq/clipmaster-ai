// Simple JSON file store for ClipMaster AI.
// Data lives in data/db.json: { projects: [], jobs: [], clips: [], downloads: [] }
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function blank() {
  return { projects: [], jobs: [], clips: [], downloads: [], seq: 0 };
}

function load() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) { console.error('[store] load failed, starting blank:', e.message); }
  return blank();
}

function save(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function uid(prefix) {
  const db = load();
  db.seq = (db.seq || 0) + 1;
  const id = `${prefix}_${Date.now().toString(36)}${db.seq.toString(36)}`;
  save(db);
  return id;
}

module.exports = { load, save, uid, DB_PATH };
