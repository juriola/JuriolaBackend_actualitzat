import 'dotenv/config';
import { setAppVersionInfo, initDb } from '../src/store.js';

// ─────────────────────────────────────────────
// ÚS
// ─────────────────────────────────────────────
//
//   node scripts/set-app-version.js <versionCode> <versionName> <downloadUrl> ["notes de la versió"]
//
// Exemple:
//   node scripts/set-app-version.js 2 "1.1" "https://juriola.com/download/JuriolaApp.apk" "Millores al panell i suport de càmeres RTSP"
//
// El versionCode ha de coincidir EXACTAMENT amb el que tens al
// build.gradle.kts (camp versionCode) de la versió que acabes de pujar.
//

const [, , versionCodeArg, versionName, downloadUrl, releaseNotes] = process.argv;

if (!versionCodeArg || !versionName || !downloadUrl) {
  console.error('Ús: node scripts/set-app-version.js <versionCode> <versionName> <downloadUrl> ["notes"]');
  process.exit(1);
}

const versionCode = parseInt(versionCodeArg, 10);

if (Number.isNaN(versionCode)) {
  console.error('versionCode ha de ser un número enter (el mateix que tens al build.gradle.kts)');
  process.exit(1);
}

await initDb();

const info = setAppVersionInfo({ versionCode, versionName, downloadUrl, releaseNotes });

console.log('Versió publicada:', info);
