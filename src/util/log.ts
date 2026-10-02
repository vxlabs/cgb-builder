/**
 * Stderr-only diagnostics. stdout is the MCP JSON-RPC channel and must never be written to.
 * Debug output is gated by CGB_DEBUG=1.
 */

const warned = new Set<string>();

export function isDebug(): boolean {
  const v = process.env.CGB_DEBUG;
  return v === '1' || v === 'true';
}

function format(scope: string, msg: string, err?: unknown): string {
  let out = `[cgb:${scope}] ${msg}`;
  if (err !== undefined) {
    const message = err instanceof Error ? err.message : String(err);
    out += `: ${message}`;
    if (isDebug() && err instanceof Error && err.stack) out += `\n${err.stack}`;
  }
  return out + '\n';
}

/** Write a diagnostic to stderr, only when CGB_DEBUG is set. */
export function debug(scope: string, msg: string, err?: unknown): void {
  if (!isDebug()) return;
  process.stderr.write(format(scope, msg, err));
}

/** Write a warning to stderr once per (scope, key) per process. */
export function warnOnce(scope: string, key: string, msg: string, err?: unknown): void {
  const id = `${scope}\u0000${key}`;
  if (warned.has(id)) return;
  warned.add(id);
  process.stderr.write(format(scope, msg, err));
}
