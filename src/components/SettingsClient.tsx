"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Camera,
  Check,
  Download,
  History,
  Layers,
  ListPlus,
  LogOut,
  Pencil,
  Shield,
  Trash2,
  UserCog,
} from "lucide-react";
import {
  Avatar,
  Button,
  ConfirmDialog,
  FieldError,
  Input,
  Label,
  Overlay,
  Textarea,
  useToast,
} from "@/components/ui";
import type { AccountView, SpaceSummaryView } from "@/lib/types";

type AboutField = { id: string; label: string; value: string; sortOrder: number };

/* Restore point (backup) types — mirrors the API contract in src/lib/backup.ts. */
type RestorePreview = {
  format: string;
  formatLabel: string;
  legacy: boolean;
  exportedAt: string | null;
  sourceEmail: string | null;
  counts: Record<string, number>;
  mediaBytes: number;
  warnings: string[];
  notRecoverable: string[];
  destructive: boolean;
};

type RestoreResult = {
  format: string;
  mode: "replace" | "merge";
  restored: Record<string, number>;
  skipped: string[];
  notRecoverable: string[];
};

const MAX_RESTORE_BYTES = 200 * 1024 * 1024;

const COUNT_LABELS: Array<[string, string]> = [
  ["spaces", "Spaces"],
  ["people", "People"],
  ["meNodes", "Me nodes"],
  ["relationships", "Relationships"],
  ["mutualRelationships", "— mutual"],
  ["directionalRelationships", "— directional"],
  ["customFields", "Person custom fields"],
  ["accountFields", "Account About Me fields"],
  ["memories", "Memories"],
  ["media", "Media files"],
  ["mediaWithPayload", "— with file contents"],
  ["externalMediaReferences", "— external links only"],
  ["graphLayouts", "Graph layout records"],
];

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function SettingsClient({
  user,
  spaces,
}: {
  user: AccountView;
  spaces: SpaceSummaryView[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio ?? "");
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const avatarRef = useRef<HTMLInputElement>(null);

  const [aboutFields, setAboutFields] = useState<AboutField[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ label: "", value: "" });
  const [fieldsBusy, setFieldsBusy] = useState(false);

  // --- Restore point -------------------------------------------------
  const restoreRef = useRef<HTMLInputElement>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreStage, setRestoreStage] = useState<string>("");
  const [restoreProgress, setRestoreProgress] = useState(0);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);

  useEffect(() => {
    fetch("/api/account/fields")
      .then((r) => r.json())
      .then((d: { fields?: AboutField[] }) => setAboutFields(d.fields ?? []))
      .catch(() => {});
  }, []);

  async function saveProfile() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, bio, avatarUrl }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Could not save your profile.");
      }
      toast("Profile saved");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  }

  async function uploadAvatar(file: File | null) {
    if (!file) return;
    setUploadingAvatar(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("read failed"));
        reader.readAsDataURL(file);
      });
      const res = await fetch("/api/account/avatar", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, mimeType: file.type, data }),
      });
      const body = (await res.json()) as { error?: string; user?: AccountView };
      if (!res.ok || !body.user) throw new Error(body.error ?? "Upload failed.");
      setAvatarUrl(body.user.avatarUrl ?? "");
      toast("Profile photo updated");
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed.", "error");
    } finally {
      setUploadingAvatar(false);
      if (avatarRef.current) avatarRef.current.value = "";
    }
  }

  async function addAboutField() {
    if (!newLabel.trim()) return;
    setFieldsBusy(true);
    try {
      const res = await fetch("/api/account/fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newLabel, value: newValue }),
      });
      const body = (await res.json()) as { error?: string; field?: AboutField };
      if (!res.ok || !body.field) throw new Error(body.error ?? "Could not add the field.");
      setAboutFields((f) => [...f, body.field!]);
      setNewLabel("");
      setNewValue("");
      toast("Field added");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not add the field.", "error");
    } finally {
      setFieldsBusy(false);
    }
  }

  async function saveAboutField(id: string) {
    setFieldsBusy(true);
    try {
      const res = await fetch(`/api/items/userfield/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error();
      setAboutFields((fields) =>
        fields.map((f) => (f.id === id ? { ...f, label: draft.label, value: draft.value } : f)),
      );
      setEditingId(null);
      toast("Field updated");
    } catch {
      toast("Could not update the field.", "error");
    } finally {
      setFieldsBusy(false);
    }
  }

  async function removeAboutField(id: string) {
    setAboutFields((fields) => fields.filter((f) => f.id !== id));
    await fetch(`/api/items/userfield/${id}`, { method: "DELETE" });
    toast("Field deleted");
  }

  async function deleteAccount() {
    setDeleting(true);
    try {
      const res = await fetch("/api/account", { method: "DELETE" });
      if (!res.ok) throw new Error();
      router.replace("/login");
      router.refresh();
    } catch {
      toast("Could not delete the account", "error");
      setDeleting(false);
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  /**
   * Chunked, authenticated upload of the chosen backup file. Each chunk is sent as a
   * raw binary body so it stays below the hosting request-body limit (4.5 MB on
   * Vercel). Nothing is restored here — the server only validates and previews.
   */
  async function chooseBackupFile(file: File | null) {
    if (!file) return;
    if (restoreBusy || restoring) return;
    setRestoreError(null);
    setRestoreResult(null);
    setAcknowledged(false);
    setPreview(null);

    if (!/\.json$/i.test(file.name) && file.type !== "application/json") {
      setRestoreError("Choose a CircleMap .json backup file.");
      return;
    }
    if (file.size === 0) {
      setRestoreError("That file is empty.");
      return;
    }
    if (file.size > MAX_RESTORE_BYTES) {
      setRestoreError(
        `That file is ${formatBytes(file.size)}. The maximum restore size is ${formatBytes(MAX_RESTORE_BYTES)}.`,
      );
      return;
    }

    setRestoreBusy(true);
    setRestoreProgress(0);
    setRestoreStage("Preparing upload…");
    let createdId: string | null = null;
    try {
      const startRes = await fetch("/api/account/restore/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, totalBytes: file.size }),
      });
      const startBody = (await startRes.json()) as {
        error?: string;
        upload?: { id: string; chunkSize: number; totalChunks: number };
      };
      if (!startRes.ok || !startBody.upload) throw new Error(startBody.error ?? "Could not start the upload.");
      const { id, chunkSize, totalChunks } = startBody.upload;
      createdId = id;

      for (let i = 0; i < totalChunks; i += 1) {
        const blob = file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize));
        const res = await fetch(`/api/account/restore/uploads/${id}/chunks/${i}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: blob,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Upload failed on part ${i + 1} of ${totalChunks}.`);
        }
        setRestoreProgress(Math.round(((i + 1) / totalChunks) * 100));
        setRestoreStage(`Uploading ${i + 1} / ${totalChunks}…`);
      }

      setRestoreStage("Validating backup…");
      const checkRes = await fetch(`/api/account/restore/uploads/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "validate" }),
      });
      const checkBody = (await checkRes.json()) as { error?: string; preview?: RestorePreview };
      if (!checkRes.ok || !checkBody.preview) throw new Error(checkBody.error ?? "That backup could not be read.");
      setUploadId(id);
      setPreview(checkBody.preview);
    } catch (e) {
      if (createdId) {
        await fetch(`/api/account/restore/uploads/${createdId}`, { method: "DELETE" }).catch(() => {});
      }
      setUploadId(null);
      setRestoreError(e instanceof Error ? e.message : "That backup could not be read.");
    } finally {
      setRestoreBusy(false);
      setRestoreStage("");
      setRestoreProgress(0);
      if (restoreRef.current) restoreRef.current.value = "";
    }
  }

  async function cancelRestore() {
    const id = uploadId;
    setPreview(null);
    setUploadId(null);
    setAcknowledged(false);
    setRestoreResult(null);
    if (id) await fetch(`/api/account/restore/uploads/${id}`, { method: "DELETE" }).catch(() => {});
  }

  async function confirmRestore() {
    if (!uploadId || !preview || !acknowledged || restoring) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const res = await fetch(`/api/account/restore/uploads/${uploadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", acknowledge: true }),
      });
      const body = (await res.json()) as { error?: string; result?: RestoreResult };
      if (!res.ok || !body.result) throw new Error(body.error ?? "The restore did not complete.");
      setRestoreResult(body.result);
      setPreview(null);
      setUploadId(null);
      toast(body.result.mode === "replace" ? "Backup restored" : "Legacy export imported");
      router.refresh();
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : "The restore did not complete.");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="min-h-dvh cm-aurora">
      <div className="mx-auto w-full max-w-3xl space-y-5 px-5 py-7 sm:px-8">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Settings</h1>
          <p className="mt-1.5 text-sm text-muted">Your account, your spaces, your data.</p>
        </header>

        <section className="rounded-2xl p-5 cm-card">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <UserCog className="size-4 text-primary" /> Account profile
          </h2>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="flex flex-col items-center gap-2">
              <Avatar name={displayName || user.email} src={avatarUrl || null} size={64} />
              <input
                ref={avatarRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(e) => uploadAvatar(e.target.files?.[0] ?? null)}
              />
              <Button
                size="sm"
                variant="secondary"
                loading={uploadingAvatar}
                icon={<Camera className="size-3.5" />}
                onClick={() => avatarRef.current?.click()}
              >
                Upload
              </Button>
            </div>
            <div className="flex-1 space-y-3">
              <div>
                <Label htmlFor="name">Display name</Label>
                <Input id="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="avatar">Photo URL</Label>
                <Input id="avatar" value={avatarUrl} placeholder="https://…" onChange={(e) => setAvatarUrl(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="bio">About me</Label>
                <Textarea id="bio" rows={2} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="A line about you" />
              </div>
              <FieldError>{error}</FieldError>
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-muted">{user.email}</p>
                <Button loading={saving} onClick={saveProfile}>
                  Save profile
                </Button>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl p-5 cm-card">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <ListPlus className="size-4 text-secondary" /> About me — details
          </h2>
          <p className="mb-3 text-xs text-muted">
            The same flexible fields as person profiles, for your own account.
          </p>
          <div className="space-y-2">
            {aboutFields.length === 0 && (
              <p className="rounded-xl border border-dashed border-line/70 px-3 py-4 text-center text-xs text-muted">
                No details yet — add anything you want attached to your account.
              </p>
            )}
            {aboutFields.map((f) =>
              editingId === f.id ? (
                <div key={f.id} className="space-y-2 rounded-xl border border-line/60 p-3">
                  <Input value={draft.label} placeholder="Field name" onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
                  <Input value={draft.value} placeholder="Value" onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" loading={fieldsBusy} icon={<Check className="size-3.5" />} onClick={() => saveAboutField(f.id)}>
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div key={f.id} className="group flex items-center gap-2 rounded-xl border border-line/50 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] uppercase tracking-wide text-muted/70">{f.label}</p>
                    <p className="truncate text-sm">{f.value || "—"}</p>
                  </div>
                  <button
                    aria-label={`Edit ${f.label}`}
                    className="rounded-md p-1.5 text-muted hover:text-ink"
                    onClick={() => {
                      setEditingId(f.id);
                      setDraft({ label: f.label, value: f.value });
                    }}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    aria-label={`Delete ${f.label}`}
                    className="rounded-md p-1.5 text-muted hover:text-danger"
                    onClick={() => removeAboutField(f.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ),
            )}
            <div className="flex gap-2 pt-1">
              <Input value={newLabel} placeholder="Field name (e.g. Hometown)" onChange={(e) => setNewLabel(e.target.value)} />
              <Input value={newValue} placeholder="Value" onChange={(e) => setNewValue(e.target.value)} />
              <Button loading={fieldsBusy} onClick={addAboutField}>
                Add
              </Button>
            </div>
          </div>
        </section>

        <section className="rounded-2xl p-5 cm-card">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Layers className="size-4 text-secondary" /> Spaces ({spaces.length})
          </h2>
          <div className="space-y-1.5">
            {spaces.length === 0 && <p className="text-xs text-muted">No spaces yet.</p>}
            {spaces.map((s) => (
              <Link
                key={s.id}
                href={`/spaces/${s.id}`}
                className="flex items-center gap-3 rounded-xl border border-line/50 p-2.5 transition hover:border-primary/50"
              >
                <span
                  className="flex size-8 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `${s.color}22`, border: `1px solid ${s.color}55` }}
                >
                  {s.icon}
                </span>
                <span className="flex-1 truncate text-sm">{s.name}</span>
                <span className="text-[11px] text-muted">{s.peopleCount} people</span>
              </Link>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-muted/80">Manage or delete individual spaces from My Spaces.</p>
        </section>

        <section className="rounded-2xl p-5 cm-card">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Shield className="size-4 text-accent" /> Privacy & data
          </h2>
          <p className="mb-4 text-xs leading-relaxed text-muted">
            Every request is checked against your session on the server — knowing an id is never enough to read a record.
            Uploaded media is stored privately and streamed only to you.
          </p>
          <div className="flex flex-wrap gap-2">
            <a href="/api/account/export" download>
              <Button variant="secondary" icon={<Download className="size-4" />}>
                Export my data (JSON)
              </Button>
            </a>
            <a href="/api/account/backup" download>
              <Button variant="secondary" icon={<Download className="size-4" />}>
                Download full backup (JSON)
              </Button>
            </a>
            <Button variant="secondary" icon={<LogOut className="size-4" />} onClick={signOut}>
              Sign out
            </Button>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted/80">
            The full backup (<code>circlemap.backup.v2</code>) includes your Spaces, people, relationships,
            custom fields, memories, graph layouts and the actual contents of your uploaded photos and
            documents. The original export (<code>circlemap.export.v1</code>) is unchanged and still
            available above.
          </p>
        </section>

        <section className="rounded-2xl p-5 cm-card">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <History className="size-4 text-primary" /> Restore point
          </h2>
          <p className="mb-4 text-xs leading-relaxed text-muted">
            Restore your CircleMap data from a backup file previously downloaded to your device. The file is
            uploaded privately, validated and previewed first — nothing changes until you confirm.
          </p>
          <input
            ref={restoreRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => chooseBackupFile(e.target.files?.[0] ?? null)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              loading={restoreBusy}
              icon={<History className="size-4" />}
              onClick={() => restoreRef.current?.click()}
            >
              Choose backup file
            </Button>
            {restoreBusy && (
              <span className="text-[11px] text-muted">
                {restoreStage} {restoreProgress > 0 ? `${restoreProgress}%` : ""}
              </span>
            )}
          </div>
          <FieldError>{restoreError}</FieldError>
          {restoreResult && (
            <div className="mt-3 rounded-xl border border-line/60 p-3 text-xs">
              <p className="font-semibold">
                {restoreResult.mode === "replace"
                  ? "Full backup restored."
                  : "Legacy export imported alongside your existing data."}
              </p>
              <ul className="mt-2 space-y-0.5 text-muted">
                {Object.entries(restoreResult.restored).map(([k, v]) => (
                  <li key={k}>
                    {v} {k}
                  </li>
                ))}
              </ul>
              {restoreResult.skipped.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-amber-200/90">
                  {restoreResult.skipped.map((s) => (
                    <li key={s}>• {s}</li>
                  ))}
                </ul>
              )}
              {restoreResult.notRecoverable.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-amber-200/90">
                  {restoreResult.notRecoverable.map((s) => (
                    <li key={s}>• Not recoverable from this file: {s}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-danger/40 bg-danger/5 p-5">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-200">
            <Trash2 className="size-4" /> Danger zone
          </h2>
          <p className="mb-4 text-xs leading-relaxed text-muted">
            Deleting your account permanently removes every space, person, relationship, custom field, memory and file.
            There is no recovery.
          </p>
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete my account
          </Button>
        </section>
      </div>

      <Overlay
        open={preview !== null}
        onClose={() => {
          if (!restoring) void cancelRestore();
        }}
        title="Review this backup before restoring"
        wide
      >
        {preview && (
          <div className="space-y-4 text-sm">
            <div className="rounded-xl border border-line/60 p-3 text-xs">
              <p className="font-semibold text-ink">{preview.formatLabel}</p>
              <p className="mt-1 text-muted">
                Exported {preview.exportedAt ? new Date(preview.exportedAt).toLocaleString() : "at an unknown time"}
                {preview.sourceEmail ? ` · from ${preview.sourceEmail}` : ""}
              </p>
              <p className="mt-1 text-muted">
                Media payload in file: {formatBytes(preview.mediaBytes)}
              </p>
            </div>

            <div
              className={
                preview.destructive
                  ? "rounded-xl border border-danger/40 bg-danger/5 p-3 text-xs leading-relaxed"
                  : "rounded-xl border border-amber-400/40 bg-amber-400/5 p-3 text-xs leading-relaxed"
              }
            >
              <p className="mb-1 flex items-center gap-2 font-semibold">
                <AlertTriangle className="size-3.5" />
                {preview.destructive ? "This replaces your current CircleMap data" : "Legacy partial export"}
              </p>
              {preview.destructive ? (
                <p className="text-muted">
                  Restoring this full backup deletes the Spaces, people, relationships, custom fields,
                  memories, uploads and layouts currently in this account and replaces them with the backup
                  contents. Anything you changed since the backup was taken will be lost. Your email address,
                  password and current sign-in are never changed.
                </p>
              ) : (
                <p className="text-muted">
                  This is the older <code>circlemap.export.v1</code> file. It cannot recover data it never
                  contained. It will be imported <strong>alongside</strong> your existing data with new ids —
                  nothing you already have is deleted.
                </p>
              )}
              {preview.notRecoverable.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-muted">
                  {preview.notRecoverable.map((n) => (
                    <li key={n}>• Cannot be recovered: {n}</li>
                  ))}
                </ul>
              )}
              {preview.warnings.map((w) => (
                <p key={w} className="mt-2 text-muted">
                  • {w}
                </p>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
              {COUNT_LABELS.filter(([key]) => preview.counts[key] !== undefined).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-2 border-b border-line/30 py-1">
                  <span className="text-muted">{label}</span>
                  <span className="font-semibold">{preview.counts[key]}</span>
                </div>
              ))}
            </div>

            <label className="flex items-start gap-2 rounded-xl border border-line/60 p-3 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span className="text-muted">
                {preview.destructive
                  ? "I understand this permanently replaces the data currently in my account."
                  : "I understand this old export cannot restore uploaded files, account avatar bytes or graph layouts, and will be imported as additional data."}
              </span>
            </label>

            <FieldError>{restoreError}</FieldError>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => void cancelRestore()} disabled={restoring}>
                Cancel
              </Button>
              <Button
                variant={preview.destructive ? "danger" : "primary"}
                loading={restoring}
                disabled={!acknowledged || restoring}
                onClick={confirmRestore}
              >
                {preview.destructive ? "Replace my data" : "Import this export"}
              </Button>
            </div>
          </div>
        )}
      </Overlay>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete your account?"
        body="This erases all of your spaces, people, relationships, custom fields, memories and uploads immediately. This cannot be undone."
        confirmLabel="Delete everything"
        loading={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={deleteAccount}
      />
    </div>
  );
}
