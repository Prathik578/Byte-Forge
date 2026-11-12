"use client";

import { useCallback, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Binary,
  Check,
  FileCode2,
  Loader2,
  LockKeyhole,
  ScanSearch,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { HexEditor } from "@/components/hex-editor";
import { discardSession, uploadFile, SessionInfo } from "@/lib/api";
import { formatBytes } from "@/lib/hex";

const highlights = [
  {
    icon: ScanSearch,
    title: "Find any byte",
    detail: "Search the whole file in hex or plain text.",
  },
  {
    icon: Binary,
    title: "Edit with precision",
    detail: "Stage byte changes, undo, and download a clean copy.",
  },
  {
    icon: LockKeyhole,
    title: "Private by design",
    detail: "In-memory sessions expire automatically.",
  },
];

export default function Home() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!file.size) {
      toast.error("Choose a file that contains data.");
      return;
    }
    setUploading(true);
    try {
      const info = await uploadFile(file);
      setSession(info);
      toast.success(`Loaded ${info.filename} · ${formatBytes(info.size)}`);
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
      // Session expiry makes cleanup best-effort.
    }
    setSession(null);
  }, [session]);

  if (session) {
    return (
      <main className="flex h-screen flex-col overflow-hidden bg-background">
        <HexEditor session={session} onDiscard={handleDiscard} />
      </main>
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden px-5 pb-12 pt-6 sm:px-8 sm:pt-8">
      <div aria-hidden="true" className="grid-noise pointer-events-none absolute inset-x-0 top-0 h-[600px]" />
      <div className="relative mx-auto max-w-6xl">
        <header className="flex items-center justify-between">
          <a href="#top" className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="ByteForge home">
            <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Binary className="size-5" aria-hidden="true" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">byteforge<span className="text-primary">.</span></span>
          </a>
          <div className="inline-flex items-center gap-2 rounded-full border bg-white/75 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm">
            <span className="size-1.5 rounded-full bg-primary" />
            Runs in a private session
          </div>
        </header>

        <section id="top" className="mx-auto flex max-w-4xl flex-col items-center pt-20 text-center sm:pt-28">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-white/80 px-3.5 py-1.5 text-xs font-medium text-primary shadow-sm">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Your files are never written to disk
          </div>
          <h1 className="max-w-3xl text-balance text-5xl font-semibold leading-[1.04] tracking-[-0.055em] sm:text-7xl">
            Get closer to
            <span className="block text-primary">every byte.</span>
          </h1>
          <p className="mt-6 max-w-xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg">
            A focused workspace for inspecting and patching binary files. Find the exact offset, make a careful change, and export when you&apos;re ready.
          </p>

          <div
            className={`mt-10 w-full max-w-2xl rounded-2xl border bg-white/90 p-3 text-left shadow-[0_24px_90px_-48px_rgba(25,50,40,0.3)] transition ${
              dragging ? "border-primary ring-4 ring-primary/10" : "border-border"
            }`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
          >
            <div className={`flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-dashed px-5 py-8 text-center transition-colors ${dragging ? "border-primary/50 bg-primary/[0.04]" : "border-border bg-[#fbfcfb]"}`}>
              <div className="mb-4 grid size-12 place-items-center rounded-2xl border bg-white text-primary shadow-sm">
                {uploading ? <Loader2 className="size-5 animate-spin" aria-hidden="true" /> : <Upload className="size-5" aria-hidden="true" />}
              </div>
              <p className="text-sm font-semibold">{uploading ? "Preparing your workspace…" : dragging ? "Drop your file to begin" : "Drop a file to inspect"}</p>
              <p className="mt-1.5 text-xs text-muted-foreground">Any file type · processed in memory · no account needed</p>
              <input
                ref={inputRef}
                type="file"
                className="sr-only"
                aria-label="Choose a binary file to inspect"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFile(file);
                  event.currentTarget.value = "";
                }}
              />
              <Button className="mt-5 gap-2 px-5" onClick={() => inputRef.current?.click()} disabled={uploading}>
                {uploading ? "Uploading file" : "Choose a file"}
                {!uploading && <ArrowRight className="size-4" aria-hidden="true" />}
              </Button>
              <p className="mt-3 text-[11px] text-muted-foreground">Your file is held temporarily and removed when the session expires.</p>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] font-medium text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><Check className="size-3.5 text-primary" /> Virtualized for large files</span>
            <span className="inline-flex items-center gap-1.5"><Check className="size-3.5 text-primary" /> Search hex and text</span>
            <span className="inline-flex items-center gap-1.5"><Check className="size-3.5 text-primary" /> Undo before saving</span>
          </div>
        </section>

        <section aria-label="Editor features" className="mx-auto mt-20 grid max-w-4xl grid-cols-1 gap-3 border-t border-border/80 pt-8 sm:grid-cols-3 sm:gap-6">
          {highlights.map(({ icon: Icon, title, detail }, index) => (
            <article key={title} className="flex gap-3 rounded-xl p-3 sm:p-2">
              <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary">
                <Icon className="size-[18px]" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-semibold">0{index + 1} <span className="ml-1 text-foreground">{title}</span></p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
              </div>
            </article>
          ))}
        </section>

        <footer className="mt-14 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <FileCode2 className="size-3.5" aria-hidden="true" />
          Inspect carefully. Change only what you intend.
          <ArrowDownToLine className="ml-1 size-3.5" aria-hidden="true" />
        </footer>
      </div>
    </main>
  );
}
