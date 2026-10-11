// Canonical request keys. Demo fixtures and the live cache are both keyed by the canonical URL,
// so the same inputs always hit the same fixture. The API key is never part of the key.

import type { Params } from "./qloo.ts";

export const QLOO_BASE = "https://hackathon.api.qloo.com";

export function canonicalUrl(path: string, params: Params, base = QLOO_BASE): string {
  const p = path.startsWith("/") ? path : "/" + path;
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k.toLowerCase(), String(v).trim()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return base.replace(/\/$/, "") + p + (qs ? "?" + qs : "");
}

// Normalize a user-typed city into "City, ST" (title-cased city, upper-cased state).
export function normalizeCity(input: string): string {
  const parts = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  const city = parts[0]
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const state = parts[1] ? parts[1].toUpperCase().slice(0, 2) : "";
  return state ? `${city}, ${state}` : city;
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Sorted, de-duplicated entity id list so comp order never changes the key.
export function idList(ids: string[]): string {
  return [...new Set(ids.map((s) => s.trim()).filter(Boolean))].sort().join(",");
}
