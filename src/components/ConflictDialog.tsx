/** Conflict resolution dialog — appears when policy=ask and a conflict arrives. */
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { useStore, type ConflictRecord } from "@/store";
import { resolveConflict } from "@/lib/tauri";
import { toast } from "sonner";

interface Props {
  conflict: ConflictRecord;
}

export function ConflictDialog({ conflict }: Props) {
  const removeConflict = useStore((s) => s.removeConflict);

  async function resolve(choice: "local" | "remote" | "both") {
    try {
      await resolveConflict(conflict.pair_id, conflict.rel_path, choice);
      removeConflict(conflict.pair_id, conflict.rel_path);
    } catch (e) {
      toast.error(`Conflict resolution failed: ${String(e)}`);
    }
  }

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            zIndex: 50,
          }}
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
          onEscapeKeyDown={() => removeConflict(conflict.pair_id, conflict.rel_path)}
        >
          <Dialog.Title style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
            Sync conflict
          </Dialog.Title>
          <Dialog.Description style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>
            Both the local and remote versions of{" "}
            <code
              style={{
                fontFamily: '"Cascadia Mono", Consolas, monospace',
                fontSize: 12,
                color: "var(--text)",
              }}
            >
              {conflict.rel_path}
            </code>{" "}
            changed since last sync. Choose how to resolve.
          </Dialog.Description>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              <strong style={{ color: "var(--text)" }}>Keep local</strong> — upload your version, discard remote changes.
            </p>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              <strong style={{ color: "var(--text)" }}>Keep remote</strong> — download Drive version, overwrite local.
            </p>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              <strong style={{ color: "var(--text)" }}>Keep both</strong> — rename local to a conflict copy, download remote.
            </p>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="secondary" onClick={() => removeConflict(conflict.pair_id, conflict.rel_path)}>
              Decide later
            </Button>
            <Button variant="secondary" onClick={() => resolve("local")}>
              Keep local
            </Button>
            <Button variant="secondary" onClick={() => resolve("remote")}>
              Keep remote
            </Button>
            <Button onClick={() => resolve("both")}>Keep both</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

