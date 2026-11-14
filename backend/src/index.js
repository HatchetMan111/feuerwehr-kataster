import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pool from './db.js';
import { signToken, requireAuth, requireRole, requireAuthFlexible } from './auth.js';

const UPLOAD_DIR = '/app/uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Fail-fast: Ohne JWT_SECRET würde jeder Login erst zur Laufzeit mit einer
// kryptischen Fehlermeldung scheitern. Besser mit klarer Meldung direkt beim Start.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('FEHLER: JWT_SECRET ist nicht gesetzt oder zu kurz (min. 16 Zeichen). Bitte .env prüfen.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Caddy leitet X-Forwarded-For weiter, damit req.ip die echte Client-IP ist
app.use(cors());
app.use(express.json({ limit: '12mb' })); // genug Spielraum für ein Handyfoto als Base64
// Fotos enthalten personenbezogene Daten (Eigentümer, Telefonnummer) und sind
// deshalb nicht offen erreichbar. <img>-Tags können keine Header mitschicken,
// daher akzeptiert requireAuthFlexible das Token zusätzlich als ?token=...
app.use('/uploads', requireAuthFlexible, express.static(UPLOAD_DIR));

// Express 4 fängt Fehler in async-Route-Handlern NICHT ab - ohne diesen Wrapper
// würde die Anfrage bei jedem DB-Fehler einfach ewig hängen, ohne eine Antwort.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Einfache Brute-Force-Bremse für den Login: zählt nur FEHLGESCHLAGENE Versuche
// pro IP (erfolgreiche Anmeldungen zählen nicht, sonst sperrt man sich bei
// gemeinsamer VPN-IP gegenseitig aus).
const failedLogins = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
function loginTooOften(ip) {
  const entry = failedLogins.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) { failedLogins.delete(ip); return false; }
  return entry.count >= LOGIN_MAX_FAILURES;
}
function registerLoginFailure(ip) {
  const entry = failedLogins.get(ip);
  if (entry && Date.now() <= entry.resetAt) {
    entry.count++;
  } else {
    failedLogins.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  }
}

// --- Beim Start: Schema-Ergänzungen, die auch auf bereits laufenden Installationen greifen ---
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      wehrname TEXT NOT NULL DEFAULT 'Musterwehr',
      overdue_months INTEGER NOT NULL DEFAULT 12,
      CHECK (id = 1)
    )
  `);
  // Migration für Datenbanken, die vor Einführung von overdue_months angelegt wurden
  await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS overdue_months INTEGER NOT NULL DEFAULT 12`);
  // Startposition der Karte (Gerätehaus), gesetzt aus WEHR_LAT / WEHR_LNG / WEHR_VIEW_RADIUS
  await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS home_lat DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS home_lng DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS home_radius INTEGER`);

  const homeLat = Number(process.env.WEHR_LAT);
  const homeLng = Number(process.env.WEHR_LNG);
  const radiusRaw = Number(process.env.WEHR_VIEW_RADIUS);
  const homeRadius = Number.isInteger(radiusRaw) && radiusRaw > 0 ? radiusRaw : null;
  const hasHome = Number.isFinite(homeLat) && Number.isFinite(homeLng)
    && Math.abs(homeLat) <= 90 && Math.abs(homeLng) <= 180;

  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM settings');
  if (rows[0].count === 0) {
    await pool.query(
      `INSERT INTO settings (id, wehrname, home_lat, home_lng, home_radius) VALUES (1, $1, $2, $3, $4)`,
      [process.env.WEHRNAME || 'Musterwehr', hasHome ? homeLat : null, hasHome ? homeLng : null, homeRadius]
    );
  } else if (hasHome) {
    // Bestehende Installationen nachrüsten, solange noch kein Standort hinterlegt ist
    await pool.query(
      `UPDATE settings SET home_lat = $1, home_lng = $2, home_radius = COALESCE($3, home_radius) WHERE id = 1 AND home_lat IS NULL`,
      [homeLat, homeLng, homeRadius]
    );
  }
}

// --- Beim Start: ersten Admin-Nutzer anlegen, falls noch keiner existiert ---
async function ensureAdminUser() {
  try {
    await ensureSchema();
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM users');
    if (rows[0].count === 0) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'changeme', 10);
      await pool.query(
        `INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin')`,
        [hash]
      );
      console.log('Admin-Nutzer "admin" wurde mit dem Passwort aus ADMIN_PASSWORD angelegt.');
    }
  } catch (err) {
    console.error('Konnte Admin-Nutzer nicht anlegen, versuche es in 3s erneut:', err.message);
    setTimeout(ensureAdminUser, 3000);
  }
}
ensureAdminUser();

