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

export { SESSION_COOKIE };
