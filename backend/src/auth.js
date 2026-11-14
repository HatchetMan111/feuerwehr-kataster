import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;

export function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    SECRET,
    { expiresIn: '30d' }
  );
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Nicht angemeldet.' });
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sitzung abgelaufen, bitte neu anmelden.' });
  }
}

// Wie requireAuth, akzeptiert das Token aber zusätzlich als ?token=...-Parameter.
// Nötig für Fotos: <img>-Tags senden keine Authorization-Header, dürfen aber
// trotzdem nicht ohne Anmeldung laden (Fotos enthalten Eigentümerdaten).
export function requireAuthFlexible(req, res, next) {
  const queryToken = typeof (req.query && req.query.token) === 'string' ? req.query.token : '';
  const header = req.headers.authorization;
  const token = queryToken || (header ? header.replace('Bearer ', '') : '');
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet.' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sitzung abgelaufen, bitte neu anmelden.' });
  }
}

export function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion.' });
    }
    next();
  };
}
