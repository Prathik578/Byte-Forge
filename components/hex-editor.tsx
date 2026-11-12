"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
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
  deleteBytes,
  downloadFile,
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
  const [insertValue, setInsertValue] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const editsRef = useRef<Map<number, PendingEdit>>(new Map());
  const [, forceRender] = useState(0);
  const historyRef = useRef<{ offset: number; before: number; after: number }[]>([]);
  const redoRef = useRef<{ offset: number; before: number; after: number }[]>([]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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
  }, [session.session_id, size, visibleRows.first, visibleRows.last, refreshVersion]);

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
      const rowData = rows.get(Math.floor(offset / BYTES_PER_ROW));
      const before = existing?.current ?? rowData?.[offset % BYTES_PER_ROW];
      if (before === undefined || before === value) return;
      editsRef.current.set(offset, {
        offset,
        original: existing?.original ?? before,
        current: value,
      });
      historyRef.current.push({ offset, before, after: value });
      redoRef.current = [];
      forceRender((n) => n + 1);
    },
    [rows]
  );

  const saveEdits = useCallback(async () => {
    if (editsRef.current.size === 0) return true;
    setSaving(true);
    try {
      const entries = [...editsRef.current.values()];
      // Group contiguous edits into runs
      const runs: { offset: number; bytes: number[] }[] = [];
      for (const e of entries.sort((a, b) => a.offset - b.offset)) {
        const last = runs[runs.length - 1];
        if (last && last.offset + last.bytes.length === e.offset && last.bytes.length < 65536) {
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
      setRefreshVersion((version) => version + 1);
      forceRender((n) => n + 1);
      toast.success(`Saved ${runs.length} change${runs.length === 1 ? "" : "s"}`);
      return true;
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [session.session_id]);

  const handleInsertBytes = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (editsRef.current.size > 0) {
      toast.error("Save or undo staged edits before inserting bytes.");
      return;
    }
    const compact = insertValue.replace(/\s/g, "");
    if (!compact || compact.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(compact)) {
      toast.error("Enter complete hex byte pairs, such as DE AD BE EF.");
      return;
    }
    const bytes = compact.match(/[0-9a-fA-F]{2}/g)?.map((byte) => parseInt(byte, 16)) ?? [];
    if (bytes.length > 65536) {
      toast.error("You can insert up to 65,536 bytes at a time.");
      return;
    }
    const offset = selectedOffset ?? size;
    setSaving(true);
    try {
      const result = await insertBytes(session.session_id, offset, bytes);
      setSize(result.size);
      setRows(new Map());
      setRefreshVersion((version) => version + 1);
      historyRef.current = [];
      redoRef.current = [];
      setSelectedOffset(offset);
      setInsertValue("");
      toast.success(`Inserted ${bytes.length} byte${bytes.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(`Insert failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [insertValue, selectedOffset, session.session_id, size]);

  const handleDeleteByte = useCallback(async () => {
    if (selectedOffset === null) return;
    if (editsRef.current.size > 0) {
      toast.error("Save or undo staged edits before deleting bytes.");
      return;
    }
    const offset = selectedOffset;
    setSaving(true);
    try {
      const result = await deleteBytes(session.session_id, offset, 1);
      setSize(result.size);
      setRows(new Map());
      setRefreshVersion((version) => version + 1);
      historyRef.current = [];
      redoRef.current = [];
      setSelectedOffset(result.size ? Math.min(offset, result.size - 1) : null);
      toast.success("Deleted 1 byte");
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [selectedOffset, session.session_id]);

  const undo = useCallback(() => {
    const last = historyRef.current.pop();
    if (!last) return;
    const edit = editsRef.current.get(last.offset);
    if (edit) {
      if (last.before === edit.original) editsRef.current.delete(last.offset);
      else editsRef.current.set(last.offset, { ...edit, current: last.before });
    }
    redoRef.current.push(last);
    forceRender((n) => n + 1);
  }, []);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    const edit = editsRef.current.get(next.offset);
    const rowData = rows.get(Math.floor(next.offset / BYTES_PER_ROW));
    const original = edit?.original ?? rowData?.[next.offset % BYTES_PER_ROW];
    if (original === undefined) return;
    editsRef.current.set(next.offset, { offset: next.offset, original, current: next.after });
    historyRef.current.push(next);
    forceRender((n) => n + 1);
  }, [rows]);

  const handleDownload = useCallback(async () => {
    if (editsRef.current.size > 0) {
      const saved = await saveEdits();
      if (!saved) return;
    }
    setSaving(true);
    try {
      await downloadFile(session.session_id, filename);
      toast.success("Download started");
    } catch (err) {
      toast.error(`Download failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [saveEdits, session.session_id, filename]);

  const handleGoTo = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const offsetText = goto.trim().replace(/^0x/i, "");
      if (size === 0) {
        toast.error("This file does not contain any bytes yet.");
        return;
      }
      if (!/^[0-9a-f]+$/i.test(offsetText)) {
        toast.error("Enter a valid hex offset like 1A2B");
        return;
      }
      const value = parseInt(offsetText, 16);
      const clamped = Math.min(value, size - 1);
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
      const query = search.trim();
      if (!query) return;
      const hexQuery = query.replace(/^0x/i, "");
      const compactHex = hexQuery.replace(/\s/g, "");
      const isHexQuery = /^0x/i.test(query) || (/^[0-9a-fA-F\s]+$/.test(query) && compactHex.length % 2 === 0);
      if (isHexQuery && compactHex.length % 2 !== 0) {
        toast.error("Hex searches must contain complete byte pairs, such as 0xDE AD.");
        return;
      }
      const bytes = isHexQuery
        ? (compactHex.match(/[0-9a-fA-F]{2}/g) || []).map((value) => parseInt(value, 16))
        : Array.from(new TextEncoder().encode(query));
      if (!bytes.length) return;
      if (bytes.length > 65536) {
        toast.error("Search values are limited to 65,536 bytes.");
        return;
      }

      const prefix = new Array(bytes.length).fill(0);
      for (let index = 1, matched = 0; index < bytes.length; index++) {
        while (matched > 0 && bytes[index] !== bytes[matched]) matched = prefix[matched - 1];
        if (bytes[index] === bytes[matched]) matched++;
        prefix[index] = matched;
      }
      let matched = 0;
      for (let offset = 0; offset < size; offset += 65536) {
        try {
          const chunk = await readChunk(session.session_id, offset, Math.min(65536, size - offset));
          for (const [editOffset, edit] of editsRef.current) {
            if (editOffset >= offset && editOffset < offset + chunk.length) {
              chunk[editOffset - offset] = edit.current;
            }
          }
          for (let index = 0; index < chunk.length; index++) {
            while (matched > 0 && chunk[index] !== bytes[matched]) matched = prefix[matched - 1];
            if (chunk[index] === bytes[matched]) matched++;
            if (matched === bytes.length) {
              const found = offset + index + 1 - bytes.length;
              const rowKey = Math.floor(found / BYTES_PER_ROW);
              const viewport = scrollRef.current?.querySelector(
                "[data-radix-scroll-area-viewport]"
              ) as HTMLDivElement | null;
              if (viewport) viewport.scrollTop = Math.max(0, rowKey * ROW_HEIGHT - 200);
              setSelectedOffset(found);
              toast.success(`Found at offset ${toHexOffset(found)}`);
              return;
            }
          }
        } catch (err) {
          toast.error(`Search failed: ${(err as Error).message}`);
          return;
        }
      }
      toast.error("No match found in this file");
    },
    [search, session.session_id, size]
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
            aria-label="Go to hexadecimal offset"
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
            aria-label="Search the entire file in hexadecimal or text"
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
          disabled={historyRef.current.length === 0}
          aria-label="Undo last byte edit"
        >
          <Undo2 className="h-4 w-4 mr-1" /> Undo
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8"
          onClick={redo}
          disabled={redoRef.current.length === 0}
          aria-label="Redo byte edit"
        >
          <Redo2 className="h-4 w-4 mr-1" /> Redo
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
        <ResizablePanelGroup direction={isMobile ? "vertical" : "horizontal"}>
          <ResizablePanel defaultSize={isMobile ? 55 : 65} minSize={isMobile ? 35 : 40}>
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
                        <div aria-label="ASCII preview" className="ml-3 flex shrink-0 border-l pl-3 font-mono text-muted-foreground">
                          {Array.from({ length: BYTES_PER_ROW }, (_, col) => {
                            const off = rowOffset + col;
                            if (off >= size) return null;
                            const value = getByte(row, col);
                            return <span key={col} className="w-[0.65rem] text-center">{value === null ? "·" : toAscii(value)}</span>;
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
          <ResizablePanel defaultSize={isMobile ? 45 : 35} minSize={20}>
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
                      if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
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

              <form onSubmit={handleInsertBytes} className="flex flex-col gap-2 border-t pt-4">
                <label htmlFor="insert-bytes" className="text-sm font-medium">Insert bytes</label>
                <Input
                  id="insert-bytes"
                  value={insertValue}
                  onChange={(event) => setInsertValue(event.target.value.replace(/[^0-9a-fA-F\s]/g, ""))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                      event.preventDefault();
                      void handleInsertBytes(event);
                    }
                  }}
                  placeholder="DE AD BE EF"
                  className="font-mono text-xs"
                  aria-describedby="insert-bytes-help"
                />
                <p id="insert-bytes-help" className="text-[11px] text-muted-foreground">
                  Inserts at the selected offset, or at the end of the file.
                </p>
                <Button type="submit" size="sm" variant="outline" disabled={saving || !insertValue.trim()}>
                  Insert bytes
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={handleDeleteByte}
                  disabled={saving || selectedOffset === null || size === 0}
                >
                  Delete selected byte
                </Button>
              </form>

              <div className="text-xs leading-5 text-muted-foreground">
                Byte edits are staged until Save. Insert and delete apply immediately to the temporary server copy.
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
