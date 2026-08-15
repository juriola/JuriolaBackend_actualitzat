import 'dotenv/config';
import { hashPassword } from '../src/auth.js';
import { addUser, initDb } from '../src/store.js';

// ─────────────────────────────────────────────
// ÚS
// ─────────────────────────────────────────────
//
//   node scripts/create-user.js <username> <password> <role> [boatId]
//
// Exemples:
//   node scripts/create-user.js admin "unaContrasenyaForta" admin
//   node scripts/create-user.js cavale "unaAltraContrasenya" client juriola
//
// (el 4t argument, boatId, correspon a l'id del vaixell, per
// exemple "juriola", no al seu nom mostrat "Cavale")
//

const [, , username, password, role, boatId] = process.argv;

if (!username || !password || !role) {
  console.error(
    'Ús: node scripts/create-user.js <username> <password> <role> [boatId]'
  );
  process.exit(1);
}

await initDb();

const passwordHash = await hashPassword(password);

try {
  const user = addUser({ username, passwordHash, role, boatId });

  console.log('Usuari creat:');
  console.log({ id: user.id, username: user.username, role: user.role, boatId: user.boatId });
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
