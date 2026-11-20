import { Hono } from 'hono';
import type { AppDatabase } from './db/index.js';
import { ScanOrchestrator } from './services/scanner/scanOrchestrator.js';
import { createDiscoveryRoutes } from './routes/discovery.js';
import { createLeadsRoutes } from './routes/leads.js';
import { createScansRoutes } from './routes/scans.js';
import { createSuppressionRoutes } from './routes/suppression.js';
import { createSettingsRoutes } from './routes/settings.js';

export function createApp(db: AppDatabase, customOrchestrator?: ScanOrchestrator): Hono {
  const app = new Hono();
  const orchestrator = customOrchestrator ?? new ScanOrchestrator(db);

  app.get('/api/health', (c) => {
    return c.json({ ok: true, service: 'audiolead' });
  });

  app.route('/api/discovery', createDiscoveryRoutes(db, orchestrator));
  app.route('/api/leads', createLeadsRoutes(db));
  app.route('/api/scans', createScansRoutes(db, orchestrator));
  app.route('/api/suppression', createSuppressionRoutes(db));
  app.route('/api/settings', createSettingsRoutes(db));

  return app;
}
