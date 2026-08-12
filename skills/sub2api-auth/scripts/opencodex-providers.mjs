#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw new Error(`Unable to read required configuration file: ${file}`);
  }
}

function parseEnvFile(file) {
  const values = {};
  for (const rawLine of readText(file).split(/\r?\n/u)) {
    const line = rawLine.trim().replace(/^export\s+/u, "");
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function activeOpenCodexBaseUrl() {
  const config = readText(path.join(homedir(), ".codex", "config.toml"));
  let inProvider = false;
  for (const rawLine of config.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inProvider = line.slice(1, -1) === "model_providers.opencodex";
      continue;
    }
    if (!inProvider) continue;
    const match = line.match(/^base_url\s*=\s*["']([^"']+)["']/u);
    if (match) return match[1];
  }
  return null;
}

function managementEndpoint(projectEnv) {
  const configured = activeOpenCodexBaseUrl() || process.env.OCX_ADMIN_BASE || projectEnv.OCX_ADMIN_BASE;
  if (!configured) throw new Error("OpenCodex base URL is missing from ~/.codex/config.toml and OCX_ADMIN_BASE");
  const url = new URL(configured);
  url.pathname = url.pathname.replace(/\/v1\/?$/u, "").replace(/\/$/u, "") + "/api/providers";
  url.search = "";
  url.hash = "";
  if (url.protocol !== "https:") throw new Error("The public OpenCodex management probe requires HTTPS");
  return url;
}

function required(name, ...sources) {
  const value = process.env[name] || sources.map((source) => source[name]).find(Boolean);
  if (!value) throw new Error(`Required environment variable is unavailable: ${name}`);
  return value;
}

function discoverySummary(discovery) {
  if (!discovery || typeof discovery !== "object") return null;
  return {
    status: discovery.status ?? discovery.state ?? null,
    hasError: Boolean(discovery.error),
    modelCount: Array.isArray(discovery.models) ? discovery.models.length : 0,
  };
}

const projectEnv = parseEnvFile(path.join(repoRoot, ".env"));
const codexEnv = parseEnvFile(path.join(homedir(), ".codex", "secrets", "opencodex-provider.env"));
const endpoint = managementEndpoint(projectEnv);
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);

let response;
try {
  response = await fetch(endpoint, {
    method: "GET",
    redirect: "manual",
    signal: controller.signal,
    headers: {
      Accept: "application/json",
      "CF-Access-Client-Id": required("CF_ACCESS_CLIENT_ID", codexEnv),
      "CF-Access-Client-Secret": required("CF_ACCESS_CLIENT_SECRET", codexEnv),
      "x-opencodex-api-key": required("OCX_ADMIN_AUTH_TOKEN", projectEnv),
    },
  });
} catch (error) {
  if (error?.name === "AbortError") throw new Error("OpenCodex provider query timed out after 30 seconds");
  throw new Error(`OpenCodex provider query failed before an HTTP response: ${error?.message || "unknown error"}`);
} finally {
  clearTimeout(timeout);
}

const body = await response.text();
if (response.status !== 200) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  throw new Error(`OpenCodex provider query returned HTTP ${response.status}; response_sha256=${bodyHash}`);
}

let providers;
try {
  providers = JSON.parse(body);
} catch {
  throw new Error("OpenCodex provider query returned HTTP 200 with invalid JSON");
}
if (!Array.isArray(providers)) throw new Error("OpenCodex provider query returned HTTP 200 with a non-array payload");

const output = {
  endpointPath: endpoint.pathname,
  deploymentOriginRedacted: true,
  providerCount: providers.length,
  providers: providers.map((provider) => ({
    name: provider.name ?? null,
    adapter: provider.adapter ?? null,
    hasBaseUrl: Boolean(provider.baseUrl),
    defaultModel: provider.defaultModel ?? null,
    hasApiKey: Boolean(provider.hasApiKey),
    hasHeaders: Boolean(provider.hasHeaders),
    allowPrivateNetwork: Boolean(provider.allowPrivateNetwork),
    liveModels: provider.liveModels !== false,
    disabled: Boolean(provider.disabled),
    authMode: provider.authMode ?? null,
    apiKeyTransport: provider.apiKeyTransport ?? null,
    modelCount: Array.isArray(provider.models) ? provider.models.length : 0,
    discovery: discoverySummary(provider.discovery),
  })),
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
