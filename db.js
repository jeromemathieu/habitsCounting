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

  CREATE TABLE IF NOT EXISTS notes (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id INTEGER NOT NULL,
    date     TEXT NOT NULL,
    text     TEXT NOT NULL,
    FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE,
    UNIQUE (habit_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_notes_date ON notes(date);
  CREATE INDEX IF NOT EXISTS idx_notes_habit ON notes(habit_id);

  CREATE TABLE IF NOT EXISTS shares (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL,
    viewer_id  INTEGER NOT NULL,
    habit_id   INTEGER,                       -- NULL = toutes les habitudes
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id)  REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (viewer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (habit_id)  REFERENCES habits(id) ON DELETE CASCADE,
    UNIQUE (owner_id, viewer_id, habit_id)
  );

  CREATE INDEX IF NOT EXISTS idx_shares_viewer ON shares(viewer_id);
  CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_id);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,          -- destinataire (propriétaire du flux)
    actor      TEXT NOT NULL DEFAULT '',  -- 'Vous' ou email de l'auteur
    type       TEXT NOT NULL,
    habit_id   INTEGER,
    habit_name TEXT,
    date       TEXT,
    detail     TEXT,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, id);

  CREATE TABLE IF NOT EXISTS shared_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id   INTEGER NOT NULL,
    date       TEXT NOT NULL,
    author_id  INTEGER NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (habit_id)  REFERENCES habits(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (habit_id, date, author_id)
  );

  CREATE INDEX IF NOT EXISTS idx_shared_comments ON shared_comments(habit_id, date);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`);

// Réglage par défaut : autoriser les inscriptions.
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_registration', 'true')").run();

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

// Emoji optionnel de l'habitude.
if (!habitCols.includes("icon")) {
  db.exec("ALTER TABLE habits ADD COLUMN icon TEXT NOT NULL DEFAULT ''");
}
// Rappel propre à l'habitude : heure "HH:MM" (NULL = pas de rappel) + garde anti-doublon.
if (!habitCols.includes("reminder_time")) {
  db.exec("ALTER TABLE habits ADD COLUMN reminder_time TEXT");
}
if (!habitCols.includes("reminder_last_sent")) {
  db.exec("ALTER TABLE habits ADD COLUMN reminder_last_sent TEXT");
}

// État du log : 'done' (fait) ou 'missed' (pas fait). Pas de ligne = rien.
// Les lignes existantes (avant cette colonne) sont des « fait ».
const logCols = db.prepare("PRAGMA table_info(logs)").all().map((c) => c.name);
if (!logCols.includes("status")) {
  db.exec("ALTER TABLE logs ADD COLUMN status TEXT NOT NULL DEFAULT 'done'");
}

// Jeton secret pour le flux iCal (abonnement calendrier en lecture seule).
const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols.includes("calendar_token")) {
  db.exec("ALTER TABLE users ADD COLUMN calendar_token TEXT");
}
// Clé API (authentification du MCP, à la place de l'email/mot de passe).
if (!userCols.includes("api_token")) {
  db.exec("ALTER TABLE users ADD COLUMN api_token TEXT");
}
// Rappel quotidien : heure "HH:MM" (NULL = désactivé) + garde anti-doublon.
if (!userCols.includes("reminder_time")) {
  db.exec("ALTER TABLE users ADD COLUMN reminder_time TEXT");
}
if (!userCols.includes("reminder_last_sent")) {
  db.exec("ALTER TABLE users ADD COLUMN reminder_last_sent TEXT");
}
// Fuseau horaire de l'utilisateur (IANA, ex. "Europe/Paris") pour l'heure du rappel.
if (!userCols.includes("timezone")) {
  db.exec("ALTER TABLE users ADD COLUMN timezone TEXT");
}

// Partage par habitude : recrée l'ancienne table shares (UNIQUE(owner,viewer))
// avec une colonne habit_id (NULL = toutes), en conservant les partages existants
// comme partages « toutes les habitudes ».
const shareCols = db.prepare("PRAGMA table_info(shares)").all().map((c) => c.name);
if (!shareCols.includes("habit_id")) {
  db.exec(`
    CREATE TABLE shares_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id   INTEGER NOT NULL,
      viewer_id  INTEGER NOT NULL,
      habit_id   INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id)  REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (viewer_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (habit_id)  REFERENCES habits(id) ON DELETE CASCADE,
      UNIQUE (owner_id, viewer_id, habit_id)
    );
    INSERT INTO shares_new (id, owner_id, viewer_id, created_at)
      SELECT id, owner_id, viewer_id, created_at FROM shares;
    DROP TABLE shares;
    ALTER TABLE shares_new RENAME TO shares;
    CREATE INDEX IF NOT EXISTS idx_shares_viewer ON shares(viewer_id);
    CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_id);
  `);
}

export default db;
