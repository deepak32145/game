// Empties the game's database so it can start fresh: all players, wallets, wallet history,
// login codes and old match records. THIS CANNOT BE UNDONE.
//
//   node scripts/reset-db.js                  show what would be deleted (local database, from .env)
//   node scripts/reset-db.js --production     the same, for the live database (from .env.production)
//   node scripts/reset-db.js --production --yes     actually delete it
//
// Only this app's own database is touched. Other databases on the same server are left alone.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const here = path.dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes('--production');
const really = process.argv.includes('--yes');
const envFile = path.join(here, '..', production ? '.env.production' : '.env');
const env = dotenv.parse(fs.readFileSync(envFile));
const uri = env.MONGO_URI;
if (!uri) throw new Error(`MONGO_URI is not set in ${envFile}`);

await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;
const host = mongoose.connection.host;
console.log(`${production ? 'LIVE' : 'Local'} database "${db.databaseName}" on ${host}`);

const collections = await db.listCollections().toArray();
let total = 0;
for (const c of collections) {
  const count = await db.collection(c.name).countDocuments();
  total += count;
  console.log(`  ${c.name.padEnd(14)} ${count} record(s)`);
}
if (!collections.length) console.log('  (already empty)');

if (!really) {
  console.log(`\nNothing was deleted. ${total} record(s) would be removed. Add --yes to delete them.`);
} else {
  for (const c of collections) await db.collection(c.name).drop();
  console.log(`\nDeleted ${total} record(s) from ${collections.length} collection(s). The database is empty.`);
}
await mongoose.disconnect();
