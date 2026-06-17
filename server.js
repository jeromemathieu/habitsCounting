import express from "express";
import crypto from "node:crypto";
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
  ADMIN_COOKIE,
  isAdminConfigured,
  getAdminEmail,
  verifyAdmin,
  createAdminSession,
  isAdminSession,
  deleteAdminSession,
  setAdminCookie,
  clearAdminCookie,
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

// Détermine de quelles données on autorise la lecture.
// Sans `?owner=`, c'est soi-même (toutes ses habitudes).
// Avec `?owner=<id>`, selon les partages reçus :
//   - un partage « toutes » (habit_id NULL) -> habitIds = null (toutes)
//   - sinon -> habitIds = Set des habitudes partagées
// Renvoie { ownerId, habitIds } ou null si aucun accès.
function resolveAccess(req) {
  const owner = req.query.owner ? Number(req.query.owner) : null;
  if (!owner || owner === req.user.id) return { ownerId: req.user.id, habitIds: null };
  const rows = db
    .prepare("SELECT habit_id FROM shares WHERE owner_id = ? AND viewer_id = ?")
    .all(owner, req.user.id);
  if (!rows.length) return null;
  if (rows.some((r) => r.habit_id === null)) return { ownerId: owner, habitIds: null };
  return { ownerId: owner, habitIds: new Set(rows.map((r) => r.habit_id)) };
}

// Filtre une liste d'habitudes selon les ids autorisés (null = toutes).
function filterHabits(habits, habitIds) {
  return habitIds ? habits.filter((h) => habitIds.has(h.id)) : habits;
}

// --- Authentification ---
const isValidEmail = (s) => typeof s === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

// Lecture/écriture d'un réglage applicatif.
function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}
const registrationAllowed = () => getSetting("allow_registration") !== "false";

// Journalise une activité dans le flux d'un utilisateur.
function logActivity(userId, { actor = "Vous", type, habitId = null, habitName = null, date = null, detail = null, read = 1 }) {
  db.prepare(
    "INSERT INTO activity (user_id, actor, type, habit_id, habit_name, date, detail, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(userId, actor, type, habitId, habitName, date, detail, read ? 1 : 0);
}

// Middleware : réservé à une session admin valide.
function requireAdmin(req, res, next) {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!isAdminSession(token)) return res.status(401).json({ error: "Admin non authentifié" });
  next();
}

// Inscription. La 1re inscription récupère les habitudes orphelines (pré-auth).
app.post("/api/auth/register", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!isValidEmail(email)) return res.status(400).json({ error: "Email invalide" });
  if (password.length < 8)
    return res.status(400).json({ error: "Mot de passe : 8 caractères minimum" });

  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  // On autorise toujours le tout premier compte (amorçage), sinon on respecte le réglage.
  if (userCount > 0 && !registrationAllowed())
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

// Changer son propre mot de passe.
app.put("/api/auth/password", requireAuth, (req, res) => {
  const current = String(req.body?.current_password || "");
  const next = String(req.body?.new_password || "");
  if (next.length < 8)
    return res.status(400).json({ error: "Nouveau mot de passe : 8 caractères minimum" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!verifyPassword(current, user.password))
    return res.status(401).json({ error: "Mot de passe actuel incorrect" });

  db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hashPassword(next), req.user.id);
  // Invalide les autres sessions (déconnexion des autres appareils).
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token <> ?").run(req.user.id, req.sessionToken);
  res.json({ ok: true });
});

// --- Journal d'activité ---

app.get("/api/activity", requireAuth, (req, res) => {
  const items = db
    .prepare("SELECT * FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 100")
    .all(req.user.id);
  const unread = db
    .prepare("SELECT COUNT(*) AS c FROM activity WHERE user_id = ? AND read = 0")
    .get(req.user.id).c;
  res.json({ unread, items });
});

app.post("/api/activity/read", requireAuth, (req, res) => {
  db.prepare("UPDATE activity SET read = 1 WHERE user_id = ? AND read = 0").run(req.user.id);
  res.json({ ok: true });
});

// --- Flux iCal (abonnement calendrier, ex. Google Agenda) ---

function ensureCalendarToken(userId) {
  const row = db.prepare("SELECT calendar_token FROM users WHERE id = ?").get(userId);
  if (row && row.calendar_token) return row.calendar_token;
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("UPDATE users SET calendar_token = ? WHERE id = ?").run(token, userId);
  return token;
}

