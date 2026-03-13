import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  type ProviderKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type TurnId,
} from "@t3tools/contracts";

import type { ChatMessage, ProposedPlan, SessionPhase, ThreadSession, TurnDiffSummary } from "./types";

export type ProviderPickerKind = ProviderKind | "claudeCode";

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeCode", label: "Claude Code", available: true },
  { value: "pi", label: "Pi", available: true },
  { value: "cursor", label: "Cursor", available: false },
];

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<string>;
  toolCall?: {
    name: string;
    status: "started" | "updated" | "completed";
    inputSummary?: ReadonlyArray<{
      label: string;
      value: string;
    }>;
  };
  tone: "thinking" | "tool" | "info" | "error";
  activityKind: string;
  task?: {
    id: string;
    phase: "started" | "progress" | "completed";
    type?: string;
    typeLabel?: string;
    status?: "completed" | "failed" | "stopped";
    lastToolName?: string;
  };
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function requestKindFromRequestType(
  requestType: unknown,
): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      detail?.includes("Unknown pending permission request")
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const candidates = ordered.filter((activity) => {
    if (activity.kind !== "turn.plan.updated") {
      return false;
    }
    if (!latestTurnId) {
      return true;
    }
    return activity.turnId === latestTurnId;
  });
  const latest = candidates.at(-1);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress"
          ? record.status
          : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload ? { explanation: payload.explanation as string | null } : {}),
    steps,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return {
        id: matchingTurnPlan.id,
        createdAt: matchingTurnPlan.createdAt,
        updatedAt: matchingTurnPlan.updatedAt,
        turnId: matchingTurnPlan.turnId,
        planMarkdown: matchingTurnPlan.planMarkdown,
      };
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return {
    id: latestPlan.id,
    createdAt: latestPlan.createdAt,
    updatedAt: latestPlan.updatedAt,
    turnId: latestPlan.turnId,
    planMarkdown: latestPlan.planMarkdown,
  };
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const taskTypeById = new Map<string, string>();
  return ordered
    .filter((activity) => (latestTurnId ? activity.turnId === latestTurnId : true))
    .filter((activity) => activity.kind !== "tool.started")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .map((activity) => {
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      const itemType = extractWorkLogItemType(payload);
      const requestKind = extractWorkLogRequestKind(payload);
      const toolCall = extractToolCall(payload, activity.kind);
      const command = extractToolCommand(payload);
      const changedFiles = extractChangedFiles(payload, itemType);
      const title = extractToolTitle(payload);
      const entry: WorkLogEntry = {
        id: activity.id,
        createdAt: activity.createdAt,
        label: activity.summary,
        activityKind: activity.kind,
        tone: activity.tone === "approval" ? "info" : activity.tone,
      };
      if (toolCall) {
        entry.toolCall = toolCall;
        entry.label = toolCall.name;
      }

      const payloadTaskId =
        payload && typeof payload.taskId === "string" && payload.taskId.length > 0
          ? payload.taskId
          : undefined;
      const payloadTaskType =
        payload && typeof payload.taskType === "string" && payload.taskType.length > 0
          ? payload.taskType
          : undefined;
      if (payloadTaskId && payloadTaskType) {
        taskTypeById.set(payloadTaskId, payloadTaskType);
      }

      const rememberedTaskType =
        payloadTaskType ?? (payloadTaskId ? taskTypeById.get(payloadTaskId) : undefined);
      const detail = workLogDetailFromPayload(payload);
      const lastToolName =
        payload && typeof payload.lastToolName === "string" && payload.lastToolName.length > 0
          ? payload.lastToolName
          : undefined;

      if (payloadTaskId && isTaskActivityKind(activity.kind)) {
        const taskPhase = taskPhaseFromActivityKind(activity.kind);
        const taskTypeLabel = humanizeTaskType(rememberedTaskType);
        entry.label = buildTaskLabel({
          phase: taskPhase,
          ...(taskTypeLabel ? { taskTypeLabel } : {}),
          ...((activity.kind === "task.completed" &&
            payload &&
            (payload.status === "completed" ||
              payload.status === "failed" ||
              payload.status === "stopped")
              ? { status: payload.status }
              : {}) as { status?: "completed" | "failed" | "stopped" }),
        });
        entry.tone =
          activity.kind === "task.completed" && payload?.status === "failed" ? "error" : "thinking";
        if (detail && !isRedundantToolDetail(detail, toolCall, command)) {
          entry.detail = detail;
        }
        if (command) {
          entry.command = command;
        }
        if (changedFiles.length > 0) {
          entry.changedFiles = changedFiles;
        }
        entry.task = {
          id: payloadTaskId,
          phase: taskPhase,
          ...(rememberedTaskType ? { type: rememberedTaskType } : {}),
          ...(taskTypeLabel ? { typeLabel: taskTypeLabel } : {}),
          ...(activity.kind === "task.completed" &&
          payload &&
          (payload.status === "completed" ||
            payload.status === "failed" ||
            payload.status === "stopped")
            ? { status: payload.status }
            : {}),
          ...(lastToolName ? { lastToolName } : {}),
        };
      } else if (detail && !isRedundantToolDetail(detail, toolCall, command)) {
        const normalizedDetail = stripTrailingExitCode(detail).output;
        if (normalizedDetail) {
          entry.detail = normalizedDetail;
        }
      }
      if (command) {
        entry.command = command;
      }
      if (changedFiles.length > 0) {
        entry.changedFiles = changedFiles;
      }
      if (title) {
        entry.toolTitle = title;
      }
      if (itemType) {
        entry.itemType = itemType;
      }
      if (requestKind) {
        entry.requestKind = requestKind;
      }
      return entry;
    });
}

