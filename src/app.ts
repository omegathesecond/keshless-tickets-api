import dotenv from 'dotenv';

// Load environment variables first (SENTRY_DSN etc. must be in process.env
// before initSentry() below reads them).
dotenv.config();

// Initialize Sentry BEFORE express/mongoose are imported, so its
// express/mongoose auto-instrumentation can hook them.
import { initSentry, isSentryInitialised } from '@config/sentry.config';
initSentry();

import express, { Application, Request, Response } from 'express';
import mongoose from 'mongoose';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import * as Sentry from '@sentry/node';

import { getDatabaseURI, logDatabaseConfig, validateEnvironment } from '@config/database.config';
import { buildCorsOrigin } from '@utils/corsOrigins.util';

// Background sweeps (reservation expiry, card-sale reconciliation, event
// reminders, stuck-update reconciliation) — consolidated in src/tasks.
import { startBackgroundTasks } from '@/tasks/backgroundTasks';
import { migrateReviewIndexes } from '@/scripts/migrate-review-indexes';
import { migrateWalletIndexes } from '@/scripts/migrate-wallet-indexes';

// Import routes
import ticketsRoutes from '@routes/tickets.route';
import mediaRoutes from '@routes/media.route';
import publicRoutes from '@routes/public.route';
import momoRoutes from '@routes/momo.route';
import cardRoutes from '@routes/card.route';
import deltapayRoutes from '@routes/deltapay.route';
import yocoRoutes from '@routes/yoco.route';
import { boot } from './boot';
import yebopayRoutes from '@routes/yebopay.route';
import resellerRoutes from '@routes/reseller.route';
import resellerAdminRoutes from '@routes/resellerAdmin.route';
import operatorRoutes from '@routes/operator.route';
import merchantRoutes from '@routes/merchant.route';
import cashierRoutes from '@routes/cashier.route';
import waiterRoutes from '@routes/waiter.route';
import communityRoutes from '@routes/community.route';
import socialRoutes from '@routes/social.route';
import dmRoutes from '@routes/dm.route';
import updateRoutes from '@routes/update.route';
import vendorUpdateRoutes from '@routes/vendorUpdate.route';
import transportRoutes from '@routes/transport.route';
import transportPosRoutes from '@routes/transportPos.route';
import vendorSocialRoutes from '@routes/vendorSocial.route';
import vendorDmRoutes from '@routes/vendorDm.route';
import eventPlanRoutes from '@routes/eventPlan.route';
import weekendRoutes from '@routes/weekend.route';
import whatsHotRoutes from '@routes/whatsHot.route';

// Realtime bus
import { ensureAdapterCollection } from '@/realtime/adapterCollection';
import { initSocketEmitter } from '@/realtime/emitter';

// Web Push (VAPID) — delivery-grade: missing env logs loudly but never
// crashes boot. See @config/vapid.config.
import { initWebPush } from '@config/vapid.config';

// Import error handling middleware
import {
  errorHandler,
  notFoundHandler,
  requestIdMiddleware,
  handleUncaughtException,
  handleUnhandledRejection
} from '@middleware/errorHandler.middleware';

// Import Swagger configuration
import { swaggerSpec } from '@config/swagger.config';

// Setup global error handlers
handleUncaughtException();
handleUnhandledRejection();

// Initialize Express app
const app: Application = express();

// Middleware
app.use(requestIdMiddleware); // Add request ID for tracking
app.use(helmet()); // Security headers
app.use(compression()); // Compress responses

// CORS Configuration. Entries may be exact origins or project-scoped wildcard
// subdomains (Cloudflare Pages branch previews) — see corsOrigins.util.
const corsOrigins = buildCorsOrigin(process.env['CORS_ORIGINS']);
app.use(cors({
  origin: corsOrigins,
  credentials: false
}));

// Parse JSON bodies with a size limit.
//
// The `verify` hook stashes the RAW bytes on the request. The Yoco webhook's
// Standard-Webhooks signature is computed over the exact body Yoco sent, so a
// re-serialised `req.body` would never verify — see YocoController.webhook.
// Capturing here (rather than remounting middleware around the webhook route)
// keeps route ordering untouched.
// Only signed webhooks need their raw bytes kept. Scoping the capture to those
// paths avoids duplicating every 10mb JSON body into a second string.
const YOCO_WEBHOOK_PATH = '/api/public/purchase/yoco/webhook';
const YEBOPAY_WEBHOOK_PATH = '/api/public/purchase/yebopay/webhook';
const RAW_BODY_PATHS = new Set([YOCO_WEBHOOK_PATH, YEBOPAY_WEBHOOK_PATH]);

