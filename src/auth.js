import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
//
// JWT_SECRET ha de venir de .env i ser un valor llarg i
// aleatori en producció (per exemple: openssl rand -hex 32).
//

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = process.env.JWT_TTL || '30d';

if (!JWT_SECRET) {
  throw new Error(
    "Falta 'JWT_SECRET' a l'entorn (.env)"
  );
}


// ─────────────────────────────────────────────
// CONTRASENYES
// ─────────────────────────────────────────────

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  if (!hash) {
    return false;
  }

  return bcrypt.compare(plain, hash);
}


// ─────────────────────────────────────────────
// TOKEN
// ─────────────────────────────────────────────
//
// El payload es manté mínim a propòsit: id, role, boatId.
// Qualsevol altra dada de l'usuari (nom del vaixell, etc.)
// s'ha de tornar a consultar via API, no confiar-hi cegament
// des del token.
//

export function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      boatId: user.boatId || null,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}


// ─────────────────────────────────────────────
// MIDDLEWARE: requireAuth
// ─────────────────────────────────────────────
//
// Llegeix "Authorization: Bearer <token>", el valida i
// deixa el payload a req.user. Si falla, 401.
//

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({
      error: "Falta el token (capçalera 'Authorization: Bearer <token>')"
    });
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch (e) {
    return res.status(401).json({
      error: 'Token invàlid o caducat'
    });
  }
}


// ─────────────────────────────────────────────
// MIDDLEWARE: requireBoatAccess
// ─────────────────────────────────────────────
//
// Cal fer servir DESPRÉS de requireAuth, en rutes amb
// :boatId. Un 'admin' pot accedir a qualsevol vaixell;
// un 'client' només al seu propi boatId.
//

export function requireBoatAccess(req, res, next) {
  const { role, boatId } = req.user || {};

  if (role === 'admin') {
    return next();
  }

  if (role === 'client' && boatId === req.params.boatId) {
    return next();
  }

  return res.status(403).json({
    error: 'No tens accés a aquest vaixell'
  });
}


// ─────────────────────────────────────────────
// MIDDLEWARE: requireAdmin
// ─────────────────────────────────────────────
//
// Per a rutes exclusives d'administració (crear vaixells,
// gestionar usuaris, etc.)
//

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      error: "Cal ser 'admin' per fer aquesta acció"
    });
  }

  next();
}
