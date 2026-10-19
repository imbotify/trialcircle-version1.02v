# CircleMap — Phase 0.5 Architecture Reconciliation

Status: **APPROVED FOR IMPLEMENTATION** — all 14 items below are resolved. No broad feature work
begins until this document is reviewed. Code changes in this phase are limited to the
reconciliation itself (schema constraints, relationship semantics, derivation fixes, test suite).

Conventions: **DECISION** = binding choice. **RULE** = invariant enforced in code and/or the
database. References like §16 point at the Master Engineering Specification.

---

## Item 1 — Reconciling `relationshipToMe` with the relationship graph

**Problem.** `people.relationship_to_me` was a stored column *and* person creation wrote a
Me↔person edge with the same label. Profile edits updated only the column, so the graph edge and
the profile header could disagree (e.g. header "Cousin", edge "Best Friend"). Two sources of truth.

**DECISION — the graph is the single source of truth. The column is removed.**

- `people.relationship_to_me` is dropped. There is no cached copy anywhere.
- `relationshipToMe` remains in the API view model (`PersonView`) but is now **derived**:
  the label of the oldest Me↔person edge in that space, or `null` when no such edge exists.
- Person creation with a relationship label creates a mutual Me↔person edge (unchanged behavior,
  minus the column write). If `connectToMe === false`, a supplied label is ignored — a label
  without an edge is meaningless — and documented as such.
- Profile edits to "Relationship to me" map onto the **primary Me-edge** (the oldest Me↔person
  edge), with these exact semantics:
  - label provided + primary edge exists → update that edge's label (conflict-checked, RULE D3);
  - label provided + no Me-edge exists → create a mutual Me↔person edge;
  - label cleared + primary edge exists → delete the primary edge only;
  - label cleared + no Me-edge → no-op.
  - Additional Me-edges beyond the primary (e.g. "Brother" + "Business Partner") are managed
    exclusively through the Connections tab / edge editor, never through the profile field.

**RULE R1.** No read path may consult anything except `relationships` rows to answer "how is X
related to me". No write path may store that answer anywhere except `relationships` rows.

**Migration.** Before the column is dropped, any legacy field value without a corresponding
Me-edge is backfilled as a mutual Me↔person edge; where both exist and differ, the edge wins.

---

## Item 2 — Exact relationship semantics

### 2a. Mutual relationship

- A mutual relationship is an **unordered pair** `{A, B}` plus a normalized label.
- Storage form is **canonical**: the lexicographically smaller person UUID is always
  `from_person_id`. Application code canonicalizes on write; the database never sees both orders.
- Rendered as `↔` (dashed indigo→cyan edge). Either endpoint may initiate creation; deleting the
  row removes the relationship for both sides simultaneously — there is no "side" to a mutual edge.
- Directional metadata (`from`/`to`) on a mutual row carries no meaning and must never be
  interpreted by any read path.

### 2b. Directional relationship

- A directional relationship is an **ordered pair** `(A → B)` plus a normalized label.
- Storage order is significant and preserved. Rendered as `→` (solid violet→pink edge with
  arrowhead at the target).
- The reversed pair `(B → A)` with the same label is a **distinct** relationship, not a
  duplicate. Example: `Me → Vikram "Manages"` vs `Vikram → Me "Manages"` are different claims.
- Changing a row's type between mutual and directional recomputes endpoint order: → mutual
  re-sorts to canonical order; → directional keeps the stored order as the direction (with an
  explicit swap operation available to flip it).

### 2c. Path traversal ("How are A and B connected?")

- **RULE P1.** Paths are computed with BFS over the **undirected projection** of the real
  relationship rows. Direction is ignored for connectivity, surfaced in presentation.
- Returns the shortest path (fewest edges) or `null` when disconnected. Self-query returns `[self]`.
- BFS terminates on visited sets, so cycles are safe by construction.
- **RULE P2.** No path logic may consult node coordinates, view mode, layout rows, or render
  state. Ever. The current `findPath` implementation already satisfies P1–P2 and is now covered
  by unit tests.

### 2d. Focus traversal (Focus Mode)

- Focus is a **1-hop neighbourhood emphasis**: given a selected person S, the set
  `{S} ∪ neighbours(S)` renders fully; all other nodes/edges are dimmed. No path computation.
- Focus and path-tracing are mutually exclusive overlays: enabling one clears the other.
- Selecting nothing while Focus Mode is on is a no-op visually (nothing to emphasize); the mode
  toggle remains available.

