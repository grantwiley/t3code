import { Effect, FileSystem, Layer, Path } from "effect";
import {
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { ServerConfig } from "./config";
import { Keybindings } from "./keybindings";
import { Open, resolveAvailableEditors } from "./open";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { resolveWorkspaceWritePath, searchWorkspaceEntries } from "./workspaceEntries";

const WsRpcLayer = WsRpcGroup.toLayer({
  [WS_METHODS.serverGetConfig]: () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const keybindings = yield* Keybindings;
      const providerHealth = yield* ProviderHealth;
      const keybindingsConfig = yield* keybindings.loadConfigState;
      const providers = yield* providerHealth.getStatuses;

      return {
        cwd: config.cwd,
        keybindingsConfigPath: config.keybindingsConfigPath,
        keybindings: keybindingsConfig.keybindings,
        issues: keybindingsConfig.issues,
        providers,
        availableEditors: resolveAvailableEditors(),
      };
    }),
  [WS_METHODS.serverUpsertKeybinding]: (rule) =>
    Effect.gen(function* () {
      const keybindings = yield* Keybindings;
      const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
      return { keybindings: keybindingsConfig, issues: [] };
    }),
  [WS_METHODS.projectsSearchEntries]: (input) =>
    Effect.tryPromise({
      try: () => searchWorkspaceEntries(input),
      catch: (cause) =>
        new ProjectSearchEntriesError({
          message: "Failed to search workspace entries",
          cause,
        }),
    }),
  [WS_METHODS.projectsWriteFile]: (input) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = yield* resolveWorkspaceWritePath({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
      yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectWriteFileError({
              message: "Failed to prepare workspace path",
              cause,
            }),
        ),
      );
      yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectWriteFileError({
              message: "Failed to write workspace file",
              cause,
            }),
        ),
      );
      return { relativePath: target.relativePath };
    }),
  [WS_METHODS.shellOpenInEditor]: (input) =>
    Effect.gen(function* () {
      const open = yield* Open;
      return yield* open.openInEditor(input);
    }),
});

export const websocketRpcRouteLayer = RpcServer.layerHttp({
  group: WsRpcGroup,
  path: "/ws",
  protocol: "websocket",
}).pipe(Layer.provide(WsRpcLayer), Layer.provide(RpcSerialization.layerJson));
