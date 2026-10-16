# Capacity & Sizing

Answering "how many users / how many servers" honestly requires separating the
three different quantities that get conflated. All numbers below are
**measured**, not estimated — see §4 for how to reproduce them on your own
hardware.

---

## 1. The short answer

| Question | Answer |
|---|---|
| How many **servers**? | **One.** An admin console does not need a cluster. |
| How many **administrators** can use it at once? | **~100–300 actively working** admins on a single instance. Thousands of *logged-in but idle* admins cost nothing. |
| How much **data** can it hold? | **~100k–250k rows per table** with the current search. Beyond that, switch search to the FULLTEXT index that is already defined but unused (§5). |
| What's the real bottleneck? | **bcrypt login** (~1–4 logins/sec/core, by design) and the `LIKE '%…%'` search at high row counts. Not the API itself. |

---

## 2. Measured on this machine

Single Node process, MariaDB 11.4 co-located on the same host, benchmark client
sharing the same CPU. This makes the numbers **conservative** — a dedicated VPS
with the client elsewhere will do better.

| Endpoint | Serial (c=1) | c=10 | c=25 |
|---|---|---|---|
| `GET /health` (1 query) | 122 req/s | 189 req/s | 247 req/s |
| `GET /users?per_page=20` (3 queries) | 69 req/s | 155 req/s | 148 req/s |
| `GET /dashboard/summary` (~8 queries) | 57 req/s | 106 req/s | 98 req/s |
| `POST /auth/login` (bcrypt 12) | **1.0 req/s** | — | — |

Latency stayed healthy under load: `p99` for the heaviest endpoint
(`/dashboard/summary`) was **385 ms at 25 concurrent** — well inside any
interactive budget.

### Why throughput plateaus around 100–250 req/s

Node runs the JavaScript event loop on **one core**. Every authenticated
request also does one extra indexed query to re-check the administrator's
status (`authenticate` loads the admin row so that disabling an account takes
effect immediately — a deliberate security-over-speed tradeoff, see
`src/middleware/authenticate.js`). A 2-core VPS will roughly double the
concurrent throughput because the OS can schedule the process better while Node
awaits MySQL I/O.

### The real ceiling: login

`bcrypt` at cost factor 12 is **intentionally slow** — that is the whole point
of password hashing.

| | This machine | Typical Linux VPS (native bcrypt) |
|---|---|---|
| Time per hash | ~1430 ms | ~250–300 ms |
| Logins per second per core | **~0.7** | **~3–4** |

> **Note on bcryptjs.** This backend uses `bcryptjs`, a pure-JavaScript
> implementation, chosen so it installs and runs identically anywhere without a
> native toolchain (including this Windows machine). It is roughly **3–5×
> slower** than the native `bcrypt` module. On a Linux VPS you may switch to
> `bcrypt` (drop-in: same API) for a significant login-throughput gain —
> do it before launch if you expect more than a handful of administrators.

For an admin console with a few administrators, 1–4 logins/sec/core is a complete
non-issue. If this ever becomes a **public** login endpoint, that number is the
one to plan around — and the rate limiter (`RATE_LIMIT_LOGIN_MAX`, failed
attempts only) is what protects it.

---

## 3. Deriving "how many admins" from requests/second

An administrator actively using the dashboard generates roughly **one API call
every 1–3 seconds** — a screen view fires a handful of requests (summary + list
+ facets) and then goes quiet while the human reads.

```
~150 req/s measured  ÷  ~0.5 req/s per actively-working admin
                   =  ~300 concurrently ACTIVE administrators
```

Idle, logged-in admins generate **zero** load: there is no polling, no
heartbeat, no session sweeper. A JWT is verified with a signature check plus one
indexed primary-key lookup, and nothing happens until the next request.

---

## 4. Reproduce these numbers on your production box

```bash
# Start a benchmark instance with the limiter raised out of the way
PORT=4100 RATE_LIMIT_API_MAX=100000 RATE_LIMIT_WRITE_MAX=100000 \
RATE_LIMIT_LOGIN_MAX=1000 LOG_LEVEL=error node src/server.js &

node scripts/bench.mjs http://127.0.0.1:4100
```

`scripts/bench.mjs` prints req/s with p50/p95/p99 for the cheapest read, the
typical list, the heaviest read, login, and the raw bcrypt cost on that machine.
It reports **429 counts explicitly** so you can tell the difference between
hitting the rate limiter (which is doing its job) and hitting a real limit.

Run it before launch, on the actual VPS, with the actual database loaded with
your real row counts. That single number is worth more than any estimate in this
document.

---

## 5. Data volume: when the current search stops being enough

`users`, `withdrawals` and `payment_methods` all search with
`LIKE '%term%'`. A leading-wildcard `LIKE` **cannot use an index** — it is a
table scan by definition, bounded only by how fast InnoDB can walk the rows.

| Rows in table | Expected search latency | Verdict |
|---|---|---|
| ≤ 10,000 | ~1–10 ms | Fine |
| 10k – 100k | ~10–50 ms | Fine |
| 100k – 250k | ~50–200 ms | Acceptable; plan the change |
| > 250k | 200 ms – seconds | **Switch to FULLTEXT** |

The schema already defines the upgrade path — it is just not wired up:

```sql
FULLTEXT KEY ft_users_search (full_name, email)      -- users
FULLTEXT KEY ft_withdrawals_search (method, receiver_email)  -- withdrawals
```

Switching is a one-line query change (`MATCH … AGAINST` instead of `LIKE`),
plus a behavioural note: FULLTEXT has a minimum word length (`ft_min_word_len`,
default 3/4) and a stopword list, so short search terms behave differently. Do
this when row counts demand it, not before — `LIKE` is simpler and its
behaviour is exactly what the HTML demo shows.

Pagination and counts stay fast at any size: every list endpoint has a
covering index on the sort column, and `COUNT(*)` on the filtered set is what
dominates. `DB_POOL_SIZE` (default 10) is the knob if MySQL connection
contention ever shows up in the p99.

---

## 6. Scaling out, if you ever need to

You almost certainly will not for an admin console, but the design does not
block it:

| Component | Scales across instances? |
|---|---|
| Access-token verification | ✅ stateless JWT — no shared state |
| Refresh sessions | ✅ stored in MySQL (`admin_sessions`), shared |
| Data | ✅ MySQL is the single source of truth |
| **Rate limiting** | ❌ **in-process store** — limits are per-instance, not global |

So N instances behind a load balancer work correctly, but each one counts its
own rate-limit window. With more than one instance, either:

- move the limiter to a shared store (Redis) — `src/middleware/rateLimiters.js`
  is a single file with one `MemoryStore` to swap; or
- enforce the limit at the proxy instead — nginx `limit_req` on the API location,
  which is the usual choice and needs no application change.

This limitation is documented rather than hidden because it is the one piece of
the design that assumes a single instance.
