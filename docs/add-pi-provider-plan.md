# Add pi-coding-agent as a Provider Option

## Goal

Add `pi` as a first-class provider alongside Codex and Claude Code, using **pi RPC mode** as the initial integration strategy.

## Decision

Use **RPC** instead of the pi SDK for v1.

### Why RPC

- Fits the current T3 Code provider architecture well: one managed runtime per session.
- Preserves a clean subprocess boundary, similar to the existing Codex integration.
- Keeps pi failures, extension issues, and memory growth isolated from the server process.
- pi RPC already exposes the main primitives needed for T3 Code:
  - `prompt`
  - `abort`
  - `get_state`
  - `set_model`
  - `get_available_models`
  - `fork`
  - `get_fork_messages`
  - streamed message/tool events
  - `extension_ui_request` / `extension_ui_response`

### Why not SDK first

The SDK gives richer direct control, but it embeds pi inside the server process. For v1, reliability and containment are more important than tighter integration.

---

## Important prerequisite

Before adding pi, remove the current pattern of inferring provider from model string.

### Why this matters

pi models are cross-provider identifiers such as:

- `anthropic/claude-sonnet-...`
- `openai/gpt-...`
- `google/gemini-...`

That will break the current Codex/Claude-oriented model inference logic.

### Required change

Persist the selected provider explicitly on the thread/read model and use that as the source of truth throughout the app.

---

## Implementation plan

## Phase 1: Provider persistence refactor

### Objective
Persist the thread's selected provider explicitly instead of inferring it from the model string.

### Expected work

- Add a persistent thread-level provider field such as `providerName` or `preferredProvider`.
- Update read model mapping and projector logic to carry that field through.
- Update web/store logic to rely on persisted provider instead of model parsing.

### Likely files

- `packages/contracts/src/orchestration.ts`
- `apps/web/src/store.ts`
- `apps/web/src/types.ts`
- orchestration projector / projection persistence files

---

## Phase 2: Shared contract updates

### Objective
Teach shared contracts about the new `pi` provider.

### Required changes

#### Add `pi` to provider kind

Update:

- `packages/contracts/src/orchestration.ts`

#### Add pi provider start options

Update:

- `packages/contracts/src/provider.ts`

Suggested shape:

- `providerOptions.pi.binaryPath?: string`
- `providerOptions.pi.sessionDir?: string` (optional; likely server-managed)

#### Add pi model options

Update:

- `packages/contracts/src/model.ts`

Suggested shape:

- `modelOptions.pi.thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"`

Current implementation note:

- the shared composer exposes Pi reasoning via the existing reasoning-effort control
- selected efforts map directly to `modelOptions.pi.thinkingLevel` for `low | medium | high | xhigh`

### Model catalog strategy

For v1, do **not** hardcode a large static pi model catalog into contracts.

Preferred approach:

- treat pi models as dynamic/server-backed
- optionally support custom pi model strings in the UI
- later use `get_available_models` for dynamic model discovery

---

## Phase 3: Add a server-side Pi adapter

### Objective
Implement a new provider adapter backed by `pi --mode rpc`.

### New files

- `apps/server/src/provider/Services/PiAdapter.ts`
- `apps/server/src/provider/Layers/PiAdapter.ts`

### Responsibilities

Implement the standard `ProviderAdapterShape`:

- `startSession`
- `sendTurn`
- `interruptTurn`
- `respondToRequest`
- `respondToUserInput` (possibly unsupported initially)
- `readThread`
- `rollbackThread`
- `stopSession`
- `listSessions`
- `hasSession`
- `stopAll`
- `streamEvents`

### Runtime model

Each T3 thread should own a pi RPC subprocess and a persisted pi session file.

Suggested pi launch shape:

- `pi --mode rpc`
- `--session-dir <t3-managed-dir>`
- `--session <path>` when resuming
- `--model <id>` when explicitly selected
- `--thinking <level>` when needed
- `-e <t3-bridge-extension>`
- likely `--no-extensions` for v1 unless generic extension UI support is added

---

## Phase 4: Session persistence and recovery

### Objective
Make pi sessions recoverable through the existing provider session directory flow.

### Persist in `resumeCursor`

Suggested data:

- `sessionFile`
- `sessionId`
- selected model
- selected thinking level
- any other pi-specific recovery metadata needed

### Recovery flow

On recovery:

1. restart pi RPC process
2. reopen the saved `sessionFile`
3. restore model and thinking level if needed
4. continue routing turns normally

This should integrate cleanly with existing `ProviderService` recovery behavior.

---

## Phase 5: Approval bridge via bundled pi extension

### Objective
Support T3 Code's approval-required runtime mode using pi's extension system.

### Why this is needed

pi does not ship with a Codex-style native permission system. However, pi extensions can:

- intercept `tool_call`
- block tool execution
- ask the host for confirmation using `ctx.ui.confirm(...)`

In RPC mode, those requests are surfaced as `extension_ui_request` events.

### Plan

Ship a small bundled extension used only for T3-managed pi sessions.

It should:

- intercept `tool_call`
- when T3 runtime mode is `approval-required`, request confirmation
- classify tools into T3 approval types:
  - command
  - file-read
  - file-change
- allow or block tool execution based on host response

### Adapter-side behavior

The adapter should:

- translate `extension_ui_request(method="confirm")` into canonical `request.opened`
- hold pending approval state per request ID
- send `extension_ui_response` when the user approves/declines
- emit canonical `request.resolved`

