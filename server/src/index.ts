import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = openDb(config.databasePath);
const app = await buildApp({ config, db });

await app.listen({ port: config.port, host: '0.0.0.0' });
