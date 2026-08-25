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
| `GET` / `HEAD` | `/tools/*` | none | Proxy to AEM EDS (`main--wac--davidnuescheler.aem.live`) |
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

5. **Upload keys** are SHA-256 hex digests stored in the `WAC_KEYS` KV namespace
   (not in git). One KV key per scope (`org/site`, `*`, …).
   Lookup order for `/org/site/path.wac`:
   `org/site/path` → `org/site` → `org` → `*`.

   ```bash
   # hash a token
   node -e "console.log(require('crypto').createHash('sha256').update('TOKEN').digest('hex'))"

   # store / rotate one site (production + preview)
   npx wrangler kv key put --binding WAC_KEYS --preview false --remote "adobecom/wac-demo" "<sha256-hex>"
   npx wrangler kv key put --binding WAC_KEYS --preview --remote "adobecom/wac-demo" "<sha256-hex>"

   # remove a site
   npx wrangler kv key delete --binding WAC_KEYS --preview false --remote "adobecom/wac-demo"
   ```

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
npm run dev
```

`wrangler dev` uses the KV `preview_id` namespace. Put preview digests with
`--preview` as shown above.

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

The worker proxies `/tools/*` to the AEM EDS origin
(`https://main--wac--davidnuescheler.aem.live/`), using the same request
rewriting as the [AEM Cloudflare production worker](https://github.com/adobe/aem-cloudflare-prod-worker).
Open `/tools/wac/wac.html` on the worker (or on this site). Sign in with email +
shared token against an org/site, then browse, preview, upload, replace, or
delete containers.
