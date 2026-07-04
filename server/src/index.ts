import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { startScheduler } from './lib/roundLifecycle.js';

const config = loadConfig();
const db = openDb(config.databasePath);
const app = await buildApp({ config, db });

startScheduler(db); // in-app scheduler: opens/closes round phases (SPEC §10)

await app.listen({ port: config.port, host: '0.0.0.0' });
