import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ScanProgressEvent } from '@audiolead/shared';
import type { AppDatabase } from '../db/index.js';
import { LeadsRepo } from '../db/repositories.js';
import type { ScanOrchestrator } from '../services/scanner/scanOrchestrator.js';

export function createScansRoutes(db: AppDatabase, orchestrator: ScanOrchestrator): Hono {
  const app = new Hono();

  app.post('/start', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      leadIds?: string[];
      scanPending?: boolean;
      forceRescan?: boolean;
    };

    const leadsRepo = new LeadsRepo(db);
    let ids = body.leadIds ?? [];
    if (body.scanPending || ids.length === 0) {
      ids = leadsRepo.getPendingLeadIds(100);
    }

    const summary = orchestrator.startJob(ids, { forceRescan: body.forceRescan });
    return c.json(summary);
  });

  app.get('/:jobId/events', (c) => {
    const jobId = c.req.param('jobId');
    const job = orchestrator.getJobEmitter(jobId);
    if (!job) {
      return c.json({ error: 'Scan job not found' }, 404);
    }

    return streamSSE(c, async (stream) => {
      // Replay buffered events so clients joining slightly late don't miss anything
      for (const ev of job.events) {
        await stream.writeSSE({
          event: ev.type,
          data: JSON.stringify(ev),
        });
      }

      if (job.done) return;

      await new Promise<void>((resolve) => {
        const onEvent = async (ev: ScanProgressEvent) => {
          try {
            await stream.writeSSE({
              event: ev.type,
              data: JSON.stringify(ev),
            });
          } catch {
            cleanup();
          }
          if (ev.type === 'job_done' || ev.type === 'error') {
            cleanup();
          }
        };

        const cleanup = () => {
          job.emitter.off('event', onEvent);
          resolve();
        };

        stream.onAbort(() => cleanup());
        job.emitter.on('event', onEvent);
      });
    });
  });

  return app;
}
