import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { KeybindingRule, ResolvedKeybindingRule, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import type { ServerConfigShape } from "./config.ts";
import { ServerConfig } from "./config.ts";
import { makeRoutesLayer } from "./server.ts";
import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import { Keybindings, KeybindingsConfigError, type KeybindingsShape } from "./keybindings.ts";
import { ProviderHealth, type ProviderHealthShape } from "./provider/Services/ProviderHealth.ts";

const buildAppUnderTest = (options?: {
  config?: Partial<ServerConfigShape>;
  layers?: {
    keybindings?: Partial<KeybindingsShape>;
    providerHealth?: Partial<ProviderHealthShape>;
  };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempStateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
    const stateDir = options?.config?.stateDir ?? tempStateDir;
    const layerConfig = Layer.succeed(ServerConfig, {
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      stateDir,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      authToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      ...options?.config,
    });

    const appLayer = HttpRouter.serve(makeRoutesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Layer.mock(Keybindings)({
          streamChanges: Stream.empty,
          ...options?.layers?.keybindings,
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderHealth)({
          getStatuses: Effect.succeed([]),
          ...options?.layers?.providerHealth,
        }),
      ),
      Layer.provide(layerConfig),
    );

    yield* Layer.build(appLayer);
    return stateDir;
  });

const wsRpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerWebSocket(wsUrl)),
    Layer.provide(RpcSerialization.layerJson),
  );

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl)));

const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

const getWsServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `ws://127.0.0.1:${address.port}${pathname}`;
  });

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("routes GET /health through HttpRouter", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.get("/health");
      assert.equal(response.status, 200);
      assert.deepEqual(yield* response.json, { ok: true });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-static-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "router-static-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to dev URL when configured", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const url = yield* getHttpServerUrl("/foo/bar");
      const response = yield* Effect.promise(() => fetch(url, { redirect: "manual" }));

      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "http://127.0.0.1:5173/");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files from state dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-11111111-1111-4111-8111-111111111111";

      const stateDir = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        stateDir,
        relativePath: `${attachmentId}.bin`,
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-ok");

      const response = yield* HttpClient.get(`/attachments/${attachmentId}`);
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 404 for missing attachment id lookups", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.get(
        "/attachments/missing-11111111-1111-4111-8111-111111111111",
      );
      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.getConfig", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]()),
      );

      assert.equal(response.cwd, process.cwd());
      assert.deepEqual(response.keybindings, []);
      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.providers, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.upsertKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "k",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            upsertKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](rule)),
      );

      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.getConfig errors", () =>
    Effect.gen(function* () {
      const error = new KeybindingsConfigError({
        configPath: "/tmp/keybindings.json",
        detail: "expected JSON array",
      });
      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.fail(error),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]()).pipe(
          Effect.result,
        ),
      );

      assertFailure(result, error);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
