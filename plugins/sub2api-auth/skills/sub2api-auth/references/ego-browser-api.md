# ego-browser nodejs runtime — API reference

evidence:
- `evidence_status`: `live_verified` (signatures marked per-fn below) on 2026-08-13 against the installed ego-lite service
- `source_system`: the `ego-browser nodejs` embedded Node runtime that drives a real Chromium via CDP; scripts are piped on stdin (`spawnSync("ego-browser", ["nodejs"], { input })`) and `cliLog` output arrives on the child's **stderr** (Hard Rule 22)
- `provenance`: signatures confirmed by direct probe in an isolated task space on 2026-08-13 while building `flow-email-login.mjs`; the costly rediscovery of `typeText`'s single-arg form is the reason this file exists
- `redaction_notes`: no secrets; this documents call shapes only. Values typed into inputs are still embedded via `JSON.stringify` per Hard Rule 22 and masked per Hard Rule 4.

## Why this file exists

The functions are exposed as opaque `async (...args)` proxies, so `.toString()` and `.length` reveal nothing. Each signature below was determined empirically. **Re-read this before typing into any input or managing a task space** — guessing the arg shape wastes a full flow (the 2026-08-13 `typeText('selector', text)` probe typed a partial value and burned an OAuth page).

## Typing into inputs (the critical signatures)

| Function | Call shape | Behavior | Verified |
|---|---|---|---|
| `typeText(value)` | **single arg**, types into the **currently focused** element | Real keystrokes → React controlled-component state updates correctly → `requestSubmit` works. Focus the input first via `js()` (see Hard Rule 14 focus+clear pattern), then `await typeText(value)`. | `live_verified` 2026-08-13 (email 26/26, code 6/6) |
| `fillInput(target, value)` | `target` = CSS selector **or** `loc:` string (e.g. `css:input[name="email"]`); sets value | Sets the DOM `.value` via the page but leaves React state empty, so `requestSubmit` **no-ops** on React forms (OpenAI auth). Usable for non-React fields; **not** for OpenAI email/code/password inputs. | `live_verified` 2026-08-13 (sets value, React-state-empty proven) |
| `pressKey(key)` | single string, e.g. `pressKey('Enter')` | Synthetic key event on the focused element. Arg shape accepted (errors only when no task space is selected). Prefer `form.requestSubmit(btn)` via `js()` for OpenAI form submits (Hard Rule 15). | arg shape `live_verified` 2026-08-13 |

**The rule:** for any OpenAI auth input (email, password, code) — focus via `js()` with the native setter to clear, then `await typeText(value)`. Never `fillInput` and never `typeText(selector, value)` (the two-arg form throws `Cannot read properties of undefined (reading 'slice')` and types nothing). Verify `input.value.length === expected` before submitting.

## Page observation

| Function | Call shape | Returns | Verified |
|---|---|---|---|
| `js(code)` | a JS expression/statement string (IIFE `(()=>{...})()` recommended); runs in the page | the evaluated value | `live_verified` |
| `snapshotText()` | no args | an a11y-tree text dump of the page (contains `[ref=N, loc=css:...]` anchors for elements). Does NOT trigger fetches (Hard Rule 29). | `live_verified` |
| `pageInfo()` | no args | `{ url, title }` (url is `null` on a chrome-error/500 page — a reliable crash signal) | `live_verified` |
| `captureScreenshot()` | no args | a screenshot for visual-model analysis | `referenced` (Hard Rule / Error Recovery) |

`pageInfo().url === null` + `title === '<host>'` is the signature of a chrome-error page (e.g. the HTTP 500 the `/email-verification` page degrades to). Treat it as a dead page and restart the flow fresh (Hard Rule 23).

## Task-space lifecycle (isolation per account)

| Function | Call shape | Returns / Behavior | Verified |
|---|---|---|---|
| `useOrCreateTaskSpace(ref)` | `ref` = numeric id (reuse existing) **or** string name (create new) | `{ id }` (the numeric id to reuse in later calls) | `live_verified` |
| `listTaskSpaces()` | no args | array of spaces | `live_verified` |
| `completeTaskSpace(id, { keep: false })` | numeric id | `{ done: true }`; close the dedicated space when the account finishes | `live_verified` |
| `claimTaskSpace(id)` / `takeOverTaskSpace(id)` / `handOffTaskSpace(id)` | numeric id | ownership transitions; see Hard Rule 11 for when each applies | `referenced` (Hard Rule 11) |

A new task space can inherit an OpenAI account chooser / authenticated session from a previous account — identity is still a hard gate (Hard Rule 16), not implied by space isolation.

## Tabs & navigation

| Function | Call shape | Behavior | Verified |
|---|---|---|---|
| `openOrReuseTab(url, { wait: true })` | url + options | opens a fresh tab or reuses one matching the url. **Reusing does NOT reload** an existing tab (Hard Rule 29) — force a reload with `cdp('Page.reload')`. | `live_verified` |
| `listTabs()` | no args | `[{ id, url, ... }]` | `live_verified` |
| `switchTab(tab)` | the **tab object** from `listTabs()`, not an id | switches the active tab | `referenced` (Hard Rule 22) |
| `cdp(method, params)` | CDP `method` name + params object | raw Chrome DevTools Protocol call, e.g. `cdp('Page.reload', { ignoreCache: false })`, `cdp('Page.getNavigationHistory')` | `referenced` (Hard Rule 29) |

## Logging

`cliLog(message)` — the ONLY way to emit from the runtime; it writes to the child process's **stderr**. The parent Node driver captures it on `spawnSync`'s `stderr` (Hard Rule 22b). `console.log` from the runtime does not surface. Mask every secret before `cliLog` (Hard Rule 4).

## Runtime facts that bite

- Top-level `await` IS supported in piped scripts (each invocation is one async module). `@N` snapshot refs and local `const` bindings do NOT survive across invocations — re-snapshot in the same round, or use CSS `loc`/selectors (Hard Rule 22).
- Shell env vars are invisible to the runtime: embed secrets via `JSON.stringify` into the piped script (Hard Rule 22a). The runtime's own `fetch` runs as Node (no CORS) and honored the ichzl `:8443` cert without a TLS bypass (live 2026-08-13).
- A script is one shot: any poll that depends on a live page (e.g. OpenAI `/email-verification`, which 500s after a few minutes) must run inside the SAME call as the page interaction — do not split browser→Node-poll→browser across calls (Hard Rule 33 / `flow-email-login.mjs`).
