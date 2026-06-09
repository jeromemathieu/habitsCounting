import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import db from "./db.js";
import {
  hashPassword,
  verifyPassword,
  createSession,
  getSessionUser,
  deleteSession,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
} from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1); // derrière Traefik : pour détecter HTTPS (cookie Secure)
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// Attache l'utilisateur courant (si session valide) à chaque requête.
app.use((req, res, next) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  req.sessionToken = token || null;
  req.user = getSessionUser(token);
  next();
});

// Protège les routes de données : renvoie 401 si non authentifié.
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Non authentifié" });
  next();
}

// --- Authentification ---
const isValidEmail = (s) => typeof s === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

// Inscription. La 1re inscription récupère les habitudes orphelines (pré-auth).
app.post("/api/auth/register", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!isValidEmail(email)) return res.status(400).json({ error: "Email invalide" });
  if (password.length < 8)
    return res.status(400).json({ error: "Mot de passe : 8 caractères minimum" });

  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (userCount > 0 && process.env.DISABLE_REGISTRATION)
    return res.status(403).json({ error: "Les inscriptions sont désactivées" });

  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return res.status(409).json({ error: "Cet email est déjà utilisé" });

  const info = db
    .prepare("INSERT INTO users (email, password) VALUES (?, ?)")
    .run(email, hashPassword(password));
  const userId = info.lastInsertRowid;

  // Premier compte : adopte les éventuelles habitudes créées avant l'auth.
  if (userCount === 0) {
    db.prepare("UPDATE habits SET user_id = ? WHERE user_id IS NULL").run(userId);
  }

  const token = createSession(userId);
  setSessionCookie(req, res, token);
  res.status(201).json({ id: userId, email });
});

// Connexion.
app.post("/api/auth/login", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !verifyPassword(password, user.password))
    return res.status(401).json({ error: "Email ou mot de passe incorrect" });

  const token = createSession(user.id);
  setSessionCookie(req, res, token);
  res.json({ id: user.id, email: user.email });
});

// Déconnexion.
app.post("/api/auth/logout", (req, res) => {
  deleteSession(req.sessionToken);
  clearSessionCookie(req, res);
  res.status(204).end();
});

// Utilisateur courant.
app.get("/api/auth/me", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Non authentifié" });
  res.json(req.user);
});

// --- Validation helpers ---
const isValidDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isValidMonth = (s) => typeof s === "string" && /^\d{4}-\d{2}$/.test(s);

// Normalise un masque de jours en chaîne de 7 caractères ('1'/'0'),
// indexée par getDay() (0 = dimanche ... 6 = samedi).
// Accepte soit une chaîne "1010101", soit un tableau d'index [1,3,5].
function normalizeDays(input) {
  if (input === undefined || input === null) return null;
  let mask = new Array(7).fill("0");
  if (Array.isArray(input)) {
    for (const d of input) {
      const n = Number(d);
      if (Number.isInteger(n) && n >= 0 && n <= 6) mask[n] = "1";
    }
  } else if (typeof input === "string" && /^[01]{7}$/.test(input)) {
    mask = input.split("");
  } else {
    return undefined; // entrée invalide
  }
  const out = mask.join("");
  return out.includes("1") ? out : "1111111"; // au moins un jour, sinon tous
}

// Valide une date optionnelle : renvoie la date normalisée, null si vide,
// ou undefined si invalide.
function normalizeOptionalDate(input) {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input === "string" && isValidDate(input)) return input;
  return undefined;
}

// Nombre de jours du mois (YYYY-MM) tombant sur les jours prévus du masque,
// en restant dans la période de validité [start, end] si elle est définie.
function scheduledDaysInMonth(year, mon, mask, start = null, end = null) {
  const total = new Date(year, mon, 0).getDate();
  const ym = `${year}-${String(mon).padStart(2, "0")}`;
  let n = 0;
  for (let d = 1; d <= total; d++) {
    if (mask[new Date(year, mon - 1, d).getDay()] !== "1") continue;
    const iso = `${ym}-${String(d).padStart(2, "0")}`; // comparable lexicalement
    if (start && iso < start) continue;
    if (end && iso > end) continue;
    n++;
  }
  return n;
}

// --- Habits ---

// List active habits (ordered)
app.get("/api/habits", requireAuth, (req, res) => {
  const habits = db
    .prepare("SELECT * FROM habits WHERE archived = 0 AND user_id = ? ORDER BY sort_order, id")
    .all(req.user.id);
  res.json(habits);
});

