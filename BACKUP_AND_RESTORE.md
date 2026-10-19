# Full backup download & Restore point

Narrowly scoped feature added to Settings. Nothing else in CircleMap changed.

## Download

| Button | Endpoint | Format | Status |
| --- | --- | --- | --- |
| **Export my data (JSON)** | `GET /api/account/export` | `circlemap.export.v1` | unchanged |
| **Download full backup (JSON)** | `GET /api/account/backup` | `circlemap.backup.v2` | new |

`circlemap.backup.v2` contains: account display name / bio / avatar bytes + MIME, account
About-Me fields, every Space, every person (incl. the Me node), person avatars and tags,
all mutual and directional relationships (labels, notes, multiple edges per pair), all
person custom fields with ordering, all memories (dates, descriptions, attachments), all
uploaded photos and documents **including their Base64 contents, byte length and SHA-256**,
Circle *and* Tree graph-layout rows, plus `format`, `exportedAt` and an `integrity` block.

Never included: password hashes, session tokens, any credential. Media rows that only ever
held an external URL are exported as `externalReference: { url, binaryIncluded: false }` —
the backup never claims to carry bytes CircleMap does not store.

## Hosting limits (Vercel)

A Vercel Function request **or** response body is capped at 4.5 MB
(`FUNCTION_PAYLOAD_TOO_LARGE`). Streaming responses are exempt.

* **Download** — `/api/account/backup` returns a `ReadableStream`; the JSON document is
  emitted fragment by fragment and media rows are read one at a time, so neither the
  response-body limit nor process memory is a ceiling.
* **Upload** — the browser slices the chosen file into 3 MB raw binary chunks
  (`PUT /api/account/restore/uploads/:id/chunks/:index`, `application/octet-stream`, no
  Base64, no JSON wrapper). Each request stays far below 4.5 MB.
* **Staging** — chunks land in `backup_uploads` / `backup_upload_chunks`, scoped to the
  authenticated user, with a 2 hour expiry and a lazy sweep on every new upload
  (`DELETE /api/account/restore/uploads` also purges). These tables sit outside the
  `users -> spaces -> …` chain that a restore deletes, so an in-flight upload is never
  destroyed by the restore it feeds. No new storage vendor is required.

## Restore workflow

Choose file → chunked upload → `POST …/:id {action:"validate"}` (reassemble, checksum,
structure + reference validation, real record counts) → preview dialog with warnings →
explicit acknowledgement checkbox → `POST …/:id {action:"restore", acknowledge:true}` →
truthful result summary → `router.refresh()`.

* **`circlemap.backup.v2`** — destructive for the signed-in account only: inside one
  transaction the user's Spaces and account fields are deleted and the backup is inserted
  with fresh UUIDs and remapped references. `users.id`, `email`, `password_hash` and
  `sessions` are never touched. Any failure rolls the whole thing back.
* **`circlemap.export.v1`** — recognised as a *legacy partial export*. Imported
  non-destructively alongside existing data with new ids. Media is **not** recreated from
  metadata (no bytes exist), and the UI lists exactly what the old format never contained.

Validation rejects: unknown formats, corrupt JSON, missing sections, cross-Space or
cross-user references, duplicate Me nodes, layouts pointing outside their Space, media with
no payload/reference, byte-length mismatch, checksum mismatch and oversized files (>200 MB).

## Tests

* `tests/unit/backup.test.ts` — format detection, validation, previews, legacy limits.
* `tests/integration/backup.test.ts` — download, round trip, chunked upload > 4.5 MB,
  rollback, expiry, rejections (needs a running server + `TEST_BASE_URL`).
