import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

function classifyTool(toolName) {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "bash" || normalized.includes("command") || normalized.includes("shell")) {
    return "command";
  }
  if (normalized === "write" || normalized === "edit") {
    return "file-change";
  }
  return "file-read";
}

function summarizeToolCall(event) {
  if (isToolCallEventType("bash", event)) {
    return event.input.command;
  }
  if (isToolCallEventType("read", event)) {
    return event.input.path;
  }
  if (isToolCallEventType("write", event)) {
    return event.input.path;
  }
  if (isToolCallEventType("edit", event)) {
    return event.input.path;
  }
  return event.toolName;
}

export default function registerT3PiApprovalBridge(pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (process.env.T3_PI_RUNTIME_MODE !== "approval-required") {
      return;
    }
    const requestKind = classifyTool(event.toolName);
    const detail = summarizeToolCall(event);
    const confirmed = await ctx.ui.confirm(
      `Approve ${requestKind}`,
      `Allow ${event.toolName} to run?\n\n${detail}`,
    );
    if (!confirmed) {
      return {
        block: true,
        reason: `Declined ${requestKind}`,
      };
    }
  });
}