// --- Status ---
app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- Anmeldung ---
app.post('/api/auth/login', ah(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });
  }
  if (loginTooOften(req.ip)) {
    return res.status(429).json({ error: 'Zu viele fehlgeschlagene Anmeldeversuche. Bitte in 10 Minuten erneut versuchen.' });
  }
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    registerLoginFailure(req.ip);
    return res.status(401).json({ error: 'Benutzername oder Passwort ist falsch.' });
  }
  failedLogins.delete(req.ip); // erfolgreicher Zugang setzt den Zähler zurück
  res.json({ token: signToken(user), role: user.role, username: user.username });
}));

// Eigenes Passwort ändern
app.post('/api/auth/change-password', requireAuth, ah(async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Neues Passwort muss mindestens 8 Zeichen haben.' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  res.json({ ok: true });
}));

// Neue Nutzer anlegen (nur Admin)
app.post('/api/users', requireAuth, requireRole('admin'), ah(async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !username.trim() || username.trim().length > 50 || !password || !['admin', 'gruppenfuehrer'].includes(role)) {
    return res.status(400).json({ error: 'Benutzername, Passwort und gültige Rolle erforderlich.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben.' });
  }
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
      [username.trim(), hash, role]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: 'Benutzername existiert bereits.' });
  }
}));

// --- Einstellungen ---
app.get('/api/settings', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT wehrname, overdue_months, home_lat, home_lng, home_radius FROM settings WHERE id = 1');
  res.json(rows[0] || { wehrname: 'Musterwehr', overdue_months: 12, home_lat: null, home_lng: null, home_radius: null });
}));

app.put('/api/settings', requireAuth, requireRole('admin'), ah(async (req, res) => {
  const { wehrname, overdue_months } = req.body || {};
  if (!wehrname || !wehrname.trim()) {
    return res.status(400).json({ error: 'Name darf nicht leer sein.' });
  }
  const months = Number(overdue_months);
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    return res.status(400).json({ error: 'Prüfintervall muss zwischen 1 und 120 Monaten liegen.' });
  }
  await pool.query('UPDATE settings SET wehrname = $1, overdue_months = $2 WHERE id = 1', [wehrname.trim(), months]);
  res.json({ ok: true });
}));

// --- Speicherplatz-Status (wird von check-disk.sh per Cron aktualisiert) ---
app.get('/api/system-status', requireAuth, ah(async (req, res) => {
  try {
    const raw = fs.readFileSync('/app/status/disk.json', 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.json({ disk_percent: null, warning: false, checked_at: null });
  }
}));

// --- Kategorien ---
// bewusst auch mit Auth: die App lädt sie nach der Anmeldung, und die Route
// soll konsistent mit den übrigen API-Endpunkten nicht offen im Netz stehen
app.get('/api/categories', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY id');
  res.json(rows);
}));

// --- Punkte ---
// Einheitliche Prüfung der Punkt-Felder, damit fehlerhafte Eingaben als
// verständlicher 400 ankommen statt als DB-Fehler 500 (oder gar hängende Anfrage)
function validatePointBody(b) {
  if (!b.name || typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 200) {
    return 'Name ist erforderlich (max. 200 Zeichen).';
  }
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return 'Breitengrad ungültig.';
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return 'Längengrad ungültig.';
  if (b.category_id == null || !Number.isInteger(Number(b.category_id))) return 'Kategorie ungültig.';
  if (b.capacity_liters != null && (!Number.isInteger(Number(b.capacity_liters)) || Number(b.capacity_liters) < 0)) {
    return 'Fassungsvermögen muss eine ganze Zahl ≥ 0 sein.';
  }
  if (b.last_checked != null && !/^\d{4}-\d{2}-\d{2}$/.test(b.last_checked)) {
    return 'Ungültiges Datum für die letzte Prüfung.';
  }
  return null;
}

async function categoryExists(id) {
  const { rows } = await pool.query('SELECT 1 FROM categories WHERE id = $1', [id]);
  return rows.length > 0;
}

