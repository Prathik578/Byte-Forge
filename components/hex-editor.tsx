"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Download,
  FileWarning,
  Loader2,
  LogOut,
  Redo2,
  Search,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  downloadFile,
  getSessionMeta,
  insertBytes,
  readChunk,
  writeBytes,
  SessionInfo,
} from "@/lib/api";
import { formatBytes, toAscii, toHex, toHexOffset } from "@/lib/hex";

const ROW_HEIGHT = 22;
const BYTES_PER_ROW = 16;
const VIEWPORT_ROWS = 40;
const CHUNK = 4096;
const CACHE_ROWS = 256; // rows held in memory around viewport

interface PendingEdit {
  offset: number;
  original: number;
  current: number;
}

interface HexEditorProps {
  session: SessionInfo;
  onDiscard: () => void;
}

export function HexEditor({ session, onDiscard }: HexEditorProps) {
  const [size, setSize] = useState(session.size);
  const [filename, setFilename] = useState(session.filename);
  const [rows, setRows] = useState<Map<number, Uint8Array>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [selectedOffset, setSelectedOffset] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [goto, setGoto] = useState("");
  const [search, setSearch] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const editsRef = useRef<Map<number, PendingEdit>>(new Map());
  const [, forceRender] = useState(0);
  const historyRef = useRef<{ offset: number; original: number }[]>([]);
  const redoRef = useRef<{ offset: number; value: number }[]>([]);

  const totalRows = Math.ceil(size / BYTES_PER_ROW);

  const visibleRows = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4);
    const last = Math.min(totalRows, first + VIEWPORT_ROWS + 8);
    return { first, last };
  }, [scrollTop, totalRows]);

  // Load rows around viewport
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const startRow = Math.floor(visibleRows.first * BYTES_PER_ROW / CHUNK) * CHUNK;
      const endByte = Math.min(size, (visibleRows.last + 1) * BYTES_PER_ROW);
      const newRows = new Map<number, Uint8Array>();
      for (let off = startRow; off < endByte; off += CHUNK) {
        const rowKey = Math.floor(off / BYTES_PER_ROW);
        if (rows.has(rowKey)) continue;
        const len = Math.min(CHUNK, size - off);
        try {
          const data = await readChunk(session.session_id, off, len);
          if (cancelled) return;
          for (let i = 0; i < data.length; i += BYTES_PER_ROW) {
            newRows.set(
              Math.floor((off + i) / BYTES_PER_ROW),
              data.slice(i, Math.min(i + BYTES_PER_ROW, data.length))
            );
          }
        } catch (err) {
          if (!cancelled) toast.error(`Failed to load data: ${(err as Error).message}`);
          return;
        }
      }
      if (cancelled || newRows.size === 0) return;
      setRows((prev) => {
        const merged = new Map(prev);
        for (const [k, v] of newRows) merged.set(k, v);
        // Trim far-away rows
        if (merged.size > CACHE_ROWS * 2) {
          const center = visibleRows.first;
          for (const key of merged.keys()) {
            if (Math.abs(key - center) > CACHE_ROWS) merged.delete(key);
          }
        }
        return merged;
      });
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.session_id, size, visibleRows.first, visibleRows.last]);

  const getByte = useCallback(
    (row: number, col: number): number | null => {
      const rowKey = row;
      const data = rows.get(rowKey);
      if (!data) return null;
      const off = row * BYTES_PER_ROW + col;
      const edit = editsRef.current.get(off);
      if (edit) return edit.current;
      return off - row * BYTES_PER_ROW < data.length ? data[col] : null;
    },
    [rows]
  );

  const applyEdit = useCallback(
    (offset: number, value: number) => {
      const existing = editsRef.current.get(offset);
      if (!existing) {
        const rowKey = Math.floor(offset / BYTES_PER_ROW);
        const rowData = rows.get(rowKey);
        const col = offset % BYTES_PER_ROW;
        const original = rowData ? rowData[col] : 0;
        editsRef.current.set(offset, { offset, original, current: value });
        historyRef.current.push({ offset, original });
      } else {
        existing.current = value;
        editsRef.current.set(offset, existing);
      }
      redoRef.current = [];
      forceRender((n) => n + 1);
    },
    [rows]
  );

  const saveEdits = useCallback(async () => {
    if (editsRef.current.size === 0) return;
    setSaving(true);
    try {
      const entries = [...editsRef.current.values()];
      // Group contiguous edits into runs
      const runs: { offset: number; bytes: number[] }[] = [];
      for (const e of entries.sort((a, b) => a.offset - b.offset)) {
        const last = runs[runs.length - 1];
        if (last && last.offset + last.bytes.length === e.offset) {
          last.bytes.push(e.current);
        } else {
          runs.push({ offset: e.offset, bytes: [e.current] });
        }
      }
      for (const run of runs) {
        await writeBytes(session.session_id, run.offset, run.bytes);
      }
      editsRef.current.clear();
      historyRef.current = [];
      redoRef.current = [];
      setRows(new Map());
      forceRender((n) => n + 1);
      toast.success(`Saved ${runs.length} change${runs.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [session.session_id]);

  const undo = useCallback(async () => {
    const last = historyRef.current.pop();
    if (!last) return;
    const edit = editsRef.current.get(last.offset);
    if (edit) editsRef.current.delete(last.offset);
    redoRef.current.push({ offset: last.offset, value: edit?.current ?? 0 });
    forceRender((n) => n + 1);
  }, []);

  const handleDownload = useCallback(async () => {
    setSaving(true);
    try {
      await downloadFile(session.session_id, filename);
      toast.success("Download started");
    } catch (err) {
      toast.error(`Download failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [session.session_id, filename]);

  const handleGoTo = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const value = parseInt(goto.replace(/^(0x)/i, ""), 16);
      if (Number.isNaN(value)) {
        toast.error("Enter a valid hex offset like 1A2B");
        return;
      }
      const clamped = Math.min(value, Math.max(0, size - 1));
      const row = Math.floor(clamped / BYTES_PER_ROW);
      const viewport = scrollRef.current?.querySelector(
        "[data-radix-scroll-area-viewport]"
      ) as HTMLDivElement | null;
      if (viewport) {
        viewport.scrollTop = Math.max(0, row * ROW_HEIGHT - 200);
      }
      setSelectedOffset(clamped);
    },
    [goto, size]
  );

  const handleSearch = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const q = search.trim();
      if (!q) return;
      // Search the loaded cache for hex or ASCII match
      const hex = /^[0-9a-fA-F\s]+$/.test(q) && q.replace(/\s/g, "").length % 2 === 0
        ? (q.match(/[0-9a-fA-F]{2}/g) || []).map((h) => parseInt(h, 16))
        : [...q].map((c) => c.charCodeAt(0));

      const allRows = [...rows.entries()].sort((a, b) => a[0] - b[0]);
      for (const [rowKey, data] of allRows) {
        outer: for (let i = 0; i < data.length; i++) {
          for (let j = 0; j < hex.length; j++) {
            if (data[i + j] !== hex[j]) continue outer;
          }
          const found = rowKey * BYTES_PER_ROW + i;
          const viewport = scrollRef.current?.querySelector(
            "[data-radix-scroll-area-viewport]"
          ) as HTMLDivElement | null;
          if (viewport) {
            viewport.scrollTop = Math.max(0, rowKey * ROW_HEIGHT - 200);
          }
          setSelectedOffset(found);
          toast.success(`Found at offset ${toHexOffset(found)}`);
          return;
        }
      }
      toast.error("Not found in the loaded region");
    },
    [search, rows]
  );

  const commitEdit = useCallback(() => {
    if (selectedOffset === null || !editingValue) return;
    const value = parseInt(editingValue, 16);
    if (Number.isNaN(value) || value < 0 || value > 255) {
      toast.error("Enter a hex value 00-FF");
      return;
    }
    applyEdit(selectedOffset, value);
    setEditingValue("");
    const next = selectedOffset + 1;
    if (next < size) setSelectedOffset(next);
  }, [selectedOffset, editingValue, applyEdit, size]);

  const rowNumbers: number[] = [];
  for (let r = visibleRows.first; r < visibleRows.last; r++) rowNumbers.push(r);

  const dirtyCount = editsRef.current.size;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-2">
        <div className="flex items-center gap-2 min-w-0 mr-2">
          <span className="font-mono text-sm font-medium truncate max-w-[220px]">
            {filename}
          </span>
          <span className="text-xs text-muted-foreground">{formatBytes(size)}</span>
          {dirtyCount > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <FileWarning className="h-3 w-3" />
              {dirtyCount} unsaved
            </span>
          )}
        </div>

        <form onSubmit={handleGoTo} className="flex items-center gap-1">
          <Input
            value={goto}
            onChange={(e) => setGoto(e.target.value)}
            placeholder="Go to offset…"
            className="h-8 w-40 font-mono text-xs"
          />
          <Button type="submit" size="sm" variant="ghost" className="h-8 px-2">
            <ChevronDown className="h-4 w-4" />
          </Button>
        </form>

        <form onSubmit={handleSearch} className="flex items-center gap-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find hex or text…"
            className="h-8 w-44 font-mono text-xs"
          />
          <Button type="submit" size="sm" variant="ghost" className="h-8 px-2">
            <Search className="h-4 w-4" />
          </Button>
        </form>

        <div className="flex-1" />

        <Button
          size="sm"
          variant="ghost"
          className="h-8"
          onClick={undo}
          disabled={dirtyCount === 0}
        >
          <Undo2 className="h-4 w-4 mr-1" /> Undo
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8"
          onClick={saveEdits}
          disabled={saving || dirtyCount === 0}
        >
          {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Redo2 className="h-4 w-4 mr-1" />}
          Save
        </Button>
        <Button
          size="sm"
          className="h-8"
          onClick={handleDownload}
          disabled={saving}
        >
          <Download className="h-4 w-4 mr-1" /> Download
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          onClick={onDiscard}
        >
          <LogOut className="h-4 w-4 mr-1" /> Close
        </Button>
      </div>

      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={65} minSize={40}>
            <ScrollArea
              ref={scrollRef}
              className="h-full w-full"
              onScrollCapture={(e: React.UIEvent<HTMLDivElement>) => {
                const viewport = e.currentTarget.querySelector(
                  "[data-radix-scroll-area-viewport]"
                ) as HTMLDivElement | null;
                if (viewport) setScrollTop(viewport.scrollTop);
              }}
            >
              <div data-viewport>
                <div style={{ height: totalRows * ROW_HEIGHT, position: "relative" }}>
                  {rowNumbers.map((row) => {
                    const rowOffset = row * BYTES_PER_ROW;
                    return (
                      <div
                        key={row}
                        className="absolute left-0 right-0 flex items-center font-mono text-xs select-none"
                        style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT }}
                      >
                        <span className="text-muted-foreground pr-4 pl-2 w-28 text-right shrink-0">
                          {toHexOffset(rowOffset)}
                        </span>
                        <div className="flex gap-0">
                          {Array.from({ length: BYTES_PER_ROW }, (_, col) => {
                            const off = rowOffset + col;
                            if (off >= size) {
                              return (
                                <span key={col} className="w-7 shrink-0" />
                              );
                            }
                            const value = getByte(row, col);
                            const edited = editsRef.current.has(off);
                            const isSelected = selectedOffset === off;
                            return (
                              <button
                                key={col}
                                type="button"
                                className="w-7 shrink-0 text-center rounded-sm cursor-pointer hover:bg-accent focus:outline-none"
                                style={{
                                  color: edited
                                    ? "hsl(38 92% 50%)"
                                    : value === null
                                    ? "transparent"
                                    : undefined,
                                  backgroundColor: isSelected
                                    ? "hsl(var(--primary) / 0.15)"
                                    : undefined,
                                  outline: isSelected
                                    ? "1px solid hsl(var(--primary))"
                                    : undefined,
                                }}
                                onClick={() => {
                                  setSelectedOffset(off);
                                  setEditingValue("");
                                }}
                                tabIndex={0}
                              >
                                {value === null ? (
                                  "··"
                                ) : (
                                  toHex(value)
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </ScrollArea>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={35} minSize={20}>
            <div className="h-full flex flex-col p-4 gap-4 overflow-auto">
              <div>
                <h3 className="text-sm font-medium mb-2">Selected byte</h3>
                {selectedOffset !== null ? (
                  <dl className="space-y-1 font-mono text-xs">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Offset (hex)</dt>
                      <dd>{toHexOffset(selectedOffset)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Offset (dec)</dt>
                      <dd>{selectedOffset}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Value</dt>
                      <dd>
                        {(() => {
                          const edit = editsRef.current.get(selectedOffset);
                          if (edit) return `${toHex(edit.current)} (edited)`;
                          const rowKey = Math.floor(selectedOffset / BYTES_PER_ROW);
                          const data = rows.get(rowKey);
                          if (!data) return "loading…";
                          const v = data[selectedOffset % BYTES_PER_ROW];
                          return v === undefined ? "—" : toHex(v);
                        })()}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Click a byte to inspect and edit it.
                  </p>
                )}
              </div>

              {selectedOffset !== null && (
                <div>
                  <label className="text-sm font-medium mb-1 block">
                    New value (hex)
                  </label>
                  <Input
                    value={editingValue}
                    onChange={(e) =>
                      setEditingValue(e.target.value.replace(/[^0-9a-fA-F]/g, ""))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitEdit();
                      }
                    }}
                    placeholder="00–FF"
                    className="font-mono"
                    maxLength={2}
                  />
                  <Button
                    size="sm"
                    className="mt-2 w-full"
                    onClick={commitEdit}
                    disabled={!editingValue}
                  >
                    Stage change
                  </Button>
                </div>
              )}

              <div className="text-xs text-muted-foreground space-y-1">
                <p>
                  Edits are staged in the browser and applied to the file on the
                  server when you press Save. Download gives you the modified
                  file.
                </p>
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