// URL d'abonnement de l'utilisateur courant.
app.get("/api/calendar-url", requireAuth, (req, res) => {
  const token = ensureCalendarToken(req.user.id);
  res.json({ url: `${req.protocol}://${req.get("host")}/calendar/${token}.ics` });
});

// Régénère le jeton (invalide l'ancienne URL).
app.post("/api/calendar-url/regenerate", requireAuth, (req, res) => {
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("UPDATE users SET calendar_token = ? WHERE id = ?").run(token, req.user.id);
  res.json({ url: `${req.protocol}://${req.get("host")}/calendar/${token}.ics` });
});

// Échappe une valeur de texte iCalendar (RFC 5545).
function icsEscape(s) {
  return String(s).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
}

// Flux iCalendar public, authentifié par le jeton dans l'URL (pas de cookie).
app.get("/calendar/:token.ics", (req, res) => {
  const token = req.params.token;
  const user = token ? db.prepare("SELECT id, email FROM users WHERE calendar_token = ?").get(token) : null;
  if (!user) return res.status(404).type("text/plain").send("Calendrier introuvable");

  const rows = db
    .prepare(
      `SELECT h.name, l.date, l.status, n.text AS note
       FROM logs l
       JOIN habits h ON h.id = l.habit_id
       LEFT JOIN notes n ON n.habit_id = l.habit_id AND n.date = l.date
       WHERE h.user_id = ? AND l.status = 'done' ORDER BY l.date, h.name`
    )
    .all(user.id);

  const dtstamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Habits Counting//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Mes habitudes",
    "NAME:Mes habitudes",
  ];
  for (const r of rows) {
    const ymd = r.date.replace(/-/g, "");
    const [y, m, d] = r.date.split("-").map(Number);
    const end = new Date(y, m - 1, d + 1); // événement « jour entier »
    const endYmd = `${end.getFullYear()}${String(end.getMonth() + 1).padStart(2, "0")}${String(end.getDate()).padStart(2, "0")}`;
    const mark = r.status === "done" ? "✓" : "✗";
    const suffix = r.status === "done" ? "" : " (pas fait)";
    lines.push(
      "BEGIN:VEVENT",
      `UID:${r.date}-${icsEscape(r.name)}-${r.status}@habits`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${ymd}`,
      `DTEND;VALUE=DATE:${endYmd}`,
      `SUMMARY:${mark} ${icsEscape(r.name)}${suffix}`,
      ...(r.note ? [`DESCRIPTION:${icsEscape(r.note)}`] : []),
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");

  res.type("text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="habits.ics"');
  res.send(lines.join("\r\n") + "\r\n");
});

// --- Administration (console) ---

// Connexion admin (identifiants d'environnement).
app.post("/api/admin/login", (req, res) => {
  if (!isAdminConfigured())
    return res.status(503).json({ error: "Console admin non configurée (ADMIN_PASSWORD)" });
  const email = String(req.body?.email || "");
  const password = String(req.body?.password || "");
  if (!verifyAdmin(email, password))
    return res.status(401).json({ error: "Identifiants admin incorrects" });
  const token = createAdminSession();
  setAdminCookie(req, res, token);
  res.json({ admin: true, email: getAdminEmail() });
});

app.post("/api/admin/logout", (req, res) => {
  deleteAdminSession(parseCookies(req)[ADMIN_COOKIE]);
  clearAdminCookie(req, res);
  res.status(204).end();
});

app.get("/api/admin/me", (req, res) => {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!isAdminSession(token))
    return res.status(401).json({ error: "Admin non authentifié", configured: isAdminConfigured() });
  res.json({ admin: true, email: getAdminEmail() });
});

// Liste des utilisateurs + nombre d'habitudes.
app.get("/api/admin/users", requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.email, u.created_at,
              (SELECT COUNT(*) FROM habits h WHERE h.user_id = u.id) AS habit_count,
              (SELECT COUNT(*) FROM habits h WHERE h.user_id = u.id AND h.archived = 0) AS active_count
       FROM users u ORDER BY u.id`
    )
    .all();
  res.json(rows);
});

// Modifier un utilisateur : email et/ou mot de passe.
app.put("/api/admin/users/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });

  let email = user.email;
  if (req.body?.email !== undefined) {
    email = String(req.body.email).trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ error: "Email invalide" });
    const clash = db.prepare("SELECT id FROM users WHERE email = ? AND id <> ?").get(email, id);
    if (clash) return res.status(409).json({ error: "Cet email est déjà utilisé" });
  }

  let password = user.password;
  if (req.body?.password !== undefined && req.body.password !== "") {
    if (String(req.body.password).length < 8)
      return res.status(400).json({ error: "Mot de passe : 8 caractères minimum" });
    password = hashPassword(String(req.body.password));
  }

  db.prepare("UPDATE users SET email = ?, password = ? WHERE id = ?").run(email, password, id);
  res.json({ id, email });
});

