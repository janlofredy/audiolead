import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createDatabase } from './db/index.js';
import { createApp } from './app.js';
import { ScanOrchestrator } from './services/scanner/scanOrchestrator.js';
import { backfillTrancoVisitEstimates } from './services/suppression/reconcile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = createDatabase();
backfillTrancoVisitEstimates(db);
const orchestrator = new ScanOrchestrator(db);
const app = createApp(db, orchestrator);
orchestrator.resumePendingOnStartup();

// Resolve compiled client/dist in both tsx dev and compiled node dist/
const candidateDistDirs = [
  path.resolve(__dirname, '../../client/dist'),
  path.resolve(__dirname, '../../../client/dist'),
  path.resolve(process.cwd(), 'client/dist'),
  path.resolve(process.cwd(), '../client/dist'),
];

const clientDistDir = candidateDistDirs.find((dir) => fs.existsSync(path.join(dir, 'index.html')));

if (clientDistDir) {
  const relativeRoot = path.relative(process.cwd(), clientDistDir) || '.';
  app.use('/*', serveStatic({ root: relativeRoot }));
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Not found' }, 404);
    }
    const html = fs.readFileSync(path.join(clientDistDir, 'index.html'), 'utf8');
    return c.html(html);
  });
}

const defaultPort = process.env.NODE_ENV === 'production' || clientDistDir ? 3000 : 3001;
const port = Number(process.env.PORT || defaultPort);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`AudioLead server listening on http://localhost:${info.port}`);
});
