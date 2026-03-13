import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  type ProviderSendTurnInput,
  type ProviderSession,
  ThreadId,
  TurnId,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ChatAttachment,
} from "@t3tools/contracts";
import { qualifyPiModelForLaunch } from "@t3tools/shared/model";
import { Effect, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = "pi" as const;
const RPC_TIMEOUT_MS = 30_000;
const PI_APPROVAL_BRIDGE_PATH_CANDIDATES = [
  new URL("../pi/t3-approval-bridge.mjs", import.meta.url),
  new URL("./pi-approval-bridge.mjs", import.meta.url),
] as const;

interface PiResumeCursor {
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
}

interface PiStateSnapshot {
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
}

interface PendingRpcResponse {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PiTurnState {
  readonly turnId: TurnId;
  readonly assistantItemId: RuntimeItemId;
  readonly startedAt: string;
  aborted: boolean;
  assistantHasVisibleOutput: boolean;
  readonly toolItemIds: Map<string, RuntimeItemId>;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly child: ChildProcessWithoutNullStreams;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly cwd?: string;
  readonly sessionDir: string;
  readonly binaryPath: string;
  readonly pendingResponses: Map<string, PendingRpcResponse>;
  readonly pendingApprovalTypes: Map<string, CanonicalRequestType>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly stderrChunks: Array<string>;
  buffer: string;
  nextRequestId: number;
  session: ProviderSession;
  pendingTurnId: TurnId | undefined;
  turnState: PiTurnState | undefined;
  stopped: boolean;
}

export interface PiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nowIso() {
  return new Date().toISOString();
}

function isoFromTimestamp(value: unknown): string {
  const timestamp = asNumber(value);
  return timestamp !== undefined ? new Date(timestamp).toISOString() : nowIso();
}

function readPiResumeCursor(value: unknown): PiResumeCursor | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const sessionFile = asString(record.sessionFile);
  const sessionId = asString(record.sessionId);
  const model = asString(record.model);
  const thinkingLevel = asString(record.thinkingLevel);
  return {
    ...(sessionFile ? { sessionFile } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

function readStateSnapshot(value: unknown): PiStateSnapshot {
  const record = asRecord(value) ?? {};
  const modelRecord = asRecord(record.model);
  return {
    ...(asString(record.sessionFile) ? { sessionFile: asString(record.sessionFile)! } : {}),
    ...(asString(record.sessionId) ? { sessionId: asString(record.sessionId)! } : {}),
    ...(asString(modelRecord?.id) ? { model: asString(modelRecord?.id)! } : {}),
    ...(asString(record.thinkingLevel)
      ? { thinkingLevel: asString(record.thinkingLevel)! }
      : {}),
  };
}

function buildResumeCursor(snapshot: PiStateSnapshot): PiResumeCursor {
  return {
    ...(snapshot.sessionFile ? { sessionFile: snapshot.sessionFile } : {}),
    ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
    ...(snapshot.model ? { model: snapshot.model } : {}),
    ...(snapshot.thinkingLevel ? { thinkingLevel: snapshot.thinkingLevel } : {}),
  };
}

function extractTextContent(value: unknown): string | undefined {
  const record = asRecord(value);
  const content = record?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((entry) => {
      const item = asRecord(entry);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}

function buildPiLaunchModel(
  model: string | undefined,
  thinkingLevel: string | undefined,
): string | undefined {
  const launchModel = qualifyPiModelForLaunch(model);
  if (!launchModel) {
    return undefined;
  }
  if (!thinkingLevel || launchModel.includes(":")) {
    return launchModel;
  }
  return `${launchModel}:${thinkingLevel}`;
}

function resolvePiApprovalBridgePath(): string {
  for (const candidate of PI_APPROVAL_BRIDGE_PATH_CANDIDATES) {
    const resolvedPath = fileURLToPath(candidate);
    if (existsSync(resolvedPath)) {
      return resolvedPath;
    }
  }

  throw new Error("Pi approval bridge asset is missing from the server package.");
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "bash" || normalized.includes("command") || normalized.includes("shell")) {
    return "command_execution";
  }
  if (normalized === "write" || normalized === "edit") {
    return "file_change";
  }
  return "dynamic_tool_call";
}

function summarizeToolArgs(args: unknown): string | undefined {
  const record = asRecord(args);
  const command = asString(record?.command);
  if (command) {
    const trimmed = command.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const targetPath = asString(record?.path);
  if (targetPath) {
    const trimmed = targetPath.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function providerError(method: string, detail: string, cause?: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function validationError(operation: string, issue: string): ProviderAdapterValidationError {
  return new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation,
    issue,
  });
}

function extractMessages(value: unknown): Array<{ id: TurnId; items: Array<unknown> }> {
  const record = asRecord(value);
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
  let turnIndex = 0;
  for (const message of messages) {
    const item = asRecord(message);
    if (item?.role === "user") {
      turns.push({ id: TurnId.makeUnsafe(`pi-turn-${turnIndex + 1}`), items: [message] });
      turnIndex += 1;
      continue;
    }
    const active = turns.at(-1);
    if (active) {
      active.items.push(message);
    }
  }
  return turns;
}

function resolvePiRequestTypeFromMethod(method: string, title?: string): CanonicalRequestType {
  if (method !== "confirm") {
    return "unknown";
  }
  const normalizedTitle = (title ?? "").toLowerCase();
  if (normalizedTitle.includes("file-read")) return "file_read_approval";
  if (normalizedTitle.includes("file-change")) return "file_change_approval";
  if (normalizedTitle.includes("command")) return "command_execution_approval";
  return "unknown";
}

function makeRuntimeEvent(
  event: Omit<ProviderRuntimeEvent, "provider">,
): ProviderRuntimeEvent {
  return {
    ...event,
    provider: PROVIDER,
  } as ProviderRuntimeEvent;
}

const makePiAdapter = (options?: PiAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();

    const publishRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const writeNativeRecord = (threadId: ThreadId, payload: unknown) =>
      nativeEventLogger ? nativeEventLogger.write(payload, threadId) : Effect.void;

    const refreshSessionState = async (context: PiSessionContext): Promise<void> => {
      const state = readStateSnapshot(
        await sendRpcCommand(context, { type: "get_state" }, "get_state"),
      );
      context.session = {
        ...context.session,
        model: state.model,
        resumeCursor: buildResumeCursor(state),
        activeTurnId: context.turnState?.turnId,
        updatedAt: nowIso(),
      };
    };

    const finalizeTurn = (context: PiSessionContext, reason: "completed" | "aborted") =>
      Effect.gen(function* () {
        const turn = context.turnState;
        if (!turn) {
          return;
        }
        context.turnState = undefined;
        context.pendingTurnId = undefined;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: nowIso(),
        };
        yield* publishRuntimeEvent(
          makeRuntimeEvent({
            eventId: EventId.makeUnsafe(crypto.randomUUID()),
            threadId: context.threadId,
            createdAt: nowIso(),
            turnId: turn.turnId,
            type: reason === "aborted" ? "turn.aborted" : "turn.completed",
            payload:
              reason === "aborted"
                ? { reason: "aborted" }
                : { state: turn.aborted ? "interrupted" : "completed" },
          }),
        );
        yield* publishRuntimeEvent(
          makeRuntimeEvent({
            eventId: EventId.makeUnsafe(crypto.randomUUID()),
            threadId: context.threadId,
            createdAt: nowIso(),
            type: "session.state.changed",
            payload: { state: "ready" },
          }),
        );
      });

    const stopProcess = (context: PiSessionContext) => {
      if (context.stopped) {
        return;
      }
      context.stopped = true;
      for (const pending of context.pendingResponses.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: context.threadId,
            detail: "Pi RPC process stopped before responding.",
          }),
        );
      }
      context.pendingResponses.clear();
      context.child.kill("SIGTERM");
    };

    const sendRpcCommand = (
      context: PiSessionContext,
      command: Record<string, unknown>,
      method: string,
      timeoutMs = RPC_TIMEOUT_MS,
    ): Promise<unknown> =>
      new Promise((resolve, reject) => {
        if (context.stopped) {
          reject(
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: context.threadId,
              detail: "Pi RPC process is not running.",
            }),
          );
          return;
        }
        const id = `${context.threadId}:${++context.nextRequestId}`;
        const timer = setTimeout(() => {
          context.pendingResponses.delete(id);
          reject(providerError(method, `Timed out waiting for '${method}' response.`));
        }, timeoutMs);
        context.pendingResponses.set(id, {
          command: method,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
          timer,
        });
        try {
          const payload = JSON.stringify({ id, ...command });
          void Effect.runFork(writeNativeRecord(context.threadId, { stdin: payload }));
          context.child.stdin.write(`${payload}\n`);
        } catch (error) {
          clearTimeout(timer);
          context.pendingResponses.delete(id);
          reject(providerError(method, `Failed to write '${method}' command.`, error));
        }
      });

    const startAssistantTurn = (context: PiSessionContext, createdAt: string) =>
      Effect.gen(function* () {
        if (context.turnState) {
          yield* finalizeTurn(context, context.turnState.aborted ? "aborted" : "completed");
        }
        const turnId = context.pendingTurnId ?? TurnId.makeUnsafe(crypto.randomUUID());
        const assistantItemId = RuntimeItemId.makeUnsafe(`pi:assistant:${crypto.randomUUID()}`);
        context.turnState = {
          turnId,
          assistantItemId,
          startedAt: createdAt,
          aborted: false,
          assistantHasVisibleOutput: false,
          toolItemIds: new Map(),
        };
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: createdAt,
        };
        yield* publishRuntimeEvent(
          makeRuntimeEvent({
            eventId: EventId.makeUnsafe(crypto.randomUUID()),
            threadId: context.threadId,
            createdAt,
            type: "session.state.changed",
            payload: { state: "running" },
          }),
        );
        yield* publishRuntimeEvent(
          makeRuntimeEvent({
            eventId: EventId.makeUnsafe(crypto.randomUUID()),
            threadId: context.threadId,
            createdAt,
            turnId,
            type: "turn.started",
            payload: context.session.model ? { model: context.session.model } : {},
          }),
        );
        yield* publishRuntimeEvent(
          makeRuntimeEvent({
            eventId: EventId.makeUnsafe(crypto.randomUUID()),
            threadId: context.threadId,
            createdAt,
            turnId,
            itemId: assistantItemId,
            type: "item.started",
            payload: {
              itemType: "assistant_message",
              title: "Assistant message",
              status: "inProgress",
            },
          }),
        );
      });

    const handleToolStart = (context: PiSessionContext, event: Record<string, unknown>) =>
      Effect.gen(function* () {
        const toolCallId = asString(event.toolCallId) ?? crypto.randomUUID();
        const toolName = asString(event.toolName) ?? "tool";
        const itemId = RuntimeItemId.makeUnsafe(`pi:tool:${toolCallId}`);
        if (context.turnState) {
          context.turnState.toolItemIds.set(toolCallId, itemId);
        }
        const createdAt = nowIso();
        const itemType = classifyToolItemType(toolName);
        const detail = summarizeToolArgs(event.args);
        yield* publishRuntimeEvent(
          makeRuntimeEvent({
            eventId: EventId.makeUnsafe(crypto.randomUUID()),
            threadId: context.threadId,
            createdAt,
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            itemId,
            type: "item.started",
            payload: {
              itemType,
              status: "inProgress",
              title: toolName,
              ...(detail ? { detail } : {}),
              ...(event.args !== undefined ? { data: event.args } : {}),
            },
          }),
        );
        yield* publishRuntimeEvent(
          makeRuntimeEvent({
            eventId: EventId.makeUnsafe(crypto.randomUUID()),
            threadId: context.threadId,
            createdAt,
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            itemId,
            type: "tool.progress",
            payload: {
              toolUseId: toolCallId,
              toolName,
              ...(detail ? { summary: detail } : {}),
            },
          }),
        );
      });

    const handleToolUpdate = (context: PiSessionContext, event: Record<string, unknown>) =>
      Effect.gen(function* () {
        const toolCallId = asString(event.toolCallId) ?? crypto.randomUUID();
        const toolName = asString(event.toolName) ?? "tool";
        const createdAt = nowIso();
        const itemId =
          context.turnState?.toolItemIds.get(toolCallId) ??
          RuntimeItemId.makeUnsafe(`pi:tool:${toolCallId}`);
        const detail = extractTextContent(event.partialResult) ?? summarizeToolArgs(event.args);
        yield* publishRuntimeEvent(
          makeRuntimeEvent({
            eventId: EventId.makeUnsafe(crypto.randomUUID()),
            threadId: context.threadId,
            createdAt,
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            itemId,
            type: "item.updated",
            payload: {
              itemType: classifyToolItemType(toolName),
              status: "inProgress",
              title: toolName,
              ...(detail ? { detail } : {}),
            },
          }),
        );
        yield* publishRuntimeEvent(
          makeRuntimeEvent({
            eventId: EventId.makeUnsafe(crypto.randomUUID()),
            threadId: context.threadId,
            createdAt,
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            itemId,
            type: "tool.progress",
            payload: {
              toolUseId: toolCallId,
              toolName,
              ...(detail ? { summary: detail } : {}),
            },
          }),
        );
      });

    const handleToolEnd = (context: PiSessionContext, event: Record<string, unknown>) =>
      Effect.gen(function* () {
        const toolCallId = asString(event.toolCallId) ?? crypto.randomUUID();
        const toolName = asString(event.toolName) ?? "tool";
        const createdAt = nowIso();
        const itemId =
          context.turnState?.toolItemIds.get(toolCallId) ??
          RuntimeItemId.makeUnsafe(`pi:tool:${toolCallId}`);
        const detail = extractTextContent(event.result) ?? summarizeToolArgs(event.result);
        const status = event.isError === true ? "failed" : "completed";
        yield* publishRuntimeEvent(
          makeRuntimeEvent({
            eventId: EventId.makeUnsafe(crypto.randomUUID()),
            threadId: context.threadId,
            createdAt,
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            itemId,
            type: "item.completed",
            payload: {
              itemType: classifyToolItemType(toolName),
              status,
              title: toolName,
              ...(detail ? { detail } : {}),
              ...(event.result !== undefined ? { data: event.result } : {}),
            },
          }),
        );
        if (detail) {
          yield* publishRuntimeEvent(
            makeRuntimeEvent({
              eventId: EventId.makeUnsafe(crypto.randomUUID()),
              threadId: context.threadId,
              createdAt,
              ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
              itemId,
              type: "tool.summary",
              payload: {
                summary: detail,
                precedingToolUseIds: [toolCallId],
              },
            }),
          );
        }
      });

    const handleRpcEvent = (context: PiSessionContext, event: Record<string, unknown>) =>
      Effect.gen(function* () {
        yield* writeNativeRecord(context.threadId, { stdout: event });
        switch (event.type) {
          case "agent_start": {
            yield* publishRuntimeEvent(
              makeRuntimeEvent({
                eventId: EventId.makeUnsafe(crypto.randomUUID()),
                threadId: context.threadId,
                createdAt: nowIso(),
                type: "session.state.changed",
                payload: { state: "running" },
              }),
            );
            return;
          }
          case "turn_start": {
            yield* startAssistantTurn(context, nowIso());
            return;
          }
          case "message_update": {
            const assistantMessageEvent = asRecord(event.assistantMessageEvent);
            if (!assistantMessageEvent || !context.turnState) {
              return;
            }
            const createdAt = isoFromTimestamp(asRecord(event.message)?.timestamp);
            const deltaType = asString(assistantMessageEvent.type);
            if (deltaType === "text_delta") {
              const delta = asString(assistantMessageEvent.delta);
              if (!delta) return;
              context.turnState.assistantHasVisibleOutput = true;
              yield* publishRuntimeEvent(
                makeRuntimeEvent({
                  eventId: EventId.makeUnsafe(crypto.randomUUID()),
                  threadId: context.threadId,
                  createdAt,
                  turnId: context.turnState.turnId,
                  itemId: context.turnState.assistantItemId,
                  type: "content.delta",
                  payload: {
                    streamKind: "assistant_text",
                    delta,
                    ...(asNumber(assistantMessageEvent.contentIndex) !== undefined
                      ? { contentIndex: asNumber(assistantMessageEvent.contentIndex)! }
                      : {}),
                  },
                }),
              );
              return;
            }
            if (deltaType === "thinking_delta") {
              const delta = asString(assistantMessageEvent.delta);
              if (!delta) return;
              yield* publishRuntimeEvent(
                makeRuntimeEvent({
                  eventId: EventId.makeUnsafe(crypto.randomUUID()),
                  threadId: context.threadId,
                  createdAt,
                  turnId: context.turnState.turnId,
                  itemId: context.turnState.assistantItemId,
                  type: "content.delta",
                  payload: {
                    streamKind: "reasoning_text",
                    delta,
                    ...(asNumber(assistantMessageEvent.contentIndex) !== undefined
                      ? { contentIndex: asNumber(assistantMessageEvent.contentIndex)! }
                      : {}),
                  },
                }),
              );
              return;
            }
            if (deltaType === "error") {
              yield* publishRuntimeEvent(
                makeRuntimeEvent({
                  eventId: EventId.makeUnsafe(crypto.randomUUID()),
                  threadId: context.threadId,
                  createdAt,
                  turnId: context.turnState.turnId,
                  type: "runtime.error",
                  payload: {
                    message: asString(assistantMessageEvent.error) ?? "Pi assistant stream failed.",
                    class: "provider_error",
                  },
                }),
              );
            }
            return;
          }
          case "message_end": {
            const message = asRecord(event.message);
            if (!context.turnState || message?.role !== "assistant") {
              return;
            }
            const createdAt = isoFromTimestamp(message.timestamp);
            const detail = extractTextContent(message);
            if (detail) {
              context.turnState.assistantHasVisibleOutput = true;
            }
            if (!context.turnState.assistantHasVisibleOutput && !detail) {
              return;
            }
            yield* publishRuntimeEvent(
              makeRuntimeEvent({
                eventId: EventId.makeUnsafe(crypto.randomUUID()),
                threadId: context.threadId,
                createdAt,
                turnId: context.turnState.turnId,
                itemId: context.turnState.assistantItemId,
                type: "item.completed",
                payload: {
                  itemType: "assistant_message",
                  status: context.turnState.aborted ? "failed" : "completed",
                  title: "Assistant message",
                  ...(detail ? { detail } : {}),
                  data: message,
                },
              }),
            );
            return;
          }
          case "tool_execution_start":
            return yield* handleToolStart(context, event);
          case "tool_execution_update":
            return yield* handleToolUpdate(context, event);
          case "tool_execution_end":
            return yield* handleToolEnd(context, event);
          case "agent_end": {
            yield* Effect.promise(() => refreshSessionState(context)).pipe(
              Effect.catch(() => Effect.void),
            );
            yield* finalizeTurn(context, context.turnState?.aborted ? "aborted" : "completed");
            return;
          }
          case "extension_ui_request": {
            const method = asString(event.method) ?? "unknown";
            if (method !== "confirm") {
              return;
            }
            const rawRequestId = asString(event.id) ?? crypto.randomUUID();
            const requestType = resolvePiRequestTypeFromMethod(method, asString(event.title));
            context.pendingApprovalTypes.set(rawRequestId, requestType);
            const requestId = RuntimeRequestId.makeUnsafe(rawRequestId);
            yield* publishRuntimeEvent(
              makeRuntimeEvent({
                eventId: EventId.makeUnsafe(crypto.randomUUID()),
                threadId: context.threadId,
                createdAt: nowIso(),
                ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
                requestId,
                type: "request.opened",
                payload: {
                  requestType,
                  ...(asString(event.message) ? { detail: asString(event.message)! } : {}),
                  args: event,
                },
              }),
            );
            return;
          }
          default:
            return;
        }
      });

    const wireChildProcess = (context: PiSessionContext) => {
      context.child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        context.buffer += text;
        while (true) {
          const newlineIndex = context.buffer.indexOf("\n");
          if (newlineIndex < 0) {
            break;
          }
          const rawLine = context.buffer.slice(0, newlineIndex);
          context.buffer = context.buffer.slice(newlineIndex + 1);
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (!line.trim()) {
            continue;
          }
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            if (message.type === "response") {
              const responseId = asString(message.id);
              const pending = responseId ? context.pendingResponses.get(responseId) : undefined;
              if (!pending) {
                void Effect.runFork(
                  publishRuntimeEvent(
                    makeRuntimeEvent({
                      eventId: EventId.makeUnsafe(crypto.randomUUID()),
                      threadId: context.threadId,
                      createdAt: nowIso(),
                      ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
                      type: "runtime.error",
                      payload: {
                        message:
                          asString(message.error) ??
                          `Received unexpected Pi RPC response for '${asString(message.command) ?? "unknown"}'.`,
                        class: "transport_error",
                      },
                      raw: {
                        source: "pi.rpc.response",
                        payload: message,
                        ...(asString(message.command)
                          ? { method: asString(message.command)! }
                          : {}),
                      },
                    }),
                  ),
                );
                continue;
              }
              context.pendingResponses.delete(responseId!);
              if (message.success === false) {
                pending.reject(
                  providerError(
                    pending.command,
                    asString(message.error) ?? `${pending.command} failed.`,
                  ),
                );
              } else {
                pending.resolve(message.data);
              }
              continue;
            }
            void Effect.runFork(handleRpcEvent(context, message));
          } catch (error) {
            void Effect.runFork(
              publishRuntimeEvent(
                makeRuntimeEvent({
                  eventId: EventId.makeUnsafe(crypto.randomUUID()),
                  threadId: context.threadId,
                  createdAt: nowIso(),
                  ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
                  type: "runtime.error",
                  payload: {
                    message: toMessage(error, "Failed to parse Pi RPC event."),
                    class: "transport_error",
                  },
                }),
              ),
            );
          }
        }
      });

      context.child.stderr.on("data", (chunk) => {
        context.stderrChunks.push(chunk.toString("utf8"));
      });

      context.child.on("close", (code, signal) => {
        if (!sessions.has(context.threadId)) {
          return;
        }
        sessions.delete(context.threadId);
        for (const pending of context.pendingResponses.values()) {
          clearTimeout(pending.timer);
          pending.reject(
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: context.threadId,
              detail: `Pi RPC process exited before '${pending.command}' completed.`,
            }),
          );
        }
        context.pendingResponses.clear();
        const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
        void Effect.runFork(
          publishRuntimeEvent(
            makeRuntimeEvent({
              eventId: EventId.makeUnsafe(crypto.randomUUID()),
              threadId: context.threadId,
              createdAt: nowIso(),
              type: "session.exited",
              payload: {
                reason,
                exitKind: code === 0 ? "graceful" : "error",
                recoverable: true,
              },
            }),
          ),
        );
      });
    };

    const startSession: PiAdapterShape["startSession"] = (input) =>
      Effect.promise(async () => {
        const existing = sessions.get(input.threadId);
        if (existing) {
          stopProcess(existing);
          sessions.delete(input.threadId);
        }

        const resumeCursor = readPiResumeCursor(input.resumeCursor);
        const binaryPath = input.providerOptions?.pi?.binaryPath ?? "pi";
        const sessionDir =
          input.providerOptions?.pi?.sessionDir ??
          path.join(serverConfig.stateDir, "provider", "pi", input.threadId);
        mkdirSync(sessionDir, { recursive: true });

        const launchModel = buildPiLaunchModel(
          input.model ?? resumeCursor?.model,
          input.modelOptions?.pi?.thinkingLevel ?? resumeCursor?.thinkingLevel,
        );
        const args = ["--mode", "rpc", "--session-dir", sessionDir];
        if (input.runtimeMode === "approval-required") {
          args.push("-e", resolvePiApprovalBridgePath());
        }
        if (resumeCursor?.sessionFile) {
          args.push("--session", resumeCursor.sessionFile);
        }
        if (launchModel) {
          args.push("--model", launchModel);
        }
        const child = spawn(binaryPath, args, {
          cwd: input.cwd,
          env: {
            ...process.env,
            T3_PI_RUNTIME_MODE: input.runtimeMode,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        const now = nowIso();
        const context: PiSessionContext = {
          threadId: input.threadId,
          child,
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          sessionDir,
          binaryPath,
          pendingResponses: new Map(),
          pendingApprovalTypes: new Map(),
          turns: [],
          stderrChunks: [],
          buffer: "",
          nextRequestId: 0,
          session: {
            provider: PROVIDER,
            status: "connecting",
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.model ? { model: input.model } : {}),
            threadId: input.threadId,
            createdAt: now,
            updatedAt: now,
          },
          pendingTurnId: undefined,
          turnState: undefined,
          stopped: false,
        };
        sessions.set(input.threadId, context);
        wireChildProcess(context);

        try {
          const state = readStateSnapshot(await sendRpcCommand(context, { type: "get_state" }, "get_state"));
          context.session = {
            ...context.session,
            status: "ready",
            ...(state.model ? { model: state.model } : {}),
            resumeCursor: buildResumeCursor(state),
            updatedAt: nowIso(),
          };
          void Effect.runFork(
            publishRuntimeEvent(
              makeRuntimeEvent({
                eventId: EventId.makeUnsafe(crypto.randomUUID()),
                threadId: input.threadId,
                createdAt: nowIso(),
                type: "session.started",
                payload: {
                  message: "Pi RPC session started",
                  resume: buildResumeCursor(state),
                },
              }),
            ),
          );
          void Effect.runFork(
            publishRuntimeEvent(
              makeRuntimeEvent({
                eventId: EventId.makeUnsafe(crypto.randomUUID()),
                threadId: input.threadId,
                createdAt: nowIso(),
                type: "thread.started",
                payload: state.sessionId ? { providerThreadId: state.sessionId } : {},
              }),
            ),
          );
          void Effect.runFork(
            publishRuntimeEvent(
              makeRuntimeEvent({
                eventId: EventId.makeUnsafe(crypto.randomUUID()),
                threadId: input.threadId,
                createdAt: nowIso(),
                type: "session.configured",
                payload: {
                  config: {
                    model: state.model ?? null,
                    thinkingLevel: state.thinkingLevel ?? null,
                    sessionFile: state.sessionFile ?? null,
                    sessionId: state.sessionId ?? null,
                  },
                },
              }),
            ),
          );
          void Effect.runFork(
            publishRuntimeEvent(
              makeRuntimeEvent({
                eventId: EventId.makeUnsafe(crypto.randomUUID()),
                threadId: input.threadId,
                createdAt: nowIso(),
                type: "session.state.changed",
                payload: { state: "ready" },
              }),
            ),
          );
          return context.session;
        } catch (error) {
          stopProcess(context);
          sessions.delete(input.threadId);
          throw new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(error, "Failed to initialize Pi RPC session."),
            cause: error,
          });
        }
      });

    const getContext = (threadId: ThreadId): PiSessionContext => {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return context;
    };

    const attachmentToPiImage = (attachment: ChatAttachment) => {
      const attachmentPath = resolveAttachmentPath({
        stateDir: serverConfig.stateDir,
        attachment,
      });
      if (!attachmentPath) {
        throw providerError(
          "prompt",
          `Attachment '${attachment.id}' could not be resolved on disk for Pi RPC.`,
        );
      }
      const base64 = readFileSync(attachmentPath).toString("base64");
      return {
        type: "image",
        data: base64,
        mimeType: attachment.mimeType,
      };
    };

    const sendTurn: PiAdapterShape["sendTurn"] = (input: ProviderSendTurnInput) =>
      Effect.promise(async () => {
        const context = getContext(input.threadId);
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        context.pendingTurnId = turnId;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: nowIso(),
          ...(input.model ? { model: input.model } : {}),
        };
        const images = (input.attachments ?? []).map(attachmentToPiImage);
        const message = input.input ?? "[User attached one or more images without additional text.]";
        await sendRpcCommand(
          context,
          {
            type: "prompt",
            message,
            ...(images.length > 0 ? { images } : {}),
          },
          "prompt",
        );
        return {
          threadId: input.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId) =>
      Effect.promise(async () => {
        const context = getContext(threadId);
        if (context.turnState) {
          context.turnState.aborted = true;
        }
        await sendRpcCommand(context, { type: "abort" }, "abort", 10_000);
      });

    const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.promise(async () => {
        const context = getContext(threadId);
        const requestType = context.pendingApprovalTypes.get(requestId) ?? "unknown";
        const confirmed = decision === "accept" || decision === "acceptForSession";
        await sendRpcCommand(
          context,
          {
            type: "extension_ui_response",
            id: requestId,
            confirmed,
          },
          "extension_ui_response",
          10_000,
        );
        context.pendingApprovalTypes.delete(requestId);
        void Effect.runFork(
          publishRuntimeEvent(
            makeRuntimeEvent({
              eventId: EventId.makeUnsafe(crypto.randomUUID()),
              threadId,
              createdAt: nowIso(),
              ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
              requestId: RuntimeRequestId.makeUnsafe(requestId),
              type: "request.resolved",
              payload: {
                requestType,
                decision,
                resolution: { confirmed },
              },
            }),
          ),
        );
      });

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.fail(
        providerError(
          "extension_ui_response",
          "Pi user-input requests are not yet supported by the server bridge.",
        ),
      );

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => {
        const context = getContext(threadId);
        stopProcess(context);
        sessions.delete(threadId);
      });

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values()).map((context) => context.session));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      Effect.promise(async () => {
        const context = getContext(threadId);
        const payload = await sendRpcCommand(context, { type: "get_messages" }, "get_messages");
        return {
          threadId,
          turns: extractMessages(payload),
        } satisfies ProviderThreadSnapshot;
      });

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.promise(async () => {
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          throw validationError("rollbackThread", "numTurns must be an integer >= 1.");
        }
        const context = getContext(threadId);
        const forkPayload = asRecord(
          await sendRpcCommand(context, { type: "get_fork_messages" }, "get_fork_messages"),
        );
        const messages = Array.isArray(forkPayload?.messages)
          ? forkPayload.messages.map((entry) => asRecord(entry)).filter((entry) => entry)
          : [];
        const keepCount = Math.max(0, messages.length - numTurns);
        if (keepCount === 0) {
          await sendRpcCommand(context, { type: "new_session" }, "new_session");
        } else {
          const target = messages[keepCount - 1];
          const entryId = asString(target?.entryId);
          if (!entryId) {
            throw providerError(
              "fork",
              `Pi could not find a fork target while rolling back ${numTurns} turns.`,
            );
          }
          const result = asRecord(await sendRpcCommand(context, { type: "fork", entryId }, "fork"));
          if (result?.cancelled === true) {
            throw providerError("fork", "Pi fork rollback was cancelled.");
          }
        }
        await refreshSessionState(context);
        context.turns.splice(0, context.turns.length);
        return {
          threadId,
          turns: extractMessages(
            await sendRpcCommand(context, { type: "get_messages" }, "get_messages"),
          ),
        } satisfies ProviderThreadSnapshot;
      });

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        for (const context of sessions.values()) {
          stopProcess(context);
        }
        sessions.clear();
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "restart-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies PiAdapterShape;
  });

export const PiAdapterLive = Layer.effect(PiAdapter, makePiAdapter());

export function makePiAdapterLive(options?: PiAdapterLiveOptions) {
  return Layer.effect(PiAdapter, makePiAdapter(options));
}
