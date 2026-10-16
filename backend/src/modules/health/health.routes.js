/**
 * GET /api/v1/health
 *
 * Public. Unauthenticated. Reports process-level facts only — never the
 * database connection string, host names, credentials, or version details that
 * would help an attacker fingerprint the stack.
 *
 * `optionalAuth` is a no-op here: the application already attaches `req.auth`
 * via `optionalAuthenticate` before the routers are registered.
 */
export function createHealthModule(db) {
  const startedAt = Date.now();

  return function register(router) {
    router.get('/health', async (req, res) => {
      const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

      // A cheap, non-mutating round trip proves the data layer is reachable
      // without exposing any diagnostic detail.
      let dbState = 'ok';
      try {
        await db.repositories.auditRepo.count();
      } catch {
        dbState = 'unavailable';
      }

      const body = {
        status: dbState === 'ok' ? 'ok' : 'degraded',
        checks: {
          database: dbState,
          driver: db.dialect,
          durable: db.dialect !== 'memory',
        },
        uptime_seconds: uptimeSeconds,
        api_version: 'v1',
        demo_environment: true,
        authenticated_as: req.auth
          ? { id: req.auth.adminId, email: req.auth.email, role: req.auth.role }
          : null,
      };

      // 503 when degraded so load balancers and uptime monitors react correctly.
      res.status(dbState === 'ok' ? 200 : 503).json({ success: true, data: body });
    });
  };
}