// Create a habit
app.post("/api/habits", requireAuth, (req, res) => {
  const name = (req.body?.name || "").trim();
  const color = (req.body?.color || "#4f46e5").trim();
  if (!name) return res.status(400).json({ error: "Le nom est requis" });

  const days = req.body?.days !== undefined ? normalizeDays(req.body.days) : "1111111";
  if (days === undefined) return res.status(400).json({ error: "Jours invalides" });

  const startDate = normalizeOptionalDate(req.body?.start_date);
  const endDate = normalizeOptionalDate(req.body?.end_date);
  if (startDate === undefined || endDate === undefined)
    return res.status(400).json({ error: "Date invalide (YYYY-MM-DD)" });
  if (startDate && endDate && startDate > endDate)
    return res.status(400).json({ error: "La date de début doit précéder la date de fin" });

  const maxOrder = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM habits WHERE user_id = ?")
    .get(req.user.id).m;
  const info = db
    .prepare(
      "INSERT INTO habits (name, color, sort_order, days, start_date, end_date, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(name, color, maxOrder + 1, days, startDate, endDate, req.user.id);
  const habit = db
    .prepare("SELECT * FROM habits WHERE id = ?")
    .get(info.lastInsertRowid);
  res.status(201).json(habit);
});

// Update a habit (name / color / days)
app.put("/api/habits/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const existing = db
    .prepare("SELECT * FROM habits WHERE id = ? AND user_id = ?")
    .get(id, req.user.id);
  if (!existing) return res.status(404).json({ error: "Habitude introuvable" });

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
  const color = req.body?.color !== undefined ? String(req.body.color).trim() : existing.color;
  if (!name) return res.status(400).json({ error: "Le nom est requis" });

  let days = existing.days;
  if (req.body?.days !== undefined) {
    days = normalizeDays(req.body.days);
    if (days === undefined) return res.status(400).json({ error: "Jours invalides" });
  }

  let startDate = existing.start_date;
  if (req.body?.start_date !== undefined) {
    startDate = normalizeOptionalDate(req.body.start_date);
    if (startDate === undefined) return res.status(400).json({ error: "Date de début invalide" });
  }
  let endDate = existing.end_date;
  if (req.body?.end_date !== undefined) {
    endDate = normalizeOptionalDate(req.body.end_date);
    if (endDate === undefined) return res.status(400).json({ error: "Date de fin invalide" });
  }
  if (startDate && endDate && startDate > endDate)
    return res.status(400).json({ error: "La date de début doit précéder la date de fin" });

  db.prepare(
    "UPDATE habits SET name = ?, color = ?, days = ?, start_date = ?, end_date = ? WHERE id = ?"
  ).run(name, color, days, startDate, endDate, id);
  res.json(db.prepare("SELECT * FROM habits WHERE id = ?").get(id));
});

// Delete a habit (and its logs via cascade)
app.delete("/api/habits/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const info = db
    .prepare("DELETE FROM habits WHERE id = ? AND user_id = ?")
    .run(id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: "Habitude introuvable" });
  res.status(204).end();
});

// --- Logs (daily completions) ---

// Get completed habit ids for a given date
app.get("/api/logs", requireAuth, (req, res) => {
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: "Date invalide (YYYY-MM-DD)" });
  const rows = db
    .prepare(
      "SELECT l.habit_id FROM logs l JOIN habits h ON h.id = l.habit_id WHERE l.date = ? AND h.user_id = ?"
    )
    .all(date, req.user.id);
  res.json(rows.map((r) => r.habit_id));
});

// Toggle a habit completion for a date
app.post("/api/logs/toggle", requireAuth, (req, res) => {
  const habitId = Number(req.body?.habit_id);
  const date = req.body?.date;
  if (!habitId || !isValidDate(date))
    return res.status(400).json({ error: "habit_id et date (YYYY-MM-DD) requis" });

  const habit = db
    .prepare("SELECT id FROM habits WHERE id = ? AND user_id = ?")
    .get(habitId, req.user.id);
  if (!habit) return res.status(404).json({ error: "Habitude introuvable" });

  const existing = db
    .prepare("SELECT id FROM logs WHERE habit_id = ? AND date = ?")
    .get(habitId, date);

  if (existing) {
    db.prepare("DELETE FROM logs WHERE id = ?").run(existing.id);
    res.json({ habit_id: habitId, date, done: false });
  } else {
    db.prepare("INSERT INTO logs (habit_id, date) VALUES (?, ?)").run(habitId, date);
    res.json({ habit_id: habitId, date, done: true });
  }
});

// --- Monthly summary ---

