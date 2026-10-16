# Hostinger Deployment Guidance

> **Nothing here has been deployed.** This is documentation only. Do not run
> these commands against a live site until you have read §5.

---

## 1. The one thing you must verify first

**Does your Hostinger plan actually provide Node.js application hosting?**

Hostinger sells several very different products, and only some of them run Node:

| Product | Node.js? | What you get |
|---|---|---|
| Shared / Premium / Business **Web hosting** | **No** | Apache + PHP + MySQL only. `node`, `npm`, `systemd` and long-running processes are **not available**. |
| **Cloud** hosting | Partly | Managed LEMP stack; you can add a Node app *if* the panel exposes a "Node.js" / "Setup Node.js App" tool. Verify before assuming. |
| **VPS** (KVM 1/2/4/…) | **Yes** | Full root on Ubuntu/Debian. You control everything: Node version, process manager, Nginx, TLS, firewall. |

### How to check in 60 seconds

1. hPanel → search for **"Node.js"** or **"Setup Node.js App"**.
   * It exists → Cloud hosting, Node is supported; use §4.
   * It does not exist → you are on Shared/Business hosting; use §3.
2. On a VPS: `ssh root@<ip>` then `node --version`.
   * If that errors, Node is not installed yet — install it (§4.1).
3. Or ask Hostinger support directly: *"Does my plan allow running a persistent
   Node.js process on port 3000/4000, and can I install a process manager?"*

### If the answer is "no"

You have three honest options, in order of preference:

1. **Change plan** to a VPS (or another Node-capable host). This is the only
   option that keeps the code in this repository.
2. **Use the code as the reference implementation** for a PHP/MySQL
   reimplementation on your existing plan. The data model, endpoint contract and
   OpenAPI file in this folder translate directly.
3. **Host the backend elsewhere** (any Node-capable PaaS) and point DNS at it,
   keeping the site on Hostinger.

Do **not** try to keep a Node process alive with `cron @reboot`, `nohup`, or a
PHP `shell_exec()` wrapper. On shared hosting those processes are killed at
random, are invisible to the supervisor, and are a recurring outage source.

---

## 2. Shared / Business hosting (PHP + MySQL only)

If — and only if — your plan has no Node support, the minimum viable approach on
that plan is:

1. Keep MySQL. Apply `backend/migrations/001_schema.sql` from **phpMyAdmin →
   SQL** (it is plain, portable InnoDB DDL with `utf8mb4_0900_ai_ci`).
2. Serve the admin API from PHP behind the same domain (e.g.
   `https://your-domain.example/api/v1/…`), reimplementing the endpoints
   described in `backend/docs/API_CONTRACT.md` and `backend/openapi.yaml`.
3. Reuse, unchanged, from this repository:
   - `migrations/001_schema.sql` — the schema, keys and constraints;
   - `scripts/seed-demo.js` — the demo fixture definitions (translate the arrays;
     every row is `is_demo = 1`);
   - `openapi.yaml` and `docs/API_CONTRACT.md` — the endpoint contract, field
     names, pagination metadata and error envelope;
   - `docs/SECURITY.md` — the auth/CSRF/audit design; port it to PHP sessions
     and `password_hash()`/`password_verify()` (bcrypt), which is directly
     equivalent to what this backend does.
4. Keep `backend/` in the repository as the reference implementation and the
   source of the contract. Do not leave both running.

**Do not paste PHP `shell_exec("node server.js")` into a page.** It does not
work reliably on shared hosting and it is a security problem.

---

## 3. VPS — secure, persistent Node.js setup

Assumes Ubuntu 22.04/24.04, a non-root sudo user, and the domain already
pointing at the VPS IP.

### 3.1 Install Node from NodeSource

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
node --version    # expect v22.x
```

### 3.2 Create a dedicated service user

```bash
sudo adduser --system --group --home /srv/scalpsphere scalpsphere
sudo mkdir -p /srv/scalpsphere/app
```

Never run the API as `root`.

### 3.3 Place the code and install dependencies

```bash
sudo -u scalpsphere git clone <your-repo> /srv/scalpsphere/app   # or rsync backend/
cd /srv/scalpsphere/backend
sudo -u scalpsphere npm ci --omit=dev
```

### 3.4 Environment variables

Keep them **outside** the web root and readable only by the service user.

```bash
sudo mkdir -p /etc/scalpsphere
sudo tee /etc/scalpsphere/backend.env >/dev/null <<'EOF'
NODE_ENV=production
PORT=4000
HOST=127.0.0.1
API_ORIGIN=https://api.your-domain.example
CORS_ALLOWED_ORIGINS=https://admin.your-domain.example
TRUST_PROXY=true
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=scalpsphere_app
DB_PASSWORD=<generated>
DB_NAME=scalpsphere
JWT_ACCESS_SECRET=<48+ random base64url bytes>
COOKIE_SECURE=true
COOKIE_SAMESITE=strict
LOG_LEVEL=info
LOG_FORMAT=json
SEED_ALLOW_IN_PRODUCTION=false
EOF

