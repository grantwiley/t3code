import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { KeybindingsConfigError } from "./keybindings";
import { ServerConfig, ServerUpsertKeybindingInput, ServerUpsertKeybindingResult } from "./server";
import { WS_METHODS } from "./ws";

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  success: ServerConfig,
  error: KeybindingsConfigError,
});

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsRpcGroup = RpcGroup.make(WsServerGetConfigRpc, WsServerUpsertKeybindingRpc);