// Returns, for a given month (YYYY-MM):
//  - daysInMonth
//  - per-habit completion counts + the list of completed days
app.get("/api/summary", requireAuth, (req, res) => {
  const month = req.query.month;
  if (!isValidMonth(month)) return res.status(400).json({ error: "Mois invalide (YYYY-MM)" });

  const [year, mon] = month.split("-").map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const prefix = `${month}-%`;

  const habits = db
    .prepare("SELECT * FROM habits WHERE archived = 0 AND user_id = ? ORDER BY sort_order, id")
    .all(req.user.id);

  const logRows = db
    .prepare(
      "SELECT l.habit_id, l.date FROM logs l JOIN habits h ON h.id = l.habit_id WHERE h.user_id = ? AND l.date LIKE ? ORDER BY l.date"
    )
    .all(req.user.id, prefix);

  const byHabit = new Map();
  for (const row of logRows) {
    if (!byHabit.has(row.habit_id)) byHabit.set(row.habit_id, []);
    byHabit.get(row.habit_id).push(row.date);
  }

  const summary = habits.map((h) => {
    const days = byHabit.get(h.id) || [];
    // Le taux se calcule sur les jours prévus de l'habitude (dans sa période).
    const scheduled = scheduledDaysInMonth(year, mon, h.days, h.start_date, h.end_date);
    // Numérateur : complétions tombant sur un jour prévu ET dans la période.
    const inScope = days.filter((iso) => {
      if (h.days[new Date(iso + "T00:00:00").getDay()] !== "1") return false;
      if (h.start_date && iso < h.start_date) return false;
      if (h.end_date && iso > h.end_date) return false;
      return true;
    }).length;
    return {
      id: h.id,
      name: h.name,
      color: h.color,
      count: inScope,
      scheduled,
      rate: scheduled ? Math.round((inScope / scheduled) * 100) : 0,
      days,
    };
  });

  const totalCompletions = logRows.length;

  res.json({ month, daysInMonth, totalCompletions, habits: summary });
});

// --- Yearly trends ---

// Returns, for a given year, the monthly completion count (12 values, Jan..Dec)
// for each habit. Used by the "Synthèse" view to draw a per-month chart.
app.get("/api/trends", requireAuth, (req, res) => {
  const year = req.query.year;
  if (typeof year !== "string" || !/^\d{4}$/.test(year))
    return res.status(400).json({ error: "Année invalide (YYYY)" });

  const habits = db
    .prepare("SELECT * FROM habits WHERE archived = 0 AND user_id = ? ORDER BY sort_order, id")
    .all(req.user.id);

  const rows = db
    .prepare(
      "SELECT l.habit_id, l.date FROM logs l JOIN habits h ON h.id = l.habit_id WHERE h.user_id = ? AND l.date LIKE ?"
    )
    .all(req.user.id, `${year}-%`);

  const habitMap = new Map(habits.map((h) => [h.id, h]));
  const monthly = new Map(); // habit_id -> [12] complétions brutes
  const monthlyScheduled = new Map(); // habit_id -> [12] complétions dans le périmètre
  for (const h of habits) {
    monthly.set(h.id, new Array(12).fill(0));
    monthlyScheduled.set(h.id, new Array(12).fill(0));
  }
  for (const r of rows) {
    const h = habitMap.get(r.habit_id);
    if (!h) continue;
    const mon = Number(r.date.slice(5, 7));
    monthly.get(r.habit_id)[mon - 1]++;
    // Complétion comptée pour le taux : jour prévu et dans la période.
    if (h.days[new Date(r.date + "T00:00:00").getDay()] !== "1") continue;
    if (h.start_date && r.date < h.start_date) continue;
    if (h.end_date && r.date > h.end_date) continue;
    monthlyScheduled.get(r.habit_id)[mon - 1]++;
  }

  const y = Number(year);
  const result = habits.map((h) => {
    // Jours prévus par mois (pour calculer le taux % côté client).
    const scheduled = [];
    for (let m = 1; m <= 12; m++)
      scheduled.push(scheduledDaysInMonth(y, m, h.days, h.start_date, h.end_date));
    return {
      id: h.id,
      name: h.name,
      color: h.color,
      monthly: monthly.get(h.id),
      monthlyScheduled: monthlyScheduled.get(h.id),
      scheduled,
      total: monthly.get(h.id).reduce((a, b) => a + b, 0),
    };
  });

  res.json({ year: y, habits: result });
});

// --- Per-habit calendar ---

// Liste des dates où une habitude a été réalisée dans un mois donné.
app.get("/api/habits/:id/calendar", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const month = req.query.month;
  if (!isValidMonth(month)) return res.status(400).json({ error: "Mois invalide (YYYY-MM)" });

  const habit = db
    .prepare("SELECT * FROM habits WHERE id = ? AND user_id = ?")
    .get(id, req.user.id);
  if (!habit) return res.status(404).json({ error: "Habitude introuvable" });

  const rows = db
    .prepare("SELECT date FROM logs WHERE habit_id = ? AND date LIKE ? ORDER BY date")
    .all(id, `${month}-%`);

  res.json({
    id,
    days: habit.days,
    start_date: habit.start_date,
    end_date: habit.end_date,
    dates: rows.map((r) => r.date),
  });
});

app.listen(PORT, () => {
  console.log(`Habits Counting en écoute sur http://localhost:${PORT}`);
});
