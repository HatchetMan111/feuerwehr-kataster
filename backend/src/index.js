import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import pool from './db.js';
import { signToken, requireAuth, requireRole } from './auth.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Beim Start: ersten Admin-Nutzer anlegen, falls noch keiner existiert ---
async function ensureAdminUser() {
  try {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Feuerwehr-Kataster Backend läuft auf Port ${PORT}`));
