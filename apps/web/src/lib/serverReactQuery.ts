import { type ProviderKind } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
};

export function serverConfigQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.config(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getConfig();
    },
    staleTime: Infinity,
  });
}

export function providerModelsQueryOptions(provider: ProviderKind, binaryPath?: string | null) {
  const trimmedBinaryPath = binaryPath?.trim();
  return queryOptions({
    queryKey: ["server", "provider-models", provider, trimmedBinaryPath ?? null] as const,
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.listProviderModels({
        provider,
        ...(trimmedBinaryPath ? { binaryPath: trimmedBinaryPath } : {}),
      });
    },
    staleTime: Infinity,
  });
}
