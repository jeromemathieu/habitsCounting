import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data.sqlite");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL UNIQUE,
    password   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS habits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#4f46e5',
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS logs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id INTEGER NOT NULL,
    date     TEXT NOT NULL,
    FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE,
    UNIQUE (habit_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(date);
  CREATE INDEX IF NOT EXISTS idx_logs_habit ON logs(habit_id);
`);

// --- Migrations ---
// `days` : jours de la semaine où l'habitude s'applique. Masque de 7 caractères
// ('1'/'0') indexé par getDay() JS (0 = dimanche ... 6 = samedi). Défaut : tous.
const habitCols = db.prepare("PRAGMA table_info(habits)").all().map((c) => c.name);
if (!habitCols.includes("days")) {
  db.exec("ALTER TABLE habits ADD COLUMN days TEXT NOT NULL DEFAULT '1111111'");
}
// Période de validité optionnelle de l'habitude (NULL = pas de borne).
if (!habitCols.includes("start_date")) {
  db.exec("ALTER TABLE habits ADD COLUMN start_date TEXT");
}
if (!habitCols.includes("end_date")) {
  db.exec("ALTER TABLE habits ADD COLUMN end_date TEXT");
}
// Rattachement à un utilisateur (NULL pour les habitudes créées avant l'auth ;
// elles seront réclamées par le premier compte créé, cf. server.js).
if (!habitCols.includes("user_id")) {
  db.exec("ALTER TABLE habits ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id)");

export default db;