app.get('/api/points', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.*, ST_X(geom) AS lng, ST_Y(geom) AS lat,
           c.key AS category_key, c.label AS category_label, c.color AS category_color
    FROM points p
    JOIN categories c ON c.id = p.category_id
    ORDER BY p.id
  `);
  res.json(rows);
}));

// ID-Parameter einheitlich prüfen: /api/points/abc soll als verständlicher
// 400 ankommen statt als Postgres-Fehler
function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

app.post('/api/points', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  const validationError = validatePointBody(b);
  if (validationError) return res.status(400).json({ error: validationError });

  const categoryId = Number(b.category_id);
  if (!(await categoryExists(categoryId))) {
    return res.status(400).json({ error: 'Unbekannte Kategorie.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO points
       (name, category_id, geom, capacity_liters, accessibility, condition_note,
        owner_name, owner_phone, key_deposit_note, last_checked, created_by)
     VALUES
       ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [b.name.trim(), categoryId, Number(b.lng), Number(b.lat), b.capacity_liters == null || b.capacity_liters === '' ? null : Number(b.capacity_liters), b.accessibility || null,
     b.condition_note || null, b.owner_name || null, b.owner_phone || null,
     b.key_deposit_note || null, b.last_checked || null, req.user.id]
  );
  await pool.query(
    `INSERT INTO point_history (point_id, changed_by, change_type, new_data)
     VALUES ($1, $2, 'created', $3)`,
    [rows[0].id, req.user.id, JSON.stringify(b)]
  );
  res.status(201).json({ id: rows[0].id });
}));

app.put('/api/points/:id', requireAuth, ah(async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'Ungültige Punkt-ID.' });

  const b = req.body || {};
  const validationError = validatePointBody(b);
  if (validationError) return res.status(400).json({ error: validationError });

  const { rows: old } = await pool.query('SELECT * FROM points WHERE id = $1', [id]);
  if (!old[0]) return res.status(404).json({ error: 'Punkt nicht gefunden.' });

  const categoryId = Number(b.category_id);
  if (!(await categoryExists(categoryId))) {
    return res.status(400).json({ error: 'Unbekannte Kategorie.' });
  }

  await pool.query(
    `UPDATE points SET
       name = $1, category_id = $2, geom = ST_SetSRID(ST_MakePoint($3, $4), 4326),
       capacity_liters = $5, accessibility = $6, condition_note = $7,
       owner_name = $8, owner_phone = $9, key_deposit_note = $10,
       last_checked = $11, updated_at = now()
     WHERE id = $12`,
    [b.name.trim(), categoryId, Number(b.lng), Number(b.lat), b.capacity_liters == null || b.capacity_liters === '' ? null : Number(b.capacity_liters), b.accessibility || null,
     b.condition_note || null, b.owner_name || null, b.owner_phone || null,
     b.key_deposit_note || null, b.last_checked || null, id]
  );
  await pool.query(
    `INSERT INTO point_history (point_id, changed_by, change_type, old_data, new_data)
     VALUES ($1, $2, 'updated', $3, $4)`,
    [id, req.user.id, JSON.stringify(old[0]), JSON.stringify(b)]
  );
  res.json({ ok: true });
}));

// Löschen nur für Admins - Gruppenführer können anlegen/bearbeiten, aber nichts endgültig entfernen
app.delete('/api/points/:id', requireAuth, requireRole('admin'), ah(async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'Ungültige Punkt-ID.' });

  const { rows: old } = await pool.query(
    `SELECT p.*, ST_X(geom) AS lng, ST_Y(geom) AS lat, c.label AS category_label
     FROM points p JOIN categories c ON c.id = p.category_id
     WHERE p.id = $1`,
    [id]
  );
  if (!old[0]) return res.status(404).json({ error: 'Punkt nicht gefunden.' });

  await pool.query('DELETE FROM points WHERE id = $1', [id]);
  await pool.query(
    `INSERT INTO point_history (point_id, changed_by, change_type, old_data)
     VALUES ($1, $2, 'deleted', $3)`,
    [id, req.user.id, JSON.stringify(old[0])]
  );

  if (old[0].photo_url) {
    const filePath = path.join(UPLOAD_DIR, path.basename(old[0].photo_url));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  res.json({ ok: true });
}));

app.get('/api/points/:id/history', requireAuth, ah(async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'Ungültige Punkt-ID.' });

  const { rows } = await pool.query(
    `SELECT h.*, u.username
     FROM point_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE point_id = $1
     ORDER BY changed_at DESC`,
    [id]
  );
  res.json(rows);
}));

// Gelöschte Punkte einsehen (Daten bleiben im Verlauf erhalten, auch nach dem Löschen)
app.get('/api/points/deleted', requireAuth, requireRole('admin'), ah(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT h.point_id, h.old_data, h.changed_at, u.username
    FROM point_history h
    LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.change_type = 'deleted'
    ORDER BY h.changed_at DESC
  `);
  res.json(rows);
}));

