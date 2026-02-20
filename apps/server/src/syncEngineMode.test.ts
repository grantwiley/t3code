import { describe, expect, it } from "vitest";
import { assertSyncEngineModeAllowed, resolveSyncEngineMode } from "./syncEngineMode";

describe("resolveSyncEngineMode", () => {
  it("defaults to livestore-read-pilot when env var is missing", () => {
    expect(resolveSyncEngineMode(undefined)).toBe("livestore-read-pilot");
    expect(resolveSyncEngineMode("")).toBe("livestore-read-pilot");
    expect(resolveSyncEngineMode("   ")).toBe("livestore-read-pilot");
  });

  it("accepts supported mode values case-insensitively", () => {
    expect(resolveSyncEngineMode("legacy")).toBe("legacy");
    expect(resolveSyncEngineMode("SHADOW")).toBe("shadow");
    expect(resolveSyncEngineMode("livestore-read-pilot")).toBe("livestore-read-pilot");
    expect(resolveSyncEngineMode("LIVESTORE")).toBe("livestore");
  });

  it("throws for unsupported values", () => {
    expect(() => resolveSyncEngineMode("something-else")).toThrow(
      /Invalid T3CODE_SYNC_ENGINE_MODE/i,
    );
  });
});

describe("assertSyncEngineModeAllowed", () => {
  it("allows any mode when enforcement is disabled", () => {
    expect(() => assertSyncEngineModeAllowed("legacy")).not.toThrow();
    expect(() => assertSyncEngineModeAllowed("shadow")).not.toThrow();
    expect(() => assertSyncEngineModeAllowed("livestore-read-pilot")).not.toThrow();
    expect(() => assertSyncEngineModeAllowed("livestore")).not.toThrow();
  });

  it("blocks legacy and shadow when enforceLiveStoreOnly is enabled", () => {
    expect(() =>
      assertSyncEngineModeAllowed("legacy", { enforceLiveStoreOnly: true }),
    ).toThrow(/disabled/i);
    expect(() =>
      assertSyncEngineModeAllowed("shadow", { enforceLiveStoreOnly: true }),
    ).toThrow(/disabled/i);
  });

  it("allows livestore modes when enforceLiveStoreOnly is enabled", () => {
    expect(() =>
      assertSyncEngineModeAllowed("livestore-read-pilot", { enforceLiveStoreOnly: true }),
    ).not.toThrow();
    expect(() =>
      assertSyncEngineModeAllowed("livestore", { enforceLiveStoreOnly: true }),
    ).not.toThrow();
  });
});
