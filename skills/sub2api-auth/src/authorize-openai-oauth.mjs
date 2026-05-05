#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const DEFAULTS = {
  adminUrl: "http://192.168.1.49:8080/admin/accounts",
  platform: "OpenAI",
  accountType: "Oauth",
  group: "openai",
  adminEmail: "",
  adminPassword: "",
  forceProxy: true,
  callbackPort: 18765,
  browserProfile: ".browser-profile",
  slowMo: 80,
  headless: false,
  keepOpenOnFail: false,
  perAccountTimeoutMs: 8 * 60 * 1000,
  camofoxUrl: "http://localhost:9377",
  useCamofox: true
};

const BACKUP_FILE = ".reauth-backup.txt";

function saveBackup(email, rawLine) {
  try {
    let existing = "";
    try { existing = fsSync.readFileSync(BACKUP_FILE, "utf-8"); } catch {}
    if (existing.includes(email)) return;
    fsSync.appendFileSync(BACKUP_FILE, rawLine.trim() + "\n");
    log(email, `credentials backed up to ${BACKUP_FILE}`);
  } catch {}
}

function removeBackup(email) {
  try {
    let existing = "";
    try { existing = fsSync.readFileSync(BACKUP_FILE, "utf-8"); } catch {}
    if (!existing) return;
    const lines = existing.split("\n").filter(l => l.trim() && !l.includes(email));
    if (lines.length === 0) {
      fsSync.unlinkSync(BACKUP_FILE);
    } else {
      fsSync.writeFileSync(BACKUP_FILE, lines.join("\n") + "\n");
    }
  } catch {}
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

await loadDotEnv(args.env || ".env");

const config = {
  adminUrl: args["admin-url"] || env("SUB2API_ADMIN_URL", DEFAULTS.adminUrl),
  platform: args.platform || env("SUB2API_PLATFORM", DEFAULTS.platform),
  accountType: args["account-type"] || env("SUB2API_ACCOUNT_TYPE", DEFAULTS.accountType),
  group: args.group || env("SUB2API_GROUP", DEFAULTS.group),
  adminEmail: args["admin-email"] || env("SUB2API_ADMIN_EMAIL", DEFAULTS.adminEmail),
  adminPassword: args["admin-password"] || env("SUB2API_ADMIN_PASSWORD", DEFAULTS.adminPassword),
  forceProxy: booleanArg(args["force-proxy"] ?? env("SUB2API_FORCE_PROXY"), DEFAULTS.forceProxy),
  callbackPort: numberArg(args["callback-port"], env("SUB2API_CALLBACK_PORT"), DEFAULTS.callbackPort),
  browserProfile: args.profile || env("SUB2API_BROWSER_PROFILE", DEFAULTS.browserProfile),
  slowMo: numberArg(args["slow-mo"], env("SUB2API_SLOW_MO"), DEFAULTS.slowMo),
  headless: booleanArg(args.headless ?? env("SUB2API_HEADLESS"), DEFAULTS.headless),
  keepOpenOnFail: booleanArg(args["keep-open-on-fail"] ?? env("SUB2API_KEEP_OPEN_ON_FAIL"), DEFAULTS.keepOpenOnFail),
  debug: booleanArg(args.debug ?? env("SUB2API_DEBUG"), false),
  perAccountTimeoutMs: numberArg(args.timeout, env("SUB2API_ACCOUNT_TIMEOUT_MS"), DEFAULTS.perAccountTimeoutMs),
  camofoxUrl: args["camofox-url"] || env("SUB2API_CAMOFOX_URL", DEFAULTS.camofoxUrl),
  useCamofox: booleanArg(args["use-camofox"] ?? env("SUB2API_USE_CAMOFOX"), DEFAULTS.useCamofox)
};

const checkRevoked = booleanArg(args["check-revoked"], false);
const accounts = checkRevoked ? [] : await readAccounts(args);
if (!accounts.length && !checkRevoked) {
  fail("No accounts found. Pass --accounts accounts.txt or --one 'email@example.com ---- remark'.");
}

let camofoxProcess = null;
if (config.useCamofox) {
  const healthy = await camofoxHealthCheck(config.camofoxUrl).catch(() => false);
  if (!healthy) {
    log("camofox-browser server not reachable, starting it...");
    camofoxProcess = await startCamofoxServer();
    let retries = 30;
    while (retries-- > 0) {
      if (await camofoxHealthCheck(config.camofoxUrl).catch(() => false)) break;
      await sleep(1000);
    }
    if (retries <= 0) {
      fail("camofox-browser server did not start in time. Start it manually: cd node_modules/@askjo/camofox-browser && node server.js");
    }
  }
  log(`camofox-browser server ready at ${config.camofoxUrl}`);
}

const context = await chromium.launchPersistentContext(path.resolve(config.browserProfile), {
  channel: "chrome",
  headless: config.headless,
  slowMo: config.slowMo,
  viewport: { width: 1440, height: 1000 }
});

const summary = [];

try {
  // --check-revoked mode: scan admin page for revoked tokens and re-authorize
  if (checkRevoked) {
    const scanPage = await context.newPage();
    let accountsToReauth = [];

    try {
      log("scanning admin page for revoked accounts...");
      await scanPage.goto(config.adminUrl, { waitUntil: "domcontentloaded" });
      await waitForSettled(scanPage);
      await ensureAdminPage(scanPage, config);
      await waitForPageContent(scanPage);
      await dismissGuides(scanPage);
      await closeOpenDialogs(scanPage);

      const allAccounts = await scanAllAccountStatuses(scanPage);
      const revoked = allAccounts.filter(a => a.isRevoked);
      log(`scan complete: ${allAccounts.length} accounts found, ${revoked.length} with revoked/error status`);

      for (const r of revoked) {
        log(`  revoked: ${r.email} (status: ${r.status})`);
      }

      // Get credentials from "备注" field in edit dialog (no accounts.txt needed)
      for (const r of revoked) {
        const remark = await getAccountRemark(scanPage, r.email);
        if (remark && remark.includes("----")) {
          try {
            const account = parseAccount(remark);
            accountsToReauth.push(account);
            log(`  parsed credentials for ${account.email} from remark`);
          } catch (e) {
            log(`  warning: could not parse remark for ${r.email}: ${e.message}`);
          }
        } else {
          log(`  warning: no valid remark/credentials found for ${r.email}`);
        }
      }
    } finally {
      await safeClose(scanPage);
    }

    if (!accountsToReauth.length) {
      log("no revoked accounts to re-authorize");
    } else {
      log(`re-authorizing ${accountsToReauth.length} revoked accounts...`);
      for (const account of accountsToReauth) {
        logStep(account.email, "re-authorizing revoked account");
        const adminPage = await context.newPage();
        let keepAdminPageOpen = false;
        try {
          const result = await reauthorizeAccountFlow(adminPage, account, config);
          summary.push(result);
          keepAdminPageOpen = config.keepOpenOnFail && !result.ok;
          if (result.ok) removeBackup(account.email);
          logStep(account.email, result.ok ? `re-auth success: ${result.status || "normal"}` : `re-auth failed: ${result.reason}`);
        } catch (error) {
          summary.push({ email: account.email, ok: false, reason: errorMessage(error) });
          keepAdminPageOpen = config.keepOpenOnFail;
          logStep(account.email, `re-auth failed: ${errorMessage(error)}`);
        } finally {
          if (!keepAdminPageOpen) await safeClose(adminPage);
        }
      }
    }
  } else {
    // Normal mode: authorize all accounts from accounts.txt
    for (const account of accounts) {
    logStep(account.email, "starting");
    const adminPage = await context.newPage();
    let keepAdminPageOpen = false;
    try {
      const result = await addAccountFlow(adminPage, account, config);
      summary.push(result);
      keepAdminPageOpen = config.keepOpenOnFail && !result.ok;
      if (result.ok) removeBackup(account.email);
      logStep(account.email, result.ok ? `success: ${result.status || "normal"}` : `failed: ${result.reason}`);
    } catch (error) {
      summary.push({ email: account.email, ok: false, reason: errorMessage(error) });
      keepAdminPageOpen = config.keepOpenOnFail;
      logStep(account.email, `failed: ${errorMessage(error)}`);
    } finally {
      if (!keepAdminPageOpen) await safeClose(adminPage);
    }
  }
  } // end else (normal mode)
} finally {
  if (config.keepOpenOnFail && summary.some((item) => !item.ok)) {
    log("keeping browser open because at least one account failed. Press Ctrl+C when you are done inspecting it.");
    await waitForInterrupt();
  }
  await context.close();
  if (camofoxProcess) {
    log("stopping camofox-browser server...");
    camofoxProcess.kill("SIGTERM");
  }
}

printSummary(summary);
process.exit(summary.every((item) => item.ok) ? 0 : 1);

async function addAccountFlow(page, account, config) {
  await page.goto(config.adminUrl, { waitUntil: "domcontentloaded" });
  await waitForSettled(page);
  await ensureAdminPage(page, config);
  await waitForPageContent(page);
  await dismissGuides(page);
  await closeOpenDialogs(page);

  // Check if account already exists - delete and re-add with fresh authorization
  const existing = await searchAndFindAccountRow(page, account.email);
  if (existing) {
    logStep(account.email, "account already exists, deleting and re-adding");
    saveBackup(account.email, account.raw);
    await deleteExistingAccount(page, account);
    // Reload page to reflect deletion
    await page.goto(config.adminUrl, { waitUntil: "domcontentloaded" });
    await waitForSettled(page);
    await ensureAdminPage(page, config);
    await waitForPageContent(page);
    await dismissGuides(page);
    await closeOpenDialogs(page);
    // Verify deletion worked
    const stillExists = await searchAndFindAccountRow(page, account.email);
    if (stillExists) {
      logStep(account.email, "WARNING: account still exists after deletion, retrying delete");
      await deleteExistingAccount(page, account);
      await page.goto(config.adminUrl, { waitUntil: "domcontentloaded" });
      await waitForSettled(page);
      await ensureAdminPage(page, config);
      await waitForPageContent(page);
      await dismissGuides(page);
      await closeOpenDialogs(page);
    }
  }

  await clickByText(page, ["添加账号", "新增账号", "Add Account", "Add account", "New Account", "Create"], "add account button");
  await waitForSettled(page);
  let form = await activeDialog(page);
  await debugDialog(form, config, "after open add account dialog");

  await fillDialogControl(page, ["请输入账号名称", "账号名称", "Name", "Account Name"], account.email);
  await fillDialogControl(page, ["请输入备注", "备注", "Remark", "Notes", "Description"], account.raw);

  debugStep(config, "selecting platform");
  await clickPlatformButton(page, config.platform);
  await debugDialog(await activeDialog(page), config, "after platform click");
  await waitForDialogText(page, ["ChatGPT OAuth", "Responses API"], 8000);
  debugStep(config, "confirming account type");
  await ensureOauthAccountType(page, config);
  form = await activeDialog(page);
  if (config.forceProxy) {
    debugStep(config, "selecting proxy");
    await chooseAnyProxy(page, form, account);
  }
  debugStep(config, "selecting group");
  await selectGroup(page, form, config.group);

  debugStep(config, "clicking next");
  await clickDialogText(page, ["下一步", "Next"], "next button");
  await waitForSettled(page);
  form = await activeDialog(page);
  await debugDialog(form, config, "after next");

  debugStep(config, "generating auth link");
  await clickDialogButtonTextDom(page, ["生成授权链接", "Generate authorization link", "Generate Auth Link", "授权链接"], "generate auth link button", { exact: false });
  await waitForSettled(page);
  await debugAuthorizationState(page, config, "after auth link click");
  let authUrl = await waitForAuthorizationUrl(page, 30000, config);
  if (!authUrl) {
    debugStep(config, "retrying auth link generation");
    const retried = await clickDialogButtonTextDomIfPresent(
      page,
      ["重新生成", "生成授权链接", "Generate authorization link", "Generate Auth Link", "授权链接"],
      { exact: false }
    );
    if (retried) {
      await waitForSettled(page);
      await debugAuthorizationState(page, config, "after auth link retry");
      authUrl = await waitForAuthorizationUrl(page, 30000, config);
    }
  }
  if (!authUrl) {
    await debugAuthorizationState(page, config, "auth link not found");
    throw new Error("Could not find generated authorization URL on the page.");
  }

  const callbackServer = await startCallbackServerForAuthUrl(authUrl, config);
  let callbackUrl = "";
  try {
    console.log("");
    console.log(`[${account.email}] Authorization page opened.`);

    if (config.useCamofox) {
      const cfTab = await cfCreateTab(config.camofoxUrl, account.email, "openai-auth", authUrl);
      const cfTabId = cfTab.tabId;
      try {
        console.log(`[${account.email}] Automating OpenAI login via camofox-browser...`);
        const loginResult = await automateOpenAILoginCamofox(config.camofoxUrl, cfTabId, account, config, context);
        if (loginResult && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(loginResult)) {
          callbackUrl = loginResult;
          console.log(`[${account.email}] Callback URL captured during login automation.`);
        } else {
          console.log(`[${account.email}] Waiting for the localhost callback URL...`);
          callbackUrl = await waitForCamofoxCallback(config.camofoxUrl, cfTabId, callbackServer, config.perAccountTimeoutMs, account.email);
        }
      } catch (loginError) {
        console.log(`[${account.email}] Login automation failed (${errorMessage(loginError)}). Please complete login manually.`);
        callbackUrl = await waitForCamofoxCallback(config.camofoxUrl, cfTabId, callbackServer, config.perAccountTimeoutMs, account.email);
      } finally {
        await cfCloseTab(config.camofoxUrl, cfTabId, account.email).catch(() => {});
      }
    } else {
      const authPage = await page.context().newPage();
      let keepAuthPageOpen = false;
      try {
        await authPage.goto(authUrl, { waitUntil: "domcontentloaded" });
        try {
          console.log(`[${account.email}] Automating OpenAI login...`);
          await automateOpenAILogin(authPage, account, config, context);
        } catch (loginError) {
          console.log(`[${account.email}] Login automation failed (${errorMessage(loginError)}). Please complete login manually.`);
        }
        const callbackPromise = waitForCallback(authPage, callbackServer, config.perAccountTimeoutMs);
        console.log(`[${account.email}] Waiting for the localhost callback URL...`);
        callbackUrl = await callbackPromise;
      } finally {
        keepAuthPageOpen = config.keepOpenOnFail && !callbackUrl;
        if (!keepAuthPageOpen) await safeClose(authPage);
      }
    }
  } finally {
    await callbackServer?.close?.();
  }

  await page.bringToFront();
  form = await activeDialog(page);
  logStep(account.email, `submitting callback URL: ${callbackUrl.slice(0, 100)}...`);
  logStep(account.email, `dialog available: ${!!form}`);
  if (form) {
    const dialogText = await form.evaluate(el => el.innerText?.slice(0, 800) || "").catch(() => "");
    logStep(account.email, `dialog text before submit: ${dialogText.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  await fillDialogControl(page, ["授权链接或 Code", "授权链接", "Code", "Authorization", "Callback"], callbackUrl);
  logStep(account.email, `callback URL filled into dialog`);

  // Verify the callback URL was actually filled in
  const filledValue = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')].find((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!dialog) return "no dialog";
    const inputs = [...dialog.querySelectorAll("input, textarea")].filter(n => !["radio", "checkbox", "hidden"].includes(n.type));
    return inputs.map(n => `${n.placeholder || n.name || "unnamed"}="${n.value?.slice(0, 60)}"`).join("; ");
  }).catch(() => "eval failed");
  logStep(account.email, `dialog input values: ${filledValue}`);

  await clickDialogText(page, ["完成授权", "Finish", "完成", "Submit", "Confirm"], "finish authorization button", { exact: false });
  logStep(account.email, `finish authorization button clicked`);
  await waitForSettled(page);
  await sleep(3000);

  // Check for errors or success after clicking
  const postSubmitText = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || "").catch(() => "");
  logStep(account.email, `post-submit page text: ${postSubmitText.replace(/\s+/g, " ").slice(0, 800)}`);

  // Check if dialog is still open (indicates error)
  try {
    const postDialog = await activeDialog(page);
    if (postDialog) {
      const dialogText = await postDialog.evaluate(el => el.innerText?.slice(0, 500) || "").catch(() => "");
      logStep(account.email, `dialog still open after submit: ${dialogText.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  } catch {
    logStep(account.email, `dialog closed after submit (likely success)`);
  }

  // Also check for any error toast/notification
  const errorToast = await page.evaluate(() => {
    const toasts = document.querySelectorAll('.toast, .notification, .ant-message, .el-message, [class*="error"], [class*="toast"]');
    return [...toasts].map(t => t.textContent?.trim()).filter(Boolean).join(" | ");
  }).catch(() => "");
  if (errorToast) logStep(account.email, `error notification: ${errorToast}`);

  await page.goto(config.adminUrl, { waitUntil: "domcontentloaded" });
  await waitForSettled(page);
  await waitForPageContent(page);
  await sleep(2000);

  // Scroll through the account list to ensure all items are loaded (handles virtual scrolling)
  await page.evaluate(() => {
    const scrollContainer = document.querySelector('.el-table__body-wrapper, .ant-table-body, .v-data-table__wrapper, [class*="table"] [class*="scroll"], [class*="virtual"]');
    if (scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    } else {
      window.scrollTo(0, document.body.scrollHeight);
    }
  }).catch(() => {});
  await sleep(1000);

  // Also try using the search/filter to find the specific account
  const searchInput = page.locator('input[placeholder*="搜索"], input[placeholder*="搜索"], input[placeholder*="Search"], input[placeholder*="名称"]').first();
  if ((await searchInput.count()) > 0) {
    await searchInput.fill(account.email);
    await sleep(1500);
    await waitForSettled(page);
  }

  const status = await verifyAccountStatus(page, account.email);
  logStep(account.email, `verify result: found=${status.found} normal=${status.normal} status=${status.status}`);

  if (!status.found) {
    return { email: account.email, ok: false, reason: "account not found in list after authorization" };
  }

  if (!status.normal) {
    return { email: account.email, ok: false, reason: `account found but status is ${status.status || "unknown"}` };
  }

  return { email: account.email, ok: true, status: status.status || "正常" };
}

async function reauthorizeAccountFlow(page, account, config) {
  // Re-authorize an existing account via "更多" → "重新授权" (no deletion needed)
  await page.goto(config.adminUrl, { waitUntil: "domcontentloaded" });
  await waitForSettled(page);
  await ensureAdminPage(page, config);
  await waitForPageContent(page);
  await dismissGuides(page);
  await closeOpenDialogs(page);

  // Search for the account
  const row = await searchAndFindAccountRow(page, account.email);
  if (!row) {
    return { email: account.email, ok: false, reason: "account not found in list" };
  }

  // Remove overlays
  await page.evaluate(() => {
    document.querySelectorAll('.driver-overlay, .driver-popover, [class*="driver-"]').forEach(el => el.remove());
  }).catch(() => {});

  // Click "更多" (More) dropdown button in the operations column
  const moreBtn = row.locator('button:has-text("更多"), button:has-text("More")').first();
  if ((await moreBtn.count()) === 0) {
    return { email: account.email, ok: false, reason: "could not find '更多' button" };
  }
  await moreBtn.click({ force: true });
  await sleep(1000);

  // Click "重新授权" (Re-authorize) from the dropdown
  const reauthBtn = page.locator('text=重新授权, text=Re-authorize, text=Reauthorize, [class*="dropdown"] >> text=重新授权').first();
  const reauthClicked = await page.evaluate(() => {
    const items = document.querySelectorAll('.el-dropdown-menu__item, .dropdown-item, [class*="dropdown"] li, [class*="popover"] *');
    for (const item of items) {
      const text = item.textContent?.trim();
      if (text === '重新授权' || text === 'Re-authorize' || text === 'Reauthorize') {
        item.click();
        return text;
      }
    }
    return null;
  });
  if (!reauthClicked) {
    // Fallback: try playwright locator
    const fallbackBtn = page.locator('.el-dropdown-menu__item:has-text("重新授权"), .dropdown-item:has-text("重新授权")').first();
    if ((await fallbackBtn.count()) > 0) {
      await fallbackBtn.click({ force: true });
    } else {
      return { email: account.email, ok: false, reason: "could not find '重新授权' option in dropdown" };
    }
  }
  logStep(account.email, "clicked 重新授权 from dropdown");
  await waitForSettled(page);
  await sleep(2000);

  // Wait for authorization dialog and generate auth link
  let form = await activeDialog(page);
  if (!form) {
    return { email: account.email, ok: false, reason: "authorization dialog did not open" };
  }

  debugStep(config, "generating auth link for re-authorization");
  await clickDialogButtonTextDom(page, ["生成授权链接", "Generate authorization link", "Generate Auth Link", "授权链接"], "generate auth link button", { exact: false });
  await waitForSettled(page);
  await debugAuthorizationState(page, config, "after auth link click");
  let authUrl = await waitForAuthorizationUrl(page, 30000, config);
  if (!authUrl) {
    debugStep(config, "retrying auth link generation");
    const retried = await clickDialogButtonTextDomIfPresent(
      page,
      ["重新生成", "生成授权链接", "Generate authorization link", "Generate Auth Link", "授权链接"],
      { exact: false }
    );
    if (retried) {
      await waitForSettled(page);
      await debugAuthorizationState(page, config, "after auth link retry");
      authUrl = await waitForAuthorizationUrl(page, 30000, config);
    }
  }
  if (!authUrl) {
    await debugAuthorizationState(page, config, "auth link not found");
    throw new Error("Could not find generated authorization URL on the page.");
  }

  // OAuth flow (same as addAccountFlow from here)
  const callbackServer = await startCallbackServerForAuthUrl(authUrl, config);
  let callbackUrl = "";
  try {
    console.log("");
    console.log(`[${account.email}] Authorization page opened.`);

    if (config.useCamofox) {
      const cfTab = await cfCreateTab(config.camofoxUrl, account.email, "openai-auth", authUrl);
      const cfTabId = cfTab.tabId;
      try {
        console.log(`[${account.email}] Automating OpenAI login via camofox-browser...`);
        const loginResult = await automateOpenAILoginCamofox(config.camofoxUrl, cfTabId, account, config, page.context());
        if (loginResult && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(loginResult)) {
          callbackUrl = loginResult;
          console.log(`[${account.email}] Callback URL captured during login automation.`);
        } else {
          console.log(`[${account.email}] Waiting for the localhost callback URL...`);
          callbackUrl = await waitForCamofoxCallback(config.camofoxUrl, cfTabId, callbackServer, config.perAccountTimeoutMs, account.email);
        }
      } catch (loginError) {
        console.log(`[${account.email}] Login automation failed (${errorMessage(loginError)}). Please complete login manually.`);
        callbackUrl = await waitForCamofoxCallback(config.camofoxUrl, cfTabId, callbackServer, config.perAccountTimeoutMs, account.email);
      } finally {
        await cfCloseTab(config.camofoxUrl, cfTabId, account.email).catch(() => {});
      }
    }
  } finally {
    await callbackServer?.close?.();
  }

  // Submit callback URL
  await page.bringToFront();
  form = await activeDialog(page);
  logStep(account.email, `submitting callback URL: ${callbackUrl.slice(0, 100)}...`);
  if (form) {
    const dialogText = await form.evaluate(el => el.innerText?.slice(0, 800) || "").catch(() => "");
    logStep(account.email, `dialog text before submit: ${dialogText.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  await fillDialogControl(page, ["授权链接或 Code", "授权链接", "Code", "Authorization", "Callback"], callbackUrl);
  logStep(account.email, `callback URL filled into dialog`);

  const filledValue = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')].find((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!dialog) return "no dialog";
    const inputs = [...dialog.querySelectorAll("input, textarea")].filter(n => !["radio", "checkbox", "hidden"].includes(n.type));
    return inputs.map(n => `${n.placeholder || n.name || "unnamed"}="${n.value?.slice(0, 60)}"`).join("; ");
  }).catch(() => "eval failed");
  logStep(account.email, `dialog input values: ${filledValue}`);

  await clickDialogText(page, ["完成授权", "Finish", "完成", "Submit", "Confirm"], "finish authorization button", { exact: false });
  logStep(account.email, `finish authorization button clicked`);
  await waitForSettled(page);
  await sleep(3000);

  const postSubmitText = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || "").catch(() => "");
  logStep(account.email, `post-submit page text: ${postSubmitText.replace(/\s+/g, " ").slice(0, 800)}`);

  try {
    const postDialog = await activeDialog(page);
    if (postDialog) {
      const dialogText = await postDialog.evaluate(el => el.innerText?.slice(0, 500) || "").catch(() => "");
      logStep(account.email, `dialog still open after submit: ${dialogText.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  } catch {}

  // Verify result
  await page.goto(config.adminUrl, { waitUntil: "domcontentloaded" });
  await waitForSettled(page);
  await waitForPageContent(page);
  await sleep(2000);

  const searchInput = page.locator('input[placeholder*="搜索"], input[placeholder*="Search"], input[placeholder*="名称"]').first();
  if ((await searchInput.count()) > 0) {
    await searchInput.fill(account.email);
    await sleep(1500);
    await waitForSettled(page);
  }

  const status = await verifyAccountStatus(page, account.email);
  logStep(account.email, `verify result: found=${status.found} normal=${status.normal} status=${status.status}`);

  if (!status.found) {
    return { email: account.email, ok: false, reason: "account not found after re-authorization" };
  }
  if (!status.normal) {
    return { email: account.email, ok: false, reason: `account found but status is ${status.status || "unknown"}` };
  }
  return { email: account.email, ok: true, status: status.status || "正常" };
}

async function ensureAdminPage(page, config) {
  if (!isLoginPage(page)) return;

  if (config.adminEmail && config.adminPassword) {
    log("sub2api admin login page detected; signing in with configured admin credentials.");
    await fillField(page, ["邮箱", "Email", "账号", "Username"], config.adminEmail);
    await fillField(page, ["密码", "Password"], config.adminPassword);
    await clickByText(page, ["登录", "Sign in", "Login"], "sub2api login button");
    await page.waitForURL((url) => !/\/login\b/i.test(url.pathname), { timeout: 30000 }).catch(() => {});
    await waitForSettled(page);
  } else {
    log("sub2api admin login page detected.");
    log("Please sign in manually in the opened browser window; automation will continue afterward.");
    await page.waitForURL((url) => !/\/login\b/i.test(url.pathname), { timeout: 10 * 60 * 1000 });
    await waitForSettled(page);
  }

  if (!page.url().includes("/admin/accounts")) {
    await page.goto(config.adminUrl, { waitUntil: "domcontentloaded" });
    await waitForSettled(page);
  }

  if (isLoginPage(page)) {
    throw new Error("Still on sub2api login page after login attempt.");
  }
}

function isLoginPage(page) {
  return /\/login\b/i.test(new URL(page.url()).pathname);
}

async function activeDialog(page) {
  const dialogs = page.locator('[role="dialog"], .modal-overlay, .modal');
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const count = await dialogs.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 20); index += 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const text = await dialog.innerText().catch(() => "");
      if (/添加账号|授权|账号名称|OpenAI|Claude/.test(text)) return dialog;
    }
    await page.waitForTimeout(200);
  }
  throw new Error("Could not find visible add-account dialog.");
}

async function debugDialog(scope, config, label) {
  if (!config.debug) return;
  const text = await scope.innerText().catch(() => "");
  const buttons = await scope
    .locator("button, input, textarea, select, [role='button'], [role='combobox']")
    .evaluateAll((nodes) =>
      nodes.slice(0, 80).map((node) => ({
        tag: node.tagName,
        text: (node.innerText || node.textContent || "").trim(),
        placeholder: node.getAttribute("placeholder"),
        type: node.getAttribute("type"),
        role: node.getAttribute("role"),
        className: String(node.className || "").slice(0, 80)
      }))
    )
    .catch((error) => [{ error: String(error) }]);
  console.log(`[debug] ${label}`);
  console.log(`[debug] dialog text: ${text.slice(0, 1200).replace(/\s+/g, " ")}`);
  console.log(`[debug] controls: ${JSON.stringify(buttons)}`);
}

async function dismissGuides(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .evaluate(() => {
      for (const selector of [".driver-overlay", ".driver-popover", ".driver-stage", ".driver-active-element"]) {
        for (const element of document.querySelectorAll(selector)) element.remove();
      }
      document.documentElement.classList.remove("driver-active");
      document.body.classList.remove("driver-active");
      document.body.style.pointerEvents = "";
    })
    .catch(() => {});
}

async function closeOpenDialogs(page) {
  await page
    .evaluate(() => {
      for (const dialog of document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')) {
        const rect = dialog.getBoundingClientRect();
        const style = window.getComputedStyle(dialog);
        if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") continue;
        const close = dialog.querySelector('button[aria-label="Close modal"], button[aria-label="关闭"], button[title="Close"]');
        if (close) close.click();
      }
    })
    .catch(() => {});
  await page.waitForTimeout(300);
}

async function fillField(page, labels, value) {
  const exact = labels.map(escapeForRegex).join("|");
  const labelRe = new RegExp(`^(${exact})\\s*[:：]?$`, "i");

  const byLabel = page.getByLabel(labelRe);
  if (await exactlyOne(byLabel)) {
    await safeFill(byLabel, value);
    return;
  }

  for (const label of labels) {
    const locator = page.locator(`xpath=//*[normalize-space()="${label}" or contains(normalize-space(), "${label}")]/following::*[self::input or self::textarea][1]`);
    if (await exactlyOne(locator)) {
      await safeFill(locator, value);
      return;
    }
  }

  const placeholder = page.getByPlaceholder(new RegExp(labels.map(escapeForRegex).join("|"), "i"));
  if (await exactlyOne(placeholder)) {
    await safeFill(placeholder, value);
    return;
  }

  throw new Error(`Could not find field: ${labels.join(" / ")}`);
}

async function fillScopedField(scope, labels, value) {
  const exact = labels.map(escapeForRegex).join("|");
  const byLabel = scope.getByLabel(new RegExp(`^(${exact})\\s*[:：]?$`, "i"));
  if (await exactlyOne(byLabel)) {
    await safeFill(byLabel, value);
    return;
  }

  for (const label of labels) {
    const locator = scope.locator(`xpath=.//*[normalize-space()="${label}" or contains(normalize-space(), "${label}")]/following::*[self::input or self::textarea][1]`);
    if (await exactlyOne(locator)) {
      await safeFill(locator, value);
      return;
    }
  }

  const placeholder = scope.getByPlaceholder(new RegExp(labels.map(escapeForRegex).join("|"), "i"));
  if (await exactlyOne(placeholder)) {
    await safeFill(placeholder, value);
    return;
  }

  throw new Error(`Could not find field: ${labels.join(" / ")}`);
}

async function fillDialogControl(page, labels, value) {
  const filled = await page
    .evaluate(
      (payload) => {
        const dialog = [...document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')].find((node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
        if (!dialog) return false;

        const normalize = (input) => String(input || "").replace(/\s+/g, " ").trim().toLowerCase();
        const setValue = (node) => {
          const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value");
          if (descriptor?.set) descriptor.set.call(node, payload.value);
          else node.value = payload.value;
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };

        const controls = [...dialog.querySelectorAll("input, textarea")].filter((node) => !["radio", "checkbox", "hidden"].includes(node.type));
        for (const label of payload.labels) {
          const wanted = normalize(label);
          for (const node of controls) {
            if (normalize(node.getAttribute("placeholder")) === wanted) return setValue(node);
          }
        }

        for (const label of payload.labels) {
          const wanted = normalize(label);
          const textNode = [...dialog.querySelectorAll("*")].find((node) => normalize(node.textContent) === wanted);
          if (!textNode) continue;
          const following = [...controls].find((node) => {
            const relation = textNode.compareDocumentPosition(node);
            return relation & Node.DOCUMENT_POSITION_FOLLOWING;
          });
          if (following) return setValue(following);
        }

        return false;
      },
      { labels, value }
    )
    .catch(() => false);

  if (!filled) throw new Error(`Could not find field: ${labels.join(" / ")}`);
}

async function chooseOption(page, labels, desiredText) {
  const exact = labels.map(escapeForRegex).join("|");
  const byLabel = page.getByLabel(new RegExp(`^(${exact})\\s*[:：]?$`, "i"));
  if (await exactlyOne(byLabel)) {
    await chooseOnControl(page, byLabel, desiredText);
    return;
  }

  for (const label of labels) {
    const control = page.locator(
      `xpath=//*[normalize-space()="${label}" or contains(normalize-space(), "${label}")]/following::*[self::select or self::input or @role="combobox" or contains(@class,"select") or contains(@class,"ant-select") or contains(@class,"el-select")][1]`
    );
    if (await exactlyOne(control)) {
      await chooseOnControl(page, control, desiredText);
      return;
    }
  }

  throw new Error(`Could not find selector: ${labels.join(" / ")}`);
}

async function clickScopedText(scope, texts, description) {
  for (const text of texts) {
    if (await domClickScopedText(scope, [text], { exact: true })) return;

    const exactButton = scope.getByRole("button", { name: text, exact: true });
    if ((await exactButton.count().catch(() => 0)) === 1) {
      await safeClick(exactButton);
      return;
    }

    const looseButton = scope.getByRole("button", { name: text });
    if ((await looseButton.count().catch(() => 0)) === 1) {
      await safeClick(looseButton);
      return;
    }

    const textLocator = scope.getByText(text, { exact: true });
    const count = await textLocator.count().catch(() => 0);
    if (count === 1) {
      await safeClick(textLocator);
      return;
    }
    if (count > 1) {
      await safeClick(textLocator.first());
      return;
    }

    const escapedText = text.replace(/"/g, '\\"');
    const fallback = scope.locator(
      `xpath=.//*[self::button or self::label or @role="button" or contains(@class,"cursor-pointer")][contains(normalize-space(.), "${escapedText}")]`
    );
    const fallbackCount = await fallback.count().catch(() => 0);
    for (let index = 0; index < Math.min(fallbackCount, 20); index += 1) {
      const candidate = fallback.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      await safeClick(candidate);
      return;
    }
  }

  throw new Error(`Could not find ${description}.`);
}

async function clickDialogText(page, texts, description, options = {}) {
  const clicked = await page
    .evaluate(
      (payload) => {
        const dialog = [...document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')].find((node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
        if (!dialog) return false;

        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const candidates = [...dialog.querySelectorAll('button, [role="button"], label, [class*="select-trigger"]')];

        const visible = (node) => {
          const target = node instanceof HTMLInputElement ? node.closest("label") || node.parentElement || node : node;
          const rect = target.getBoundingClientRect();
          const style = window.getComputedStyle(target);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };

        for (const text of payload.texts) {
          const target = normalize(text);
          for (const node of candidates) {
            if (!visible(node)) continue;
            const clickTarget = node;
            const current = normalize(clickTarget.innerText || clickTarget.textContent || node.value || "");
            const matched = payload.exact ? current === target : current === target || current.includes(target);
            if (!matched) continue;
            clickTarget.scrollIntoView({ block: "center", inline: "center" });
            const rect = clickTarget.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
        }
        return null;
      },
      { texts, exact: options.exact !== false }
    )
    .catch(() => null);

  if (!clicked) throw new Error(`Could not find ${description}.`);
  await page.mouse.click(clicked.x, clicked.y);
  await waitForSettled(page);
}

async function clickDialogTextDom(page, texts, description, options = {}) {
  const clicked = await page
    .evaluate(
      (payload) => {
        const dialog = [...document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')].find((node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
        if (!dialog) return false;

        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const candidates = [...dialog.querySelectorAll('button, [role="button"], label, [class*="select-trigger"]')];
        for (const text of payload.texts) {
          const target = normalize(text);
          for (const node of candidates) {
            const rect = node.getBoundingClientRect();
            const style = window.getComputedStyle(node);
            if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") continue;
            const current = normalize(node.innerText || node.textContent || "");
            const matched = payload.exact ? current === target : current === target || current.includes(target);
            if (!matched) continue;
            node.scrollIntoView({ block: "center", inline: "center" });
            node.click();
            return true;
          }
        }
        return false;
      },
      { texts, exact: options.exact !== false }
    )
    .catch(() => false);

  if (!clicked) throw new Error(`Could not find ${description}.`);
  await waitForSettled(page);
}

async function clickDialogButtonTextDom(page, texts, description, options = {}) {
  const clicked = await page
    .evaluate(
      (payload) => {
        const dialog = [...document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')].find((node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
        if (!dialog) return false;
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        for (const text of payload.texts) {
          const target = normalize(text);
          const button = [...dialog.querySelectorAll("button")].find((node) => {
            const current = normalize(node.innerText || node.textContent || "");
            return payload.exact ? current === target : current === target || current.includes(target);
          });
          if (!button) continue;
          button.scrollIntoView({ block: "center", inline: "center" });
          button.click();
          return true;
        }
        return false;
      },
      { texts, exact: options.exact !== false }
    )
    .catch(() => false);

  if (!clicked) throw new Error(`Could not find ${description}.`);
  await waitForSettled(page);
}

async function clickDialogButtonTextDomIfPresent(page, texts, options = {}) {
  const clicked = await page
    .evaluate(
      (payload) => {
        const dialog = [...document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')].find((node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
        if (!dialog) return false;
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        for (const text of payload.texts) {
          const target = normalize(text);
          const button = [...dialog.querySelectorAll("button")].find((node) => {
            const current = normalize(node.innerText || node.textContent || "");
            return payload.exact ? current === target : current === target || current.includes(target);
          });
          if (!button) continue;
          button.scrollIntoView({ block: "center", inline: "center" });
          button.click();
          return true;
        }
        return false;
      },
      { texts, exact: options.exact !== false }
    )
    .catch(() => false);

  return clicked;
}

async function clickPlatformButton(page, platform) {
  const result = await page
    .evaluate((targetPlatform) => {
      const dialog = [...document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')].find((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      if (!dialog) return { ok: false, reason: "no visible dialog" };
      const button = [...dialog.querySelectorAll("button")].find((node) => (node.innerText || node.textContent || "").trim() === targetPlatform);
      if (!button) {
        return {
          ok: false,
          reason: "button not found",
          buttons: [...dialog.querySelectorAll("button")].slice(0, 12).map((node) => (node.innerText || node.textContent || "").trim())
        };
      }
      const before = (dialog.innerText || dialog.textContent || "").slice(0, 200);
      button.scrollIntoView({ block: "center", inline: "center" });
      button.click();
      const after = (dialog.innerText || dialog.textContent || "").slice(0, 200);
      return { ok: true, before, after, button: (button.innerText || button.textContent || "").trim() };
    }, platform)
    .catch((error) => ({ ok: false, reason: String(error) }));

  debugPlatformResult(page, result);
  if (!result.ok) throw new Error(`Could not find platform option: ${platform} (${result.reason || "unknown"})`);
  await waitForSettled(page);
}

async function waitForDialogText(page, texts, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await page
      .evaluate((wantedTexts) => {
        const dialog = [...document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')].find((node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
        if (!dialog) return false;
        const text = dialog.innerText || dialog.textContent || "";
        return wantedTexts.some((wanted) => text.includes(wanted));
      }, texts)
      .catch(() => false);
    if (found) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for dialog text: ${texts.join(" / ")}`);
}

async function ensureOauthAccountType(page, config) {
  const hasOauth = await page
    .evaluate(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')].find((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      if (!dialog) return false;
      const text = dialog.innerText || dialog.textContent || "";
      return /ChatGPT OAuth|OAuth/.test(text) && /OpenAI/.test(text);
    })
    .catch(() => false);

  if (hasOauth) return;
  await clickDialogText(page, [config.accountType, "OAuth", "Oauth"], "account type option", { exact: false });
}

async function safeFill(locator, value) {
  await locator.fill(value, { timeout: 8000 }).catch(async () => {
    await locator.evaluate((node, nextValue) => {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value");
      if (descriptor?.set) descriptor.set.call(node, nextValue);
      else node.value = nextValue;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  });
}

async function safeClick(locator) {
  await locator.click({ timeout: 8000 }).catch(async () => {
    await locator.evaluate((node) => {
      node.scrollIntoView({ block: "center", inline: "center" });
      node.click();
    });
  });
}

async function domClickScopedText(scope, texts, options = {}) {
  return await scope
    .evaluate(
      (root, payload) => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const visible = (node) => {
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        const candidates = [
          ...root.querySelectorAll('button, [role="button"], label, [class*="select-trigger"], [class*="cursor-pointer"]')
        ];
        for (const text of payload.texts) {
          const target = normalize(text);
          for (const node of candidates) {
            if (!visible(node)) continue;
            const current = normalize(node.innerText || node.textContent);
            const matched = payload.exact ? current === target : current === target || current.includes(target);
            if (!matched) continue;
            node.scrollIntoView({ block: "center", inline: "center" });
            node.click();
            return true;
          }
        }
        return false;
      },
      { texts, exact: options.exact !== false }
    )
    .catch(() => false);
}

async function chooseOnControl(page, control, desiredText) {
  const tag = await control.evaluate((node) => node.tagName.toLowerCase());
  if (tag === "select") {
    await control.selectOption({ label: desiredText }).catch(async () => {
      await control.selectOption({ value: desiredText });
    });
    return;
  }

  await control.click();
  await waitForSettled(page);
  await clickOption(page, desiredText);
}

async function chooseAnyProxy(page, scope = page, account = null) {
  const email = account?.email || "";

  // "代理" label collides with "无代理" value when using contains().
  // Use exact-match XPath to find only the label element, then get its following control.
  const exactLabelXpath = (label) =>
    `xpath=.//*[normalize-space()="${label}"]/following::*[self::select or self::input or self::button or @role="combobox" or contains(@class,"select") or contains(@class,"ant-select") or contains(@class,"el-select") or contains(@class,"n-select")][1]`;

  let control = null;
  for (const label of ["代理", "Proxy"]) {
    const locator = scope.locator(exactLabelXpath(label));
    const count = await locator.count().catch(() => 0);
    if (count === 1) { control = locator; break; }
  }

  // Fallback: try findLabeledControl which uses getByLabel
  if (!control) {
    control = await findLabeledControl(scope, ["代理", "Proxy"]);
  }

  if (!control) {
    logStep(email, `proxy control NOT found in dialog`);
    return;
  }

  const tag = await control.evaluate((node) => node.tagName.toLowerCase());
  if (tag === "select") {
    const options = await control.locator("option").evaluateAll((nodes) =>
      nodes
        .map((node) => ({ value: node.value, text: node.textContent?.trim() || "", disabled: node.disabled }))
        .filter((option) => option.value && !option.disabled && !/请选择|select/i.test(option.text))
    );
    if (options.length) {
      await control.selectOption({ value: options[0].value });
    }
    return;
  }

  await control.click();
  await waitForSettled(page);
  const selectedProxy = await clickFirstDropdownOption(page, ["请选择", "Select", "无", "None", "无代理", "No Proxy", "不使用"]).catch(() => "");
  logStep(email, `proxy selected: ${selectedProxy || "(none available)"}`);
}

async function selectGroup(page, scope, groupName) {
  const groupText = scope.getByText(new RegExp(`^\\s*${escapeForRegex(groupName)}\\s*$`, "i"));
  if ((await groupText.count()) > 0) {
    const checkboxNearGroup = scope.locator(
      `xpath=.//*[normalize-space()="${groupName}"]/ancestor-or-self::*[self::label or self::div or self::span][1]//input[@type="checkbox"] | .//*[normalize-space()="${groupName}"]/preceding::input[@type="checkbox"][1] | .//*[normalize-space()="${groupName}"]/following::input[@type="checkbox"][1]`
    );
    if ((await checkboxNearGroup.count()) > 0) {
      const box = checkboxNearGroup.first();
      if (!(await box.isChecked().catch(() => false))) {
        await box.check({ force: true }).catch(async () => box.click({ force: true }));
      }
      return;
    }

    await clickDialogText(page, [groupName], "group option");
    return;
  }

  await clickDialogText(page, [groupName], "group option");
}

async function findLabeledControl(scope, labels) {
  const exact = labels.map(escapeForRegex).join("|");
  const byLabel = scope.getByLabel(new RegExp(`^(${exact})\\s*[:：]?$`, "i"));
  if (await exactlyOne(byLabel)) return byLabel;

  for (const label of labels) {
    const control = scope.locator(
      `xpath=.//*[normalize-space()="${label}" or contains(normalize-space(), "${label}")]/following::*[self::select or self::input or self::button or @role="combobox" or contains(@class,"select") or contains(@class,"ant-select") or contains(@class,"el-select") or contains(@class,"n-select")][1]`
    );
    if (await exactlyOne(control)) return control;
  }

  return null;
}

async function clickOption(page, desiredText) {
  const escaped = escapeForRegex(desiredText);
  const optionLocators = [
    page.getByRole("option", { name: desiredText, exact: true }),
    page.locator(`xpath=//*[(@role="option" or contains(@class,"option") or contains(@class,"item")) and normalize-space()="${desiredText}"]`),
    page.locator(`xpath=//*[contains(@class,"dropdown") or contains(@class,"select") or contains(@class,"popover") or contains(@class,"menu")]//*[normalize-space()="${desiredText}"]`),
    page.getByText(new RegExp(`^\\s*${escaped}\\s*$`, "i"))
  ];

  for (const locator of optionLocators) {
    const count = await locator.count().catch(() => 0);
    if (count === 1) {
      await locator.click();
      return;
    }
    if (count > 1) {
      await locator.first().click();
      return;
    }
  }

  throw new Error(`Could not find option: ${desiredText}`);
}

async function clickFirstDropdownOption(page, excludedTexts = []) {
  const exclusion = new RegExp(`^\\s*(${excludedTexts.map(escapeForRegex).join("|")})\\s*$`, "i");
  const locators = [
    page.locator('[role="option"]'),
    page.locator(".ant-select-item-option"),
    page.locator(".el-select-dropdown__item"),
    page.locator(".n-base-select-option"),
    page.locator('[class*="option"]')
  ];

  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 30); index += 1) {
      const option = locator.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;
      const text = (await option.innerText().catch(() => "")).trim();
      const firstLine = text.split(/\n/)[0].trim();
      const excluded = !firstLine || exclusion.test(firstLine);
      if (excluded) continue;
      const disabled = await option.getAttribute("aria-disabled").catch(() => null);
      const className = await option.getAttribute("class").catch(() => "");
      if (disabled === "true" || /disabled/i.test(className || "")) continue;
      await option.click();
      return firstLine;
    }
  }

  throw new Error("Could not select a proxy option.");
}

async function clickByText(page, texts, description) {
  for (const text of texts) {
    const exactButton = page.getByRole("button", { name: text, exact: true });
    if ((await exactButton.count()) === 1) {
      await exactButton.click();
      return;
    }

    const looseButton = page.getByRole("button", { name: text });
    if ((await looseButton.count()) === 1) {
      await looseButton.click();
      return;
    }

    const textLocator = page.getByText(text, { exact: true });
    const count = await textLocator.count();
    if (count === 1) {
      await textLocator.click();
      return;
    }

    if (count > 1) {
      await textLocator.first().click();
      return;
    }
  }

  throw new Error(`Could not find ${description}.`);
}

async function extractAuthorizationUrl(page, config = {}) {
  return await page
    .evaluate(() => {
      const values = [];
      const visibleDialogs = [...document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')].filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const roots = visibleDialogs.length ? visibleDialogs : [document.body];

      for (const root of roots) {
        for (const node of root.querySelectorAll("textarea, input, a[href]")) {
          values.push(node.value || node.getAttribute("href") || node.textContent || "");
        }
        values.push(root.innerText || root.textContent || "");
      }

      const urls = values
        .flatMap((value) => String(value).match(/https?:\/\/\S+/g) || [])
        .map((value) => value.replace(/[)"'，。]+$/g, ""))
        .filter((value) => !value.includes("localhost:xxx"));

      return {
        urls,
        selected:
        urls.find((value) => /^https:\/\/auth\.openai\.com\/oauth\/authorize/i.test(value)) ||
        urls.find((value) => /auth\.openai\.com|openai|auth|oauth|authorize|chatgpt/i.test(value)) ||
        ""
      };
    })
    .then((result) => {
      if (config.debug) {
        const redacted = (result.urls || []).map(redactUrlForLog);
        console.log(`[debug] authorization url candidates: ${JSON.stringify(redacted)}`);
      }
      return result.selected || "";
    })
    .catch(() => "");
}

async function debugAuthorizationState(page, config, label) {
  if (!config.debug) return;
  const state = await page
    .evaluate(() => {
      const visibleDialogs = [...document.querySelectorAll('[role="dialog"], .modal-overlay, .modal')].filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const root = visibleDialogs[0] || document.body;
      const text = root.innerText || root.textContent || "";
      const controls = [...root.querySelectorAll("button, input, textarea, a[href]")]
        .slice(0, 100)
        .map((node) => ({
          tag: node.tagName,
          text: (node.innerText || node.textContent || "").trim(),
          value: node.value || "",
          href: node.getAttribute("href") || "",
          placeholder: node.getAttribute("placeholder") || "",
          type: node.getAttribute("type") || "",
          disabled: Boolean(node.disabled)
        }));
      const rawValues = controls.flatMap((control) => [control.text, control.value, control.href, control.placeholder]);
      rawValues.push(text);
      const urls = rawValues
        .flatMap((value) => String(value).match(/https?:\/\/[^\s)"'，。<>]+/g) || [])
        .map((value) => value.replace(/[)"'，。]+$/g, ""))
        .filter(Boolean);
      return {
        text: text.slice(0, 1200),
        buttons: controls.filter((control) => control.tag === "BUTTON").map((control) => ({
          text: control.text,
          disabled: control.disabled
        })),
        urls
      };
    })
    .catch((error) => ({ error: String(error), buttons: [], urls: [] }));

  console.log(`[debug] ${label}`);
  if (state.error) {
    console.log(`[debug] authorization state error: ${state.error}`);
    return;
  }
  console.log(`[debug] auth buttons: ${JSON.stringify(state.buttons)}`);
  console.log(`[debug] auth urls: ${JSON.stringify(state.urls.map(redactUrlForLog))}`);
}

async function waitForAuthorizationUrl(page, timeoutMs, config = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const authUrl = await extractAuthorizationUrl(page, config);
    if (authUrl) return authUrl;
    await page.waitForTimeout(250);
  }
  return "";
}

function looksLikeAuthUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value) && /openai|auth|oauth|authorize|chatgpt/i.test(value);
}

function redactUrlForLog(url) {
  if (url.includes("auth.openai.com")) return "https://auth.openai.com/oauth/authorize?...";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return url.replace(/\?.*$/, "?...");
  return url.slice(0, 100);
}

async function waitForCallback(authPage, callbackServer, timeoutMs) {
  const watchers = [waitForPageCallbackUrl(authPage, timeoutMs)];
  if (callbackServer) watchers.unshift(callbackServer.next(timeoutMs));
  return await Promise.race(watchers);
}

async function waitForPageCallbackUrl(page, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const url = page.url();
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url)) {
      return url;
    }
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for localhost callback URL.");
}

async function startCallbackServer(port) {
  const waiters = [];
  const server = http.createServer((request, response) => {
    const host = request.headers.host || `localhost:${port}`;
    const url = `http://${host}${request.url || "/"}`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Authorization captured</title><h1>Authorization captured</h1><p>You can return to the automation browser tab.</p>");
    while (waiters.length) waiters.shift().resolve(url);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    next(timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for callback server request."));
        }, timeoutMs);
        waiters.push({
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          }
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

async function startCallbackServerForAuthUrl(authUrl, config) {
  const port = callbackPortFromAuthUrl(authUrl) || config.callbackPort;
  if (!port) return null;

  try {
    const server = await startCallbackServer(port);
    debugStep(config, `listening for callback on localhost:${port}`);
    return server;
  } catch (error) {
    debugStep(config, `could not listen on localhost:${port}: ${errorMessage(error)}`);
    return null;
  }
}

function callbackPortFromAuthUrl(authUrl) {
  try {
    const url = new URL(authUrl);
    const redirectUri = url.searchParams.get("redirect_uri");
    if (!redirectUri) return 0;
    const redirectUrl = new URL(redirectUri);
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(redirectUrl.hostname)) return 0;
    return Number(redirectUrl.port || (redirectUrl.protocol === "https:" ? 443 : 80));
  } catch {
    return 0;
  }
}

async function verifyAccountStatus(page, email) {
  const row = page.locator(`xpath=//*[contains(normalize-space(), "${email}")]/ancestor::tr[1]`);
  if ((await row.count()) > 0) {
    const rowText = await row.first().innerText();
    return {
      found: true,
      normal: /正常|active|enabled|ok|success/i.test(rowText),
      status: statusFromText(rowText)
    };
  }

  const bodyText = await page.locator("body").innerText();
  if (!bodyText.includes(email)) return { found: false, normal: false, status: "" };

  const aroundEmail = bodyText.slice(Math.max(0, bodyText.indexOf(email) - 200), bodyText.indexOf(email) + 500);
  return {
    found: true,
    normal: /正常|active|enabled|ok|success/i.test(aroundEmail),
    status: statusFromText(aroundEmail)
  };
}

function statusFromText(text) {
  const match = text.match(/正常|异常|失败|禁用|Active|Enabled|OK|Success|Error|Failed|Disabled/i);
  return match?.[0] || "";
}

async function searchAndFindAccountRow(page, email) {
  // Use search input to filter virtual-scrolled list so target rows are in DOM
  const searchInput = page.locator('input[placeholder*="搜索"], input[placeholder*="Search"], input[placeholder*="名称"]').first();
  if ((await searchInput.count()) > 0) {
    await searchInput.fill(email);
    await sleep(1500);
    await waitForSettled(page);
  }
  const row = page.locator(`xpath=//*[contains(normalize-space(), "${email}")]/ancestor::tr[1]`);
  if ((await row.count()) > 0) {
    return row.first();
  }
  return null;
}

async function clearSearchFilter(page) {
  const searchInput = page.locator('input[placeholder*="搜索"], input[placeholder*="Search"], input[placeholder*="名称"]').first();
  if ((await searchInput.count()) > 0) {
    await searchInput.fill("");
    await sleep(800);
    await waitForSettled(page);
  }
}

async function deleteExistingAccount(page, account) {
  // Delete ALL matching rows (there may be duplicates)
  let deleted = false;

  // Auto-accept native confirm() dialogs that the delete action might trigger
  const dialogHandler = (dialog) => { dialog.accept(); };
  page.on("dialog", dialogHandler);

  try {
  for (let i = 0; i < 10; i++) {
    const row = await searchAndFindAccountRow(page, account.email);
    if (!row) break;

    if (i === 0) logStep(account.email, "deleting existing account(s) to re-add with fresh authorization");

    // Remove driver.js guide overlays and dismiss any popups
    await page.evaluate(() => {
      document.querySelectorAll('.driver-overlay, .driver-popover, .driver-active-element, [class*="driver-"]').forEach(el => el.remove());
    }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(300);

    // The "删除" button is a <button> element with text "删除" in the action column
    const deleteBtn = row.locator('button:has-text("删除")').first();
    if ((await deleteBtn.count()) === 0) {
      logStep(account.email, `delete button not found in row ${i}`);
      break;
    }

    // Use force click to bypass any remaining overlays
    await deleteBtn.click({ force: true }).catch(() => {});
    logStep(account.email, `delete button clicked (attempt ${i})`);

    await sleep(2000);

    // Remove driver overlays that might block the confirm modal
    await page.evaluate(() => {
      document.querySelectorAll('.driver-overlay, .driver-popover, [class*="driver-"]').forEach(el => el.remove());
    }).catch(() => {});

    // Click the confirm "删除" button in the modal using JavaScript (force clicks don't trigger Vue handlers)
    const confirmResult = await page.evaluate(() => {
      const modalBtns = document.querySelectorAll('.modal-footer button, .modal-content button');
      for (const btn of modalBtns) {
        if (btn.textContent?.trim() === '删除' || btn.textContent?.trim() === 'Delete') {
          btn.click();
          return 'clicked: ' + btn.textContent?.trim();
        }
      }
      // Fallback: try any confirm-like button in the modal
      const confirmBtns = document.querySelectorAll('.modal-footer button, .modal-content button');
      for (const btn of confirmBtns) {
        const text = btn.textContent?.trim() || '';
        if (/确认|确定|Confirm|OK|Yes/.test(text)) {
          btn.click();
          return 'clicked confirm: ' + text;
        }
      }
      return 'no confirm button found';
    });
    logStep(account.email, `modal confirm: ${confirmResult}`);

    await sleep(1500);

    await waitForSettled(page);
    await sleep(1000);
    deleted = true;
  }
  } finally {
    page.off("dialog", dialogHandler);
  }
  return deleted;
}

// ── Camofox-browser REST API helpers ──────────────────────────────────

async function cfRequest(baseUrl, method, path, body = null) {
  const url = `${baseUrl}${path}`;
  const options = { method, headers: { "Content-Type": "application/json" } };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`camofox ${method} ${path} failed: ${response.status} ${text}`);
  }
  return response.json().catch(() => ({}));
}

async function camofoxHealthCheck(baseUrl) {
  const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
  return response.ok;
}

async function startCamofoxServer() {
  const serverPath = path.resolve("node_modules/@askjo/camofox-browser/server.js");
  const child = execFile("node", [serverPath], {
    cwd: path.resolve("node_modules/@askjo/camofox-browser"),
    env: { ...process.env, CAMOFOX_PORT: "9377", CAMOFOX_CRASH_REPORT_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (data) => {
    if (config.debug) process.stderr.write(`[camofox] ${data}`);
  });
  child.stderr?.on("data", (data) => {
    if (config.debug) process.stderr.write(`[camofox:err] ${data}`);
  });
  child.on("exit", (code) => {
    if (code && code !== 0) log(`camofox-browser exited with code ${code}`);
  });
  return child;
}

async function cfCreateTab(baseUrl, userId, sessionKey, url) {
  return await cfRequest(baseUrl, "POST", "/tabs", { userId, sessionKey, url });
}

async function cfGetSnapshot(baseUrl, tabId, userId) {
  return await cfRequest(baseUrl, "GET", `/tabs/${tabId}/snapshot?userId=${encodeURIComponent(userId)}`);
}

async function cfClickRef(baseUrl, tabId, userId, ref) {
  return await cfRequest(baseUrl, "POST", `/tabs/${tabId}/click`, { userId, ref });
}

async function cfTypeRef(baseUrl, tabId, userId, ref, text, pressEnter = false) {
  return await cfRequest(baseUrl, "POST", `/tabs/${tabId}/type`, { userId, ref, text, pressEnter });
}

async function cfNavigate(baseUrl, tabId, userId, url) {
  return await cfRequest(baseUrl, "POST", `/tabs/${tabId}/navigate`, { userId, url });
}

async function cfCloseTab(baseUrl, tabId, userId) {
  return await cfRequest(baseUrl, "DELETE", `/tabs/${tabId}`, { userId });
}

async function cfPress(baseUrl, tabId, userId, key) {
  return await cfRequest(baseUrl, "POST", `/tabs/${tabId}/press`, { userId, key });
}

async function cfTypeSelector(baseUrl, tabId, userId, selector, text) {
  return await cfRequest(baseUrl, "POST", `/tabs/${tabId}/type`, { userId, selector, text });
}

async function cfClickSelector(baseUrl, tabId, userId, selector) {
  return await cfRequest(baseUrl, "POST", `/tabs/${tabId}/click`, { userId, selector });
}

async function cfEvaluate(baseUrl, tabId, userId, expression) {
  return await cfRequest(baseUrl, "POST", `/tabs/${tabId}/evaluate`, { userId, expression });
}

function cfFindRef(snapshot, { role, text, roleMatch = null }) {
  if (!snapshot) return null;
  // Format: `- role "text" [eN]:` or `- role [eN]:`
  const regex = /-\s*(\w+)\s+"([^"]*)"\s+\[(e\d+)\]/g;
  let match;
  while ((match = regex.exec(snapshot)) !== null) {
    const elRole = match[1].toLowerCase();
    const elText = match[2];
    const elRef = match[3];
    if (roleMatch && roleMatch.test(elRole)) {
      if (!text || elText.toLowerCase().includes(text.toLowerCase())) {
        return { ref: elRef, role: elRole, text: elText };
      }
    }
    if (role && !roleMatch) {
      const roleLower = role.toLowerCase();
      if (elRole === roleLower || elRole.includes(roleLower)) {
        if (!text || elText.toLowerCase().includes(text.toLowerCase())) {
          return { ref: elRef, role: elRole, text: elText };
        }
      }
    }
  }
  // Fallback: match refs without quoted text (e.g., `- textbox [e5]:`)
  const simpleRegex = /-\s*(\w+)\s+\[(e\d+)\]/g;
  while ((match = simpleRegex.exec(snapshot)) !== null) {
    const elRole = match[1].toLowerCase();
    const elRef = match[2];
    if (roleMatch && roleMatch.test(elRole)) return { ref: elRef, role: elRole, text: "" };
    if (role && !roleMatch) {
      const roleLower = role.toLowerCase();
      if (elRole === roleLower || elRole.includes(roleLower)) return { ref: elRef, role: elRole, text: "" };
    }
  }
  return null;
}

function cfFindAllRefs(snapshot, { role, text }) {
  if (!snapshot) return [];
  const results = [];
  const regex = /-\s*(\w+)\s+"([^"]*)"\s+\[(e\d+)\]/g;
  let match;
  while ((match = regex.exec(snapshot)) !== null) {
    const elRole = match[1].toLowerCase();
    const elText = match[2];
    const elRef = match[3];
    if (role) {
      const roleLower = role.toLowerCase();
      if (elRole !== roleLower && !elRole.includes(roleLower)) continue;
    }
    if (text && !elText.toLowerCase().includes(text.toLowerCase())) continue;
    results.push({ ref: elRef, role: elRole, text: elText });
  }
  return results;
}

// ── Camofox-based OpenAI login automation ──────────────────────────────

async function automateOpenAILoginCamofox(baseUrl, tabId, account, config, browserContext) {
  await sleep(3000);

  // Get initial snapshot
  let snap = await cfGetSnapshot(baseUrl, tabId, account.email);
  debugStep(config, `camofox auth snapshot: ${(snap.snapshot || "").slice(0, 500)}`);

  // No Cloudflare handling needed — camofox bypasses it

  // Step 1: Fill email
  logStep(account.email, "entering email on OpenAI login page (camofox)");
  const emailRef = cfFindRef(snap.snapshot, { roleMatch: /textbox|input|edit/i });
  if (!emailRef) {
    throw new Error("Could not find email input in camofox snapshot");
  }
  await cfClickRef(baseUrl, tabId, account.email, emailRef.ref);
  await sleep(300);
  await cfTypeRef(baseUrl, tabId, account.email, emailRef.ref, account.email);
  await sleep(500);

  // Click Continue/submit
  const continueRef = cfFindRef(snap.snapshot, { role: "button", text: "continue" })
    || cfFindRef(snap.snapshot, { role: "button", text: "next" });
  if (continueRef) {
    await cfClickRef(baseUrl, tabId, account.email, continueRef.ref);
  } else {
    await cfPress(baseUrl, tabId, account.email, "Enter");
  }
  await sleep(3000);

  // Step 2: Check for "Continue with password" link
  logStep(account.email, "checking for password-preferred login option (camofox)");
  snap = await cfGetSnapshot(baseUrl, tabId, account.email);
  debugStep(config, `camofox after email: ${(snap.snapshot || "").slice(0, 500)}`);

  const passwordLinkTexts = ["continue with password", "use password", "sign in with password", "使用密码继续", "使用密码登录", "enter your password"];
  for (const text of passwordLinkTexts) {
    const pwLink = cfFindRef(snap.snapshot, { text });
    if (pwLink) {
      await cfClickRef(baseUrl, tabId, account.email, pwLink.ref);
      await sleep(2500);
      break;
    }
  }

  // Step 3: Fill password
  logStep(account.email, "entering password (camofox)");
  if (account.password) {
    // Click password field via CSS selector to focus it, then type via keyboard mode
    await cfClickSelector(baseUrl, tabId, account.email, 'input[type="password"]');
    await sleep(500);
    await cfRequest(baseUrl, "POST", `/tabs/${tabId}/type`, {
      userId: account.email, text: account.password, mode: "keyboard", delay: 20
    });
    await sleep(500);

    snap = await cfGetSnapshot(baseUrl, tabId, account.email);
    debugStep(config, `camofox after password: ${(snap.snapshot || "").slice(0, 500)}`);
    const submitRef = cfFindRef(snap.snapshot, { role: "button", text: "continue" })
      || cfFindRef(snap.snapshot, { role: "button", text: "log in" })
      || cfFindRef(snap.snapshot, { role: "button", text: "next" });
    if (submitRef) {
      await cfClickRef(baseUrl, tabId, account.email, submitRef.ref);
    } else {
      await cfPress(baseUrl, tabId, account.email, "Enter");
    }
  }
  await sleep(3000);

  // Step 4: Handle verification code
  snap = await cfGetSnapshot(baseUrl, tabId, account.email);
  debugStep(config, `camofox after password: ${(snap.snapshot || "").slice(0, 500)}`);

  const codeInput = cfFindRef(snap.snapshot, { roleMatch: /textbox|input|edit/i });
  if (codeInput) {
    logStep(account.email, "verification code required, retrieving from email helper... (camofox)");
    const code = await retrieveEmailCode(account, config, browserContext);
    if (code) {
      logStep(account.email, `retrieved verification code: ${code}`);
      await cfClickRef(baseUrl, tabId, account.email, codeInput.ref);
      await sleep(300);
      await cfTypeRef(baseUrl, tabId, account.email, codeInput.ref, code);
      await sleep(500);

      snap = await cfGetSnapshot(baseUrl, tabId, account.email);
      const verifyRef = cfFindRef(snap.snapshot, { role: "button", text: "continue" })
        || cfFindRef(snap.snapshot, { role: "button", text: "verify" })
        || cfFindRef(snap.snapshot, { role: "button", text: "submit" });
      if (verifyRef) {
        await cfClickRef(baseUrl, tabId, account.email, verifyRef.ref);
      } else {
        await cfPress(baseUrl, tabId, account.email, "Enter");
      }
      await sleep(2500);
    } else {
      logStep(account.email, "could not retrieve verification code, please enter manually");
    }
  }

  // Step 5: Handle consent page (Codex linking consent)
  logStep(account.email, "checking for consent page (camofox)");
  await sleep(3000);
  for (let attempt = 0; attempt < 5; attempt++) {
    snap = await cfGetSnapshot(baseUrl, tabId, account.email);
    debugStep(config, `camofox consent attempt ${attempt}: ${(snap.snapshot || "").slice(0, 800)}`);

    // Check if already redirected to callback
    if (snap.url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(snap.url)) {
      debugStep(config, "already on callback URL, skipping consent");
      break;
    }

    let clicked = false;

    // Scroll to bottom to reveal the Continue button, then re-snapshot
    await cfEvaluate(baseUrl, tabId, account.email, `window.scrollTo(0, document.body.scrollHeight)`).catch(() => {});
    await sleep(800);

    // Take a fresh snapshot after scrolling - refs are now valid for the consent page
    const freshSnap = await cfGetSnapshot(baseUrl, tabId, account.email);
    logStep(account.email, `consent fresh snapshot (after scroll): ${(freshSnap.snapshot || "").slice(-300)}`);

    // Try ref-based click with the fresh snapshot
    const consentTexts = ["continue", "allow", "authorize", "accept"];
    for (const text of consentTexts) {
      const consentRef = cfFindRef(freshSnap.snapshot, { role: "button", text });
      if (consentRef) {
        logStep(account.email, `consent: clicking button ref ${consentRef.ref} (${consentRef.text})`);
        await cfClickRef(baseUrl, tabId, account.email, consentRef.ref);
        clicked = true;
        break;
      }
    }

    // Fallback: try CSS selector via camofox click endpoint
    if (!clicked) {
      logStep(account.email, "consent: ref not found, trying CSS selector click");
      try {
        await cfClickSelector(baseUrl, tabId, account.email, 'button:has-text("Continue")');
        clicked = true;
      } catch {
        try {
          await cfClickSelector(baseUrl, tabId, account.email, 'button[type="submit"]');
          clicked = true;
        } catch { /* no button found */ }
      }
    }

    logStep(account.email, `consent attempt ${attempt} result: clicked=${clicked}`);

    if (clicked) {
      await sleep(3000);
      // Check if already redirected to callback after clicking consent
      let postSnap = await cfGetSnapshot(baseUrl, tabId, account.email);
      logStep(account.email, `consent post-click URL: ${postSnap.url}`);
      if (postSnap.url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(postSnap.url)) {
        logStep(account.email, "callback URL already reached after consent click");
        return postSnap.url;
      }

      // Handle consent_challenge redirect chain — wait for the API to redirect to localhost
      if (postSnap.url && /consent/i.test(postSnap.url)) {
        logStep(account.email, "consent_challenge redirect detected, waiting for redirect to callback...");
        for (let wait = 0; wait < 20; wait++) {
          await sleep(1000);
          postSnap = await cfGetSnapshot(baseUrl, tabId, account.email).catch(() => ({}));
          if (postSnap.url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(postSnap.url)) {
            logStep(account.email, "callback URL reached after consent_challenge redirect");
            return postSnap.url;
          }
          // Check if page has a redirect URL in its content (JSON or HTML)
          if (wait === 5) {
            const pageContent = await cfEvaluate(baseUrl, tabId, account.email, "document.body?.innerText?.slice(0, 2000) || ''").catch(() => ({}));
            logStep(account.email, `consent_challenge page content: ${String(pageContent.result || "").slice(0, 300)}`);
          }
        }
        logStep(account.email, `consent_challenge did not redirect to localhost, current URL: ${postSnap.url}`);
      }
      break;
    }

    // Try scrolling down more
    await cfRequest(baseUrl, "POST", `/tabs/${tabId}/scroll`, { userId: account.email, direction: "down" }).catch(() => {});
    await sleep(1500);
  }

  logStep(account.email, "camofox login automation steps complete");
}

async function waitForCamofoxCallback(baseUrl, tabId, callbackServer, timeoutMs, userId = "callback-check") {
  const started = Date.now();
  const serverPromise = callbackServer ? callbackServer.next(timeoutMs) : null;

  const pollPromise = (async () => {
    while (Date.now() - started < timeoutMs) {
      const snap = await cfGetSnapshot(baseUrl, tabId, userId).catch(() => ({}));
      // The snapshot response includes the current page URL
      if (snap.url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(snap.url)) {
        return snap.url;
      }
      await sleep(500);
    }
    throw new Error("Timed out waiting for localhost callback URL (camofox).");
  })();

  if (serverPromise) {
    return Promise.race([serverPromise, pollPromise]);
  }
  return pollPromise;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleCloudflareChallenge(page, email, config) {
  const started = Date.now();
  const maxWait = 120000;
  let warned = false;

  while (Date.now() - started < maxWait) {
    const pageText = await page.evaluate(() => (document.body?.innerText || "").slice(0, 800)).catch(() => "");
    const url = page.url();

    // Already past the challenge — login page detected
    if (/login|identifier|sign.?in|password|enter.*email|otp/i.test(url) || /email|password|continue|log.?in|sign.?in/i.test(pageText)) {
      debugStep(config, "cloudflare challenge passed, login page detected");
      return;
    }

    // Still on Cloudflare challenge
    if (/安全验证|security verification|checking|cloudflare|ray.?id|turning/i.test(pageText)) {
      if (!warned) {
        console.log(`[${email}] Cloudflare challenge detected. Please click the verification checkbox in the browser window to proceed.`);
        warned = true;
      }
      await page.waitForTimeout(3000);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      continue;
    }

    // Not a Cloudflare page and not a login page — wait a bit more
    await page.waitForTimeout(2000);
  }

  debugStep(config, "cloudflare challenge wait timed out, proceeding anyway");
}

async function automateOpenAILogin(authPage, account, config, browserContext) {
  await authPage.waitForLoadState("domcontentloaded");
  await authPage.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await authPage.waitForTimeout(3000);

  debugStep(config, `auth page URL: ${authPage.url()}`);
  const pageText = await authPage.evaluate(() => (document.body?.innerText || "").slice(0, 500)).catch(() => "");
  debugStep(config, `auth page text: ${pageText.replace(/\s+/g, " ").slice(0, 300)}`);

  // Handle Cloudflare challenge
  await handleCloudflareChallenge(authPage, account.email, config);

  logStep(account.email, "entering email on OpenAI login page");
  await openAIFillEmail(authPage, account.email);
  await openAIClickSubmit(authPage, ["Continue", "继续", "Next"]);
  await authPage.waitForTimeout(2500);

  logStep(account.email, "checking for password-preferred login option");
  await openAIPreferPassword(authPage);

  logStep(account.email, "entering password");
  await openAIFillPassword(authPage, account.password);
  await authPage.waitForTimeout(2500);

  await openAIHandleVerification(authPage, account, config, browserContext);
  await openAIHandleConsent(authPage);
  logStep(account.email, "login automation steps complete");
}

async function openAIFillEmail(page, email) {
  const selectors = [
    'input[name="username"]', 'input[name="email"]', 'input[type="email"]',
    'input[autocomplete="username"]', 'input[autocomplete="email"]',
    'input[id="username"]', 'input[id="email"]', 'input[id="email-input"]',
    'input[data-testid="username"]', 'input[data-testid="email"]',
  ];

  // Wait for any input to appear first
  await page.waitForSelector('input', { timeout: 10000 }).catch(() => {});

  for (const sel of selectors) {
    const input = page.locator(sel).first();
    if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
      await input.click();
      await input.fill(email);
      return;
    }
  }

  // Fallback: any visible text or email input
  const textInput = page.locator('input[type="text"]:visible, input[type="email"]:visible, input:not([type]):visible').first();
  if (await textInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await textInput.click();
    await textInput.fill(email);
    return;
  }

  // Last resort: evaluate in DOM
  const filled = await page.evaluate((emailValue) => {
    const inputs = [...document.querySelectorAll('input')].filter(
      (n) => !["hidden", "checkbox", "radio", "submit", "button"].includes(n.type)
    );
    for (const input of inputs) {
      if (input.offsetParent !== null) {
        const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
        if (proto?.set) proto.set.call(input, emailValue);
        else input.value = emailValue;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }, email).catch(() => false);

  if (filled) return;
  throw new Error("Could not find email input on OpenAI login page");
}

async function openAIFillPassword(page, password) {
  if (!password) {
    logStep("", "no password in account line, skipping automated password entry");
    return;
  }
  const selectors = [
    'input[type="password"]', 'input[name="password"]',
    'input[autocomplete="current-password"]', 'input[id="password"]',
  ];
  for (const sel of selectors) {
    const input = page.locator(sel).first();
    if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
      await input.click();
      await input.fill(password);
      await openAIClickSubmit(page, ["Continue", "继续", "Log in", "登录", "Next"]);
      return;
    }
  }
}

async function openAIPreferPassword(page) {
  const texts = [
    "使用密码继续", "Continue with password", "Use password instead",
    "Sign in with password", "Try another method", "使用密码登录",
    "Enter your password",
  ];
  for (const text of texts) {
    const link = page.locator(
      `a:has-text("${text}"), button:has-text("${text}"), [role="link"]:has-text("${text}"), span:has-text("${text}")`
    ).first();
    if (await link.isVisible({ timeout: 1500 }).catch(() => false)) {
      await link.click();
      await page.waitForTimeout(2000);
      return;
    }
    const textEl = page.getByText(text, { exact: false }).first();
    if (await textEl.isVisible({ timeout: 1000 }).catch(() => false)) {
      await textEl.click();
      await page.waitForTimeout(2000);
      return;
    }
  }
}

async function openAIHandleVerification(page, account, config, browserContext) {
  const hasCodeInput = await page.locator(
    'input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]'
  ).first().isVisible({ timeout: 3000 }).catch(() => false);

  if (!hasCodeInput) {
    const url = page.url();
    if (!/verify|challenge|code|otp/i.test(url)) return;
    const textInput = page.locator('input[type="text"]:visible, input[type="number"]:visible, input[type="tel"]:visible').first();
    if (!(await textInput.isVisible({ timeout: 2000 }).catch(() => false))) return;
  }

  logStep(account.email, "verification code required, retrieving from email helper...");
  const code = await retrieveEmailCode(account, config, browserContext);
  if (!code) {
    logStep(account.email, "could not retrieve verification code, please enter manually");
    return;
  }

  logStep(account.email, `retrieved verification code: ${code}`);
  const input = page.locator(
    'input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="text"]:visible, input[type="number"]:visible'
  ).first();
  await input.click();
  await input.fill(code);
  await openAIClickSubmit(page, ["Continue", "继续", "Verify", "验证", "Submit"]);
  await page.waitForTimeout(2500);
}

async function openAIHandleConsent(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = page.url();
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url)) return;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(await page.evaluate(() => window.location.href).catch(() => ""))) return;

    const consentTexts = ["Continue", "继续", "Allow", "Authorize", "授权", "Accept"];
    for (const text of consentTexts) {
      const btn = page.locator(`button:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(2500);
        return;
      }
    }
    await page.waitForTimeout(1500);
  }
}

async function openAIClickSubmit(page, fallbackTexts) {
  await page.locator('button[type="submit"]').first().click().catch(async () => {
    for (const text of fallbackTexts) {
      const btn = page.locator(`button:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        return;
      }
    }
  });
}

async function retrieveEmailCode(accountOrEmail, config, browserContext) {
  const email = typeof accountOrEmail === "string" ? accountOrEmail : accountOrEmail.email;
  const rawLine = typeof accountOrEmail === "string" ? email : (accountOrEmail.raw || email);
  const emailPage = await browserContext.newPage();
  try {
    await emailPage.goto("https://email.nloop.cc/", { waitUntil: "domcontentloaded", timeout: 15000 });
    await emailPage.waitForTimeout(3000);

    const imported = await importEmailToHelper(emailPage, rawLine);
    if (!imported) {
      logStep(email, "could not find email import field on email helper page");
      return null;
    }

    // Click "获取邮件" button to fetch emails
    const fetchBtn = emailPage.locator('button, a, [role="button"]')
      .filter({ hasText: /获取邮件|刷新|fetch|refresh|get.*mail/i }).first();
    if (await fetchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fetchBtn.click();
      logStep(email, "clicked 获取邮件 button on email helper");
      await emailPage.waitForTimeout(5000);
    }

    for (let attempt = 0; attempt < 15; attempt++) {
      // Click 获取邮件 before each poll attempt to refresh
      if (attempt > 0) {
        const refreshBtn = emailPage.locator('button, a, [role="button"]')
          .filter({ hasText: /获取邮件|刷新|fetch|refresh|get.*mail/i }).first();
        if (await refreshBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await refreshBtn.click().catch(() => {});
        }
      }
      await emailPage.waitForTimeout(3000);
      const code = await emailPage.evaluate(() => {
        const text = document.body.innerText || document.body.textContent || "";
        const patterns = [
          /(?:验证码|verification code|your code|码)[^\d]*(\d{6})/i,
          /(\d{6})[^\d]*(?:是您|is your|verification|验证)/i,
          /OpenAI[^\d]*(\d{6})/i,
        ];
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) return match[1];
        }
        const sixDigit = text.match(/\b(\d{6})\b/);
        return sixDigit?.[1] || null;
      });
      if (code) return code;
    }
    return null;
  } finally {
    await emailPage.close().catch(() => {});
  }
}

async function importEmailToHelper(emailPage, accountRawLine) {
  const importBtn = emailPage.locator('button, a, [role="button"]')
    .filter({ hasText: /批量导入|bulk import|添加|add|import/i }).first();
  if (await importBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await importBtn.click();
    await emailPage.waitForTimeout(1500);
  }

  const selectors = [
    'textarea:visible', 'input[type="text"]:visible',
    'input[placeholder*="邮箱"]', 'input[placeholder*="email"]',
    'input[placeholder*="导入"]', 'input[placeholder*="import"]',
    'input[placeholder*="地址"]', 'input[placeholder*="address"]',
  ];
  for (const sel of selectors) {
    const input = emailPage.locator(sel).first();
    if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
      await input.click();
      await input.fill(accountRawLine);
      await emailPage.keyboard.press("Enter").catch(() => {});
      await emailPage.waitForTimeout(2000);
      return true;
    }
  }
  return false;
}

async function exactlyOne(locator) {
  return (await locator.count().catch(() => 0)) === 1;
}

async function waitForSettled(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
}

async function waitForPageContent(page) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const hasContent = await page.evaluate(() => {
      const body = document.body;
      if (!body) return false;
      const text = (body.innerText || "").trim();
      if (text.length < 20) return false;
      return /账号|账户|Account|添加|Add|列表|List|管理|Admin|登录|Login|Sign/i.test(text);
    }).catch(() => false);
    if (hasContent) return;
    await page.waitForTimeout(500);
  }
}