// Supprimer un utilisateur (et ses habitudes/logs/notes/partages via cascade).
app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const info = db.prepare("DELETE FROM users WHERE id = ?").run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: "Utilisateur introuvable" });
  res.status(204).end();
});

// Réglages applicatifs.
app.get("/api/admin/settings", requireAdmin, (req, res) => {
  res.json({ allow_registration: registrationAllowed() });
});

app.put("/api/admin/settings", requireAdmin, (req, res) => {
  if (req.body?.allow_registration !== undefined) {
    const v = req.body.allow_registration ? "true" : "false";
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('allow_registration', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(v);
  }
  res.json({ allow_registration: registrationAllowed() });
});

// --- Partage (lecture seule) ---

// Personnes avec qui JE partage (sortant), avec l'habitude concernée (ou toutes).
app.get("/api/shares", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id, u.email, s.habit_id, h.name AS habit_name
       FROM shares s
       JOIN users u ON u.id = s.viewer_id
       LEFT JOIN habits h ON h.id = s.habit_id
       WHERE s.owner_id = ? ORDER BY u.email, h.name`
    )
    .all(req.user.id);
  res.json(rows);
});

// Partager avec un utilisateur : toutes les habitudes, ou une seule via habit_id.
app.post("/api/shares", requireAuth, (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!isValidEmail(email)) return res.status(400).json({ error: "Email invalide" });

  const viewer = db.prepare("SELECT id, email FROM users WHERE email = ?").get(email);
  if (!viewer) return res.status(404).json({ error: "Aucun utilisateur avec cet email" });
  if (viewer.id === req.user.id)
    return res.status(400).json({ error: "Vous ne pouvez pas vous partager à vous-même" });

  // Habitude ciblée (optionnelle). Doit appartenir au propriétaire.
  let habitId = null;
  let habitName = null;
  if (req.body?.habit_id !== undefined && req.body.habit_id !== null && req.body.habit_id !== "") {
    habitId = Number(req.body.habit_id);
    const habit = db
      .prepare("SELECT id, name FROM habits WHERE id = ? AND user_id = ?")
      .get(habitId, req.user.id);
    if (!habit) return res.status(404).json({ error: "Habitude introuvable" });
    habitName = habit.name;
  }

  const dup = db
    .prepare(
      habitId === null
        ? "SELECT id FROM shares WHERE owner_id = ? AND viewer_id = ? AND habit_id IS NULL"
        : "SELECT id FROM shares WHERE owner_id = ? AND viewer_id = ? AND habit_id = ?"
    )
    .get(...(habitId === null ? [req.user.id, viewer.id] : [req.user.id, viewer.id, habitId]));
  if (dup) return res.status(409).json({ error: "Ce partage existe déjà" });

  const info = db
    .prepare("INSERT INTO shares (owner_id, viewer_id, habit_id) VALUES (?, ?, ?)")
    .run(req.user.id, viewer.id, habitId);
  logActivity(req.user.id, {
    type: "share_added",
    habitName,
    detail: `Partage avec ${viewer.email} (${habitName || "toutes les habitudes"})`,
  });
  res.status(201).json({ id: info.lastInsertRowid, email: viewer.email, habit_id: habitId, habit_name: habitName });
});

// Révoquer un partage que j'ai créé.
app.delete("/api/shares/:id", requireAuth, (req, res) => {
  const info = db
    .prepare("DELETE FROM shares WHERE id = ? AND owner_id = ?")
    .run(Number(req.params.id), req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: "Partage introuvable" });
  res.status(204).end();
});

// Personnes qui ont partagé AVEC moi (entrant) — propriétaires distincts.
app.get("/api/shared", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT u.id, u.email FROM shares s JOIN users u ON u.id = s.owner_id
       WHERE s.viewer_id = ? ORDER BY u.email`
    )
    .all(req.user.id);
  res.json(rows);
});

// --- Validation helpers ---
const isValidDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isValidMonth = (s) => typeof s === "string" && /^\d{4}-\d{2}$/.test(s);

// --- Commentaires d'un lecteur sur une habitude partagée ---

