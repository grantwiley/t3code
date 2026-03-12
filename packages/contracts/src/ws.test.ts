import { expect, it } from "vitest";
import { Schema } from "effect";

import { ORCHESTRATION_WS_CHANNELS, ORCHESTRATION_WS_METHODS } from "./orchestration";
import { WebSocketRequest, WsResponse, WS_CHANNELS, WS_METHODS } from "./ws";

const decodeWebSocketRequest = Schema.decodeUnknownSync(WebSocketRequest);
const decodeWsResponse = Schema.decodeUnknownSync(WsResponse);

it("accepts getTurnDiff requests when fromTurnCount <= toTurnCount", () => {
  const parsed = decodeWebSocketRequest({
    id: "req-1",
    body: {
      _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    },
  });
  expect(parsed.body._tag).toBe(ORCHESTRATION_WS_METHODS.getTurnDiff);
});

it("rejects getTurnDiff requests when fromTurnCount > toTurnCount", () => {
  expect(() =>
    decodeWebSocketRequest({
      id: "req-1",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      },
    }),
  ).toThrow();
});

it("trims websocket request id and nested orchestration ids", () => {
  const parsed = decodeWebSocketRequest({
    id: " req-1 ",
    body: {
      _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
      threadId: " thread-1 ",
      fromTurnCount: 0,
      toTurnCount: 0,
    },
  });
  expect(parsed.id).toBe("req-1");
  expect(parsed.body._tag).toBe(ORCHESTRATION_WS_METHODS.getTurnDiff);
  if (parsed.body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
    expect(parsed.body.threadId).toBe("thread-1");
  }
});

it("accepts git.preparePullRequestThread requests", () => {
  const parsed = decodeWebSocketRequest({
    id: "req-pr-1",
    body: {
      _tag: WS_METHODS.gitPreparePullRequestThread,
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    },
  });
  expect(parsed.body._tag).toBe(WS_METHODS.gitPreparePullRequestThread);
});

it("accepts typed websocket push envelopes with sequence", () => {
  const parsed = decodeWsResponse({
    type: "push",
    sequence: 1,
    channel: WS_CHANNELS.serverWelcome,
    data: {
      cwd: "/tmp/workspace",
      projectName: "workspace",
    },
  });

  expect("type" in parsed && parsed.type === "push").toBe(true);
  if (!("type" in parsed) || parsed.type !== "push") {
    throw new Error("expected websocket response to decode as a push envelope");
  }

  expect(parsed.type).toBe("push");
  expect(parsed.sequence).toBe(1);
  expect(parsed.channel).toBe(WS_CHANNELS.serverWelcome);
});

it("rejects push envelopes when channel payload does not match the channel schema", () => {
  expect(() =>
    decodeWsResponse({
      type: "push",
      sequence: 2,
      channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
      data: {
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    }),
  ).toThrow();
});