// Gelöschten Punkt als neuen Punkt wiederherstellen (Foto muss ggf. neu hochgeladen werden)
app.post('/api/points/deleted/:pointId/restore', requireAuth, requireRole('admin'), ah(async (req, res) => {
  const id = parseId(req.params.pointId);
  if (id == null) return res.status(400).json({ error: 'Ungültige Punkt-ID.' });

  const { rows } = await pool.query(
    `SELECT old_data FROM point_history WHERE point_id = $1 AND change_type = 'deleted' ORDER BY changed_at DESC LIMIT 1`,
    [id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Kein gelöschter Punkt mit dieser ID gefunden.' });
  const d = rows[0].old_data;

  if (!(await categoryExists(Number(d.category_id)))) {
    return res.status(400).json({ error: 'Die Kategorie dieses Punktes existiert nicht mehr.' });
  }

  const { rows: created } = await pool.query(
    `INSERT INTO points
       (name, category_id, geom, capacity_liters, accessibility, condition_note,
        owner_name, owner_phone, key_deposit_note, last_checked, created_by)
     VALUES
       ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [d.name, d.category_id, d.lng, d.lat, d.capacity_liters, d.accessibility, d.condition_note,
     d.owner_name, d.owner_phone, d.key_deposit_note, d.last_checked, req.user.id]
  );

  await pool.query(
    `INSERT INTO point_history (point_id, changed_by, change_type, new_data)
     VALUES ($1, $2, 'restored', $3)`,
    [created[0].id, req.user.id, JSON.stringify(d)]
  );

  res.status(201).json({ id: created[0].id });
}));

// --- Foto-Upload ---
const ALLOWED_IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

app.post('/api/points/:id/photo', requireAuth, ah(async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'Ungültige Punkt-ID.' });

  const { photo_base64 } = req.body || {};
  if (!photo_base64 || !photo_base64.startsWith('data:')) {
    return res.status(400).json({ error: 'Kein gültiges Bild übermittelt.' });
  }

  const match = photo_base64.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
  if (!match || !ALLOWED_IMAGE_TYPES[match[1]]) {
    return res.status(400).json({ error: 'Nur JPEG-, PNG- oder WebP-Bilder sind erlaubt.' });
  }

  const { rows: existing } = await pool.query('SELECT * FROM points WHERE id = $1', [id]);
  if (!existing[0]) return res.status(404).json({ error: 'Punkt nicht gefunden.' });

  const ext = ALLOWED_IMAGE_TYPES[match[1]];
  const filename = `${id}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const buffer = Buffer.from(match[2], 'base64');

  // Grobe Größenprüfung (max. 8 MB nach Dekodierung)
  if (buffer.length > 8 * 1024 * 1024) {
    return res.status(413).json({ error: 'Bild ist zu groß (max. 8 MB).' });
  }

  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);

  // Altes Foto aufräumen, falls vorhanden
  if (existing[0].photo_url) {
    const oldFile = path.basename(existing[0].photo_url);
    const oldPath = path.join(UPLOAD_DIR, oldFile);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  const photoUrl = `/uploads/${filename}`;
  await pool.query('UPDATE points SET photo_url = $1, updated_at = now() WHERE id = $2', [photoUrl, id]);
  await pool.query(
    `INSERT INTO point_history (point_id, changed_by, change_type, new_data)
     VALUES ($1, $2, 'photo_updated', $3)`,
    [id, req.user.id, JSON.stringify({ photo_url: photoUrl })]
  );

  res.json({ photo_url: photoUrl });
}));

// --- Zentraler Fehlerhandler: DB-/Code-Fehler werden als sauberes 500-JSON ---
// beantwortet statt die Anfrage ewig hängen zu lassen (Express 4 fängt
// async-Fehler ohne den ah()-Wrapper oben ohnehin nicht ab).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`Fehler bei ${req.method} ${req.originalUrl}:`, err.message);
  res.status(500).json({ error: 'Interner Serverfehler. Bitte erneut versuchen.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Feuerwehr-Kataster Backend läuft auf Port ${PORT}`));
