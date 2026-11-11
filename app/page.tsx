"use client";

import { useCallback, useRef, useState } from "react";
import { UploadCloud, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { HexEditor } from "@/components/hex-editor";
import { discardSession, getSessionMeta, uploadFile, SessionInfo } from "@/lib/api";
import { formatBytes } from "@/lib/hex";

export default function Home() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const info = await uploadFile(file);
      setSession(info);
      toast.success(`Loaded ${info.filename} (${formatBytes(info.size)})`);
    } catch (err) {
      toast.error(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDiscard = useCallback(async () => {
    if (!session) return;
    try {
      await discardSession(session.session_id);
    } catch {
      // best effort cleanup
    }
    setSession(null);
  }, [session]);

  if (session) {
    return (
      <div className="h-screen flex flex-col">
        <HexEditor session={session} onDiscard={handleDiscard} />
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-20 flex flex-col items-center text-center">
        <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground mb-6">
          <ShieldCheck className="h-3.5 w-3.5" />
          Files are processed in memory and never stored
        </div>

        <h1 className="text-4xl font-semibold tracking-tight mb-3">
          ByteForge
        </h1>
        <p className="text-lg text-muted-foreground mb-10 max-w-xl">
          Inspect and edit any binary file directly in your browser. Upload a
          file, jump to an offset, patch bytes in hex, and download the result.
        </p>

        <div
          className={`w-full rounded-xl border-2 border-dashed p-12 transition-colors ${
            dragging
              ? "border-primary bg-primary/5"
              : "border-border hover:border-muted-foreground/40"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleFile(file);
          }}
        >
          <UploadCloud className="h-10 w-10 mx-auto text-muted-foreground mb-4" />
          <p className="text-sm text-muted-foreground mb-4">
            Drag and drop a binary file here
          </p>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = "";
            }}
          />
          <Button
            size="lg"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Uploading…
              </>
            ) : (
              "Choose a file"
            )}
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mt-14 text-sm">
          <div>
            <p className="font-medium mb-1">Virtualized hex grid</p>
            <p className="text-muted-foreground">
              Smoothly browse files of any size — only visible bytes are loaded.
            </p>
          </div>
          <div>
            <p className="font-medium mb-1">Byte-level editing</p>
            <p className="text-muted-foreground">
              Click a byte, type a new hex value, stage and save changes.
            </p>
          </div>
          <div>
            <p className="font-medium mb-1">Private by default</p>
            <p className="text-muted-foreground">
              Files live in server memory only and expire automatically.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