// Vérifie que `viewerId` a accès en lecture à `habitId` (partage all ou ciblé).
function canViewHabit(habitId, viewerId) {
  const habit = db.prepare("SELECT id, name, user_id FROM habits WHERE id = ?").get(habitId);
  if (!habit) return null;
  if (habit.user_id === viewerId) return { habit, isOwner: true };
  const share = db
    .prepare(
      "SELECT 1 FROM shares WHERE owner_id = ? AND viewer_id = ? AND (habit_id IS NULL OR habit_id = ?)"
    )
    .get(habit.user_id, viewerId, habitId);
  return share ? { habit, isOwner: false } : null;
}

// Lire les commentaires partagés d'une habitude pour un jour.
app.get("/api/shared-comments", requireAuth, (req, res) => {
  const habitId = Number(req.query.habit_id);
  const date = req.query.date;
  if (!habitId || !isValidDate(date)) return res.status(400).json({ error: "habit_id et date requis" });
  const acc = canViewHabit(habitId, req.user.id);
  if (!acc) return res.status(403).json({ error: "Accès non autorisé" });

  const rows = db
    .prepare(
      `SELECT c.text, c.author_id, u.email AS author
       FROM shared_comments c JOIN users u ON u.id = c.author_id
       WHERE c.habit_id = ? AND c.date = ? ORDER BY c.created_at`
    )
    .all(habitId, date);

  // Le propriétaire voit tout ; un lecteur ne voit que son propre commentaire.
  const visible = acc.isOwner ? rows : rows.filter((r) => r.author_id === req.user.id);
  res.json({
    isOwner: acc.isOwner,
    mine: (rows.find((r) => r.author_id === req.user.id) || {}).text || "",
    comments: visible.map((r) => ({ author: r.author, text: r.text, mine: r.author_id === req.user.id })),
  });
});

// Ajouter / modifier / supprimer son commentaire sur une habitude partagée.
app.put("/api/shared-comments", requireAuth, (req, res) => {
  const habitId = Number(req.body?.habit_id);
  const date = req.body?.date;
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!habitId || !isValidDate(date)) return res.status(400).json({ error: "habit_id et date requis" });

  const acc = canViewHabit(habitId, req.user.id);
  if (!acc) return res.status(403).json({ error: "Accès non autorisé" });
  if (acc.isOwner)
    return res.status(400).json({ error: "Utilisez les commentaires normaux sur vos propres habitudes" });

  if (text === "") {
    db.prepare("DELETE FROM shared_comments WHERE habit_id = ? AND date = ? AND author_id = ?").run(
      habitId, date, req.user.id
    );
    return res.json({ text: "" });
  }

  db.prepare(
    `INSERT INTO shared_comments (habit_id, date, author_id, text) VALUES (?, ?, ?, ?)
     ON CONFLICT(habit_id, date, author_id) DO UPDATE SET text = excluded.text`
  ).run(habitId, date, req.user.id, text);

  // Notifie le propriétaire (non lu).
  logActivity(acc.habit.user_id, {
    actor: req.user.email,
    type: "shared_comment",
    habitId,
    habitName: acc.habit.name,
    date,
    detail: text,
    read: 0,
  });

  res.json({ text });
});

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

// List active habits (ordered). `?owner=` pour consulter un partage.
app.get("/api/habits", requireAuth, (req, res) => {
  const acc = resolveAccess(req);
  if (!acc) return res.status(403).json({ error: "Accès non autorisé" });
  const habits = db
    .prepare("SELECT * FROM habits WHERE archived = 0 AND user_id = ? ORDER BY sort_order, id")
    .all(acc.ownerId);
  res.json(filterHabits(habits, acc.habitIds));
});

// Create a habit
app.post("/api/habits", requireAuth, (req, res) => {
  const name = (req.body?.name || "").trim();
  const color = (req.body?.color || "#4f46e5").trim();
  if (!name) return res.status(400).json({ error: "Le nom est requis" });

  const days = req.body?.days !== undefined ? normalizeDays(req.body.days) : "1111111";
  if (days === undefined) return res.status(400).json({ error: "Jours invalides" });
  const icon = String(req.body?.icon || "").trim().slice(0, 8);

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
      "INSERT INTO habits (name, color, sort_order, days, start_date, end_date, user_id, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(name, color, maxOrder + 1, days, startDate, endDate, req.user.id, icon);
  const habit = db
    .prepare("SELECT * FROM habits WHERE id = ?")
    .get(info.lastInsertRowid);
  logActivity(req.user.id, { type: "created", habitId: habit.id, habitName: habit.name });
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

  const icon = req.body?.icon !== undefined ? String(req.body.icon).trim().slice(0, 8) : existing.icon;

  db.prepare(
    "UPDATE habits SET name = ?, color = ?, days = ?, start_date = ?, end_date = ?, icon = ? WHERE id = ?"
  ).run(name, color, days, startDate, endDate, icon, id);
  res.json(db.prepare("SELECT * FROM habits WHERE id = ?").get(id));
});