async function safeClose(page) {
  await page.close().catch(() => {});
}

async function readAccounts(args) {
  if (args.one) return [parseAccount(args.one)];
  if (args.stdin) {
    const content = await readStdin();
    return parseAccountLines(content);
  }

  const file = args.accounts || args.file;
  if (!file) return [];
  const content = await fs.readFile(file, "utf8");
  return parseAccountLines(content);
}

function parseAccountLines(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(parseAccount);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseAccount(raw) {
  const email = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (!email) throw new Error(`Could not parse email from account line: ${raw}`);
  let parts = raw.split(/\s*-{4}\s*/);
  if (parts.length < 2) parts = raw.split(/\s*\|\s*/);
  const password = parts.length >= 2 ? parts[1].trim() : "";
  return { email, password, raw };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

async function loadDotEnv(file) {
  try {
    const content = await fs.readFile(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (!match) continue;
      const key = match[1];
      const value = match[2].replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function env(key, fallback) {
  return process.env[key] ?? fallback;
}

function numberArg(value, envValue, fallback) {
  const raw = value ?? envValue;
  if (raw === undefined || raw === null || raw === "") return fallback;
  const number = Number(raw);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

function booleanArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function escapeForRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function logStep(email, message) {
  console.log(`[${email}] ${message}`);
}

function log(message) {
  console.log(`[sub2api] ${message}`);
}

function debugStep(config, message) {
  if (config.debug) console.log(`[debug] ${message}`);
}

function debugPlatformResult(page, result) {
  void page;
  if (!config.debug) return;
  console.log(`[debug] platform click result: ${JSON.stringify(result)}`);
}

async function waitForInterrupt() {
  await new Promise((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function printSummary(summary) {
  console.log("");
  console.log("Summary");
  console.log("=======");
  for (const item of summary) {
    console.log(`${item.ok ? "OK" : "FAIL"}  ${item.email}  ${item.status || item.reason || ""}`);
  }
  const ok = summary.filter((item) => item.ok).length;
  console.log("");
  console.log(`Total: ${summary.length}, success: ${ok}, failed: ${summary.length - ok}`);
}

async function getAccountRemark(page, email) {
  // Search for the account, click "编辑" to open edit dialog, read "备注" field, close dialog
  const searchInput = page.locator('input[placeholder*="搜索"], input[placeholder*="Search"], input[placeholder*="名称"]').first();
  if ((await searchInput.count()) > 0) {
    await searchInput.fill(email);
    await sleep(1500);
    await waitForSettled(page);
  }

  const row = page.locator(`xpath=//*[contains(normalize-space(), "${email}")]/ancestor::tr[1]`);
  log(email, `getAccountRemark: search input found=${(await searchInput.count()) > 0}, row count=${await row.count()}`);
  if ((await row.count()) === 0) {
    log(email, `getAccountRemark: row not found, trying without search filter`);
    // Clear search and try broader match
    await searchInput.fill("").catch(() => {});
    await sleep(1000);
    const row2 = page.locator(`xpath=//*[contains(normalize-space(), "${email}")]/ancestor::tr[1]`);
    log(email, `getAccountRemark: retry row count=${await row2.count()}`);
    if ((await row2.count()) === 0) return null;
    // Use row2 from now on
    var editRow = row2.first();
  } else {
    var editRow = row.first();
  }

  // Remove overlays and click "编辑" button in the row
  await page.evaluate(() => {
    document.querySelectorAll('.driver-overlay, .driver-popover, [class*="driver-"]').forEach(el => el.remove());
  }).catch(() => {});

  const editBtn = editRow.locator('button:has-text("编辑")').first();
  log(email, `getAccountRemark: editBtn count=${await editBtn.count()}`);
  if ((await editBtn.count()) === 0) return null;
  await editBtn.click({ force: true });
  await sleep(1500);
  await waitForSettled(page);

  // Read the "备注" field value from the edit dialog
  let remark = "";
  try {
    const dialog = await activeDialog(page);
    if (dialog) {
      // Find the remark/备注 input/textarea
      const remarkInput = dialog.locator(
        `xpath=.//*[normalize-space()="备注" or normalize-space()="Remark" or normalize-space()="Notes"]/following::*[self::input or self::textarea][1]`
      ).first();
      log(email, `getAccountRemark: remarkInput count=${await remarkInput.count()}`);
      if ((await remarkInput.count()) > 0) {
        remark = await remarkInput.inputValue().catch(() => "");
        log(email, `getAccountRemark: remark from labeled input="${remark.slice(0, 100)}"`);
      }
      // If not found by label, try textarea/input with the raw line pattern
      if (!remark) {
        const allInputs = await dialog.locator('input, textarea').evaluateAll((nodes) => {
          for (const node of nodes) {
            const val = node.value || "";
            if (val.includes("----") || val.includes("@")) return val;
          }
          return "";
        });
        remark = allInputs;
        log(email, `getAccountRemark: remark from fallback scan="${remark.slice(0, 100)}"`);
      }
    }
  } catch (e) {
    // ignore
  }

  // Close the edit dialog
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);
  // Also try clicking "取消" or "返回" buttons
  await page.evaluate(() => {
    const btns = document.querySelectorAll('.modal-footer button, .dialog-footer button');
    for (const btn of btns) {
      const text = btn.textContent?.trim();
      if (text === '取消' || text === 'Cancel' || text === '返回' || text === 'Back') {
        btn.click();
        break;
      }
    }
  }).catch(() => {});
  await sleep(800);

  log(email, `remark from edit dialog: ${remark.slice(0, 80)}`);
  return remark || null;
}

async function scanAllAccountStatuses(page) {
  // Scroll through the entire account list (handles virtual scrolling)
  // Returns array of { email, status, rowText }
  const seen = new Map();

  // Find scrollable table container
  const scrollContainer = await page.evaluate(() => {
    const selectors = [
      '.el-table__body-wrapper', '.ant-table-body', '.v-data-table__wrapper',
      '.n-data-table__body', '.el-scrollbar__wrap', '[class*="table"]',
      '[class*="virtual"]', '[class*="scroll"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight) return sel;
    }
    // Fallback: check for any scrollable container
    for (const el of document.querySelectorAll('div')) {
      if (el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 200) {
        // Return a unique selector
        if (el.className && typeof el.className === 'string') {
          const firstClass = el.className.split(/\s+/).find(c => c && !c.startsWith('data-'));
          if (firstClass) return `.${firstClass}`;
        }
      }
    }
    return null;
  });

  const maxScrolls = 50;
  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    // Extract emails and statuses from visible rows
    const rows = await page.evaluate(() => {
      const trs = document.querySelectorAll('table tbody tr, .el-table__body tr, .ant-table-tbody tr, [class*="table"] tbody tr');
      return Array.from(trs).map(tr => {
        const text = (tr.innerText || '').trim();
        const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
        return emailMatch ? { email: emailMatch[0], rowText: text } : null;
      }).filter(Boolean);
    });

    let newCount = 0;
    for (const row of rows) {
      if (!seen.has(row.email)) {
        const statusMatch = row.rowText.match(/正常|异常|失败|禁用|限流中|Token revoked|401|错误|Error|Failed|Disabled|Revoked|Active|Enabled|OK/i);
        seen.set(row.email, {
          email: row.email,
          status: statusMatch?.[0] || "未知",
          rowText: row.rowText,
          isRevoked: /Token revoked|401|token.*revok|revok.*token|异常|错误|Error|Failed/i.test(row.rowText)
        });
        newCount++;
      }
    }

    // If no new rows found, we've scrolled through everything
    if (newCount === 0 && scroll > 0) break;

    // Scroll down
    if (scrollContainer) {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollTop = el.scrollHeight;
      }, scrollContainer).catch(() => {});
    } else {
      await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
    }
    await sleep(500);
  }

  return Array.from(seen.values());
}

function printHelp() {
  console.log(`sub2api OpenAI OAuth helper

Usage:
  npm run auth -- --accounts accounts.txt
  npm run auth -- --stdin < accounts.txt
  npm run auth -- --one "email@example.com ---- remark copied into sub2api"

Options:
  --accounts <file>         Account list, one account per line
  --stdin                   Read account lines from standard input
  --one <line>              Run one account line directly
  --admin-url <url>         sub2api accounts page
  --platform <text>         Platform option text, default OpenAI
  --account-type <text>     Account type option text, default Oauth
  --group <text>            Group to select, default openai
  --admin-email <email>     Optional sub2api admin email
  --admin-password <text>   Optional sub2api admin password
  --force-proxy             Open proxy dropdown and select a non-empty option
  --callback-port <port>    Fallback callback capture port if auth link has no redirect port
  --profile <dir>           Persistent browser profile dir
  --headless                Run browser headless
  --keep-open-on-fail       Leave the browser open after a failed account for inspection
  --debug                   Print sanitized dialog structure while running
  --timeout <ms>            Per-account callback wait timeout
  --use-camofox             Use camofox-browser for OpenAI auth (default: true)
  --camofox-url <url>       Camofox server URL (default: http://localhost:9377)
  --env <file>              Env file path, default .env
  --check-revoked           Scan admin page for Token revoked (401) accounts and re-authorize them

Boundary:
  The script automates sub2api form handling, OpenAI login (via camofox-browser to bypass Cloudflare),
  email verification code retrieval, and callback URL capture.
  Use --no-use-camofox to fall back to Playwright for OpenAI auth (may get blocked by Cloudflare).
`);
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\nCall log:/)[0].trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