### 2e. Duplicate prevention

A relationship's identity key is defined as:

```
key = (from_person_id, to_person_id, lower(trim(label)))
```

where `(from, to)` is the canonical order for mutual rows and the stored order for directional
rows. Label normalization is `trim()` + case-insensitive comparison; interior whitespace and
original casing are preserved for display.

| Incoming write | Existing row with same key | Result |
|---|---|---|
| mutual | mutual | Idempotent return of the existing row (HTTP 200, `created: false`) |
| directional | directional | Idempotent return of the existing row (HTTP 200, `created: false`) |
| mutual | directional (or vice versa) | **HTTP 409** — "These two people already have a '‹label›' relationship. Edit that connection to change its type." |
| (no row with same key) | — | Create (HTTP 201, `created: true`) |

**RULE D1.** Retries, double-taps and double submissions can never create a second row: the
check-then-insert is backed by the database unique index (§12), so concurrent duplicates fail
closed at the DB layer.

### 2f. Multiple relationships between the same pair

- **RULE D2.** Any number of rows may share the same endpoint pair **iff their normalized labels
  differ**. Example: `Rahul ↔ Priya` as "Childhood Friends" + "Business Partners" is two rows.
- Rendered as fanned parallel edges with independent labels and independent selection/deletion.
- The primary (oldest) row is used only for the derived `relationshipToMe` display (§1); it
  confers no other privilege.

### 2g. Label updates

**RULE D3.** Renaming a relationship re-runs the full identity-key check against all *other*
rows. A rename that would collide returns HTTP 409; the row is left untouched.

---

## Item 3 — Application vs. database consistency matrix

Every rule below is enforced at **both** layers. The database is the backstop; the application
provides idempotent/conflict-aware UX on top. They cannot disagree because they implement the
same key definition (§2e).

| Rule | Application (`domain.ts` + `relationships.ts`) | Database |
|---|---|---|
| Mutual canonical order | `canonicalPair()` sorts endpoints before insert/update | Unique index on `(from, to, lower(label))` makes any non-canonical duplicate impossible |
| Duplicate prevention | Key lookup → return existing (200) or 409 on type conflict | `relationships_pair_label_unique` on `(from_person_id, to_person_id, lower(label))` |
| Same-space endpoints | `requirePerson` on both ends + space equality check (422) | Composite FKs `(from_person_id, space_id)` and `(to_person_id, space_id)` → `people(id, space_id)` |
| Valid relationship type | `type` coerced to `mutual` unless exactly `directional` | `CHECK (type IN ('mutual','directional'))` |
| One Me per space | Exactly one Me row created per space; no API can create another | Partial unique index on `people(space_id) WHERE is_me` |
| Valid view mode | Coerced to `circle` unless exactly `tree` | `CHECK (view_mode IN ('circle','tree'))` |
| Valid media kind | Derived from MIME allow-list, never trusted from client | `CHECK (kind IN ('photo','document'))` |
| No self-loops | Explicit 422 | (No DB check: the app rule is total — every write path funnels through `createRelationship`. A DB check would be redundant, not contradictory.) |
| Layout rows reference same-space people | Ownership pre-filter before upsert | Composite FK `(person_id, space_id)` → `people(id, space_id)` |

**DECISION.** Where Postgres cannot express a rule declaratively (self-loops would need a check
on two columns — actually expressible…). Reconsidered: `CHECK (from_person_id <> to_person_id)`
*is* expressible and is therefore added. No rule is left app-only when a declarative form exists.

---

## Item 4 — Tree View vs. BFS network depth

**Problem.** The tree layout used BFS hop-depth from Me as vertical levels, implicitly equating
"network distance" with "hierarchy". Those are different concepts: a spouse is 1 hop but not a
"child" of Me; a manager is 1 hop but senior in hierarchy.

**DECISION.** Tree View levels are **exploration layers, not hierarchy**. Level *n* = "shortest
path of length *n* from Me". This is honest about what is computed and matches the Circle view's
ring semantics (rings and levels are the same BFS depth, projected differently).

**RULE T1.** No feature may interpret tree level as seniority, generation, or reporting depth.
The UI must not label levels with hierarchical terms ("parents", "children", "reports").

---

## Item 5 — Does Tree View need hierarchy metadata?

**DECISION — No. Tree View is an explicitly simplified graph projection.**

