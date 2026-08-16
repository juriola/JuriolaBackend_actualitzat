import 'dotenv/config';
import { updateUserRole, initDb } from '../src/store.js';

// ─────────────────────────────────────────────
// ÚS
// ─────────────────────────────────────────────
//
//   node scripts/set-user-role.js <username> <admin|client>
//
// Exemple:
//   node scripts/set-user-role.js juriola admin
//

const [, , username, role] = process.argv;

if (!username || !role) {
  console.error('Ús: node scripts/set-user-role.js <username> <admin|client>');
  process.exit(1);
}

await initDb();

const updated = updateUserRole(username, role);

if (!updated) {
  console.error(`No existeix cap usuari amb el nom '${username}'`);
  process.exit(1);
}

console.log('Usuari actualitzat:', updated);