// Delete a habit (and its logs via cascade)
app.delete("/api/habits/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT name FROM habits WHERE id = ? AND user_id = ?").get(id, req.user.id);
  const info = db
    .prepare("DELETE FROM habits WHERE id = ? AND user_id = ?")
    .run(id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: "Habitude introuvable" });
  logActivity(req.user.id, { type: "deleted", habitName: existing.name });
  res.status(204).end();
});

// --- Logs (daily completions) ---

// Statuts des habitudes pour une date : { habit_id: 'done' | 'missed' }.
// (Une habitude absente de la carte = « rien ».)
app.get("/api/logs", requireAuth, (req, res) => {
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: "Date invalide (YYYY-MM-DD)" });
  const acc = resolveAccess(req);
  if (!acc) return res.status(403).json({ error: "Accès non autorisé" });
  const rows = db
    .prepare(
      "SELECT l.habit_id, l.status FROM logs l JOIN habits h ON h.id = l.habit_id WHERE l.date = ? AND h.user_id = ?"
    )
    .all(date, acc.ownerId);
  const out = {};
  for (const r of rows) {
    if (!acc.habitIds || acc.habitIds.has(r.habit_id)) out[r.habit_id] = r.status;
  }
  res.json(out);
});

// Définit l'état d'une habitude pour un jour : 'done', 'missed' ou 'none'.
app.post("/api/logs/set", requireAuth, (req, res) => {
  const habitId = Number(req.body?.habit_id);
  const date = req.body?.date;
  const status = req.body?.status;
  if (!habitId || !isValidDate(date))
    return res.status(400).json({ error: "habit_id et date (YYYY-MM-DD) requis" });
  if (!["done", "missed", "none"].includes(status))
    return res.status(400).json({ error: "status doit être done, missed ou none" });

  const habit = db
    .prepare("SELECT id, name FROM habits WHERE id = ? AND user_id = ?")
    .get(habitId, req.user.id);
  if (!habit) return res.status(404).json({ error: "Habitude introuvable" });

  if (status === "none") {
    db.prepare("DELETE FROM logs WHERE habit_id = ? AND date = ?").run(habitId, date);
  } else {
    db.prepare(
      `INSERT INTO logs (habit_id, date, status) VALUES (?, ?, ?)
       ON CONFLICT(habit_id, date) DO UPDATE SET status = excluded.status`
    ).run(habitId, date, status);
  }
  logActivity(req.user.id, { type: status, habitId, habitName: habit.name, date });
  res.json({ habit_id: habitId, date, status });
});

// Bascule simple fait/rien (conservée pour compatibilité, ex. MCP).
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
    .prepare("SELECT id, status FROM logs WHERE habit_id = ? AND date = ?")
    .get(habitId, date);

  if (existing && existing.status === "done") {
    db.prepare("DELETE FROM logs WHERE id = ?").run(existing.id);
    res.json({ habit_id: habitId, date, done: false });
  } else {
    db.prepare(
      `INSERT INTO logs (habit_id, date, status) VALUES (?, ?, 'done')
       ON CONFLICT(habit_id, date) DO UPDATE SET status = 'done'`
    ).run(habitId, date);
    res.json({ habit_id: habitId, date, done: true });
  }
});

// --- Notes (commentaire par habitude et par jour) ---

// Notes de toutes les habitudes de l'utilisateur pour une date donnée.
app.get("/api/notes", requireAuth, (req, res) => {
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: "Date invalide (YYYY-MM-DD)" });
  const acc = resolveAccess(req);
  if (!acc) return res.status(403).json({ error: "Accès non autorisé" });
  const rows = db
    .prepare(
      "SELECT n.habit_id, n.text FROM notes n JOIN habits h ON h.id = n.habit_id WHERE n.date = ? AND h.user_id = ?"
    )
    .all(date, acc.ownerId);
  const out = {};
  for (const r of rows) {
    if (!acc.habitIds || acc.habitIds.has(r.habit_id)) out[r.habit_id] = r.text;
  }
  res.json(out);
});

