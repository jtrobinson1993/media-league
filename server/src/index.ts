import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { tickAll } from './lib/roundLifecycle.js';
import { sendClosingReminders } from './lib/events.js';

const config = loadConfig();
const db = openDb(config.databasePath);
const app = await buildApp({ config, db });

// In-app scheduler (SPEC §10/§14): phase transitions + closing-soon nudges.
const scheduler = setInterval(() => {
  tickAll(db);
  sendClosingReminders(db);
}, 30_000);
scheduler.unref();

await app.listen({ port: config.port, host: '0.0.0.0' });
