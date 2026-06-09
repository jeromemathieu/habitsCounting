import crypto from "node:crypto";
import db from "./db.js";

const SESSION_COOKIE = "sid";
const SESSION_DAYS = 30;

// --- Mots de passe (scrypt, intégré à Node — aucune dépendance native) ---
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const ref = Buffer.from(hash, "hex");
  return test.length === ref.length && crypto.timingSafeEqual(test, ref);
}

// --- Sessions ---
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    expires
  );
  return token;
}

export function getSessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return { id: row.id, email: row.email };
}

export function deleteSession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// --- Cookies ---
export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Cookie Secure automatiquement actif derrière un proxy HTTPS (Traefik).
function isSecure(req) {
  return (
    req.secure ||
    (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"
  );
}

export function setSessionCookie(req, res, token) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (isSecure(req)) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

export function clearSessionCookie(req, res) {
  const attrs = [`${SESSION_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (isSecure(req)) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

// --- Administration ---
// Identifiants admin via variables d'environnement (mot de passe unique).
const ADMIN_COOKIE = "asid";
const ADMIN_SESSION_HOURS = 8;
const adminSessions = new Map(); // token -> expiry (ms)

export function isAdminConfigured() {
  return !!process.env.ADMIN_PASSWORD;
}

export function getAdminEmail() {
  return (process.env.ADMIN_EMAIL || "admin").trim().toLowerCase();
}

// Comparaison à temps constant de deux chaînes.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function verifyAdmin(email, password) {
  if (!isAdminConfigured()) return false;
  const okEmail = safeEqual(String(email).trim().toLowerCase(), getAdminEmail());
  const okPass = safeEqual(password, process.env.ADMIN_PASSWORD);
  return okEmail && okPass;
}

export function createAdminSession() {
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, Date.now() + ADMIN_SESSION_HOURS * 3600_000);
  return token;
}

export function isAdminSession(token) {
  if (!token) return false;
  const exp = adminSessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

export function deleteAdminSession(token) {
  if (token) adminSessions.delete(token);
}

export function setAdminCookie(req, res, token) {
  const attrs = [
    `${ADMIN_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${ADMIN_SESSION_HOURS * 3600}`,
  ];
  if (isSecure(req)) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

export function clearAdminCookie(req, res) {
  const attrs = [`${ADMIN_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (isSecure(req)) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

export { SESSION_COOKIE, ADMIN_COOKIE };
