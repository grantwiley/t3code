import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger";
import { PersistenceService } from "../persistenceService";
import { LegacyStateSyncEngine } from "../stateSyncEngineLegacy";
import { bootstrapMirrorFromCatchUp } from "./mirrorBootstrap";
import { LiveStoreStateMirror } from "./liveStoreEngine";
import { diffStateSnapshots } from "./parity";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bootstrapMirrorFromCatchUp", () => {
  it("mirrors catch-up history into the mirror sink", async () => {
    const mirrorStateEvent = vi.fn();
    const source = {
      catchUp: vi.fn().mockReturnValue({
        events: [
          {
            seq: 1,
            entityId: "project-1",
            eventType: "project.upsert",
            payload: { id: "project-1", name: "Demo", path: "/demo" },
            createdAt: new Date().toISOString(),
          },
          {
            seq: 2,
            entityId: "thread-1",
            eventType: "thread.upsert",
            payload: { id: "thread-1", title: "Thread" },
            createdAt: new Date().toISOString(),
          },
        ],
        lastStateSeq: 2,
      }),
    };

    const result = await bootstrapMirrorFromCatchUp({
      source,
      mirror: { mirrorStateEvent },
      logger: createLogger("mirror-bootstrap-test"),
    });

    expect(result).toEqual({
      mirroredCount: 2,
      lastStateSeq: 2,
      complete: true,
    });
    expect(mirrorStateEvent).toHaveBeenCalledTimes(2);
  });

  it("returns partial progress when non-fatal mirroring errors occur", async () => {
    const mirrorStateEvent = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("mirror write failed");
      });
    const source = {
      catchUp: vi.fn().mockReturnValue({
        events: [
          {
            seq: 1,
            entityId: "project-1",
            eventType: "project.upsert",
            payload: { id: "project-1", name: "Demo", path: "/demo" },
            createdAt: new Date().toISOString(),
          },
          {
            seq: 2,
            entityId: "thread-1",
            eventType: "thread.upsert",
            payload: { id: "thread-1", title: "Thread" },
            createdAt: new Date().toISOString(),
          },
        ],
        lastStateSeq: 2,
      }),
    };

    const result = await bootstrapMirrorFromCatchUp({
      source,
      mirror: { mirrorStateEvent },
      logger: createLogger("mirror-bootstrap-test"),
    });

    expect(result).toEqual({
      mirroredCount: 1,
      lastStateSeq: 2,
      complete: false,
    });
    expect(mirrorStateEvent).toHaveBeenCalledTimes(2);
  });

  it("throws when failOnError is enabled", async () => {
    const mirrorStateEvent = vi.fn().mockImplementation(() => {
      throw new Error("mirror write failed");
    });
    const source = {
      catchUp: vi.fn().mockReturnValue({
        events: [
          {
            seq: 1,
            entityId: "project-1",
            eventType: "project.upsert",
            payload: { id: "project-1", name: "Demo", path: "/demo" },
            createdAt: new Date().toISOString(),
          },
        ],
        lastStateSeq: 1,
      }),
    };

    await expect(
      bootstrapMirrorFromCatchUp({
        source,
        mirror: { mirrorStateEvent },
        logger: createLogger("mirror-bootstrap-test"),
        failOnError: true,
      }),
    ).rejects.toThrow(/failed to bootstrap livestore mirror/i);
  });

  it("treats mirrorStateEvent false return as a bootstrap failure", async () => {
    const source = {
      catchUp: vi.fn().mockReturnValue({
        events: [
          {
            seq: 1,
            entityId: "project-1",
            eventType: "project.upsert",
            payload: { id: "project-1", name: "Demo", path: "/demo" },
            createdAt: new Date().toISOString(),
          },
        ],
        lastStateSeq: 1,
      }),
    };

    const result = await bootstrapMirrorFromCatchUp({
      source,
      mirror: { mirrorStateEvent: vi.fn().mockResolvedValue(false) },
      logger: createLogger("mirror-bootstrap-test"),
    });

    expect(result).toEqual({
      mirroredCount: 0,
      lastStateSeq: 1,
      complete: false,
    });
  });

  it("replays persisted legacy catch-up history into a real LiveStore mirror", async () => {
    const stateDir = makeTempDir("t3code-bootstrap-replay-state-");
    const projectDir = makeTempDir("t3code-bootstrap-replay-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService: service });
    const mirror = new LiveStoreStateMirror({ storeId: "bootstrap-replay-parity-test" });

    try {
      const project = legacy.addProject({ cwd: projectDir }).project;
      const thread = legacy.createThread({
        projectId: project.id,
        title: "Bootstrap replay parity thread",
      }).thread;
      service.bindSessionToThread("bootstrap-replay-session", thread.id, "runtime-thread-bootstrap");
      service.persistUserMessageForTurn({
        sessionId: "bootstrap-replay-session",
        clientMessageId: "bootstrap-message-1",
        clientMessageText: "bootstrap replay parity",
        input: "bootstrap replay parity",
        attachments: [],
      });

      const expectedSnapshot = legacy.loadSnapshot();
      const bootstrapResult = await bootstrapMirrorFromCatchUp({
        source: legacy,
        mirror,
        logger: createLogger("mirror-bootstrap-test"),
        failOnError: true,
      });

      expect(bootstrapResult.complete).toBe(true);
      expect(bootstrapResult.lastStateSeq).toBe(expectedSnapshot.lastStateSeq);
      expect(bootstrapResult.mirroredCount).toBeGreaterThan(0);
      expect(diffStateSnapshots(expectedSnapshot, mirror.debugReadSnapshot())).toEqual([]);
    } finally {
      await mirror.dispose();
      service.close();
    }
  });
});
