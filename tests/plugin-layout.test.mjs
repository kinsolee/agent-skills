import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("marketplace export is self-contained and excludes local runtime files", (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "plugin-layout-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const destination = path.join(temp, "marketplace");
  const result = spawnSync("python3", [path.join(root, "scripts/export-marketplace.py"), destination], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const marketplace = JSON.parse(readFileSync(path.join(destination, ".agents/plugins/marketplace.json")));
  assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name), ["sub2api-auth", "wechat-draft-publisher", "codex-task-management"]);
  for (const plugin of marketplace.plugins) {
    const pluginRoot = path.resolve(destination, plugin.source.path);
    const manifest = JSON.parse(readFileSync(path.join(pluginRoot, ".codex-plugin/plugin.json")));
    assert.equal(manifest.name, plugin.name);
    assert.equal(plugin.policy.installation, "AVAILABLE");
    assert.match(readFileSync(path.join(pluginRoot, "skills", plugin.name, "SKILL.md"), "utf8"), /^---\nname:/);
  }
  const report = JSON.parse(readFileSync(path.join(destination, "export-manifest.json")));
  assert.ok(Object.keys(report.files).includes("plugins/sub2api-auth/src/sub2api-monitor.mjs"));
  assert.ok(Object.keys(report.files).every((name) => !/(^|\/)(\.env|state|node_modules|accounts-temp\.txt)(\/|$)/.test(name)));
  // Import-only checks must never invoke lark-cli, a browser, or an API.
  const guard = path.join(temp, "guard.mjs");
  writeFileSync(guard, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
cp.execFileSync = cp.spawnSync = () => { throw new Error('unexpected external process'); };
syncBuiltinESMExports(); globalThis.fetch = () => { throw new Error('unexpected network'); };`);
  const skill = path.join(destination, "plugins/sub2api-auth/skills/sub2api-auth");
  for (const relative of ["scripts/flow-email-otp.mjs", "scripts/opencodex-account.mjs", "src/sub2api-admin-api.mjs"]) {
    const imported = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e",
      `await import(${JSON.stringify(pathToFileURL(path.join(skill, relative)).href)}); console.log('import-ok');`], { encoding: "utf8" });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout.trim(), "import-ok");
  }
  // Synthetic config verifies the plugin-root lookup without reading real secrets.
  const envRoot = path.join(temp, "env-plugin");
  const moduleDir = path.join(envRoot, "skills/example/src");
  mkdirSync(moduleDir, { recursive: true });
  copyFileSync(path.join(skill, "src/_env.mjs"), path.join(moduleDir, "_env.mjs"));
  writeFileSync(path.join(envRoot, ".env"), "PLUGIN_LAYOUT_TEST=synthetic\n");
  const envResult = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { readEnvFile } from ${JSON.stringify(pathToFileURL(path.join(moduleDir, "_env.mjs")).href)};
if (readEnvFile().PLUGIN_LAYOUT_TEST !== 'synthetic') process.exit(1);`], { cwd: temp, encoding: "utf8" });
  assert.equal(envResult.status, 0, envResult.stderr);
});

test("legacy skill paths still execute their CLI entry points", () => {
  const commands = [
    ["sub2api-auth", "scripts/flow-email-otp.mjs", [], 2, /usage: flow-email-otp/],
    ["sub2api-auth", "scripts/opencodex-account.mjs", [], 2, /usage:/],
    ["sub2api-auth", "src/sub2api-admin-api.mjs", [], 2, /usage: sub2api-admin-api/],
    ["wechat-draft-publisher", "scripts/wechat_draft.mjs", ["--help"], 0, /draft/],
  ];
  for (const [name, relative, args, code, output] of commands) {
    const legacy = path.join(root, "skills", name, relative);
    assert.equal(realpathSync(legacy), path.join(root, "plugins", name, "skills", name, relative));
    const result = spawnSync(process.execPath, [legacy, ...args], { encoding: "utf8" });
    assert.equal(result.status, code, result.stderr);
    assert.match(result.stdout + result.stderr, output);
  }
});
