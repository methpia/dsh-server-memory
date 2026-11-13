# Deploying on a public server

The default setups are local (`127.0.0.1`) and private-network (`tailscale serve`). This page covers the third case:
the service sitting on a public VPS (Aliyun, Tencent Cloud, Hetzner, a home box with port forwarding) so any machine
can reach it without a VPN.

**Read the trade-off first.** `/api` has exactly one shared bearer token and no rate limiting. On a public address any
scanner can reach the port; the token is the only lock. That is acceptable for a personal service, but treat it like
an SSH key: long, secret, rotated if it ever leaks.

---

## 1. What you need

| Item | Why |
|---|---|
| A VPS (1 vCPU / 512 MB is enough) | the service is one Python file plus SQLite |
| A domain, or an IP | for TLS you need a name; an IP-only setup works but certs get awkward |
| Python 3.9+ | preinstalled on most images |
| Open ports | **443** if you terminate TLS here; **80** only for ACME challenges |

> **Mainland China note:** if you serve a domain on 80/443 from a mainland VPS, ICP filing (备案) applies to the
> domain. A tailnet or an overseas VPS avoids that. This is a policy constraint, not a technical one.

## 2. Install the service

```bash
git clone https://github.com/methpia/dsh-server-memory.git
cd dsh-server-memory/server
python3 memoryd.py --init-config        # prints the token once — copy it now
```

Config lives at `~/.config/dsh-memory/config.json`. For a public host, edit it:

```json
{
  "host": "0.0.0.0",
  "port": 8788,
  "db_path": "~/dsh-memory/data/memory.db",
  "tls_cert": "/etc/letsencrypt/live/your.domain/fullchain.pem",
  "tls_key": "/etc/letsencrypt/live/your.domain/privkey.pem"
}
```

Leave `tls_cert` / `tls_key` out and it speaks plain HTTP — only do that behind a proxy that terminates TLS.

`0.0.0.0` is correct here: the firewall, not the bind address, decides who can reach the port.


> Prefer containers? server/docker/ ships a compose file that mounts the config read-only and the database as a bind
> mount; see [server/README.md](../server/README.md#docker). The rest of this page applies unchanged (TLS, firewall,
> token handling).

## 3. TLS

### Option A — built in (simplest)

The server terminates TLS itself when both `tls_cert` and `tls_key` are set (minimum TLS 1.2). Get a certificate:

```bash
# certbot with the standalone challenge needs port 80 free for a moment
sudo certbot certonly --standalone -d mem.example.com
sudo systemctl enable --now certbot.timer   # renewal; reload the service after renewal
```

Certificates renew in place; `memoryd` reads them at startup, so add a post-renew hook:

```bash
echo 'systemctl --user restart dsh-memory' | sudo tee /etc/letsencrypt/renewal-hooks/post/memoryd.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/post/memoryd.sh
```

Run as a user service:

```bash
cp systemd/dsh-memory.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dsh-memory
journalctl --user -u dsh-memory -f
```

> The unit sets `ProtectSystem=strict` and only allows writes under `~/dsh-memory/data`. If you keep the database
> elsewhere, adjust `ReadWritePaths`. Reading certificates from `/etc/letsencrypt` works; `ProtectHome=read-only`
> only restricts home.

Verify from **another** machine:

```bash
curl -s https://mem.example.com/health
curl -s -o /dev/null -w '%{http_code}\n' https://mem.example.com/api/projects   # 401 = token enforced
```

### Option B — behind a reverse proxy

If you already run Caddy or nginx, keep the service on `127.0.0.1:8788` and let the proxy terminate TLS.

**Caddy** (certificates are automatic):

```caddyfile
mem.example.com {
    reverse_proxy 127.0.0.1:8788
    encode zstd gzip
}
```

**nginx** (with certbot managing certs):

```nginx
server {
    listen 443 ssl http2;
    server_name mem.example.com;

    ssl_certificate     /etc/letsencrypt/live/mem.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mem.example.com/privkey.pem;

    client_max_body_size 1m;          # the server rejects larger bodies anyway

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

server {
    listen 80;
    server_name mem.example.com;
    return 301 https://$host$request_uri;
}
```

With a proxy, keep `tls_cert` / `tls_key` empty and let the service speak HTTP on loopback only.

## 4. Firewall

Open only what you use. Examples:

```bash
# ufw (Debian/Ubuntu)
sudo ufw allow 443/tcp
sudo ufw allow 22/tcp
sudo ufw enable

# Aliyun / Tencent Cloud: do the same in the console security group —
# an open security group overrides ufw-less images.
```

If you chose the proxy, 8788 must **not** be open to the world.

## 5. Point the clients at it

In each client's profile patch:

```yaml
- id: dsh-server-memory
  config:
    serverUrl: https://mem.example.com
    tokenFile: ~/.config/dsh-memory/token
```

Copy the token file over (`chmod 600`), restart DSH, and confirm with the two-command check in the
[user guide](USER-GUIDE.md#step-6-verify-end-to-end).

## 6. Operating it

```bash
# health and counts
curl -s https://mem.example.com/health
python3 memoryd.py --check

# backup: the database is one file, but take it while the service is stopped
systemctl --user stop dsh-memory
cp ~/dsh-memory/data/memory.db ~/dsh-memory-backups/memory-$(date +%F).db
systemctl --user start dsh-memory

# rotate the token (no --force flag; back up the config first)
mv ~/.config/dsh-memory/config.json ~/.config/dsh-memory/config.json.bak
python3 memoryd.py --init-config        # re-apply host/port/tls_cert/tls_key afterwards
# then update every client's token file
```

**Optional hardening — fail2ban.** The service logs `401` responses but has no built-in throttling. If you want
brute-force protection, parse the log:

```
# /etc/fail2ban/filter.d/memoryd.conf
[Definition]
failregex = ^.*memoryd.*\s401\s.*$
ignoreregex =
```

then a jail reading `journalctl --user -u dsh-memory`. Because the token is 40 hex characters, guessing is
infeasible anyway — this only reduces log noise from scanners.

**Monitoring.** `/health` is unauthenticated and cheap; point any uptime checker at it. It returns `{"ok":true,...}`
with a 200 when the database opens.

## 7. What public deployment does *not* give you

- **No accounts.** One token = full access to every project's memory. There is no per-user isolation.
- **No rate limiting.** A hostile client can spam `/api/search`; the server is single-threaded per connection and will
  answer. Put it behind a proxy with `limit_req` if that matters.
- **No encryption at rest.** The SQLite file is plaintext on disk; use full-disk encryption on the VPS.
- **No audit trail beyond the HTTP log.** Enable the proxy's access log if you need to know who called what.

If those matter, the tailnet setup is better: it authenticates devices, not just a bearer header.
