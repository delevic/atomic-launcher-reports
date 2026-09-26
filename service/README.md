# Atomic Reports Worker

Prepared receiver for automatic report sending from Atomic Launcher.

**Status:** source tested locally against real SQLite and simulated GitHub responses.
Not yet deployed/configured/verified on Cloudflare. V72IE APK still uses the earlier
manual export + GitHub form workflow. This receiver does not update an installed APK.

## Installation through Cloudflare dashboard

1. Open existing Worker `atomic-reports`, then **Edit code**.
2. Replace the entire `worker.js` contents with this directory's `worker.js`, then Deploy.
3. Create a D1 database named `atomic-reports`. Add it to this Worker as a **D1 binding named `DB`**.
   Tables are created automatically on the first configured API request.
4. Register a **GitHub OAuth App** (not the Cloudflare GitHub integration):
   - Application name: `Atomic Launcher Reports`
   - Homepage: `https://atomic-reports.djdelevic.workers.dev`
   - Authorization callback: `https://atomic-reports.djdelevic.workers.dev/auth/callback`
   - Device flow is unnecessary. Login uses browser authorization with PKCE.
5. In Worker settings add:

| Name | Type | Value |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | Text | Client ID from the OAuth App |
| `GITHUB_CLIENT_SECRET` | Secret | OAuth App client secret |
| `GITHUB_REPORT_TOKEN` | Secret | Fine-grained GitHub token described below |
| `ALLOWED_GITHUB_USERS` | Text, optional | Comma-separated tester GitHub usernames; defaults to `delevic` |

The fine-grained report token must select **only `delevic/atomic-launcher-reports`**,
with repository permissions **Contents: Read and write** and **Issues: Read and write**.
Metadata read is implicit. Do not select the private launcher source repository.
Enter tokens directly in Cloudflare Secrets. Never put a secret in source, APK, chat,
screenshots, issue bodies, or normal text variables. Renew the report token before it expires.

For controlled testing add tester usernames to `ALLOWED_GITHUB_USERS`.
Setting that value to `*` permits any GitHub account; use only when public beta is intended.
No write access to the repository is requested from testers. Their OAuth token is used
only to read their GitHub identity and is not stored. App sessions expire after 30 days.
Logout revokes the current app session. Removing a tester from the allowlist blocks existing
sessions as well. These service sessions are independent of GitHub's OAuth revocation state.

The `/health` endpoint reports configuration presence, not a successful GitHub permission
or upload test. A complete synthetic end-to-end test must be performed before release.
Keep Worker request logging/observability disabled: OAuth callback URLs contain temporary codes.

## APK protocol, version 1

Fixed HTTPS base: `https://atomic-reports.djdelevic.workers.dev`.
Do not follow redirects for native API requests or log credentials/authorization URLs.

1. Generate a cryptographically random PKCE verifier (32 random bytes, base64url without padding),
   its SHA-256 base64url `challenge`, and an independent random 32-byte `session_token`.
   Persist them privately until sign-in completes so rotation/process death can resume it.
2. `POST /v1/auth/start`, JSON `{ "challenge": "..." }`.
   Receive `login_id`, `authorization_url`, expiry 600s, polling interval 5s.
3. Open that URL in the system browser. User authorizes GitHub and returns to the app.
   Poll at most every 5 seconds via `POST /v1/auth/token` with JSON
   `{ "login_id":"...", "verifier":"...", "session_token":"..." }`.
   HTTP 202 means pending. HTTP 200 with `status: authorized` confirms the session.
   On a lost response repeat with the same three values. Restart login after expiration/error.
4. Save the native session token in protected app storage. Subsequent API requests use
   `Authorization: Bearer <session_token>`. `GET /v1/me` checks the session;
   `POST /v1/logout` revokes it. HTTP 401 triggers a fresh login, not silent data loss.
5. Before sending, clearly disclose that the report ZIP (including video/logs) will be public
   in `delevic/atomic-launcher-reports`; obtain the user's confirmation. Freeze that export.
