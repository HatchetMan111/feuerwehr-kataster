import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pool from './db.js';
import { signToken, requireAuth, requireRole } from './auth.js';

const UPLOAD_DIR = '/app/uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' })); // genug Spielraum für ein Handyfoto als Base64
app.use('/uploads', express.static(UPLOAD_DIR));

// --- Beim Start: Schema-Ergänzungen, die auch auf bereits laufenden Installationen greifen ---
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      wehrname TEXT NOT NULL DEFAULT 'Musterwehr',
      CHECK (id = 1)
    )
  `);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM settings');
  if (rows[0].count === 0) {
    await pool.query('INSERT INTO settings (id, wehrname) VALUES (1, $1)', [process.env.WEHRNAME || 'Musterwehr']);
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
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });
  }
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Benutzername oder Passwort ist falsch.' });
  }
  res.json({ token: signToken(user), role: user.role, username: user.username });
});

// Eigenes Passwort ändern
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Neues Passwort muss mindestens 8 Zeichen haben.' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  res.json({ ok: true });
});

// Neue Nutzer anlegen (nur Admin)
app.post('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || !['admin', 'gruppenfuehrer'].includes(role)) {
    return res.status(400).json({ error: 'Benutzername, Passwort und gültige Rolle erforderlich.' });
  }
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
      [username, hash, role]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: 'Benutzername existiert bereits.' });
  }
});

// --- Einstellungen ---
app.get('/api/settings', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT wehrname FROM settings WHERE id = 1');
  res.json(rows[0] || { wehrname: 'Musterwehr' });
});

app.put('/api/settings', requireAuth, requireRole('admin'), async (req, res) => {
  const { wehrname } = req.body || {};
  if (!wehrname || !wehrname.trim()) {
    return res.status(400).json({ error: 'Name darf nicht leer sein.' });
  }
  await pool.query('UPDATE settings SET wehrname = $1 WHERE id = 1', [wehrname.trim()]);
  res.json({ ok: true });
});

// --- Kategorien ---
app.get('/api/categories', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY id');
  res.json(rows);
});

// --- Punkte ---
app.get('/api/points', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.*, ST_X(geom) AS lng, ST_Y(geom) AS lat,
           c.key AS category_key, c.label AS category_label, c.color AS category_color
    FROM points p
    JOIN categories c ON c.id = p.category_id
    ORDER BY p.id
  `);
  res.json(rows);
});

app.post('/api/points', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.category_id || b.lat == null || b.lng == null) {
    return res.status(400).json({ error: 'Name, Kategorie und Koordinaten sind erforderlich.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO points
       (name, category_id, geom, capacity_liters, accessibility, condition_note,
        owner_name, owner_phone, key_deposit_note, last_checked, created_by)
     VALUES
       ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [b.name, b.category_id, b.lng, b.lat, b.capacity_liters || null, b.accessibility || null,
     b.condition_note || null, b.owner_name || null, b.owner_phone || null,
     b.key_deposit_note || null, b.last_checked || null, req.user.id]
  );
  await pool.query(
    `INSERT INTO point_history (point_id, changed_by, change_type, new_data)
     VALUES ($1, $2, 'created', $3)`,
    [rows[0].id, req.user.id, JSON.stringify(b)]
  );
  res.status(201).json({ id: rows[0].id });
});

app.put('/api/points/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const { rows: old } = await pool.query('SELECT * FROM points WHERE id = $1', [req.params.id]);
  if (!old[0]) return res.status(404).json({ error: 'Punkt nicht gefunden.' });

  await pool.query(
    `UPDATE points SET
       name = $1, category_id = $2, geom = ST_SetSRID(ST_MakePoint($3, $4), 4326),
       capacity_liters = $5, accessibility = $6, condition_note = $7,
       owner_name = $8, owner_phone = $9, key_deposit_note = $10,
       last_checked = $11, updated_at = now()
     WHERE id = $12`,
    [b.name, b.category_id, b.lng, b.lat, b.capacity_liters || null, b.accessibility || null,
     b.condition_note || null, b.owner_name || null, b.owner_phone || null,
     b.key_deposit_note || null, b.last_checked || null, req.params.id]
  );
  await pool.query(
    `INSERT INTO point_history (point_id, changed_by, change_type, old_data, new_data)
     VALUES ($1, $2, 'updated', $3, $4)`,
    [req.params.id, req.user.id, JSON.stringify(old[0]), JSON.stringify(b)]
  );
  res.json({ ok: true });
});

// Löschen nur für Admins - Gruppenführer können anlegen/bearbeiten, aber nichts endgültig entfernen
app.delete('/api/points/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows: old } = await pool.query('SELECT * FROM points WHERE id = $1', [req.params.id]);
  if (!old[0]) return res.status(404).json({ error: 'Punkt nicht gefunden.' });

  await pool.query('DELETE FROM points WHERE id = $1', [req.params.id]);
  await pool.query(
    `INSERT INTO point_history (point_id, changed_by, change_type, old_data)
     VALUES ($1, $2, 'deleted', $3)`,
    [req.params.id, req.user.id, JSON.stringify(old[0])]
  );

  if (old[0].photo_url) {
    const filePath = path.join(UPLOAD_DIR, path.basename(old[0].photo_url));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  res.json({ ok: true });
});

app.get('/api/points/:id/history', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT h.*, u.username
     FROM point_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE point_id = $1
     ORDER BY changed_at DESC`,
    [req.params.id]
  );
  res.json(rows);
});

// --- Foto-Upload ---
const ALLOWED_IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

app.post('/api/points/:id/photo', requireAuth, async (req, res) => {
  const { photo_base64 } = req.body || {};
  if (!photo_base64 || !photo_base64.startsWith('data:')) {
    return res.status(400).json({ error: 'Kein gültiges Bild übermittelt.' });
  }

  const match = photo_base64.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
  if (!match || !ALLOWED_IMAGE_TYPES[match[1]]) {
    return res.status(400).json({ error: 'Nur JPEG-, PNG- oder WebP-Bilder sind erlaubt.' });
  }

  const { rows: existing } = await pool.query('SELECT * FROM points WHERE id = $1', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: 'Punkt nicht gefunden.' });

  const ext = ALLOWED_IMAGE_TYPES[match[1]];
  const filename = `${req.params.id}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
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
  await pool.query('UPDATE points SET photo_url = $1, updated_at = now() WHERE id = $2', [photoUrl, req.params.id]);
  await pool.query(
    `INSERT INTO point_history (point_id, changed_by, change_type, new_data)
     VALUES ($1, $2, 'photo_updated', $3)`,
    [req.params.id, req.user.id, JSON.stringify({ photo_url: photoUrl })]
  );

  res.json({ photo_url: photoUrl });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Feuerwehr-Kataster Backend läuft auf Port ${PORT}`));
