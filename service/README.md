# Web Asset Container (WAC) service

Cloudflare Worker that accepts zip uploads, extracts them into R2 under
`/<org>/<site>/<wac-path>/`, and serves the files as a static hosting
environment.

## URL contract

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/<org>/<site>/<wac-path>.wac` | Bearer / `X-WAC-Key` | Upload + extract zip |
| `DELETE` | `/<org>/<site>/<wac-path>.wac` | Bearer / `X-WAC-Key` | Remove container objects |
| `GET` | `/<org>/<site>/index.json` | Bearer / `X-WAC-Key` | List WACs for the site |
| `GET` / `HEAD` | `/<org>/<site>/<wac-path>/...` | none | Serve extracted assets |
| `OPTIONS` | any | none | CORS preflight |

Examples:

```bash
# Upload (raw zip body)
curl -X POST "http://127.0.0.1:8787/goodness/demo/hello.wac" \
  -H "Authorization: Bearer dev-upload-key" \
  -H "X-WAC-Author: david@goodness.cc" \
  -H "Content-Type: application/zip" \
  --data-binary @site.zip

# List containers for a site (auth required)
curl "http://127.0.0.1:8787/goodness/demo/index.json" \
  -H "Authorization: Bearer dev-upload-key"

# Consume (no auth, CORS open)
curl "http://127.0.0.1:8787/goodness/demo/hello/"
curl "http://127.0.0.1:8787/goodness/demo/hello/styles.css"
```

R2 keys mirror the public path:

```text
goodness/demo/hello/index.html
goodness/demo/hello/styles.css
```

## Cloudflare dashboard / account setup (david@goodness.cc)

Do these once on the account you use with Wrangler:

1. **Log in to Wrangler with that account**
   ```bash
   cd service
   npx wrangler login
   npx wrangler whoami
   ```
   Confirm the email / account is `david@goodness.cc`. If another account is
   selected, log out and log in again, then pick the right account when prompted.

2. **Enable R2** (Dashboard → R2 Object Storage → purchase/enable free tier if
   prompted). Workers bindings do not need a public R2 bucket URL; the Worker
   serves objects.

3. **Create the bucket** (CLI is enough; dashboard also works):
   ```bash
   npx wrangler r2 bucket create wac
   ```

4. **Set `account_id` in `wrangler.toml`** from `wrangler whoami` output.

5. **Set the upload-key secret for production**
   ```bash
   npx wrangler secret put WAC_UPLOAD_KEYS
   ```
   Paste JSON, for example:
   ```json
   {"*":"replace-me","goodness/demo":"site-specific-key"}
   ```
   Lookup order for a request to `/org/site/path.wac`:
   `org/site/path` → `org/site` → `org` → `*`.

6. **Deploy**
   ```bash
   npm run deploy
   ```

Optional later: attach a custom domain (Workers & Pages → your worker →
Triggers → Custom Domains). No special CORS dashboard config is required;
the Worker sends CORS headers itself.

## Local development

```bash
cd service
npm install
cp .dev.vars.example .dev.vars   # edit keys as needed
npm run dev
```

`.dev.vars` is gitignored. Production uses `wrangler secret`, not committed files.

## Auth header

```http
Authorization: Bearer <key>
```

or

```http
X-WAC-Key: <key>
```

Uploads and deletes require a matching key. GETs are public so browsers can
load HTML/CSS/JS cross-origin without credentials.

### Default asset (no index.html)

If a zip has no root `index.html` / `index.htm`, the client must send:

```http
X-WAC-Default: path/to/entry.html
```

That path is stored in `.wac/manifest.json` as `default`. Requests to the
container root then respond with **301** to that file.

### Manager UI

Open `/tools/wac/wac.html` on this site (or open the file locally). Sign in with
email + shared token against an org/site, then browse, preview, upload, replace,
or delete containers.
