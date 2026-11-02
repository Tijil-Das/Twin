/** Add-pair dialog: text input for local path + Drive folder ID or URL. */
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addPair } from "@/lib/tauri";
import type { PairEntry, PairMode } from "@/lib/tauri";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

function parseDriveFolderId(input: string): string {
  // Accept raw ID or full URL like https://drive.google.com/drive/folders/FOLDER_ID
  const m = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : input.trim();
}

export function AddPairDialog({ open, onClose, onAdded }: Props) {
  const [local, setLocal] = useState("");
  const [driveInput, setDriveInput] = useState("");
  const [mode, setMode] = useState<PairMode>("two_way");
  const [saving, setSaving] = useState(false);
  const [localErr, setLocalErr] = useState("");
  const [driveErr, setDriveErr] = useState("");

  function validate(): boolean {
    let ok = true;
    if (!local.trim()) { setLocalErr("Local path is required."); ok = false; }
    else setLocalErr("");
    if (!driveInput.trim()) { setDriveErr("Drive folder ID or URL is required."); ok = false; }
    else setDriveErr("");
    return ok;
  }

  async function handleAdd() {
    if (!validate()) return;
    setSaving(true);
    try {
      const pair: PairEntry = {
        id: crypto.randomUUID(),
        local: local.trim(),
        drive_folder_id: parseDriveFolderId(driveInput),
        mode,
        enabled: true,
      };
      await addPair(pair);
      onAdded();
      onClose();
      setLocal(""); setDriveInput(""); setMode("two_way");
    } catch (e) {
      toast.error(`Failed to add folder pair: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 50 }}
        />
        <Dialog.Content
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%,-50%)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 24,
            width: 480,
            maxWidth: "90vw",
            zIndex: 51,
            boxShadow: "0 4px 16px rgba(0,0,0,.12)",
          }}
          onEscapeKeyDown={onClose}
        >
          <Dialog.Title style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
            Add folder pair
          </Dialog.Title>
          <Dialog.Description style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>
            Enter a local folder path and a Google Drive folder ID or URL.
          </Dialog.Description>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 4 }}>
                Local folder path
              </label>
              <Input
                value={local}
                onChange={(e) => setLocal(e.target.value)}
                placeholder="C:\Users\you\Documents\Work"
                style={{ fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 12 }}
              />
              {localErr && <p style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>{localErr}</p>}
            </div>

            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 4 }}>
                Drive folder ID or URL
              </label>
              <Input
                value={driveInput}
                onChange={(e) => setDriveInput(e.target.value)}
                placeholder="https://drive.google.com/drive/folders/…  or  folder ID"
              />
              {driveErr && <p style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>{driveErr}</p>}
            </div>

            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 4 }}>
                Sync mode
              </label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as PairMode)}
                style={{
                  width: "100%",
                  height: 32,
                  padding: "0 8px",
                  fontSize: 13,
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--surface)",
                  color: "var(--text)",
                }}
              >
                <option value="two_way">Two-way</option>
                <option value="upload">Upload only</option>
                <option value="mirror">Mirror (local wins)</option>
              </select>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={handleAdd} disabled={saving}>
              {saving ? "Adding…" : "Add pair"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

