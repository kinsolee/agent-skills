import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBrowserOutcome,
  normalizeObservedHelperPayload,
  selectChallengeOtp,
} from "../scripts/flow-email-otp.mjs";

const strictSender = ["notice", "openai.com"].join("@");
const target = "account@example.com";
const challengeStartedAtMs = 1_700_000_000_000;

function message(overrides = {}) {
  return {
    sender: strictSender,
    recipient: target,
    recipientProvided: true,
    receivedAtMs: challengeStartedAtMs + 1_000,
    code: "123456",
    ...overrides,
  };
}

test("email OTP selector accepts one strictly bound challenge message", () => {
  assert.deepEqual(
    selectChallengeOtp([message()], { targetEmail: target, challengeStartedAtMs }),
    { ok: true, code: "123456", receivedAtMs: challengeStartedAtMs + 1_000 },
  );
});

test("email OTP selector rejects stale, wrong-recipient, and untrusted-sender mail", () => {
  const cases = [
    message({ receivedAtMs: challengeStartedAtMs }),
    message({ recipient: "other@example.com" }),
    message({ sender: "notice@example.com" }),
  ];
  for (const candidate of cases) {
    assert.equal(
      selectChallengeOtp([candidate], { targetEmail: target, challengeStartedAtMs }).ok,
      false,
    );
  }
});

test("email OTP selector rejects missing timestamps and multiple current codes", () => {
  assert.deepEqual(
    selectChallengeOtp([message({ receivedAtMs: null })], { targetEmail: target, challengeStartedAtMs }),
    { ok: false, reason: "insufficient_timestamp_metadata" },
  );
  assert.deepEqual(
    selectChallengeOtp([message({ recipient: null, recipientProvided: false })], { targetEmail: target, challengeStartedAtMs }),
    { ok: false, reason: "insufficient_recipient_metadata" },
  );
  assert.deepEqual(
    selectChallengeOtp([
      message({ code: "123456", receivedAtMs: challengeStartedAtMs + 2_000 }),
      message({ code: "654321", receivedAtMs: challengeStartedAtMs + 1_000 }),
    ], { targetEmail: target, challengeStartedAtMs }),
    { ok: false, reason: "ambiguous_challenge_codes" },
  );
});

test("observed helper adapter fails closed without evidenced time metadata", () => {
  const normalized = normalizeObservedHelperPayload({
    ok: true,
    mails: [{ from: strictSender, verificationCode: "123456" }],
  });
  assert.equal(normalized[0].receivedAtMs, null);
  assert.deepEqual(
    selectChallengeOtp(normalized, { targetEmail: target, challengeStartedAtMs }),
    { ok: false, reason: "insufficient_timestamp_metadata" },
  );
});

test("email OTP browser completion requires a confirmed transition", () => {
  assert.equal(classifyBrowserOutcome("EMAIL_OTP_OUTCOME=transitioned", 0), "transitioned");
  for (const outcome of [
    "no_email_otp_tab",
    "no_code_input",
    "no_form",
    "submit_error",
    "still_email_otp",
  ]) {
    assert.notEqual(classifyBrowserOutcome(`EMAIL_OTP_OUTCOME=${outcome}`, 0), "transitioned");
  }
  assert.equal(classifyBrowserOutcome("EMAIL_OTP_OUTCOME=transitioned", 1), "browser_process_failed");
});
