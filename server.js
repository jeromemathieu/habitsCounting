import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import db from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

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

// Nombre de jours du mois (YYYY-MM) tombant sur les jours prévus du masque.
function scheduledDaysInMonth(year, mon, mask) {
  const total = new Date(year, mon, 0).getDate();
  let n = 0;
  for (let d = 1; d <= total; d++) {
    if (mask[new Date(year, mon - 1, d).getDay()] === "1") n++;
  }
  return n;
}

// --- Habits ---

// List active habits (ordered)
app.get("/api/habits", (req, res) => {
  const habits = db
    .prepare("SELECT * FROM habits WHERE archived = 0 ORDER BY sort_order, id")
    .all();
  res.json(habits);
});

// Create a habit
app.post("/api/habits", (req, res) => {
  const name = (req.body?.name || "").trim();
  const color = (req.body?.color || "#4f46e5").trim();
  if (!name) return res.status(400).json({ error: "Le nom est requis" });

  const days = req.body?.days !== undefined ? normalizeDays(req.body.days) : "1111111";
  if (days === undefined) return res.status(400).json({ error: "Jours invalides" });

  const maxOrder =
    db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM habits").get().m;
  const info = db
    .prepare("INSERT INTO habits (name, color, sort_order, days) VALUES (?, ?, ?, ?)")
    .run(name, color, maxOrder + 1, days);
  const habit = db
    .prepare("SELECT * FROM habits WHERE id = ?")
    .get(info.lastInsertRowid);
  res.status(201).json(habit);
});

// Update a habit (name / color / days)
app.put("/api/habits/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM habits WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Habitude introuvable" });

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
  const color = req.body?.color !== undefined ? String(req.body.color).trim() : existing.color;
  if (!name) return res.status(400).json({ error: "Le nom est requis" });

  let days = existing.days;
  if (req.body?.days !== undefined) {
    days = normalizeDays(req.body.days);
    if (days === undefined) return res.status(400).json({ error: "Jours invalides" });
  }

  db.prepare("UPDATE habits SET name = ?, color = ?, days = ? WHERE id = ?").run(name, color, days, id);
  res.json(db.prepare("SELECT * FROM habits WHERE id = ?").get(id));
});

// Delete a habit (and its logs via cascade)
app.delete("/api/habits/:id", (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare("DELETE FROM habits WHERE id = ?").run(id);
  if (info.changes === 0) return res.status(404).json({ error: "Habitude introuvable" });
  res.status(204).end();
});

// --- Logs (daily completions) ---

// Get completed habit ids for a given date
app.get("/api/logs", (req, res) => {
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: "Date invalide (YYYY-MM-DD)" });
  const rows = db.prepare("SELECT habit_id FROM logs WHERE date = ?").all(date);
  res.json(rows.map((r) => r.habit_id));
});

// Toggle a habit completion for a date
app.post("/api/logs/toggle", (req, res) => {
  const habitId = Number(req.body?.habit_id);
  const date = req.body?.date;
  if (!habitId || !isValidDate(date))
    return res.status(400).json({ error: "habit_id et date (YYYY-MM-DD) requis" });

  const habit = db.prepare("SELECT id FROM habits WHERE id = ?").get(habitId);
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
app.get("/api/summary", (req, res) => {
  const month = req.query.month;
  if (!isValidMonth(month)) return res.status(400).json({ error: "Mois invalide (YYYY-MM)" });

  const [year, mon] = month.split("-").map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const prefix = `${month}-%`;

  const habits = db
    .prepare("SELECT * FROM habits WHERE archived = 0 ORDER BY sort_order, id")
    .all();

  const logRows = db
    .prepare("SELECT habit_id, date FROM logs WHERE date LIKE ? ORDER BY date")
    .all(prefix);

  const byHabit = new Map();
  for (const row of logRows) {
    if (!byHabit.has(row.habit_id)) byHabit.set(row.habit_id, []);
    byHabit.get(row.habit_id).push(row.date);
  }

  const summary = habits.map((h) => {
    const days = byHabit.get(h.id) || [];
    // Le taux se calcule sur les jours prévus de l'habitude, pas sur tout le mois.
    const scheduled = scheduledDaysInMonth(year, mon, h.days);
    return {
      id: h.id,
      name: h.name,
      color: h.color,
      count: days.length,
      scheduled,
      rate: scheduled ? Math.round((days.length / scheduled) * 100) : 0,
      days,
    };
  });

  const totalCompletions = logRows.length;

  res.json({ month, daysInMonth, totalCompletions, habits: summary });
});

// --- Yearly trends ---

// Returns, for a given year, the monthly completion count (12 values, Jan..Dec)
// for each habit. Used by the "Synthèse" view to draw a per-month chart.
app.get("/api/trends", (req, res) => {
  const year = req.query.year;
  if (typeof year !== "string" || !/^\d{4}$/.test(year))
    return res.status(400).json({ error: "Année invalide (YYYY)" });

  const habits = db
    .prepare("SELECT * FROM habits WHERE archived = 0 ORDER BY sort_order, id")
    .all();

  const rows = db
    .prepare(
      `SELECT habit_id, CAST(substr(date, 6, 2) AS INTEGER) AS mon, COUNT(*) AS c
       FROM logs WHERE date LIKE ? GROUP BY habit_id, mon`
    )
    .all(`${year}-%`);

  const counts = new Map(); // habit_id -> [12]
  for (const h of habits) counts.set(h.id, new Array(12).fill(0));
  for (const r of rows) {
    const arr = counts.get(r.habit_id);
    if (arr) arr[r.mon - 1] = r.c;
  }

  const y = Number(year);
  const result = habits.map((h) => {
    // Jours prévus par mois (pour calculer le taux % côté client).
    const scheduled = [];
    for (let m = 1; m <= 12; m++) scheduled.push(scheduledDaysInMonth(y, m, h.days));
    return {
      id: h.id,
      name: h.name,
      color: h.color,
      monthly: counts.get(h.id),
      scheduled,
      total: counts.get(h.id).reduce((a, b) => a + b, 0),
    };
  });

  res.json({ year: y, habits: result });
});

// --- Per-habit calendar ---

// Liste des dates où une habitude a été réalisée dans un mois donné.
app.get("/api/habits/:id/calendar", (req, res) => {
  const id = Number(req.params.id);
  const month = req.query.month;
  if (!isValidMonth(month)) return res.status(400).json({ error: "Mois invalide (YYYY-MM)" });

  const habit = db.prepare("SELECT * FROM habits WHERE id = ?").get(id);
  if (!habit) return res.status(404).json({ error: "Habitude introuvable" });

  const rows = db
    .prepare("SELECT date FROM logs WHERE habit_id = ? AND date LIKE ? ORDER BY date")
    .all(id, `${month}-%`);

  res.json({ id, days: habit.days, dates: rows.map((r) => r.date) });
});

app.listen(PORT, () => {
  console.log(`Habits Counting en écoute sur http://localhost:${PORT}`);
});
