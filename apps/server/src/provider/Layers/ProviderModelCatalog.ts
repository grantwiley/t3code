import { spawn } from "node:child_process";

import { Effect, Layer } from "effect";

import {
  ProviderModelCatalog,
  type ProviderDiscoveredModel,
  type ProviderModelCatalogShape,
} from "../Services/ProviderModelCatalog.ts";

interface PiRpcModelRecord {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly provider?: unknown;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toProviderLabel(provider: string): string {
  return provider
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mapPiModels(rawModels: ReadonlyArray<PiRpcModelRecord>): ReadonlyArray<ProviderDiscoveredModel> {
  const idCounts = new Map<string, number>();
  for (const entry of rawModels) {
    const id = asTrimmedString(entry.id);
    if (!id) {
      continue;
    }
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  const mapped = new Map<string, ProviderDiscoveredModel>();
  for (const entry of rawModels) {
    const id = asTrimmedString(entry.id);
    const name = asTrimmedString(entry.name);
    const provider = asTrimmedString(entry.provider);
    if (!id || !name) {
      continue;
    }

    const slug = provider && (idCounts.get(id) ?? 0) > 1 ? `${provider}/${id}` : id;
    const label = provider && slug !== id ? `${name} · ${toProviderLabel(provider)}` : name;
    mapped.set(slug, { slug, name: label });
  }

  return [...mapped.values()].toSorted((left, right) => {
    const byName = left.name.localeCompare(right.name);
    return byName !== 0 ? byName : left.slug.localeCompare(right.slug);
  });
}

const listPiModels = (binaryPath?: string) =>
  Effect.promise<ReadonlyArray<ProviderDiscoveredModel>>(
    () =>
      new Promise((resolve, reject) => {
        const child = spawn(binaryPath?.trim() || "pi", ["--mode", "rpc", "--no-session"], {
          stdio: ["pipe", "pipe", "pipe"],
        });

        let settled = false;
        let stdoutBuffer = "";
        let stderrBuffer = "";
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }
          child.stdout.removeAllListeners();
          child.stderr.removeAllListeners();
          child.removeAllListeners();
          if (!child.killed) {
            child.kill();
          }
        };

        const fail = (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        };

        const succeed = (models: ReadonlyArray<ProviderDiscoveredModel>) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(models);
        };

        const handleStdoutChunk = (chunk: Buffer | string) => {
          stdoutBuffer += chunk.toString();
          while (true) {
            const newlineIndex = stdoutBuffer.indexOf("\n");
            if (newlineIndex === -1) {
              break;
            }
            const rawLine = stdoutBuffer.slice(0, newlineIndex);
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
            if (line.trim().length === 0) {
              continue;
            }

            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch (error) {
              fail(new Error(`Failed to parse Pi RPC response: ${String(error)}`));
              return;
            }

            if (!parsed || typeof parsed !== "object") {
              continue;
            }
            const record = parsed as Record<string, unknown>;
            if (record.type !== "response" || record.command !== "get_available_models") {
              continue;
            }

            if (record.success !== true) {
              const errorMessage =
                typeof record.error === "object" &&
                record.error &&
                "message" in record.error &&
                typeof record.error.message === "string"
                  ? record.error.message
                  : stderrBuffer.trim() || "Pi returned an unsuccessful get_available_models response.";
              fail(new Error(errorMessage));
              return;
            }

            const data =
              record.data && typeof record.data === "object"
                ? (record.data as Record<string, unknown>)
                : null;
            const models = Array.isArray(data?.models) ? (data.models as PiRpcModelRecord[]) : [];
            succeed(mapPiModels(models));
            return;
          }
        };

        child.once("error", fail);
        child.once("exit", (code, signal) => {
          if (settled) {
            return;
          }
          const detail = stderrBuffer.trim();
          fail(
            new Error(
              detail ||
                `Pi exited before returning available models (code=${String(code)}, signal=${String(signal)}).`,
            ),
          );
        });
        child.stdout.on("data", handleStdoutChunk);
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderrBuffer += chunk.toString();
        });

        timeoutId = setTimeout(() => {
          fail(new Error("Timed out waiting for Pi available models."));
        }, 8_000);

        child.stdin.write('{"id":"t3-pi-models","type":"get_available_models"}\n');
      }),
  );

const makeProviderModelCatalog = Effect.succeed({
  listModels: (input) => {
    switch (input.provider) {
      case "pi":
        return listPiModels(input.binaryPath).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to discover Pi models", {
              error,
              binaryPath: input.binaryPath,
            }).pipe(Effect.as([])),
          ),
        );
      case "codex":
      case "claudeCode":
      case "cursor":
      default:
        return Effect.succeed([]);
    }
  },
} satisfies ProviderModelCatalogShape);

export const ProviderModelCatalogLive = Layer.effect(ProviderModelCatalog, makeProviderModelCatalog);