app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    // A signed webhook's signature is computed over the exact body the provider
    // sent, so a re-serialised `req.body` would never verify. Stash
    // the raw bytes here — see YocoController.webhook. Capturing at this level
    // (rather than remounting middleware around the route) leaves route
    // ordering untouched.
    if (buf?.length && RAW_BODY_PATHS.has(req.url?.split('?')[0] ?? '')) {
      (req as any).rawBody = buf.toString('utf8');
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Parse URL-encoded bodies with limit

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'Carrot Tickets API is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// API Documentation — OFF by default, opt in with API_DOCS_ENABLED=true.
//
// The docs describe every route including admin, payout, withdrawal and
// settlement paths, so publishing them hands anyone a complete map of the API.
// They are genuinely useful locally, hence a switch rather than deletion.
//
// NOTE: the spec is currently EMPTY in production regardless — swagger.config.ts
// globs './src/**/*.ts' while the container runs compiled dist/**/*.js, so
// nothing matches. That is an accident, not a safeguard: pointing the glob at
// dist/ (a reasonable-looking "fix") would silently publish the whole surface.
// This gate is what actually keeps it private.
if (process.env['API_DOCS_ENABLED'] === 'true') {
  const swaggerUiOptions = {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Carrot Tickets API Documentation',
  };

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));

  // Swagger JSON endpoint
  app.get('/api-docs.json', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

// API Routes
app.use('/api/tickets/updates', vendorUpdateRoutes);   // Vendor-authored updates (organizer dashboard) - mounted before the broader /api/tickets below so this specific path isn't shadowed
app.use('/api/tickets/transport', transportRoutes);    // Vendor bus/shuttle inventory - before the broad /api/tickets
app.use('/api/tickets/social', vendorSocialRoutes);   // Vendor (brand) social graph — before the broad /api/tickets
app.use('/api/tickets/dm', vendorDmRoutes);           // Vendor (brand) DMs — before the broad /api/tickets
app.use('/api/tickets', ticketsRoutes);
app.use('/api/reseller/transport', transportPosRoutes); // POS bus selling + boarding - before the broad /api/reseller
app.use('/api/reseller', resellerRoutes);
app.use('/api/admin', resellerAdminRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/public/updates', updateRoutes);          // Buyer updates (Discover feed) - mounted before the broader /api/public below
app.use('/api/public/whats-hot', whatsHotRoutes);      // What's Hot This Weekend See All page - mounted before the broader /api/public below
app.use('/api/public', publicRoutes);                  // Public routes - no auth required
app.use('/api/public/purchase/peach-card', cardRoutes);      // Peach card webhook (unauthenticated)
app.use('/api/public/purchase/deltapay', deltapayRoutes);    // DeltaPay return + session callback (unauthenticated)
app.use('/api/public/purchase/yoco', yocoRoutes);            // Yoco signed webhook + return (unauthenticated)
app.use('/api/public/purchase/yebopay', yebopayRoutes);       // YeboPay signed webhook + return (unauthenticated)
app.use('/api/momo', momoRoutes);                      // MTN MoMo callback (unauthenticated)
app.use('/api/operator', operatorRoutes);
app.use('/api/merchant', merchantRoutes);          // Merchant tap-to-pay (cashless spec)
app.use('/api/cashier', cashierRoutes);            // Cashier desk — in-venue top-up + cash-out (cashless spec)
app.use('/api/waiter', waiterRoutes);              // Waiter floor — table tabs across stalls (cashless spec)
app.use('/api/community', communityRoutes);          // Event communities (buyer social)
app.use('/api/social/plans', eventPlanRoutes);       // Plans With Friends — mounted before the broader /api/social below so this specific path isn't shadowed
app.use('/api/social/weekend', weekendRoutes);       // My Weekend — mounted before the broader /api/social below so this specific path isn't shadowed
app.use('/api/social', socialRoutes);                // Buyer social profiles
app.use('/api/dm', dmRoutes);                        // Direct & group messages

// 404 handler - must be after all routes
app.use(notFoundHandler);

// Sentry error handler - must be before custom error handler
if (isSentryInitialised()) {
  Sentry.setupExpressErrorHandler(app, {
    shouldHandleError(error: any) {
      // Report all errors with status >= 500 to Sentry
      // Don't report client errors (4xx)
      return !error.statusCode || error.statusCode >= 500;
    },
  });
}

// Global error handler - must be last
app.use(errorHandler);

// Export Sentry for use in other parts of the app
export { Sentry };

// Validate database configuration before connecting (skip in test env)
if (process.env['NODE_ENV'] !== 'test') {
  try {
    validateEnvironment();
  } catch (error) {
    process.exit(1);
  }
}

/**
 * Everything that needs a live MongoDB connection but must be in place before
 * the port opens. boot() runs this once mongoose.connect() has resolved and
 * only then calls app.listen() — see src/boot.ts for why that order matters
 * on Cloud Run.
 */
function initAfterConnect(): void {
  console.log(`📦 Database: ${mongoose.connection.name}`);
  // Log detailed database configuration
  logDatabaseConfig();

  // One-time (safe-to-repeat) index migration for the `reviews`
  // collection — see src/scripts/migrate-review-indexes.ts. This was
  // previously a manual `npm run migrate:review-indexes` step; running it
  // here instead means an environment nobody remembered to run it
  // against (e.g. dev) self-heals on its next deploy rather than staying
  // broken indefinitely. Without it, the legacy non-partial
  // eventId_1_buyerId_1 unique index stays in place, and a SECOND
  // service-business review from any reviewer with no eventId/buyerId
  // (an organizer reviewing a business) collides on that index and 409s
  // as "You have already reviewed this business" even when they haven't.
  // Logged, not fatal — a failed migration must not block the API from
  // serving everything else. review.model.ts turns the Review schema's
  // own autoIndex off outside tests so this call is the only thing that
  // ever builds indexes for this collection.
  migrateReviewIndexes().catch((err) => {
    console.error('❌ migrateReviewIndexes failed (review submission may still 409 spuriously):', err);
  });

  // Same shape, same reasoning, for `wallets`: the ticketId unique index became
  // PARTIAL so a tag handed out without a ticket can carry a wallet. Until the
  // legacy non-partial index is dropped, the SECOND standalone tag issued at an
  // event collides on it and fails. Logged, not fatal — a failed migration must
  // not stop the API serving everything else; the symptom is confined to
  // issuing standalone tags. See src/scripts/migrate-wallet-indexes.ts.
  migrateWalletIndexes().catch((err) => {
    console.error('❌ migrateWalletIndexes failed (issuing a standalone tag may collide on ticketId_1):', err);
  });

  // Background sweeps: reservation expiry, card-sale reconciliation,
  // event reminders, stuck-update reconciliation. Same functions, same
  // intervals — see src/tasks/backgroundTasks.ts.
  startBackgroundTasks();

  // Web Push (VAPID): missing keys log loudly and disable push, never
  // crash boot — see @config/vapid.config.
  initWebPush();

  // Realtime bus: REST-created messages broadcast to the gateway's
  // channel rooms. Init failure keeps the API serving (REST is this
  // service's job) but retries with backoff — a boot-time Mongo blip
  // must not permanently disable live delivery on this instance.
  const db = mongoose.connection.db;
  if (db) {
    const initEmitterWithRetry = (attempt: number): void => {
      ensureAdapterCollection(db as any)
        .then((collection) => {
          initSocketEmitter(collection);
          console.log('📡 Socket emitter ready (realtime broadcast enabled)');
        })
        .catch((err) => {
          const delayMs = Math.min(60_000, 2 ** attempt * 1_000);
          console.error(
            `❌ Socket emitter init failed (attempt ${attempt + 1}; retrying in ${delayMs / 1000}s; live broadcast disabled until then, resync still works):`,
            err
          );
          setTimeout(() => initEmitterWithRetry(attempt + 1), delayMs).unref();
        });
    };
    initEmitterWithRetry(0);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Closing MongoDB connection...');
  mongoose.connection.close().then(() => {
    console.log('MongoDB connection closed');
    process.exit(0);
  });
});

// Boot — skipped in test env: tests use connectTestDb() from helpers/mongo.ts
// and supertest binds its own ephemeral port. The order is connect → init →
// listen, deliberately: see src/boot.ts.
if (process.env['NODE_ENV'] !== 'test') {
  const PORT = process.env['PORT'] || 5000;

  void boot({
    connect: () => mongoose.connect(getDatabaseURI()),
    afterConnect: initAfterConnect,
    listen: () => {
      app.listen(PORT, () => {
        console.log('');
        console.log('🎫 ====================================== 🎫');
        console.log('   Carrot Tickets API Server');
        console.log('🎫 ====================================== 🎫');
        console.log('');
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`🌍 Environment: ${process.env['NODE_ENV'] || 'development'}`);
        console.log(`📍 Base URL: http://localhost:${PORT}`);
        console.log(`💚 Health check: http://localhost:${PORT}/health`);
        if (process.env['API_DOCS_ENABLED'] === 'true') {
          console.log(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
        }
        console.log(`🔗 API Endpoint: http://localhost:${PORT}/api`);
        console.log('');
      });
    },
  });
}

export default app;
