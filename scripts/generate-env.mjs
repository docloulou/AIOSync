import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const template = new URL('../.env.example', import.meta.url);
const target = new URL('../.env', import.meta.url);
const argument = process.argv[2] ?? 'http://localhost:7000';

try {
  if (process.argv.length > 3) {
    throw new Error('Usage : node scripts/generate-env.mjs [https://tracker.example.com]');
  }
  const origin = new URL(argument);
  if (!['http:', 'https:'].includes(origin.protocol)
      || origin.username || origin.password || origin.search || origin.hash
      || origin.pathname !== '/') {
    throw new Error('L’URL doit être une origine HTTP(S), sans chemin, identifiants ni paramètres.');
  }
  const contents = (await readFile(template, 'utf8'))
    .replace('GLOBAL_API_KEY=REPLACE_WITH_RANDOM_GLOBAL_API_KEY', `GLOBAL_API_KEY=${randomBytes(32).toString('base64url')}`)
    .replace('ENCRYPTION_KEY=REPLACE_WITH_64_HEX_CHARACTERS', `ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`)
    .replace(/^PUBLIC_BASE_URL=.*$/m, `PUBLIC_BASE_URL=${origin.origin}`);
  await writeFile(target, contents, { flag: 'wx', mode: 0o600 });
  console.log(`Créé : ${fileURLToPath(target)}`);
  console.log('Ajoutez vos identifiants Simkl/PublicMetaDB, puis démarrez le service.');
} catch (error) {
  console.error(error?.code === 'EEXIST'
    ? 'Le fichier .env existe déjà : aucune modification effectuée.'
    : `Création impossible : ${error.message}`);
  process.exitCode = 1;
}