- Tree View = same nodes + same edges, laid out in BFS layers with manual repositioning allowed
  per view mode. Cross-links that skip layers render as ordinary edges; nothing is hidden,
  deleted, or redefined by switching views (spec §22–§23 upheld).
- True hierarchy (parent/child, manager/report roles) is **deferred**: it requires per-edge role
  metadata that does not exist in the approved MVP relationship model (free-form labels only,
  spec §14). Inventing role inference from label text ("Mother" ⇒ parent) is explicitly rejected
  — it would be guessing, and wrong guesses corrupt a personal graph silently.
- Extension point (not built): an optional `role` attribute on relationships (`peer | senior |
  junior | undefined`, user-assigned) that a future Tree View could project. The schema is not
  pre-migrated for it.

The layout module carries a comment stating this decision so future work cannot accidentally
re-introduce hop-depth-as-hierarchy.

---

## Item 6 — All Connections: list now, visual aggregate later

**DECISION.** The current All Connections screen is the **read-only list/directory
implementation**: cross-space aggregation, space-grouped, filterable, no merging, editing only
inside the owning space. This satisfies the approved release.

- The **aggregated visual network** (multi-space graph canvas) is explicitly a future milestone:
  it raises unanswered product questions (cross-space edge rendering when edges cannot span
  spaces, identity disambiguation UI, performance at N×M scale) that must not be improvised
  during feature expansion.
- The component is marked `LIST/DIRECTORY IMPLEMENTATION — visual aggregate deferred` in code.

---

## Item 7 — Memory → Media attachment semantics

**Problem.** `memories.image_url` accepted arbitrary external URLs, making an unverifiable
third-party string the "attachment".

**DECISION — media rows are the single source of truth for attachments.**

- New nullable `memories.image_media_id → media(id) ON DELETE SET NULL`.
- Memory creation/update accepts `imageMediaId`, validated as: media row exists, is owned by
  the caller, belongs to the **same person** as the memory, and is `kind = 'photo'`.
- Reads resolve `imageUrl` as: attached media → its private `/api/media/‹id›` URL; else legacy
  `image_url` value (read-only fallback for pre-reconciliation rows); else `null`.
- Writes to `image_url` are no longer accepted — the field is legacy-frozen.
- Deleting the attached photo nulls the reference (SET NULL); the memory survives.
- UI wiring (attach-a-photo picker in the memory dialog) is **deferred feature work** — the
  current memory form has no image input, so no UI writes the legacy field. Server + schema +
  semantics are reconciled now.

---

## Item 8 — Profile photo upload architecture

**Problem.** Avatars were URL-only strings (`avatar_url`), with no upload path.

**DECISION — uploads are first-class; URLs remain as import/compat.**

Person avatar:
- `POST /api/people/‹id›/avatar` accepts `{fileName, mimeType, data}` (base64 data-URL, same
  contract as media upload): validates image MIME + ≤ 4 MB, creates a `media` row
  (`kind='photo'`, caption "Profile photo"), and sets `people.avatar_url` to the private
  `/api/media/‹id›` URL. The photo also appears in the person's gallery (documented behavior:
  the avatar *is* a gallery photo).
- External URLs in `avatar_url` (imports, demo seed) keep working as a read fallback.

Account avatar:
- `users.avatar_mime` + `users.avatar_data` (base64, ≤ 2 MB, image MIME only) store the binary
  on the account row — media rows are person-scoped and must not be repurposed for accounts.
- `PUT /api/account/avatar` uploads (empty payload clears); `GET /api/account/avatar` streams
  the bytes for the current session only (no id parameter → no IDOR surface). After upload,
  `users.avatar_url` is set to `/api/account/avatar` so every existing avatar consumer
  (sidebar, Me-node inheritance) works unchanged.

**RULE M1.** No avatar read path may distinguish "uploaded" from "URL" avatars — both arrive as
`avatarUrl` strings; authorization happens at the serving route.

---

## Item 9 — Is Profile Setup a separate onboarding stage?

**DECISION — No separate stage in this release.**

- Signup collects display name (the only required identity field); sign-in goes straight to
  My Spaces with a pre-seeded starter space, so the product teaches itself.
- Bio and photo are editable in Settings and via the per-space Me override; nothing blocks the
  core loop on profile completion.
- Rationale: the blueprint's Profile Setup screen exists to personalize, not to gate. A forced
  interstitial before first value would hurt activation for a private single-user tool.
- Revisit trigger: if multi-user/shared spaces ship, onboarding identity (photo, handle)
  becomes load-bearing and a dedicated stage is justified.

