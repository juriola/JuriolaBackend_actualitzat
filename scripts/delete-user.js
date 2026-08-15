import 'dotenv/config';
import { deleteUserByUsername, initDb } from '../src/store.js';

// ─────────────────────────────────────────────
// ÚS
// ─────────────────────────────────────────────
//
//   node scripts/delete-user.js <username>
//
// Exemple:
//   node scripts/delete-user.js cavale
//

const [, , username] = process.argv;

if (!username) {
  console.error('Ús: node scripts/delete-user.js <username>');
  process.exit(1);
}

await initDb();

const removed = deleteUserByUsername(username);

if (!removed) {
  console.error(`No existeix cap usuari amb el nom '${username}'`);
  process.exit(1);
}

console.log('Usuari eliminat:', removed);
