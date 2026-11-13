"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Download,
  FileWarning,
  Loader2,
  LogOut,
  Redo2,
  Search,
  Save,
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
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
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
const CACHE_BYTES_PER_ROW = 16;
const VIEWPORT_ROWS = 40;
const ROWS_PER_PAGE = 1000;
const CHUNK = 4096;
const CACHE_ROWS = 256; // rows held in memory around viewport

function byteTypeColor(value: number): string {
  if (value === 0) return "text-muted-foreground";
  if (value === 0x09 || value === 0x0a || value === 0x0d || value === 0x20) return "text-sky-700";
  if (value >= 0x21 && value <= 0x7e) return "text-emerald-700";
  if (value < 0x20 || value === 0x7f) return "text-amber-700";
  return "text-violet-700";
}

interface PendingEdit {
  offset: number;
  original: number;
  current: number;
}

interface HexEditorProps {
  session: SessionInfo;
  onDiscard: () => void;
  initialOffset?: number;
}

export function HexEditor({ session, onDiscard, initialOffset }: HexEditorProps) {
  const [size, setSize] = useState(session.size);
  const [filename, setFilename] = useState(session.filename);
  const [rows, setRows] = useState<Map<number, Uint8Array>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [pageStartRow, setPageStartRow] = useState(0);
  const [bytesPerRow, setBytesPerRow] = useState(16);
  const [searchMode, setSearchMode] = useState<"hex" | "text">("hex");
  const [colorCoding, setColorCoding] = useState(true);
  const [bookmarks, setBookmarks] = useState<number[]>([]);
  const [bookmarkSelection, setBookmarkSelection] = useState("");
  const [searchMatchOffset, setSearchMatchOffset] = useState<number | null>(null);
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
  const initialOffsetHandledRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const totalRows = Math.ceil(size / bytesPerRow);
  const pageRowCount = Math.min(ROWS_PER_PAGE, Math.max(0, totalRows - pageStartRow));
  const totalPages = Math.max(1, Math.ceil(totalRows / ROWS_PER_PAGE));
  const currentPage = Math.floor(pageStartRow / ROWS_PER_PAGE);

  const visibleRows = useMemo(() => {
    const first = pageStartRow + Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4);
    const last = Math.min(pageStartRow + pageRowCount, first + VIEWPORT_ROWS + 8);
    return { first, last };
  }, [pageRowCount, pageStartRow, scrollTop]);

  useEffect(() => {
    const viewport = scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLDivElement | null;
    if (viewport && viewport.scrollTop !== scrollTop) viewport.scrollTop = scrollTop;
  }, [pageStartRow, scrollTop]);

  // Load rows around viewport
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const startRow = Math.floor(visibleRows.first * bytesPerRow / CHUNK) * CHUNK;
      const endByte = Math.min(size, visibleRows.last * bytesPerRow);
      const newRows = new Map<number, Uint8Array>();
      for (let off = startRow; off < endByte; off += CHUNK) {
        const rowKey = Math.floor(off / CACHE_BYTES_PER_ROW);
        if (rows.has(rowKey)) continue;
        const len = Math.min(CHUNK, size - off);
        try {
          const data = await readChunk(session.session_id, off, len);
          if (cancelled) return;
          for (let i = 0; i < data.length; i += CACHE_BYTES_PER_ROW) {
            newRows.set(
              Math.floor((off + i) / CACHE_BYTES_PER_ROW),
              data.slice(i, Math.min(i + CACHE_BYTES_PER_ROW, data.length))
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
          const center = Math.floor(visibleRows.first * bytesPerRow / CACHE_BYTES_PER_ROW);
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
  }, [session.session_id, size, visibleRows.first, visibleRows.last, bytesPerRow, refreshVersion]);

  const getByte = useCallback(
    (offset: number): number | null => {
      const rowKey = Math.floor(offset / CACHE_BYTES_PER_ROW);
      const col = offset % CACHE_BYTES_PER_ROW;
      const data = rows.get(rowKey);
      if (!data) return null;
      const edit = editsRef.current.get(offset);
      if (edit) return edit.current;
      return col < data.length ? data[col] : null;
    },
    [rows]
  );

  const moveToOffset = useCallback((offset: number) => {
    const row = Math.floor(offset / bytesPerRow);
    const nextPageStart = Math.floor(row / ROWS_PER_PAGE) * ROWS_PER_PAGE;
    setPageStartRow(nextPageStart);
    setScrollTop(Math.max(0, (row - nextPageStart) * ROW_HEIGHT - 200));
    setSelectedOffset(offset);
  }, [bytesPerRow]);

  useEffect(() => {
    if (initialOffset === undefined || size === 0 || initialOffsetHandledRef.current === initialOffset) return;
    initialOffsetHandledRef.current = initialOffset;
    moveToOffset(Math.min(initialOffset, size - 1));
  }, [initialOffset, moveToOffset, size]);

  const changeBytesPerRow = useCallback((width: number) => {
    if (width === bytesPerRow) return;
    setBytesPerRow(width);
    setRows(new Map());
    setRefreshVersion((version) => version + 1);
    const row = selectedOffset === null ? 0 : Math.floor(selectedOffset / width);
    const nextPageStart = Math.floor(row / ROWS_PER_PAGE) * ROWS_PER_PAGE;
    setPageStartRow(nextPageStart);
    setScrollTop(Math.max(0, (row - nextPageStart) * ROW_HEIGHT - 200));
  }, [bytesPerRow, selectedOffset]);

  const addBookmark = useCallback(() => {
    if (selectedOffset === null) {
      toast.error("Select a byte before adding a bookmark.");
      return;
    }
    setBookmarks((current) => [...new Set([...current, selectedOffset])].sort((a, b) => a - b));
    setBookmarkSelection(String(selectedOffset));
    toast.success(`Bookmarked ${toHexOffset(selectedOffset)}`);
  }, [selectedOffset]);

  const copyPermalink = useCallback(async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("session", session.session_id);
    if (selectedOffset !== null) url.searchParams.set("offset", toHexOffset(selectedOffset));
    try {
      await navigator.clipboard.writeText(url.toString());
      toast.success("Permalink copied");
    } catch {
      toast.error("Could not copy the permalink in this browser.");
    }
  }, [selectedOffset, session.session_id]);

  const changePage = useCallback((nextPage: number) => {
    const lastPage = Math.max(0, Math.ceil(totalRows / ROWS_PER_PAGE) - 1);
    const page = Math.max(0, Math.min(lastPage, nextPage));
    setPageStartRow(page * ROWS_PER_PAGE);
    setScrollTop(0);
  }, [totalRows]);

  const applyEdit = useCallback(
    (offset: number, value: number) => {
      const existing = editsRef.current.get(offset);
      const rowData = rows.get(Math.floor(offset / CACHE_BYTES_PER_ROW));
      const before = existing?.current ?? rowData?.[offset % CACHE_BYTES_PER_ROW];
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
      moveToOffset(offset);
      setInsertValue("");
      toast.success(`Inserted ${bytes.length} byte${bytes.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(`Insert failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [insertValue, moveToOffset, selectedOffset, session.session_id, size]);

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
      if (result.size > 0) moveToOffset(Math.min(offset, result.size - 1));
      else setSelectedOffset(null);
      toast.success("Deleted 1 byte");
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [moveToOffset, selectedOffset, session.session_id]);

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
    const rowData = rows.get(Math.floor(next.offset / CACHE_BYTES_PER_ROW));
    const original = edit?.original ?? rowData?.[next.offset % CACHE_BYTES_PER_ROW];
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

  const handleExportAsCode = useCallback(async () => {
    const startOffset = pageStartRow * bytesPerRow;
    const endOffset = Math.min(size, (pageStartRow + pageRowCount) * bytesPerRow);
    const bytes: number[] = [];
    try {
      for (let offset = startOffset; offset < endOffset; offset += 65536) {
        const chunk = await readChunk(session.session_id, offset, Math.min(65536, endOffset - offset));
        for (const [editOffset, edit] of editsRef.current) {
          if (editOffset >= offset && editOffset < offset + chunk.length) {
            chunk[editOffset - offset] = edit.current;
          }
        }
        for (const byte of chunk) bytes.push(byte);
      }
      const sourceRows: string[] = [];
      for (let index = 0; index < bytes.length; index += 16) {
        sourceRows.push(`  ${bytes.slice(index, index + 16).map((byte) => `0x${toHex(byte)}`).join(", ")}`);
      }
      const source = `export const startOffset = 0x${toHexOffset(startOffset)};\nexport const bytes = new Uint8Array([\n${sourceRows.join(",\n")}\n]);\n`;
      const blob = new Blob([source], { type: "text/typescript" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${filename.replace(/\.[^.]+$/, "")}-page-${currentPage + 1}.ts`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported page ${currentPage + 1} as TypeScript`);
    } catch (err) {
      toast.error(`Code export failed: ${(err as Error).message}`);
    }
  }, [bytesPerRow, currentPage, filename, pageRowCount, pageStartRow, session.session_id, size]);

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
      setSearchMatchOffset(null);
      moveToOffset(clamped);
    },
    [goto, moveToOffset, size]
  );

  const handleSearch = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const query = search.trim();
      if (!query) return;
      const compactHex = query.replace(/^0x/i, "").replace(/\s/g, "");
      if (searchMode === "hex" && (!compactHex || compactHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(compactHex))) {
        toast.error("Hex searches must contain complete byte pairs, such as DE AD BE EF.");
        return;
      }
      const bytes = searchMode === "hex"
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
              setSearchMatchOffset(found);
              moveToOffset(found);
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
    [moveToOffset, search, searchMode, session.session_id, size]
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

        <div role="group" aria-label="Bytes per row" className="flex items-center gap-1">
          <span className="mr-1 text-xs text-muted-foreground">Bytes per row</span>
          {[8, 16, 32].map((width) => (
            <Button
              key={width}
              type="button"
              size="sm"
              variant={bytesPerRow === width ? "default" : "outline"}
              className="h-8 px-3"
              aria-pressed={bytesPerRow === width}
              onClick={() => changeBytesPerRow(width)}
            >
              {width}
            </Button>
          ))}
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
          <select
            aria-label="Search mode"
            value={searchMode}
            onChange={(event) => setSearchMode(event.target.value as "hex" | "text")}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="hex">Hex</option>
            <option value="text">Text</option>
          </select>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={`Search file as ${searchMode}`}
            placeholder={searchMode === "hex" ? "e.g. DE AD BE EF" : "Search text…"}
            className="h-8 w-44 font-mono text-xs"
          />
          <Button type="submit" size="sm" variant="ghost" className="h-8 px-2">
            <Search className="h-4 w-4" />
          </Button>
        </form>

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1"
          onClick={addBookmark}
          disabled={selectedOffset === null}
        >
          <BookmarkPlus className="size-4" /> Add Bookmark
        </Button>
        {bookmarks.length > 0 && (
          <select
            aria-label="Jump to bookmark"
            value={bookmarkSelection}
            onChange={(event) => {
              setBookmarkSelection(event.target.value);
              moveToOffset(Number(event.target.value));
            }}
            className="h-8 max-w-40 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="" disabled>Bookmarks</option>
            {bookmarks.map((offset) => (
              <option key={offset} value={offset}>{toHexOffset(offset)}</option>
            ))}
          </select>
        )}

        {totalRows > ROWS_PER_PAGE && (
          <div role="group" aria-label="Large file pages" className="flex h-8 items-center gap-1 rounded-md border px-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-1.5"
              aria-label="Previous row page"
              onClick={() => changePage(currentPage - 1)}
              disabled={currentPage === 0}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span aria-live="polite" className="whitespace-nowrap px-1 text-[11px] text-muted-foreground">
              Page {currentPage + 1} of {totalPages}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-1.5"
              aria-label="Next row page"
              onClick={() => changePage(currentPage + 1)}
              disabled={currentPage + 1 >= totalPages}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        )}

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
          {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
          Save
        </Button>
        <Button
          size="sm"
          className="h-8"
          onClick={handleDownload}
          disabled={saving}
        >
          <Download className="h-4 w-4 mr-1" /> Export Modified
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={handleExportAsCode}>
          <Code2 className="mr-1 size-4" /> Export as Code
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={copyPermalink} disabled={selectedOffset === null}>
          <Copy className="mr-1 size-4" /> Copy Permalink
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
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex flex-col gap-2 border-b bg-background px-3 py-2 text-[11px] sm:px-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="mr-1 text-sm font-semibold text-foreground">Hex View</span>
                <span className="font-medium text-muted-foreground">Selection legend</span>
                <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-amber-500" />Modified</span>
                <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-emerald-500" />Search</span>
                <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-primary" />Selection</span>
                <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-fuchsia-500" />Bookmark</span>
                <Button type="button" size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" aria-pressed={colorCoding} onClick={() => setColorCoding((enabled) => !enabled)}>
                  Color coding: {colorCoding ? "On" : "Off"}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                <span className="font-medium">Byte types</span>
                <span><span className="font-mono text-muted-foreground">00</span> Null</span>
                <span><span className="font-mono text-emerald-700">41</span> Printable</span>
                <span><span className="font-mono text-amber-700">1F</span> Control</span>
                <span><span className="font-mono text-sky-700">0A</span> Whitespace</span>
                <span><span className="font-mono text-violet-700">FF</span> Extended</span>
              </div>
            </div>
            <ScrollArea
              ref={scrollRef}
              className="min-h-0 w-full flex-1"
              onScrollCapture={(e: React.UIEvent<HTMLDivElement>) => {
                const viewport = e.currentTarget.querySelector(
                  "[data-radix-scroll-area-viewport]"
                ) as HTMLDivElement | null;
                if (viewport) setScrollTop(viewport.scrollTop);
              }}
            >
              <div data-viewport>
                <div style={{ height: pageRowCount * ROW_HEIGHT, position: "relative" }}>
                  {rowNumbers.map((row) => {
                    const rowOffset = row * bytesPerRow;
                    return (
                      <div
                        key={row}
                        className="absolute left-0 right-0 flex items-center font-mono text-xs select-none"
                        style={{ top: (row - pageStartRow) * ROW_HEIGHT, height: ROW_HEIGHT }}
                      >
                        <span className="text-muted-foreground pr-4 pl-2 w-28 text-right shrink-0">
                          {toHexOffset(rowOffset)}
                        </span>
                        <div className="flex gap-0">
                          {Array.from({ length: bytesPerRow }, (_, col) => {
                            const off = rowOffset + col;
                            if (off >= size) {
                              return (
                                <span key={col} className="w-7 shrink-0" />
                              );
                            }
                            const value = getByte(off);
                            const edited = editsRef.current.has(off);
                            const isSelected = selectedOffset === off;
                            const isSearchMatch = searchMatchOffset === off;
                            const isBookmarked = bookmarks.includes(off);
                            return (
                              <button
                                key={col}
                                type="button"
                                aria-label={`Offset ${toHexOffset(off)}, byte ${value === null ? "loading" : toHex(value)}`}
                                className={cn(
                                  "w-7 shrink-0 rounded-sm text-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                                  value === null && "text-transparent",
                                  edited ? "font-semibold text-amber-700" : colorCoding && value !== null ? byteTypeColor(value) : "text-foreground"
                                )}
                                style={{
                                  backgroundColor: isSearchMatch
                                    ? "hsl(151 60% 42% / 0.16)"
                                    : isSelected
                                    ? "hsl(var(--primary) / 0.15)"
                                    : undefined,
                                  outline: isSelected
                                    ? "1px solid hsl(var(--primary))"
                                    : undefined,
                                  boxShadow: isBookmarked
                                    ? "inset 0 -2px hsl(300 70% 55%)"
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
                          {Array.from({ length: bytesPerRow }, (_, col) => {
                            const off = rowOffset + col;
                            if (off >= size) return null;
                            const value = getByte(off);
                            const edited = editsRef.current.has(off);
                            return (
                              <span
                                key={col}
                                className={cn(
                                  "w-[0.65rem] text-center",
                                  edited ? "font-semibold text-amber-700" : colorCoding && value !== null ? byteTypeColor(value) : "text-foreground"
                                )}
                              >
                                {value === null ? "·" : toAscii(value)}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </div>
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
                          const value = getByte(selectedOffset);
                          return value === null ? "loading…" : toHex(value);
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
