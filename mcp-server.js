#!/usr/bin/env node
/**
 * Serveur MCP pour Habits Counting.
 *
 * Permet de piloter l'application en langage naturel depuis un client MCP
 * (Claude Desktop, Claude Code...) : consulter les stats, ajouter des
 * habitudes, les compter, cocher des jours, ajouter des commentaires.
 *
 * Il s'authentifie auprès de l'API REST avec un compte utilisateur normal :
 *   HABITS_URL      URL de l'app (défaut http://localhost:3000)
 *   HABITS_EMAIL    email du compte
 *   HABITS_PASSWORD mot de passe du compte
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.HABITS_URL || "http://localhost:3000").replace(/\/$/, "");
const EMAIL = process.env.HABITS_EMAIL;
const PASSWORD = process.env.HABITS_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error("HABITS_EMAIL et HABITS_PASSWORD sont requis.");
  process.exit(1);
}

// --- Client HTTP avec session (cookie sid) ---
let sessionCookie = null;

async function login() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Connexion impossible à ${BASE_URL} : ${body.error || res.status}`);
  }
  const setCookie = res.headers.get("set-cookie") || "";
  const m = /sid=([^;]+)/.exec(setCookie);
  if (!m) throw new Error("Cookie de session absent de la réponse de connexion");
  sessionCookie = `sid=${m[1]}`;
}

async function api(path, opts = {}, retry = true) {
  if (!sessionCookie) await login();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 && retry) {
    sessionCookie = null; // session expirée : on se reconnecte une fois
    return api(path, opts, false);
  }
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erreur HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// --- Helpers ---
const DAY_NAMES = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function maskToDayNames(mask) {
  if (!mask || mask === "1111111") return "tous les jours";
  return mask
    .split("")
    .map((c, i) => (c === "1" ? DAY_NAMES[i] : null))
    .filter(Boolean)
    .join(", ");
}

// Trouve une habitude par id ou par nom (insensible à la casse, partiel accepté).
async function resolveHabit(ref) {
  const habits = await api("/api/habits");
  if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
    const h = habits.find((x) => x.id === Number(ref));
    if (h) return h;
  }
  const needle = String(ref).trim().toLowerCase();
  const exact = habits.filter((h) => h.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const partial = habits.filter((h) => h.name.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1)
    throw new Error(
      `Plusieurs habitudes correspondent à « ${ref} » : ${partial.map((h) => h.name).join(", ")}. Précise le nom.`
    );
  throw new Error(
    `Aucune habitude nommée « ${ref} ». Habitudes existantes : ${habits.map((h) => h.name).join(", ") || "(aucune)"}`
  );
}

const text = (s) => ({ content: [{ type: "text", text: s }] });

// --- Serveur MCP ---
const server = new McpServer({ name: "habits-counting", version: "1.0.0" });

server.registerTool(
  "list_habits",
  {
    title: "Lister les habitudes",
    description:
      "Liste les habitudes suivies (id, nom, jours prévus, période de validité) et leur nombre total. Utile pour compter les habitudes.",
    inputSchema: {},
  },
  async () => {
    const habits = await api("/api/habits");
    if (!habits.length) return text("Aucune habitude pour l'instant.");
    const lines = habits.map((h) => {
      let l = `- [${h.id}] ${h.name} — ${maskToDayNames(h.days)}`;
      if (h.start_date || h.end_date)
        l += ` (du ${h.start_date || "début"} au ${h.end_date || "∞"})`;
      return l;
    });
    return text(`${habits.length} habitude(s) :\n${lines.join("\n")}`);
  }
);

server.registerTool(
  "add_habit",
  {
    title: "Ajouter une habitude",
    description:
      "Crée une nouvelle habitude à suivre. Par défaut elle s'applique tous les jours ; on peut préciser les jours de la semaine et une période de validité.",
    inputSchema: {
      name: z.string().min(1).describe("Nom de l'habitude (ex : Sport)"),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional()
        .describe("Couleur hexadécimale, ex #e11d48 (optionnel)"),
      days: z
        .array(z.number().int().min(0).max(6))
        .optional()
        .describe("Jours prévus : 0=dimanche, 1=lundi … 6=samedi (optionnel, défaut tous)"),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date de début YYYY-MM-DD (optionnel)"),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date de fin YYYY-MM-DD (optionnel)"),
    },
  },
  async ({ name, color, days, start_date, end_date }) => {
    const h = await api("/api/habits", {
      method: "POST",
      body: JSON.stringify({ name, color, days, start_date, end_date }),
    });
    return text(
      `Habitude créée : [${h.id}] ${h.name} — ${maskToDayNames(h.days)}${
        h.start_date || h.end_date ? ` (du ${h.start_date || "début"} au ${h.end_date || "∞"})` : ""
      }`
    );
  }
);

const STATUS_LABEL = { done: "fait ✓", missed: "pas fait ✗", none: "remis à zéro" };

server.registerTool(
  "mark_habit",
  {
    title: "Marquer une habitude (fait / pas fait / rien)",
    description:
      "Définit l'état d'une habitude pour une date : fait (done), pas fait (missed) ou rien (none). Date par défaut : aujourd'hui.",
    inputSchema: {
      habit: z.string().describe("Nom (ou id) de l'habitude"),
      status: z
        .enum(["done", "missed", "none"])
        .optional()
        .describe("done = fait (défaut), missed = pas fait, none = rien"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date YYYY-MM-DD (défaut : aujourd'hui)"),
    },
  },
  async ({ habit, status = "done", date }) => {
    const h = await resolveHabit(habit);
    const day = date || todayISO();
    const current = (await api(`/api/logs?date=${day}`))[h.id] || "none";
    if (current === status)
      return text(`« ${h.name} » est déjà « ${STATUS_LABEL[status]} » pour le ${day}.`);
    await api("/api/logs/set", {
      method: "POST",
      body: JSON.stringify({ habit_id: h.id, date: day, status }),
    });
    return text(`« ${h.name} » → ${STATUS_LABEL[status]} pour le ${day}.`);
  }
);

server.registerTool(
  "day_status",
  {
    title: "Statut d'une journée",
    description:
      "Liste, pour une date donnée (défaut aujourd'hui), les habitudes faites et non faites, avec les commentaires éventuels.",
    inputSchema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date YYYY-MM-DD (défaut : aujourd'hui)"),
    },
  },
  async ({ date }) => {
    const day = date || todayISO();
    const [habits, statuses, notes] = await Promise.all([
      api("/api/habits"),
      api(`/api/logs?date=${day}`), // { id: 'done' | 'missed' }
      api(`/api/notes?date=${day}`),
    ]);
    if (!habits.length) return text("Aucune habitude pour l'instant.");
    const SYMBOL = { done: "✓ fait", missed: "✗ pas fait" };
    let doneCount = 0;
    const lines = habits.map((h) => {
      const st = statuses[h.id];
      if (st === "done") doneCount++;
      const label = SYMBOL[st] || "· rien";
      const note = notes[h.id] ? ` — 💬 ${notes[h.id]}` : "";
      return `- ${label} : ${h.name}${note}`;
    });
    return text(`Le ${day} : ${doneCount}/${habits.length} faites\n${lines.join("\n")}`);
  }
);

server.registerTool(
  "monthly_summary",
  {
    title: "Récapitulatif mensuel",
    description:
      "Statistiques d'un mois : nombre de jours réalisés, jours prévus et taux de régularité par habitude, plus le total du mois.",
    inputSchema: {
      month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("Mois YYYY-MM (défaut : mois courant)"),
    },
  },
  async ({ month }) => {
    const m = month || todayISO().slice(0, 7);
    const s = await api(`/api/summary?month=${m}`);
    if (!s.habits.length) return text("Aucune habitude pour l'instant.");
    const lines = s.habits.map(
      (h) => `- ${h.name} : ${h.count}/${h.scheduled} jours prévus (${h.rate} %)`
    );
    const avg = Math.round(s.habits.reduce((a, h) => a + h.rate, 0) / s.habits.length);
    return text(
      `Récap ${m} — ${s.totalCompletions} action(s) cochée(s), régularité moyenne ${avg} %\n${lines.join("\n")}`
    );
  }
);

server.registerTool(
  "yearly_stats",
  {
    title: "Statistiques annuelles",
    description:
      "Évolution mois par mois sur une année : complétions mensuelles et total annuel par habitude.",
    inputSchema: {
      year: z.string().regex(/^\d{4}$/).optional().describe("Année YYYY (défaut : année courante)"),
    },
  },
  async ({ year }) => {
    const y = year || todayISO().slice(0, 4);
    const t = await api(`/api/trends?year=${y}`);
    if (!t.habits.length) return text("Aucune habitude pour l'instant.");
    const MONTHS = ["jan", "fév", "mar", "avr", "mai", "juin", "juil", "août", "sep", "oct", "nov", "déc"];
    const lines = t.habits.map((h) => {
      const detail = h.monthly
        .map((v, i) => (v ? `${MONTHS[i]} ${v}` : null))
        .filter(Boolean)
        .join(", ");
      return `- ${h.name} : ${h.total} au total${detail ? ` (${detail})` : ""}`;
    });
    return text(`Année ${y} :\n${lines.join("\n")}`);
  }
);

server.registerTool(
  "add_note",
  {
    title: "Ajouter un commentaire",
    description:
      "Ajoute (ou remplace) le commentaire d'une habitude pour un jour donné. Un texte vide supprime le commentaire.",
    inputSchema: {
      habit: z.string().describe("Nom (ou id) de l'habitude"),
      text: z.string().describe("Le commentaire (vide pour supprimer)"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date YYYY-MM-DD (défaut : aujourd'hui)"),
    },
  },
  async ({ habit, text: noteText, date }) => {
    const h = await resolveHabit(habit);
    const day = date || todayISO();
    const saved = await api("/api/notes", {
      method: "PUT",
      body: JSON.stringify({ habit_id: h.id, date: day, text: noteText }),
    });
    return text(
      saved.text
        ? `Commentaire enregistré pour « ${h.name} » le ${day} : ${saved.text}`
        : `Commentaire supprimé pour « ${h.name} » le ${day}.`
    );
  }
);

// --- Démarrage ---
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`MCP habits-counting connecté à ${BASE_URL} (compte ${EMAIL})`);
