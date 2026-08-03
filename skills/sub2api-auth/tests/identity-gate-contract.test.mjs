import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillUrl = new URL("../SKILL.md", import.meta.url);
const patternsUrl = new URL("../references/known-ui-patterns.md", import.meta.url);
const fixtureUrl = new URL(
  "./fixtures/openai-account-chooser-inherited-session.txt",
  import.meta.url,
);

test("authorization contract rejects an inherited different OpenAI identity", async () => {
  const [skill, patterns, fixture] = await Promise.all([
    readFile(skillUrl, "utf8"),
    readFile(patternsUrl, "utf8"),
    readFile(fixtureUrl, "utf8"),
  ]);

  assert.match(fixture, /选择一个帐户/);
  assert.match(fixture, /登录至另一个帐户/);
  assert.match(fixture, /source_sha256: [a-f0-9]{64}/);

  assert.match(
    skill,
    /task space isolation[^\n]*(?:does not|doesn't|不)[^\n]*(?:fresh|empty|login|登录)[^\n]*(?:session|state|态)/i,
    "SKILL.md must state that task-space isolation does not guarantee a fresh OpenAI login state",
  );
  assert.match(
    patterns,
    /(?:account chooser|账号选择器)[\s\S]{0,1200}(?:Log in to another account|登录至另一个帐户|登录另一个帐户)/i,
    "known-ui-patterns.md must route inherited account chooser state through the other-account path",
  );
  assert.match(
    patterns,
    /(?:consent|同意|授权)[\s\S]{0,1200}(?:exact|严格|精确)[^\n]*(?:match|匹配)[^\n]*(?:target|目标)[^\n]*(?:email|邮箱)/i,
    "consent must require an exact target-email match",
  );
  assert.match(
    skill,
    /(?:backend|Sub2API)[^\n]*(?:identity|身份|email|邮箱)[^\n]*(?:match|匹配)[^\n]*(?:Base|target|目标)/i,
    "activation gate must compare backend identity with the target Base record",
  );
  assert.match(skill, /test_complete[^\n]*success\s*=\s*true/i);
  assert.match(skill, /has_access_token\s*=\s*true/i);
  assert.match(skill, /has_refresh_token\s*=\s*true/i);
});