6. `POST /v1/reports` with JSON:

```json
{
  "client_report_id": "32 lowercase hex characters generated once per frozen export",
  "name": "Report name (up to 200 UTF-16 units)",
  "description": "Problem description (up to 8000 UTF-16 units)",
  "build": "Build (up to 80 UTF-16 units)",
  "device": "Device / Android (up to 240 UTF-16 units)",
  "size": 12345,
  "sha256": "64 lowercase hex characters: actual ZIP SHA-256",
  "public_upload_consent": true
}
```

Metadata JSON may be at most 16 KiB UTF-8; APK must bound UTF-8 bytes as well as string
lengths. Full description stays in the ZIP even if the issue description is shortened.
ZIP size: 22 bytes through 50 MiB. A changed export must use a new client report ID.
Reuse the same ID and exact metadata when retrying. Receive the server `report_id` and status.

7. `PUT /v1/reports/<report_id>/zip`, raw ZIP body, `Content-Type: application/zip`,
   exact `Content-Length`. No multipart, base64, or content encoding. Use fixed-length
   streaming from disk in Android, keeping UI responsive. Receive `uploaded` only after
   GitHub confirms the file's size and SHA-256. Display upload progress in the APK.
8. `POST /v1/reports/<report_id>/submit`. Display **Sent** only on `status: sent`,
   with `issue_number` and `issue_url`. Offer tapping the verified link.
9. `GET /v1/reports/<report_id>` reads server status. Each report is scoped to its sender.
   Keep the local ZIP until successful confirmation and follow existing local retention rules.

Possible statuses: prepared, uploading, uploaded, publishing, uncertain, sent.
Rate limiting returns HTTP 429 and Retry-After: 60. Respect it and do not generate new IDs
to work around a limit. Allow at most one active send task for an export in the APK.

## Recovery and limits

- Duplicate prepare, verified upload and completed submit requests reuse the same report.
- Uploads are streamed through Cloudflare FixedLengthStream, not buffered in memory.
  An upload interrupted after acquiring its lease may remain busy for **15 minutes**;
  show pending/retry, never success. Once the lease expires the receiver checks the unique
  remote filename and SHA-256 before uploading again. Failed `starter` assets are removed.
  An already uploaded mismatching asset is not automatically overwritten.
- After an ambiguous issue POST failure, the service checks GitHub's issue listing for the
  exact report marker. It does not blindly create another issue. If no issue is confirmed,
  status stays `uncertain`; the owner must investigate. This is deliberately not a promise
  of exactly-once execution across two independent services.
- Daily releases named `reports-YYYY-MM-DD` contain ZIP assets; these are **download links
  in issues**, not GitHub's native issue attachments. Each release is marked prerelease.
- Default quotas: 3 new reports/minute and 20/day per tester, 100/day globally. Upload/API/login
  limits also apply. Limits and service availability depend on Cloudflare/GitHub free quotas.
- Files are public once uploaded, including while issue creation is pending or fails.
  No automated deletion of submitted ZIPs, issues, or report records is implemented.
  Expired login/session/rate records are removed on subsequent login starts.
- ZIP signature, exact length and GitHub SHA-256 are checked; this is not malware scanning
  or a full ZIP structure validation. Treat downloaded diagnostics as untrusted data.
- No private GitHub repository is accessed, no shared secret is embedded in the APK, and
  response errors never include upstream bodies or secrets.

## Verification

Run `node --test worker.test.js` using Node 24 or newer. Tests use real SQLite and the
actual Worker request handlers, with GitHub network calls simulated. They verify login
state/PKCE, retry behavior, upload checks, report ownership, consent, quotas, and duplicate
issue prevention. They do **not** establish Cloudflare runtime performance, live OAuth
configuration, GitHub token permissions, or Android behavior.

Official references used for the implementation:
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- https://docs.github.com/en/rest/releases/assets
- https://developers.cloudflare.com/workers/runtime-apis/request/
- https://developers.cloudflare.com/d1/worker-api/d1-database/
