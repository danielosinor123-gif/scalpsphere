/**
 * Process entry point.
 *
 * Startup is fail-fast. Configuration is validated BEFORE any other module is
 * imported, because every other module depends on the validated `env` singleton
 * in `src/config/env.js`. That module throws at evaluation time, so it is
 * imported dynamically inside a try/catch and the failure is reported as one
 * readable message with exit code 2 — never as a raw stack trace.
 *
 * The process refuses to listen when:
 *   - required configuration is missing or insecure;
 *   - `DB_DRIVER=memory` is requested in production (not durable).
 */
function startupFailure(reason) {
  process.stderr.write(`\nSTARTUP FAILED\n${reason}\n\n`);
}

async function main() {
  // -------------------------------------------------------------------------
  // 1. Configuration — before everything else.
  // -------------------------------------------------------------------------
  let env;
  try {
    ({ env } = await import('./config/env.js'));
  } catch (err) {
    startupFailure(err.message);
    return process.exit(2);
  }

  const { logger } = await import('./lib/logger.js');
  const { createDatabase } = await import('./db/index.js');
  const { createApp } = await import('./app.js');

  // -------------------------------------------------------------------------
  // 2. Refuse unsafe combinations.
  // -------------------------------------------------------------------------
  if (env.nodeEnv === 'production' && env.db.driver === 'memory') {
    startupFailure('DB_DRIVER=memory is not durable. Set DB_DRIVER=mysql for production.');
    logger.error('startup_refused', { reason: 'memory_driver_in_production' });
    return process.exit(2);
  }

  // -------------------------------------------------------------------------
  // 3. Connect to the data layer before opening the socket, so a bad database
  //    configuration is reported immediately instead of at first request.
  // -------------------------------------------------------------------------
  let db;
  try {
    db = await createDatabase();
  } catch (err) {
    startupFailure(`Could not connect to the database: ${err.message}`);
    logger.error('database_connection_failed', {
      reason: err.message,
      code: err.code,
      host: env.db.host,
      port: env.db.port,
      database: env.db.database,
    });
    return process.exit(3);
  }

  // -------------------------------------------------------------------------
  // 4. Build and listen.
  // -------------------------------------------------------------------------
  const app = createApp({ db });
  const http = (await import('node:http')).default;

  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(env.port, env.host, () => resolve());
    });
  } catch (err) {
    startupFailure(`Could not bind ${env.host}:${env.port} — ${err.message}`);
    logger.error('listen_failed', {
      reason: err.message,
      code: err.code,
      host: env.host,
      port: env.port,
    });
    await db.close().catch(() => {});
    return process.exit(3);
  }

  logger.info('server_started', {
    node_env: env.nodeEnv,
    host: env.host,
    port: env.port,
    api_base_path: env.apiBasePath,
    db_driver: db.dialect,
    cors_allowed_origins: env.corsAllowedOrigins,
  });

  // -------------------------------------------------------------------------
  // 5. Graceful shutdown: stop accepting connections, then drain the pool.
  // -------------------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_started', { signal });
    server.close(async () => {
      try {
        await db.close();
        logger.info('shutdown_complete', {});
        process.exit(0);
      } catch (err) {
        logger.error('shutdown_failed', { reason: err.message });
        process.exit(1);
      }
    });
    // Do not hang forever on keep-alive connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught_exception', { reason: err.message });
    process.exit(1);
  });
}

main().catch((err) => {
  startupFailure(err?.message ?? String(err));
  process.exit(2);
});
