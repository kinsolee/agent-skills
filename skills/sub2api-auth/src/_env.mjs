// Minimal .env loader. Reads KEY=VALUE lines from the project .env (gitignored)
// into a plain object. process.env takes precedence. Never prints file contents.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let cache = null;

export function readEnvFile() {
  if (cache) return cache;
  cache = {};
  const here = (() => {
    try { return fileURLToPath(import.meta.url); } catch { return null; }
  })();
  const candidates = [
    here ? path.resolve(path.dirname(here), "../../../../.env") : null,
    path.resolve(process.cwd(), ".env"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const text = readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        cache[key] = val;
      }
      break;
    } catch {
      // try next candidate
    }
  }
  return cache;
}
