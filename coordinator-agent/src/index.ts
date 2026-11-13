import dotenv from 'dotenv';
// Load environment variables BEFORE other imports trigger module init
dotenv.config({ path: '.env.development.local' });

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { startCoordinationLoop, startLocalCoordinationLoop } from './monitor/memory-monitor';
import coordinateRoute from './routes/coordinate';
import { getAgentDid } from './storacha/identity';
import { verdictOracle } from './agent-connect/verdict-oracle';
import { demoRoutes } from './agent-connect/demo-routes';

const LOCAL_MODE = process.env.LOCAL_MODE === 'true';

// Check required env vars — warn but don't crash (server should always start for health checks)
if (!process.env.ENSUE_API_KEY) {
  console.warn('WARNING: ENSUE_API_KEY is not set — Ensue-based coordination will not work');
}

const app = new Hono();

// Enable CORS
app.use(cors());

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    message: 'Coordinator Agent is running',
    status: 'healthy',
    mode: LOCAL_MODE ? 'local' : 'production',
    contractId: process.env.AGENT_CONTRACT_ID || process.env.NEXT_PUBLIC_contractId || 'N/A',
    timestamp: new Date().toISOString(),
  });
});

// Coordination routes
app.route('/api/coordinate', coordinateRoute);

// The product's own surface — /second-opinion/* (the Agent Connect API is
// the rail underneath; the product face is not named after it).
//   /second-opinion/demo        the live session UI
//   /second-opinion/verdict     the verdict oracle BFF (proposal in → card out)
app.route('/second-opinion', verdictOracle);
app.route('/second-opinion', demoRoutes);


/**
 * Ensure the coordinator is registered in the NEAR registry contract.
 * Idempotent: if already registered, does nothing.
 * Non-fatal: logs warnings on failure but never crashes.
 */
async function ensureCoordinatorRegistered(): Promise<void> {
  try {
    // localRegisterCoordinator imported dynamically to avoid circular deps at startup
    const { localRegisterCoordinator } = await import('./contract/local-contract');

    let coordinatorDid: string;
    try {
      coordinatorDid = await getAgentDid();
    } catch {
      console.warn('[REGISTRY] STORACHA_AGENT_PRIVATE_KEY not set, using fallback coordinator ID');
      coordinatorDid = 'local-coordinator';
    }

    const endpointUrl = process.env.COORDINATOR_ENDPOINT_URL || `http://localhost:${process.env.PORT || '3000'}`;
    const minWorkers = parseInt(process.env.MIN_WORKERS ?? '1');
    const maxWorkers = parseInt(process.env.MAX_WORKERS ?? '10');
    const cvmId = process.env.PHALA_CVM_ID ?? 'local';

    const registered = await localRegisterCoordinator(coordinatorDid, endpointUrl, minWorkers, maxWorkers, cvmId);
    if (registered) {
      console.log(`[REGISTRY] Coordinator registered/confirmed: ${coordinatorDid}`);
    } else {
      console.warn('[REGISTRY] Coordinator registration failed (non-fatal)');
    }
  } catch (err) {
    console.warn('[REGISTRY] ensureCoordinatorRegistered failed (non-fatal):', err);
  }
}

// Start server
const port = Number(process.env.PORT || '3000');
console.log('Coordinator Agent starting on port', port);
console.log('Mode:', LOCAL_MODE ? 'LOCAL (no TEE/contract)' : 'PRODUCTION');
console.log('Contract ID:', process.env.AGENT_CONTRACT_ID || process.env.NEXT_PUBLIC_contractId || 'N/A');
console.log('Ensue API configured:', process.env.ENSUE_API_KEY ? 'YES' : 'NO');

// On Vercel (serverless), skip the long-running server bind + background loops.
// The Vercel function entrypoint (api/[...path].ts) imports `app` directly.
// Local Node still binds the port and runs the coordination loop as before.
if (!process.env.VERCEL) {
  serve({ fetch: app.fetch, port }, async (info) => {
    console.log(`\nCoordinator Agent HTTP server running at http://localhost:${info.port}`);

    if (LOCAL_MODE) {
      console.log('\n[LOCAL MODE] Starting local coordination loop (Ensue-only)...');
      console.log('[LOCAL MODE] Use POST /api/coordinate/trigger to start a coordination\n');
      startLocalCoordinationLoop();

      // Register coordinator in registry (non-blocking)
      ensureCoordinatorRegistered().catch(err =>
        console.warn('[LOCAL MODE] Coordinator registry registration failed (non-fatal):', err)
      );
    } else {
      // Production: the coordinator is registered in the NEAR registry and
      // picks up proposals from the coordination contract.
      ensureCoordinatorRegistered().catch(err =>
        console.warn('[REGISTRY] Coordinator registry registration failed (non-fatal):', err)
      );
      startCoordinationLoop();
    }
  });
}

export default app;