For v1, only the confirm-based flow used by the bundled extension needs to be supported.

---

## Phase 6: Event mapping from pi RPC to canonical runtime events

### Objective
Map pi RPC events into the existing `ProviderRuntimeEvent` model used by orchestration.

### Mapping plan

#### Session lifecycle

- process/session startup → `session.started`
- state transitions → `session.state.changed`
- process exit/failure → `session.exited`

#### Turn lifecycle

- `turn_start` → `turn.started`
- `turn_end` / `agent_end` → `turn.completed` or `turn.aborted`

#### Assistant streaming

- `message_update.text_delta` → `content.delta` with `assistant_text`
- `message_update.thinking_delta` → `content.delta` with `reasoning_text`

#### Tool execution

- `tool_execution_start` → `item.started` and/or `tool.progress`
- `tool_execution_update` → `item.updated` / `tool.progress`
- `tool_execution_end` → `item.completed` / `tool.summary`

#### Errors

- RPC/protocol/process failures → `runtime.error`

This should be enough to light up the existing orchestration ingestion pipeline and timeline UI.

---

## Phase 7: Rollback strategy

### Objective
Support conversation rollback in a pi-compatible way.

### v1 approach

pi does not appear to expose a native Codex-style "rollback N turns" RPC operation.

Implement rollback via session branching:

1. query forkable user messages using `get_fork_messages`
2. choose the appropriate earlier user message
3. call `fork(entryId)`
4. update the persisted `resumeCursor` to the new session file

### Notes

- This is good enough for v1.
- If deeper tree navigation becomes important, reevaluate whether a future SDK-based implementation is warranted.

---

## Phase 8: Provider health

### Objective
Expose startup-time health information for pi in the same way as other providers.

### Plan

Extend:

- `apps/server/src/provider/Layers/ProviderHealth.ts`

Add a simple pi health probe:

- `pi --version`

Expected behavior:

- `available: true/false` depending on binary availability
- `authStatus: "unknown"`

Do not attempt generic pi auth validation in v1, since pi can be configured with many different underlying providers and auth mechanisms.

---

## Phase 9: Wire pi into the server

### Objective
Register and expose the new adapter.

### Files

- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- `apps/server/src/serverLayers.ts`

### Work

- register `PiAdapter`
- include it in provider registry wiring
- include it in server runtime/provider layers

---

## Phase 10: Web app integration

### Objective
Expose pi as a selectable provider in the UI.

### Files

- `apps/web/src/session-logic.ts`
- `apps/web/src/components/chat/ProviderModelPicker.tsx`
- `apps/web/src/components/Icons.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/appSettings.ts`
- `apps/web/src/routes/_chat.settings.tsx`
- `apps/web/src/store.ts`

### Work

- add Pi to provider picker
- add icon/label
- add settings such as:
  - `piBinaryPath`
  - pi custom model support if needed
- build `providerOptions.pi` and `modelOptions.pi` for dispatch
- remove any remaining dependence on model-string provider inference

---

## Phase 11: Testing

### Server/provider tests

Add or update:

- `apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts`
- `apps/server/src/provider/Layers/ProviderService.test.ts`
- new `PiAdapter` tests
- provider health tests

### Orchestration tests

Validate that pi events correctly drive:

- session lifecycle
- turn lifecycle
- assistant streaming
- tool activity
- approvals
- recovery
- rollback behavior

### Web tests

Update:

- provider picker tests
- settings tests
- session logic tests
- store/provider persistence tests

---

## Risks and decisions

## 1. Dynamic model discovery

### Fast v1

- support arbitrary pi model strings
- optionally expose custom models in settings

### Better long-term

- fetch pi models dynamically from the server via `get_available_models`
- avoid hardcoding model inventory into shared contracts

## 2. External pi extensions

For reliability, start with:

- bundled T3 bridge extension only
- generic user extension support disabled for T3-managed pi sessions

Reason:

- arbitrary pi extensions can emit extra `extension_ui_request` flows
- those would require more host-side UI protocol support than needed for v1

## 3. Rollback fidelity

Rollback via `fork()` is acceptable for v1, but may not fully match existing provider rollback semantics. Revisit if users expect exact in-place rewind behavior.

---

## Suggested implementation order

1. Persist thread provider explicitly
2. Add `pi` to shared contracts and settings types
3. Implement `PiAdapter` with RPC process and JSONL parser
4. Add bundled pi approval bridge extension
5. Map pi RPC events to canonical runtime events
6. Register pi in provider registry/server layers
7. Expose pi in the UI
8. Implement rollback via `fork`
9. Add tests
10. Run validation:
   - `bun lint`
   - `bun typecheck`

---

## MVP scope

Recommended initial shipping scope:

- start pi session
- send turns
- stream assistant text
- show tool activity
- abort turn
- approval-required flow via bundled extension
- session resume/recovery
- basic provider health

Follow-up scope:

- dynamic model discovery via `get_available_models`
- richer rollback/tree semantics
- broader extension UI support if needed

---

## Success criteria

The pi integration should be considered complete when:

- pi appears as a selectable provider in the UI
- a thread can start and resume a pi-backed session reliably
- streaming assistant output and tool activity appear in the timeline
- supervised mode triggers approval requests before tool execution
- provider selection persists correctly without model-string inference
- provider health reports pi availability
- `bun lint` passes
- `bun typecheck` passes
