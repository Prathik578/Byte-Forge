export function toHex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

export function toHexOffset(n: number, width = 8): string {
  return n.toString(16).padStart(width, "0");
}

const PRINTABLE_RE = /^[\x20-\x7E]$/;

export function toAscii(byte: number): string {
  return PRINTABLE_RE.test(String.fromCharCode(byte))
    ? String.fromCharCode(byte)
    : ".";
}

export function parseHexByte(text: string): number | null {
  if (!/^[0-9a-fA-F]{1,2}$/.test(text)) return null;
  const value = parseInt(text, 16);
  return Number.isNaN(value) ? null : value;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