// Crée/met à jour (ou supprime si vide) la note d'une habitude pour un jour.
app.put("/api/notes", requireAuth, (req, res) => {
  const habitId = Number(req.body?.habit_id);
  const date = req.body?.date;
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!habitId || !isValidDate(date))
    return res.status(400).json({ error: "habit_id et date (YYYY-MM-DD) requis" });

  const habit = db
    .prepare("SELECT id FROM habits WHERE id = ? AND user_id = ?")
    .get(habitId, req.user.id);
  if (!habit) return res.status(404).json({ error: "Habitude introuvable" });

  if (text === "") {
    db.prepare("DELETE FROM notes WHERE habit_id = ? AND date = ?").run(habitId, date);
    return res.json({ habit_id: habitId, date, text: "" });
  }

  db.prepare(
    `INSERT INTO notes (habit_id, date, text) VALUES (?, ?, ?)
     ON CONFLICT(habit_id, date) DO UPDATE SET text = excluded.text`
  ).run(habitId, date, text);
  res.json({ habit_id: habitId, date, text });
});

// --- Monthly summary ---

// Returns, for a given month (YYYY-MM):
//  - daysInMonth
//  - per-habit completion counts + the list of completed days
app.get("/api/summary", requireAuth, (req, res) => {
  const month = req.query.month;
  if (!isValidMonth(month)) return res.status(400).json({ error: "Mois invalide (YYYY-MM)" });

  const acc = resolveAccess(req);
  if (!acc) return res.status(403).json({ error: "Accès non autorisé" });

  const [year, mon] = month.split("-").map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const prefix = `${month}-%`;

  const habits = filterHabits(
    db
      .prepare("SELECT * FROM habits WHERE archived = 0 AND user_id = ? ORDER BY sort_order, id")
      .all(acc.ownerId),
    acc.habitIds
  );

  let logRows = db
    .prepare(
      "SELECT l.habit_id, l.date FROM logs l JOIN habits h ON h.id = l.habit_id WHERE h.user_id = ? AND l.status = 'done' AND l.date LIKE ? ORDER BY l.date"
    )
    .all(acc.ownerId, prefix);
  if (acc.habitIds) logRows = logRows.filter((r) => acc.habitIds.has(r.habit_id));

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

  const acc = resolveAccess(req);
  if (!acc) return res.status(403).json({ error: "Accès non autorisé" });

  const habits = filterHabits(
    db
      .prepare("SELECT * FROM habits WHERE archived = 0 AND user_id = ? ORDER BY sort_order, id")
      .all(acc.ownerId),
    acc.habitIds
  );

  // habitMap est construit sur les habitudes filtrées : les logs des habitudes
  // non partagées sont donc ignorés.
  const rows = db
    .prepare(
      "SELECT l.habit_id, l.date FROM logs l JOIN habits h ON h.id = l.habit_id WHERE h.user_id = ? AND l.status = 'done' AND l.date LIKE ?"
    )
    .all(acc.ownerId, `${year}-%`);

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

  const acc = resolveAccess(req);
  if (!acc) return res.status(403).json({ error: "Accès non autorisé" });
  if (acc.habitIds && !acc.habitIds.has(id))
    return res.status(404).json({ error: "Habitude introuvable" });
  const habit = db
    .prepare("SELECT * FROM habits WHERE id = ? AND user_id = ?")
    .get(id, acc.ownerId);
  if (!habit) return res.status(404).json({ error: "Habitude introuvable" });

  const rows = db
    .prepare("SELECT date, status FROM logs WHERE habit_id = ? AND date LIKE ? ORDER BY date")
    .all(id, `${month}-%`);
  const statuses = {}; // { date: 'done' | 'missed' }
  for (const r of rows) statuses[r.date] = r.status;

  const noteRows = db
    .prepare("SELECT date, text FROM notes WHERE habit_id = ? AND date LIKE ?")
    .all(id, `${month}-%`);
  const notes = {};
  for (const n of noteRows) notes[n.date] = n.text;

  res.json({
    id,
    days: habit.days,
    start_date: habit.start_date,
    end_date: habit.end_date,
    dates: rows.filter((r) => r.status === "done").map((r) => r.date),
    statuses,
    notes,
  });
});

app.listen(PORT, () => {
  console.log(`Habits Counting en écoute sur http://localhost:${PORT}`);
});