---

## Item 10 — Account "About Me" custom-field model

**DECISION — Implement now.** Spec §56 keeps About Me on the same flexible custom-field concept
as person profiles; the model was missing and is added:

- New `user_fields` table: `(id, user_id → users ON DELETE CASCADE, label, value, sort_order,
  timestamps)` — mirroring `custom_fields` exactly.
- Domain functions `list/create/update/delete/reorderUserFields`, all session-scoped (no id
  parameter can escape the account).
- API: `GET/POST /api/account/fields`, `PATCH /api/account/fields` (reorder `{order:[ids]}`),
  `PATCH/DELETE /api/items/userfield/‹id›`.
- Settings gains an "About me" section with add/edit/delete. Reorder UI is deferred (creation
  order is stable and sensible); the reorder endpoint exists for when it is needed.

---

## Item 11 — Production media storage architecture

**Current state (kept for this release).** Media binaries are base64 in Postgres (`media.data`),
streamed through the authorized `/api/media/‹id›` route. Correct, private, zero-dependency —
and adequate up to low-GB scale with the 4 MB/file cap.

**DECISION — production target is S3-compatible object storage behind the same route.**

- Target: private bucket (no public access), per-object keys `‹userId›/‹mediaId›/‹filename›`;
  the app server holds credentials and streams bytes (or mints short-lived presigned URLs).
- `media.storage_key TEXT NULL` is added **now** as the migration seam: `NULL` = inline in
  `media.data`; non-null = object storage is authoritative.
- Migration path (future, no code yet): uploader writes to object storage + sets `storage_key`;
  reader prefers `storage_key` when present; backfill job uploads legacy rows and sets keys;
  `media.data` is nulled after verification. The serving route's contract never changes.
- All object-storage code will live behind the two existing functions (`createMedia`,
  `requireMedia` + the route handler) so the cutover is contained. No other module may touch
  binaries directly (**RULE M2**).

---

## Item 12 — Database constraints (authoritative list)

Implemented in `src/db/schema.ts` and applied to the database. Drizzle push is verified
idempotent afterward (second push reports no changes).

| # | Constraint | Type | Definition |
|---|---|---|---|
| C1 | One Me per space | Partial unique index `people_one_me_per_space` | `UNIQUE (space_id) WHERE is_me` |
| C2 | Valid relationship type | Check `relationships_type_check` | `type IN ('mutual','directional')` |
| C3 | Valid view mode | Check `graph_layouts_view_mode_check` | `view_mode IN ('circle','tree')` |
| C4 | Valid media kind | Check `media_kind_check` | `kind IN ('photo','document')` |
| C5 | Same-space edge endpoints | Composite FK `relationships_from_space_fk` | `(from_person_id, space_id) → people(id, space_id) ON DELETE CASCADE` |
| C6 | Same-space edge endpoints | Composite FK `relationships_to_space_fk` | `(to_person_id, space_id) → people(id, space_id) ON DELETE CASCADE` |
| C7 | Same-space layout rows | Composite FK `graph_layouts_person_space_fk` | `(person_id, space_id) → people(id, space_id) ON DELETE CASCADE` |
| C8 | Duplicate relationship key | Unique index `relationships_pair_label_unique` | `UNIQUE (from_person_id, to_person_id, lower(label))` |
| C9 | No self-loops | Check `relationships_no_self_loop` | `from_person_id <> to_person_id` |
| C10 | FK target for C5–C7 | Unique constraint `people_id_space_uidx` | `UNIQUE (id, space_id)` |
| C11 | Memory attachment integrity | FK `memories_image_media_fk` | `image_media_id → media(id) ON DELETE SET NULL` |

Notes:
- C5–C7 replace the old single-column person FKs (same cascade behavior, strictly stronger
  guarantee). The old constraint/index names that no longer exist: single-column person FKs on
  `relationships`/`graph_layouts`, and the old case-sensitive `(from,to,label)` unique index
  (superseded by C8).
- C8 relies on application-level canonical ordering for mutual rows (§2a) to make the
  unordered-pair guarantee total. A mutual row stored non-canonically cannot collide with its
  mirror at the DB layer — which is why canonicalization is a RULE, not a convention, and is
  unit-tested.
- Existing data was reconciled before constraints were applied, in order: backfill Me-edges
  from the legacy column → delete newer duplicates → canonicalize mutual endpoint order →
  apply constraints → drop the legacy column. Each step is re-runnable except the final drop.

---