function workLogDetailFromPayload(
  payload: Record<string, unknown> | null,
): string | undefined {
  if (!payload) {
    return undefined;
  }
  const candidates = [
    payload.detail,
    payload.message,
    payload.summary,
    payload.output,
    payload.stdout,
    payload.stderr,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

function truncateInline(value: string, maxLength = 72): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function humanizeInlineLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function formatToolInputLabel(key: string): string {
  switch (key) {
    case "file_path":
    case "filePath":
    case "notebook_path":
    case "notebookPath":
      return "path";
    case "old_string":
    case "oldString":
      return "find";
    case "new_string":
    case "newString":
      return "replace";
    case "max_results":
    case "maxResults":
      return "limit";
    default:
      return humanizeInlineLabel(key).toLowerCase();
  }
}

function summarizeToolInputValue(key: string, value: unknown): string | null {
  const text = asTrimmedString(value);
  if (text) {
    if (
      key === "content" ||
      key === "new_string" ||
      key === "newString" ||
      key === "old_string" ||
      key === "oldString" ||
      key === "prompt"
    ) {
      return `${text.length} chars`;
    }
    return truncateInline(text);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const scalarValues = value
      .map((entry) => summarizeToolInputValue(key, entry))
      .filter((entry): entry is string => entry !== null);
    if (scalarValues.length === 0) {
      return null;
    }
    const visibleValues = scalarValues.slice(0, 3);
    const joined = visibleValues.join(", ");
    return scalarValues.length > visibleValues.length
      ? `${truncateInline(joined, 56)} +${scalarValues.length - visibleValues.length}`
      : truncateInline(joined, 56);
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const nestedPath =
    asTrimmedString(record.path) ??
    asTrimmedString(record.filePath) ??
    asTrimmedString(record.file_path) ??
    asTrimmedString(record.relativePath);
  if (nestedPath) {
    return truncateInline(nestedPath);
  }
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return null;
  }
  const summary = keys.slice(0, 3).map(formatToolInputLabel).join(", ");
  return keys.length > 3 ? `${summary} +${keys.length - 3}` : summary;
}

function toolStatusFromActivityKind(
  activityKind: string,
): "started" | "updated" | "completed" | null {
  if (activityKind === "tool.started") return "started";
  if (activityKind === "tool.updated") return "updated";
  if (activityKind === "tool.completed") return "completed";
  return null;
}

function extractToolCall(
  payload: Record<string, unknown> | null,
  activityKind: string,
): WorkLogEntry["toolCall"] | undefined {
  const status = toolStatusFromActivityKind(activityKind);
  if (!status) {
    return undefined;
  }

  const data = asRecord(payload?.data);
  const toolName = asTrimmedString(data?.toolName);
  if (!toolName) {
    return undefined;
  }

  const input = asRecord(data?.input);
  const inputSummary =
    input === null
      ? []
      : Object.entries(input)
          .filter(([key]) => key !== "command" && key !== "cmd")
          .map(([key, value]) => {
            const summarizedValue = summarizeToolInputValue(key, value);
            if (!summarizedValue) {
              return null;
            }
            return {
              label: formatToolInputLabel(key),
              value: summarizedValue,
            };
          })
          .filter(
            (
              entry,
            ): entry is {
              label: string;
              value: string;
            } => entry !== null,
          )
          .slice(0, 4);

  return {
    name: toolName,
    status,
    ...(inputSummary.length > 0 ? { inputSummary } : {}),
  };
}

function isRedundantToolDetail(
  detail: string,
  toolCall: WorkLogEntry["toolCall"] | undefined,
  command: string | null,
): boolean {
  if (!toolCall) {
    return false;
  }
  const normalized = detail.trim();
  if (normalized.length === 0) {
    return true;
  }
  if (normalized === toolCall.name || normalized === `${toolCall.name}: {}`) {
    return true;
  }
  if (command && normalized === `${toolCall.name}: ${command}`) {
    return true;
  }
  return normalized.startsWith(`${toolCall.name}:`) && (toolCall.inputSummary?.length ?? 0) > 0;
}

function extractToolCommand(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const dataInput = asRecord(data?.input);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(dataInput?.command),
    normalizeCommandValue(dataInput?.cmd),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(data?.cmd),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
  includeDirectPaths: boolean,
) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1, includeDirectPaths);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  if (includeDirectPaths) {
    pushChangedFile(target, seen, record.path);
    pushChangedFile(target, seen, record.filePath);
    pushChangedFile(target, seen, record.file_path);
    pushChangedFile(target, seen, record.relativePath);
    pushChangedFile(target, seen, record.relative_path);
    pushChangedFile(target, seen, record.filename);
    pushChangedFile(target, seen, record.newPath);
    pushChangedFile(target, seen, record.new_path);
    pushChangedFile(target, seen, record.oldPath);
    pushChangedFile(target, seen, record.old_path);
  }

  for (const nestedKey of [
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
    ...(includeDirectPaths ? ["item", "result", "input", "data"] : []),
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1, includeDirectPaths);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null, itemType?: string): string[] {
  const data = asRecord(payload?.data);
  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0, itemType === "file_change");
  return changedFiles;
}

function isTaskActivityKind(activityKind: string): activityKind is "task.started" | "task.progress" | "task.completed" {
  return activityKind === "task.started" || activityKind === "task.progress" || activityKind === "task.completed";
}

function taskPhaseFromActivityKind(
  activityKind: "task.started" | "task.progress" | "task.completed",
): "started" | "progress" | "completed" {
  if (activityKind === "task.started") return "started";
  if (activityKind === "task.progress") return "progress";
  return "completed";
}

function humanizeTaskType(taskType: string | undefined): string | undefined {
  if (!taskType) {
    return undefined;
  }
  if (taskType === "local_agent") {
    return "Local agent";
  }
  return taskType
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildTaskLabel(input: {
  phase: "started" | "progress" | "completed";
  taskTypeLabel?: string;
  status?: "completed" | "failed" | "stopped";
}): string {
  if (input.phase === "started") {
    return "Started";
  }
  if (input.phase === "progress") {
    return "Working";
  }
  if (input.status === "failed") {
    return "Failed";
  }
  if (input.status === "stopped") {
    return "Stopped";
  }
  return "Completed";
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  return [...messageRows, ...proposedPlanRows, ...workRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