sudo chown root:scalpsphere /etc/scalpsphere/backend.env
sudo chmod 640 /etc/scalpsphere/backend.env
```

`src/config/env.js` reads these directly; `dotenv` only fills in anything not
already set, so no `.env` file is required in production.

### 3.5 Migrations and the first administrator

```bash
cd /srv/scalpsphere/app/backend
sudo -u scalpsphere bash -c 'set -a; . /etc/scalpsphere/backend.env; set +a; npm run migrate'
sudo -u scalpsphere bash -c 'set -a; . /etc/scalpsphere/backend.env; set +a; npm run admin:create'
```

Do **not** run `npm run seed` unless this really is a demo deployment; it is
refused in production unless `SEED_ALLOW_IN_PRODUCTION=true`.

### 3.6 systemd unit (supervision + restart)

```ini
# /etc/systemd/system/scalpsphere-api.service
[Unit]
Description=ScalpSphere Admin API
After=network-online.target mysql.service
Wants=network-online.target

[Service]
Type=simple
User=scalpsphere
Group=scalpsphere
WorkingDirectory=/srv/scalpsphere/app/backend
EnvironmentFile=/etc/scalpsphere/backend.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal
SyslogIdentifier=scalpsphere-api

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/scalpsphere
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now scalpsphere-api
sudo systemctl status scalpsphere-api
journalctl -u scalpsphere-api -f
```

Restart behaviour: `Restart=always` + `RestartSec=2` covers crashes, OOM kills
and reboots. The app also handles `SIGTERM`/`SIGINT` by closing the HTTP server
and draining the MySQL pool, so `systemctl restart` is in-place-safe.

### 3.7 Nginx reverse proxy + HTTPS

```nginx
# /etc/nginx/sites-available/scalpsphere-api
server {
    listen 80;
    server_name api.your-domain.example;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name api.your-domain.example;

    ssl_certificate     /etc/letsencrypt/live/api.your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.your-domain.example/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;

    # Do not advertise the upstream.
    proxy_hide_header X-Powered-By;

    location /api/v1/ {
        proxy_pass         http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
        client_max_body_size 64k;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/scalpsphere-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.your-domain.example
```

`TRUST_PROXY=true` matches the single Nginx hop. If you add a CDN, set it to the
actual hop count instead — an incorrect value either loses the real client IP
(rate limits become global) or lets a client spoof `X-Forwarded-For` (rate limits
become bypassable).

### 3.8 Serve the frontend on the same origin

```nginx
server {
    listen 443 ssl http2;
    server_name admin.your-domain.example;
    root /srv/scalpsphere/app/public;    # admin.html, index.html, login.html
    index admin.html;

    location /api/v1/ {
        proxy_pass http://127.0.0.1:4000;   # same origin → no CORS needed
        include /etc/nginx/proxy_params;
    }
}
```

### 3.9 Firewall

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Port 4000 must stay closed to the internet; Nginx is the only ingress.

---

## 4. MySQL hardening on the VPS

```bash
sudo mysql_secure_installation        # set root password, remove test DB
sudo tee /etc/mysql/mysql.conf.d/zz-scalpsphere.cnf >/dev/null <<'EOF'
[mysqld]
bind-address = 127.0.0.1
character-set-server = utf8mb4
collation-server = utf8mb4_0900_ai_ci
innodb_buffer_pool_size = 512M
EOF
sudo systemctl restart mysql
```

```sql
CREATE DATABASE scalpsphere CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'scalpsphere_app'@'localhost' IDENTIFIED BY '<generated>';
GRANT SELECT, INSERT, UPDATE, DELETE ON scalpsphere.* TO 'scalpsphere_app'@'localhost';
FLUSH PRIVILEGES;
```

The application user needs no `DDL`, no `GRANT`, and no access to `mysql.*`.

> **MySQL vs MariaDB.** The backend works on both — the schema, queries and the
> entire test suite have been executed against MariaDB 11.4. The two things to
> know if you use MariaDB instead of MySQL 8:
> `utf8mb4_0900_ai_ci` is accepted (MariaDB maps it), and `JSON` columns behave
> as `LONGTEXT` with a validity check, so the application binds JSON as a
> *string* rather than using MySQL-8-only `CAST(x AS JSON)`. That detail is
> already handled in `src/db/mysql/repositories.js`; do not "simplify" it back.
> See `docs/TESTING.md` §0.

---

## 5. Backups

```bash
sudo tee /usr/local/bin/backup-scalpsphere.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date +%F)
DEST=/var/backups/scalpsphere
mkdir -p "$DEST"
mysqldump --single-transaction --routines --triggers \
  --user=root --password="$MYSQL_ROOT_PASSWORD" \
  scalpsphere | gzip > "$DEST/scalpsphere-$STAMP.sql.gz"
find "$DEST" -name 'scalpsphere-*.sql.gz' -mtime +30 -delete
EOF
sudo chmod 700 /usr/local/bin/backup-scalpsphere.sh

# Nightly at 02:17, with the DB password supplied by the cron environment
sudo tee /etc/cron.d/scalpsphere-backup >/dev/null <<'EOF'
17 2 * * * root MYSQL_ROOT_PASSWORD='<secret>' /usr/local/bin/backup-scalpsphere.sh
EOF
sudo chmod 600 /etc/cron.d/scalpsphere-backup
```

Then copy `/var/backups/scalpsphere` off the VPS (S3-compatible storage, another
server, or your workstation) — a backup on the same disk as the database is not a
backup.

**Rehearse a restore at least once:**

```bash
mysql -e "CREATE DATABASE scalpsphere_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
gunzip < /var/backups/scalpsphere/scalpsphere-2026-10-14.sql.gz \
  | mysql scalpsphere_restore
mysql scalpsphere_restore -e "SELECT COUNT(*) AS users FROM users;"
```

---

## 6. Deploy / update runbook

```bash
# On the VPS
cd /srv/scalpsphere/app && sudo -u scalpsphere git pull
cd backend && sudo -u scalpsphere npm ci --omit=dev
sudo -u scalpsphere bash -c 'set -a; . /etc/scalpsphere/backend.env; set +a; npm run migrate'
sudo systemctl restart scalpsphere-api
curl -fsS https://api.your-domain.example/api/v1/health
```

Zero-downtime variant: run two units on different ports behind Nginx upstreams
and `reload` Nginx between restarts. A single unit already restarts in ~2 s,
which is normally acceptable for an admin console.

**Do a smoke run after the first deploy** (against the production database, but
read the warning first):

```bash
# NEVER run this against production — it wipes the target schema and seeds demo data.
# It is for a staging clone. On production, verify with:
curl -fsS https://api.your-domain.example/api/v1/health
sudo -u scalpsphere bash -c 'set -a; . /etc/scalpsphere/backend.env; set +a; \
  npm run migrate:status'
```

`scripts/smoke-test.js` exists precisely so a staging environment can be
verified with one command; it is deliberately destructive and must never be
pointed at production.

---

## 7. Production checklist

- [ ] Node.js plan capability **verified** (VPS or Cloud with the Node.js tool)
- [ ] Node ≥ 20.12, installed from NodeSource
- [ ] Dedicated non-root service user
- [ ] `npm run check` → `configuration is valid`
- [ ] `npm test` green offline, and `npm run test:mysql` + `npm run smoke:db`
      green against a **staging clone** of the database
- [ ] MySQL bound to `127.0.0.1`, least-privilege app user, `utf8mb4_0900_ai_ci`
- [ ] Nginx terminates TLS, redirects 80 → 443, HSTS on
- [ ] `TRUST_PROXY` matches the real proxy hop count
- [ ] `CORS_ALLOWED_ORIGINS` lists only real origins; never `*`
- [ ] `COOKIE_SECURE=true`, `COOKIE_SAMESITE=strict`
- [ ] `JWT_ACCESS_SECRET` unique to this environment
- [ ] Firewall allows only 22/80/443
- [ ] systemd `Restart=always` enabled; `journalctl` reachable
- [ ] Nightly backups, off-host copy, restore rehearsed
- [ ] `SEED_ALLOW_IN_PRODUCTION=false`
- [ ] One administrator provisioned and signed in