## Item 13 — Production vs. demo authentication boundaries

**DECISION.**

- The demo account is a normal account row flagged `is_demo = true`. It receives no code-path
  privileges: every ownership check treats it identically. "Demo" is a seeding convenience,
  not a security role.
- `POST /api/auth/demo` (one-click demo entry) is gated by `ALLOW_DEMO`. When
  `ALLOW_DEMO=false`, the endpoint returns 404 as if it never existed. Default (unset) is
  allowed — required for evaluation environments; production deployments set `false`.
- Credential login for the demo account (`demo@circlemap.app`) is unaffected by the gate —
  the gate controls *one-click provisioning*, not the account. Production operators rotate or
  remove the seeded demo account as a deployment step (documented, not automated).
- Explicitly out of scope for this phase (no provider in this environment): OAuth, magic
  links, password recovery, email verification, rate limiting. The auth route's
  `/api/auth/‹action›` shape is retained so these slot in without breaking clients.

---

## Item 14 — Automated test strategy

Strategy: a fast unit layer for pure logic plus an integration layer that drives the real HTTP
API and verifies side effects at both the API and SQL levels. No mocks of the database.

```
tests/
  unit/
    relationships.test.ts   # canonicalPair, normalizeLabel, identity key, self-loop guard
    graph.test.ts           # BFS path (multi-hop, cycle, disconnected, self), neighbours,
                            # autoLayout fallback (me-centered, disconnected-safe)
  integration/
    api.test.ts             # full HTTP suite, see matrix below
```

Run: `npx tsx --test tests/unit/*.test.ts` (no server needed) and
`TEST_BASE_URL=http://localhost:3000 npx tsx --test tests/integration/*.test.ts`
(server required; fails fast with a clear message when unreachable).

Integration matrix (each row is an automated assertion; suite creates uniquely-named QA users
and deletes them afterward, so it is re-runnable against a dev database):

| Area | Assertions |
|---|---|
| Auth | signup 201 + starter space seeded; signup validation 422s; login 401 on wrong password; login 200; session persists via cookie; logout destroys session; anonymous 401 on protected routes |
| Ownership | user B gets 404 reading/deleting user A's space, person, field, memory, media, relationship |
| Cross-space relationships | 422 with stable message; DB-level cross-space insert rejected by composite FK |
| Relationship semantics | create 201; exact retry → 200 same id; case-variant retry → 200 same id; reversed mutual retry → 200 same id (canonical); reversed directional → 201 distinct; second label same pair → 201 distinct; same label different type → 409; rename collision → 409; self-loop → 422; type flip reorders canonically |
| relationshipToMe derivation | create-with-label yields edge + derived label; profile edit renames the edge; clearing deletes the primary edge only; person + other data intact |
| Deletion/cascades | delete edge removes only the edge; delete person removes edges/fields/media/memories/layouts; delete account removes everything (verified by SQL counts, zero orphans, zero cross-space rows) |
| Graph persistence | circle + tree layouts persist independently; reload returns identical coordinates |
| Media | upload 201; owner reads 200 with bytes; other user 404; anonymous 401; bad MIME 422; oversize 422; person avatar upload sets `avatarUrl` to private URL |
| Account fields | full CRUD + reorder + cross-user isolation |
| DB constraints | second Me insert fails; invalid type/view-mode/kind inserts fail; duplicate key insert fails; self-loop insert fails (direct SQL, asserting the backstop independently of app code) |

Manual E2E journeys (checklist, not automated in this phase): new-user first run, mobile
touch gestures, Tree↔Circle switching with manual positions, export-then-inspect. Automation
via Playwright is the recommended next step, not part of this gate.

---

## Appendix — Files changed in Phase 0.5 (reconciliation only)

- `src/db/schema.ts` — C1–C11, `user_fields`, `storage_key`, `image_media_id`, account avatar
  columns, legacy column removal.
- `src/lib/relationships.ts` (new) — pure canonicalization/normalization/key helpers shared by
  app code and unit tests.
- `src/lib/domain.ts` — derived `relationshipToMe`, primary-edge sync, conflict-aware
  create/update relationship, attachment validation, user fields, avatar flows.
- `src/lib/seed.ts` — edges as the only relationship source; deliberate multi-hop-only people.
- Routes: avatar endpoints, account fields, demo gate, `created` flag on relationship create.
- Minimal UI: avatar upload in profile editor + settings, About-me fields in settings.
- `tests/` — unit + integration suites described above.
