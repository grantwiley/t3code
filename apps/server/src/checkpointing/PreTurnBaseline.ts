import { type CheckpointRef, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";

import type { CheckpointStoreError } from "./Errors.ts";
import type { CheckpointStoreShape } from "./Services/CheckpointStore.ts";
import { checkpointRefForThreadTurn, resolveThreadWorkspaceCwd } from "./Utils.ts";

type CheckpointThreadLike = {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<{
    readonly checkpointTurnCount: number;
  }>;
};

type CheckpointProjectLike = {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
};

export type EnsurePreTurnBaselineResult =
  | {
      readonly status: "captured" | "exists";
      readonly cwd: string;
      readonly checkpointRef: CheckpointRef;
      readonly turnCount: number;
    }
  | {
      readonly status: "skipped-no-cwd";
    };

export function resolveCheckpointWorkspaceCwd(input: {
  readonly thread: CheckpointThreadLike;
  readonly projects: ReadonlyArray<CheckpointProjectLike>;
  readonly sessionCwd: string | undefined;
}): string | undefined {
  return (
    resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    }) ?? input.sessionCwd
  );
}

export function currentCheckpointTurnCount(
  checkpoints: ReadonlyArray<{
    readonly checkpointTurnCount: number;
  }>,
): number {
  return checkpoints.reduce(
    (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
    0,
  );
}

export const ensurePreTurnBaseline = (input: {
  readonly thread: CheckpointThreadLike;
  readonly projects: ReadonlyArray<CheckpointProjectLike>;
  readonly sessionCwd: string | undefined;
  readonly checkpointStore: Pick<CheckpointStoreShape, "captureCheckpoint" | "hasCheckpointRef">;
}): Effect.Effect<EnsurePreTurnBaselineResult, CheckpointStoreError> =>
  Effect.gen(function* () {
    const checkpointCwd = resolveCheckpointWorkspaceCwd(input);
    if (!checkpointCwd) {
      return { status: "skipped-no-cwd" } as const;
    }

    const turnCount = currentCheckpointTurnCount(input.thread.checkpoints);
    const checkpointRef = checkpointRefForThreadTurn(input.thread.id, turnCount);
    const baselineExists = yield* input.checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef,
    });
    if (baselineExists) {
      return {
        status: "exists",
        cwd: checkpointCwd,
        checkpointRef,
        turnCount,
      } as const;
    }

    yield* input.checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef,
    });

    return {
      status: "captured",
      cwd: checkpointCwd,
      checkpointRef,
      turnCount,
    } as const;
  });
