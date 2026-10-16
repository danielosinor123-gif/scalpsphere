/**
 * MySQL implementation of the repository contract.
 *
 * =========================================================================
 * PARAMETERISED SQL ONLY
 * =========================================================================
 * Every value that originates from a client request is bound with a `?`
 * placeholder. The only identifiers ever concatenated into a statement are
 * sort column names taken from a hard whitelist below, validated in the
 * controllers. There is no code path that turns user input into SQL text.
 */
import { describeMysqlError } from './pool.js';

const SORT_COLUMNS = {
  users: {
    created_at: 'u.created_at',
    balance: 'u.balance_minor',
    name: 'u.full_name',
    id: 'u.public_ref',
    status: 'u.status',
  },
  withdrawals: {
    created_at: 'w.created_at',
    amount: 'w.amount_minor',
    fee: 'w.fee_minor',
    status: 'w.status',
    id: 'w.public_ref',
  },
  payment_methods: {
    created_at: 'm.created_at',
    name: 'm.name',
    status: 'm.status',
    type: 'm.type',
    id: 'm.public_ref',
  },
  audit_log: {
    created_at: 'a.created_at',
    id: 'a.id',
  },
};

function sortClause(entity, sort, direction) {
  const whitelist = SORT_COLUMNS[entity];
  const column = whitelist[sort] ? whitelist[sort] : Object.values(whitelist)[0];
  const dir = String(direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${column} ${dir}`;
}

/** Throws a tagged error so the service layer can map it to an HTTP status. */
function tagError(err, duplicateMessage, constraintMessage) {
  const description = describeMysqlError(err);
  if (description.constraint) {
    const tagged = new Error(
      description.kind === 'duplicate' ? duplicateMessage : constraintMessage,
    );
    tagged.code = description.kind === 'duplicate' ? 'ER_DUP_ENTRY' : 'ER_CONSTRAINT';
    tagged.cause = err;
    throw tagged;
  }
  err.isOperational = true;
  throw err;
}

/**
 * Allocates the next short public reference for a prefix (`USR`, `WDR`, `PAY`).
 *
 * The AUTO_INCREMENT + LAST_INSERT_ID() idiom reserves and returns the value in
 * a single round trip on `conn`, so there is no read-then-write race. `conn`
 * must be the connection the subsequent row insert uses — which is why the
 * multi-statement writes below run inside `withUnitOfWork`.
 */
async function allocateRef(conn, prefix) {
  await conn.query(
    `INSERT INTO ref_sequences (entity_prefix) VALUES (?)
     ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)`,
    [prefix],
  );
  const [rows] = await conn.query('SELECT LAST_INSERT_ID() AS seq');
  return Number(rows[0].seq);
}

export function createMysqlRepositories(pool) {
  const query = (sql, params, conn) => (conn ?? pool).query(sql, params);

  /**
   * Runs `fn` on a connection inside a transaction unless the caller already
   * supplied one, in which case it joins that caller's unit of work.
   *
   * This keeps "allocate a reference" + "insert the row" atomic and on a single
   * connection, which is what the repository contract promises to callers and
   * what the in-memory driver also implements.
   */
  async function withUnitOfWork(conn, fn) {
    if (conn) return fn(conn);
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const result = await fn(c);
      await c.commit();
      return result;
    } catch (err) {
      try {
        await c.rollback();
      } catch {
        /* the original error is the one that matters */
      }
      throw err;
    } finally {
      c.release();
    }
  }

  // -----------------------------------------------------------------------
  // admins
  // -----------------------------------------------------------------------
  const adminRepo = {
    async findByEmail(email, conn) {
      const sql = `SELECT id, email, password_hash, full_name, role, status,
                          failed_login_count, locked_until, last_login_at,
                          password_updated_at, created_at, updated_at
                   FROM admins
                   WHERE email = ?
                   LIMIT 1`;
      const [rows] = await query(sql, [String(email).toLowerCase()], conn);
      return rows[0] ?? null;
    },

    async findById(id, conn) {
      const sql = `SELECT id, email, password_hash, full_name, role, status,
                          failed_login_count, locked_until, last_login_at,
                          password_updated_at, created_at, updated_at
                   FROM admins
                   WHERE id = ?
                   LIMIT 1`;
      const [rows] = await query(sql, [id], conn);
      return rows[0] ?? null;
    },

    async count(conn) {
      const [rows] = await query('SELECT COUNT(*) AS n FROM admins', [], conn);
      return Number(rows[0].n);
    },

    async create({ id, email, passwordHash, fullName, role = 'admin', status = 'active' }, conn) {
      const sql = `INSERT INTO admins
                     (id, email, password_hash, full_name, role, status)
                   VALUES (?, ?, ?, ?, ?, ?)`;
      try {
        await query(
          sql,
          [id, String(email).toLowerCase(), passwordHash, fullName, role, status],
          conn,
        );
      } catch (err) {
        tagError(err, 'An administrator with this email already exists.', 'Could not create administrator.');
      }
      return adminRepo.findById(id, conn);
    },

    async recordLoginSuccess(id, conn) {
      const sql = `UPDATE admins
                   SET failed_login_count = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP(3)
                   WHERE id = ?`;
      await query(sql, [id], conn);
      return adminRepo.findById(id, conn);
    },

    async recordLoginFailure(id, maxAttempts, lockUntil, conn) {
      const sql = `UPDATE admins
                   SET failed_login_count = failed_login_count + 1,
                       locked_until = CASE
                         WHEN (failed_login_count + 1) >= ? THEN ?
                         ELSE locked_until
                       END
                   WHERE id = ?`;
      await query(sql, [maxAttempts, lockUntil, id], conn);
      return adminRepo.findById(id, conn);
    },

    async clearLock(id, conn) {
      const sql = 'UPDATE admins SET failed_login_count = 0, locked_until = NULL WHERE id = ?';
      await query(sql, [id], conn);
      return adminRepo.findById(id, conn);
    },

    async setPassword(id, passwordHash, conn) {
      const sql = `UPDATE admins
                   SET password_hash = ?, password_updated_at = UTC_TIMESTAMP(3)
                   WHERE id = ?`;
      await query(sql, [passwordHash, id], conn);
      return adminRepo.findById(id, conn);
    },
  };

  // -----------------------------------------------------------------------
  // sessions
  // -----------------------------------------------------------------------
  const sessionRepo = {
    async create({ id, adminId, refreshTokenHash, expiresAt, ip = null, userAgent = null }, conn) {
      const sql = `INSERT INTO admin_sessions
                     (id, admin_id, refresh_token_hash, expires_at, ip, user_agent)
                   VALUES (?, ?, ?, ?, ?, ?)`;
      await query(sql, [id, adminId, refreshTokenHash, expiresAt, ip, userAgent], conn);
      return { id, admin_id: adminId, refresh_token_hash: refreshTokenHash, expires_at: expiresAt };
    },

    async findValidByTokenHash(hash, now = new Date(), conn) {
      const sql = `SELECT id, admin_id, refresh_token_hash, issued_at, expires_at, revoked_at
                   FROM admin_sessions
                   WHERE refresh_token_hash = ?
                     AND revoked_at IS NULL
                     AND expires_at > ?
                   LIMIT 1`;
      const [rows] = await query(sql, [hash, now], conn);
      return rows[0] ?? null;
    },

    async revoke(id, reason, now = new Date(), conn) {
      const sql = `UPDATE admin_sessions
                   SET revoked_at = ?, revoked_reason = ?
                   WHERE id = ? AND revoked_at IS NULL`;
      const [result] = await query(sql, [now, reason ?? null, id], conn);
      return result.affectedRows > 0;
    },

    async revokeForAdmin(adminId, reason, now = new Date(), conn) {
      const sql = `UPDATE admin_sessions
                   SET revoked_at = ?, revoked_reason = ?
                   WHERE admin_id = ? AND revoked_at IS NULL`;
      const [result] = await query(sql, [now, reason ?? null, adminId], conn);
      return result.affectedRows;
    },

    async deleteExpired(now = new Date(), conn) {
      const sql = 'DELETE FROM admin_sessions WHERE expires_at <= ?';
      const [result] = await query(sql, [now], conn);
      return result.affectedRows;
    },
  };

  // -----------------------------------------------------------------------
  // users
  // -----------------------------------------------------------------------
  const USER_COLUMNS = `u.id, u.public_ref, u.full_name, u.email, u.username, u.balance_minor, u.currency,
                        u.status, u.kyc_status, u.is_demo, u.created_at, u.updated_at`;

  const userRepo = {
    async create(
      {
        id,
        fullName,
        email,
        username = null,
        balanceMinor = 0,
        currency = 'USD',
        status = 'active',
        kycStatus = 'pending',
        isDemo = 1,
      },
      conn,
    ) {
      return withUnitOfWork(conn, async (c) => {
        const publicRef = `USR-${String(await allocateRef(c, 'USR')).padStart(5, '0')}`;

        const sql = `INSERT INTO users
                       (id, public_ref, full_name, email, username, balance_minor, currency,
                        status, kyc_status, is_demo)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        try {
          await c.query(
            sql,
            [
              id,
              publicRef,
              fullName,
              String(email).toLowerCase(),
              username ? String(username).toLowerCase() : null,
              Math.trunc(Number(balanceMinor)),
              currency,
              status,
              kycStatus,
              isDemo ? 1 : 0,
            ],
          );
        } catch (err) {
          const msg = /uq_users_username/.test(String(err.message))
            ? 'That username is already taken.'
            : 'A user with this email already exists.';
          tagError(err, msg, 'Could not create user.');
        }
        return userRepo.findById(id, c);
      });
    },

    async findById(id, conn) {
      // Accept either the short public reference (USR-00001) or the internal
      // UUID; both are bound parameters, never string-concatenated SQL.
      const sql = `SELECT ${USER_COLUMNS}
                   FROM users u
                   WHERE u.public_ref = ? OR u.id = ?
                   LIMIT 1`;
      const [rows] = await query(sql, [id, id], conn);
      return rows[0] ?? null;
    },

    async findByEmail(email, conn) {
      const [rows] = await query(
        `SELECT ${USER_COLUMNS} FROM users u WHERE u.email = ? LIMIT 1`,
        [String(email).toLowerCase()],
        conn,
      );
      return rows[0] ?? null;
    },

    /**
     * MySQL driver counterpart of the memory driver's findByUsername — the
     * form-compatible registration endpoint calls this before creating an
     * account. It was missing here while present in the offline driver, so the
     * MySQL run threw "findByUsername is not a function" and — because the
     * route handler was not wrapped in asyncHandler — the request hung for the
     * fetch timeout instead of erroring. Both fixed.
     */
    async findByUsername(username, conn) {
      const [rows] = await query(
        `SELECT ${USER_COLUMNS} FROM users u WHERE u.username = ? LIMIT 1`,
        [String(username).toLowerCase()],
        conn,
      );
      return rows[0] ?? null;
    },

    async list(params, conn) {
      const {
        search = '',
        status,
        kycStatus,
        sort = 'created_at',
        direction = 'desc',
        limit = 20,
        offset = 0,
      } = params;

      const where = [];
      const args = [];

      const term = String(search).trim();
      if (term) {
        where.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.public_ref LIKE ?)');
        args.push(`%${term}%`, `%${term}%`, `%${term}%`);
      }
      if (status) {
        where.push('u.status = ?');
        args.push(status);
      }
      if (kycStatus) {
        where.push('u.kyc_status = ?');
        args.push(kycStatus);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const orderSql = sortClause('users', sort, direction);

      const listSql = `SELECT ${USER_COLUMNS}
                       FROM users u
                       ${whereSql}
                       ${orderSql}
                       LIMIT ? OFFSET ?`;
      const countSql = `SELECT COUNT(*) AS total
                        FROM users u
                        ${whereSql}`;

      const [rows] = await query(listSql, [...args, Number(limit), Number(offset)], conn);
      const [countRows] = await query(countSql, args, conn);
      const [facetRows] = await query(
        `SELECT
           SUM(u.status = 'active')    AS active,
           SUM(u.status = 'inactive')  AS inactive,
           SUM(u.kyc_status = 'pending')  AS kyc_pending,
           SUM(u.kyc_status = 'verified') AS kyc_verified
         FROM users u`,
        [],
        conn,
      );

      return {
        rows,
        total: Number(countRows[0].total),
        facets: {
          active: Number(facetRows[0].active ?? 0),
          inactive: Number(facetRows[0].inactive ?? 0),
          kyc_pending: Number(facetRows[0].kyc_pending ?? 0),
          kyc_verified: Number(facetRows[0].kyc_verified ?? 0),
        },
      };
    },

    async recent(limit = 5, conn) {
      const sql = `SELECT ${USER_COLUMNS}
                   FROM users u
                   ORDER BY u.created_at DESC, u.public_ref DESC
                   LIMIT ?`;
      const [rows] = await query(sql, [Number(limit)], conn);
      return rows;
    },

    async countAll(conn) {
      const [rows] = await query('SELECT COUNT(*) AS n FROM users', [], conn);
      return Number(rows[0].n);
    },

    async updateFullName(id, fullName, conn) {
      const [result] = await query(
        'UPDATE users SET full_name = ? WHERE id = ?',
        [fullName, id],
        conn,
      );
      return result.affectedRows > 0 ? userRepo.findById(id, conn) : null;
    },

    async countCreatedBetween(from, to, conn) {
      const sql = 'SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?';
      const [rows] = await query(sql, [from, to], conn);
      return Number(rows[0].n);
    },
  };

  // -----------------------------------------------------------------------
  // withdrawals
  // -----------------------------------------------------------------------
  const WITHDRAWAL_COLUMNS = `w.id, w.public_ref, w.user_id, u.public_ref AS user_ref,
                              u.full_name AS client_name, w.amount_minor, w.fee_minor,
                              w.method, w.receiver_email, w.status, w.is_demo,
                              w.created_at, w.updated_at`;

  const withdrawalRepo = {
    async create(
      {
        id,
        userId,
        amountMinor,
        feeMinor = 0,
        method,
        receiverEmail,
        status = 'pending',
        isDemo = 1,
      },
      conn,
    ) {
      return withUnitOfWork(conn, async (c) => {
        const publicRef = `WDR-${String(await allocateRef(c, 'WDR')).padStart(5, '0')}`;

        const sql = `INSERT INTO withdrawals
                       (id, public_ref, user_id, amount_minor, fee_minor, method,
                        receiver_email, status, is_demo)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        try {
          await c.query(
            sql,
            [
              id,
              publicRef,
              userId,
              Math.trunc(Number(amountMinor)),
              Math.trunc(Number(feeMinor)),
              method,
              String(receiverEmail).toLowerCase(),
              status,
              isDemo ? 1 : 0,
            ],
          );
        } catch (err) {
          tagError(err, 'Duplicate withdrawal reference.', 'Could not create withdrawal request.');
        }
        return withdrawalRepo.findById(id, c);
      });
    },

    async findById(id, conn) {
      const sql = `SELECT ${WITHDRAWAL_COLUMNS}
                   FROM withdrawals w
                   JOIN users u ON u.id = w.user_id
                   WHERE w.public_ref = ? OR w.id = ?
                   LIMIT 1`;
      const [rows] = await query(sql, [id, id], conn);
      return rows[0] ?? null;
    },

    async list(params, conn) {
      const {
        search = '',
        status,
        method,
        from,
        to,
        // Ownership scope. Used by the customer portal; the admin endpoints
        // simply omit it. Binding it as a parameter (never string-concatenated)
        // means a customer can never widen this to another user's rows.
        userId,
        sort = 'created_at',
        direction = 'desc',
        limit = 20,
        offset = 0,
      } = params;

      const where = [];
      const args = [];

      if (userId) {
        where.push('w.user_id = ?');
        args.push(userId);
      }
      const term = String(search).trim();
      if (term) {
        where.push(
          '(w.public_ref LIKE ? OR u.full_name LIKE ? OR u.email LIKE ? OR w.method LIKE ? OR w.receiver_email LIKE ?)',
        );
        args.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
      }
      if (status) {
        where.push('w.status = ?');
        args.push(status);
      }
      if (method) {
        where.push('w.method = ?');
        args.push(method);
      }
      if (from) {
        where.push('w.created_at >= ?');
        args.push(from);
      }
      if (to) {
        where.push('w.created_at <= ?');
        args.push(to);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const orderSql = sortClause('withdrawals', sort, direction);

      const listSql = `SELECT ${WITHDRAWAL_COLUMNS}
                       FROM withdrawals w
                       JOIN users u ON u.id = w.user_id
                       ${whereSql}
                       ${orderSql}
                       LIMIT ? OFFSET ?`;
      const countSql = `SELECT COUNT(*) AS total
                        FROM withdrawals w
                        JOIN users u ON u.id = w.user_id
                        ${whereSql}`;

      const [rows] = await query(listSql, [...args, Number(limit), Number(offset)], conn);
      const [countRows] = await query(countSql, args, conn);
      const [summaryRows] = await query(
        `SELECT
           SUM(w.status = 'pending')   AS pending_count,
           SUM(CASE WHEN w.status = 'pending' THEN w.amount_minor ELSE 0 END) AS pending_amount,
           SUM(w.status = 'processed') AS processed_count
         FROM withdrawals w`,
        [],
        conn,
      );

      return {
        rows,
        total: Number(countRows[0].total),
        summary: {
          pending_count: Number(summaryRows[0].pending_count ?? 0),
          pending_amount_minor: Number(summaryRows[0].pending_amount ?? 0),
          processed_count: Number(summaryRows[0].processed_count ?? 0),
        },
      };
    },

    async distinctMethods(conn) {
      const [rows] = await query(
        'SELECT DISTINCT method FROM withdrawals ORDER BY method',
        [],
        conn,
      );
      return rows.map((r) => r.method);
    },

    async recentForUser(userId, limit = 5, conn) {
      const sql = `SELECT ${WITHDRAWAL_COLUMNS}
                   FROM withdrawals w
                   JOIN users u ON u.id = w.user_id
                   WHERE w.user_id = ?
                   ORDER BY w.created_at DESC, w.public_ref DESC
                   LIMIT ?`;
      const [rows] = await query(sql, [userId, Number(limit)], conn);
      return rows;
    },

    /**
     * Ownership-checked single fetch. Returns null when the record does not
     * exist OR does not belong to `userId` — the caller cannot distinguish the
     * two, which is the desired behaviour for an account-scoped read.
     */
    async findByIdForUser(id, userId, conn) {
      const sql = `SELECT ${WITHDRAWAL_COLUMNS}
                   FROM withdrawals w
                   JOIN users u ON u.id = w.user_id
                   WHERE (w.public_ref = ? OR w.id = ?) AND w.user_id = ?
                   LIMIT 1`;
      const [rows] = await query(sql, [id, id, userId], conn);
      return rows[0] ?? null;
    },

    async pendingAggregate(now = new Date(), conn) {
      const [rows] = await query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(w.amount_minor), 0) AS amount
         FROM withdrawals w
         WHERE w.status = 'pending'`,
        [],
        conn,
      );
      return { count: Number(rows[0].n), amount_minor: Number(rows[0].amount) };
    },
  };

  // -----------------------------------------------------------------------
  // payment methods
  // -----------------------------------------------------------------------
  const METHOD_COLUMNS = `m.id, m.public_ref, m.name, m.type, m.used_for, m.status, m.is_demo,
                          m.created_at, m.updated_at`;

  const paymentMethodRepo = {
    async create({ id, name, type, usedFor, status = 'disabled', isDemo = 0 }, conn) {
      return withUnitOfWork(conn, async (c) => {
        const publicRef = `PAY-${String(await allocateRef(c, 'PAY')).padStart(5, '0')}`;

        const sql = `INSERT INTO payment_methods
                       (id, public_ref, name, type, used_for, status, is_demo)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;
        try {
          await c.query(sql, [id, publicRef, name, type, usedFor, status, isDemo ? 1 : 0]);
        } catch (err) {
          tagError(err, 'A payment method with this name already exists.', 'Could not create payment method.');
        }
        return paymentMethodRepo.findById(id, c);
      });
    },

    async findById(id, conn) {
      const sql = `SELECT ${METHOD_COLUMNS}
                   FROM payment_methods m
                   WHERE m.public_ref = ? OR m.id = ?
                   LIMIT 1`;
      const [rows] = await query(sql, [id, id], conn);
      return rows[0] ?? null;
    },

    async findByName(name, conn) {
      const [rows] = await query(
        `SELECT ${METHOD_COLUMNS} FROM payment_methods m WHERE LOWER(m.name) = LOWER(?) LIMIT 1`,
        [String(name)],
        conn,
      );
      return rows[0] ?? null;
    },

    async list(params, conn) {
      const {
        search = '',
        type,
        usedFor,
        status,
        sort = 'created_at',
        direction = 'desc',
        limit = 20,
        offset = 0,
      } = params;

      const where = [];
      const args = [];

      const term = String(search).trim();
      if (term) {
        where.push('(m.name LIKE ? OR m.public_ref LIKE ?)');
        args.push(`%${term}%`, `%${term}%`);
      }
      if (type) {
        where.push('m.type = ?');
        args.push(type);
      }
      if (usedFor) {
        where.push('m.used_for = ?');
        args.push(usedFor);
      }
      if (status) {
        where.push('m.status = ?');
        args.push(status);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const orderSql = sortClause('payment_methods', sort, direction);

      const [rows] = await query(
        `SELECT ${METHOD_COLUMNS}
         FROM payment_methods m
         ${whereSql}
         ${orderSql}
         LIMIT ? OFFSET ?`,
        [...args, Number(limit), Number(offset)],
        conn,
      );
      const [countRows] = await query(
        `SELECT COUNT(*) AS total FROM payment_methods m ${whereSql}`,
        args,
        conn,
      );
      const [facetRows] = await query(
        `SELECT SUM(m.status = 'enabled')  AS enabled,
                SUM(m.status = 'disabled') AS disabled,
                SUM(m.type = 'crypto')      AS crypto,
                SUM(m.type = 'currency')    AS currency
         FROM payment_methods m`,
        [],
        conn,
      );

      return {
        rows,
        total: Number(countRows[0].total),
        facets: {
          enabled: Number(facetRows[0].enabled ?? 0),
          disabled: Number(facetRows[0].disabled ?? 0),
          crypto: Number(facetRows[0].crypto ?? 0),
          currency: Number(facetRows[0].currency ?? 0),
        },
      };
    },

    async update(id, patch, conn) {
      const allowed = ['name', 'type', 'used_for', 'status', 'is_demo'];
      const sets = [];
      const args = [];
      for (const key of allowed) {
        if (patch[key] !== undefined) {
          sets.push(`${key} = ?`);
          args.push(patch[key]);
        }
      }
      if (sets.length === 0) return paymentMethodRepo.findById(id, conn);
      try {
        await query(
          `UPDATE payment_methods SET ${sets.join(', ')} WHERE id = ? OR public_ref = ?`,
          [...args, id, id],
          conn,
        );
      } catch (err) {
        tagError(err, 'A payment method with this name already exists.', 'Could not update payment method.');
      }
      return paymentMethodRepo.findById(id, conn);
    },

    async remove(id, conn) {
      const [result] = await query(
        'DELETE FROM payment_methods WHERE id = ? OR public_ref = ?',
        [id, id],
        conn,
      );
      return result.affectedRows > 0;
    },

    async distinctNames(conn) {
      const [rows] = await query('SELECT DISTINCT name FROM payment_methods ORDER BY name', [], conn);
      return rows.map((r) => r.name);
    },
  };

  // -----------------------------------------------------------------------
  // payment settings (singleton)
  // -----------------------------------------------------------------------
  const settingsRepo = {
    async get(conn) {
      const [rows] = await query('SELECT * FROM payment_settings WHERE id = 1 LIMIT 1', [], conn);
      return rows[0] ?? null;
    },

    async ensure(conn) {
      const sql = `INSERT INTO payment_settings
                     (id, default_currency, processing_mode, minimum_deposit_minor, minimum_withdrawal_minor)
                   VALUES (1, 'USD', 'automatic', 1000, 1000)
                   ON DUPLICATE KEY UPDATE id = id`;
      await query(sql, [], conn);
      return settingsRepo.get(conn);
    },

    async upsert(patch, adminId, conn) {
      await settingsRepo.ensure(conn);
      const allowed = [
        'default_currency',
        'processing_mode',
        'payment_instructions',
        'minimum_deposit_minor',
        'minimum_withdrawal_minor',
      ];
      const sets = ['updated_by = ?'];
      const args = [adminId ?? null];
      for (const key of allowed) {
        if (patch[key] !== undefined) {
          sets.push(`${key} = ?`);
          args.push(patch[key]);
        }
      }
      const sql = `UPDATE payment_settings SET ${sets.join(', ')} WHERE id = 1`;
      await query(sql, args, conn);
      return settingsRepo.get(conn);
    },
  };

  // -----------------------------------------------------------------------
  // platform metrics (READ ONLY — demo aggregates)
  // -----------------------------------------------------------------------
  const metricsRepo = {
    async sumByKey(key, { from, to } = {}, conn) {
      const where = ['metric_key = ?'];
      const args = [key];
      if (from) {
        where.push('metric_date >= ?');
        args.push(from);
      }
      if (to) {
        where.push('metric_date <= ?');
        args.push(to);
      }
      const [rows] = await query(
        `SELECT COALESCE(SUM(amount_minor), 0) AS amount_minor,
                COALESCE(SUM(count_value), 0)  AS count_value,
                COALESCE(MIN(is_demo), 1)      AS is_demo,
                COUNT(*)                       AS n
         FROM platform_metrics_daily
         WHERE ${where.join(' AND ')}`,
        args,
        conn,
      );
      return {
        amount_minor: Number(rows[0].amount_minor),
        count_value: Number(rows[0].count_value),
        is_demo: Number(rows[0].is_demo) === 1 && Number(rows[0].n) > 0,
        rows: Number(rows[0].n),
      };
    },

    async series({ from, to } = {}, conn) {
      const where = ["metric_key IN ('deposits', 'withdrawals')"];
      const args = [];
      if (from) {
        where.push('metric_date >= ?');
        args.push(from);
      }
      if (to) {
        where.push('metric_date <= ?');
        args.push(to);
      }
      const [rows] = await query(
        `SELECT metric_date,
                metric_key,
                amount_minor
         FROM platform_metrics_daily
         WHERE ${where.join(' AND ')}
         ORDER BY metric_date`,
        args,
        conn,
      );
      const byDate = new Map();
      for (const r of rows) {
        const key = String(r.metric_date).slice(0, 10);
        const entry = byDate.get(key) ?? {
          date: key,
          deposits_minor: 0,
          withdrawals_minor: 0,
          is_demo: true,
        };
        if (r.metric_key === 'deposits') entry.deposits_minor = Number(r.amount_minor);
        if (r.metric_key === 'withdrawals') entry.withdrawals_minor = Number(r.amount_minor);
        byDate.set(key, entry);
      }
      return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    },

    async seedDemoRows(rows, conn) {
      const sql = `INSERT INTO platform_metrics_daily
                     (metric_date, metric_key, amount_minor, count_value, is_demo)
                   VALUES (?, ?, ?, ?, 1)
                   ON DUPLICATE KEY UPDATE amount_minor = VALUES(amount_minor),
                                           count_value  = VALUES(count_value),
                                           is_demo      = 1`;
      for (const r of rows) {
        await query(sql, [r.metric_date, r.metric_key, r.amount_minor, r.count_value], conn);
      }
      return rows.length;
    },

    async clearAll(conn) {
      await query('DELETE FROM platform_metrics_daily', [], conn);
    },
  };

  // -----------------------------------------------------------------------
  // customer portal credentials (002_customer_portal.sql)
  // -----------------------------------------------------------------------
  const customerAuthRepo = {
    async findByUserId(userId, conn) {
      const [rows] = await query(
        `SELECT user_id, password_hash, status, failed_login_count, locked_until,
                password_updated_at, last_login_at, created_at, updated_at
         FROM customer_auth
         WHERE user_id = ?
         LIMIT 1`,
        [userId],
        conn,
      );
      return rows[0] ?? null;
    },

    /**
     * Returns the credential row JOINED with its `users` row, or null when
     * either the user or the credential does not exist. The JOIN is what keeps
     * the customer portal and the admin panel on one shared identity record.
     */
    async findActiveByUserEmail(email, conn) {
      const [rows] = await query(
        `SELECT c.user_id, c.password_hash, c.status, c.failed_login_count,
                c.locked_until, c.last_login_at,
                u.id AS user_id, u.public_ref, u.full_name, u.email,
                u.balance_minor, u.currency, u.status AS user_status,
                u.kyc_status, u.created_at AS user_created_at
         FROM customer_auth c
         JOIN users u ON u.id = c.user_id
         WHERE u.email = ?
         LIMIT 1`,
        [String(email).toLowerCase()],
        conn,
      );
      return rows[0] ?? null;
    },

    async create({ userId, passwordHash }, conn) {
      await query(
        `INSERT INTO customer_auth (user_id, password_hash) VALUES (?, ?)`,
        [userId, passwordHash],
        conn,
      );
      return customerAuthRepo.findByUserId(userId, conn);
    },

    async setPassword(userId, passwordHash, conn) {
      await query(
        `UPDATE customer_auth
         SET password_hash = ?, password_updated_at = UTC_TIMESTAMP(3),
             failed_login_count = 0, locked_until = NULL
         WHERE user_id = ?`,
        [passwordHash, userId],
        conn,
      );
      return customerAuthRepo.findByUserId(userId, conn);
    },

    async recordLoginSuccess(userId, conn) {
      await query(
        `UPDATE customer_auth
         SET failed_login_count = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP(3)
         WHERE user_id = ?`,
        [userId],
        conn,
      );
      return customerAuthRepo.findByUserId(userId, conn);
    },

    async recordLoginFailure(userId, maxAttempts, lockUntil, conn) {
      await query(
        `UPDATE customer_auth
         SET failed_login_count = failed_login_count + 1,
             locked_until = CASE
               WHEN (failed_login_count + 1) >= ? THEN ?
               ELSE locked_until
             END
         WHERE user_id = ?`,
        [maxAttempts, lockUntil, userId],
        conn,
      );
      return customerAuthRepo.findByUserId(userId, conn);
    },
  };

  const customerSessionRepo = {
    async create({ id, userId, refreshTokenHash, expiresAt, ip = null, userAgent = null }, conn) {
      await query(
        `INSERT INTO customer_sessions
           (id, user_id, refresh_token_hash, expires_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, userId, refreshTokenHash, expiresAt, ip, userAgent],
        conn,
      );
      return { id, user_id: userId, refresh_token_hash: refreshTokenHash, expires_at: expiresAt };
    },

    async findValidByTokenHash(hash, now = new Date(), conn) {
      const [rows] = await query(
        `SELECT id, user_id, refresh_token_hash, issued_at, expires_at, revoked_at
         FROM customer_sessions
         WHERE refresh_token_hash = ?
           AND revoked_at IS NULL
           AND expires_at > ?
         LIMIT 1`,
        [hash, now],
        conn,
      );
      return rows[0] ?? null;
    },

    async revoke(id, reason, now = new Date(), conn) {
      const [result] = await query(
        `UPDATE customer_sessions
         SET revoked_at = ?, revoked_reason = ?
         WHERE id = ? AND revoked_at IS NULL`,
        [now, reason ?? null, id],
        conn,
      );
      return result.affectedRows > 0;
    },

    async revokeForUser(userId, reason, now = new Date(), conn) {
      const [result] = await query(
        `UPDATE customer_sessions
         SET revoked_at = ?, revoked_reason = ?
         WHERE user_id = ? AND revoked_at IS NULL`,
        [now, reason ?? null, userId],
        conn,
      );
      return result.affectedRows;
    },

    async deleteExpired(now = new Date(), conn) {
      const [result] = await query('DELETE FROM customer_sessions WHERE expires_at <= ?', [now], conn);
      return result.affectedRows;
    },
  };

  // -----------------------------------------------------------------------
  // audit log
  // -----------------------------------------------------------------------
  /**
   * Both MySQL 8 and MariaDB accept a JSON-encoded *string* bound parameter for
   * a JSON column — they parse it server side. Explicit `CAST(x AS JSON)` is
   * MySQL-8-only syntax and is a syntax error on MariaDB, so it is deliberately
   * not used; this keeps the schema and queries portable across both.
   */
  function parseJsonColumn(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  const auditRepo = {
    async insert(entry, conn) {
      const sql = `INSERT INTO audit_log
                     (actor_admin_id, actor_email, action, entity_type, entity_id,
                      summary, before_json, after_json, ip, user_agent)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      const params = [
        entry.actor_admin_id ?? null,
        entry.actor_email ?? null,
        entry.action,
        entry.entity_type,
        entry.entity_id ?? null,
        entry.summary,
        entry.before_json ? JSON.stringify(entry.before_json) : null,
        entry.after_json ? JSON.stringify(entry.after_json) : null,
        entry.ip ?? null,
        entry.user_agent ?? null,
      ];
      const [result] = await query(sql, params, conn);
      return {
        ...entry,
        id: result.insertId,
        before_json: entry.before_json ?? null,
        after_json: entry.after_json ?? null,
      };
    },

    async list(params, conn) {
      const { page = 1, perPage = 20, action, entityType, from, to } = params;
      const where = [];
      const args = [];
      if (action) {
        where.push('a.action = ?');
        args.push(action);
      }
      if (entityType) {
        where.push('a.entity_type = ?');
        args.push(entityType);
      }
      if (from) {
        where.push('a.created_at >= ?');
        args.push(from);
      }
      if (to) {
        where.push('a.created_at <= ?');
        args.push(to);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [rows] = await query(
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.summary,
                a.actor_admin_id, a.actor_email, a.before_json, a.after_json, a.created_at
         FROM audit_log a
         ${whereSql}
         ORDER BY a.id DESC
         LIMIT ? OFFSET ?`,
        [...args, Number(perPage), Number((page - 1) * perPage)],
        conn,
      );
      // The in-memory driver hands back objects, so normalise here to keep the
      // repository contract identical across drivers.
      const normalised = rows.map((r) => ({
        ...r,
        before_json: parseJsonColumn(r.before_json),
        after_json: parseJsonColumn(r.after_json),
      }));
      const [countRows] = await query(
        `SELECT COUNT(*) AS total FROM audit_log a ${whereSql}`,
        args,
        conn,
      );
      return { rows: normalised, total: Number(countRows[0].total) };
    },

    async count(conn) {
      const [rows] = await query('SELECT COUNT(*) AS n FROM audit_log', [], conn);
      return Number(rows[0].n);
    },

    async clearAll(conn) {
      await query('DELETE FROM audit_log', [], conn);
    },
  };

  return {
    adminRepo,
    sessionRepo,
    userRepo,
    withdrawalRepo,
    paymentMethodRepo,
    settingsRepo,
    metricsRepo,
    auditRepo,
    customerAuthRepo,
    customerSessionRepo,
  };
}
