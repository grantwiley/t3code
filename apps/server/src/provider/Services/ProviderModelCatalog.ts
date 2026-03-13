import { type ProviderKind } from "@t3tools/contracts";
import { Effect, ServiceMap } from "effect";

export interface ProviderDiscoveredModel {
  readonly slug: string;
  readonly name: string;
}

export interface ProviderModelCatalogShape {
  readonly listModels: (input: {
    readonly provider: ProviderKind;
    readonly binaryPath?: string;
  }) => Effect.Effect<ReadonlyArray<ProviderDiscoveredModel>>;
}

export class ProviderModelCatalog extends ServiceMap.Service<
  ProviderModelCatalog,
  ProviderModelCatalogShape
>()("t3/provider/Services/ProviderModelCatalog") {}
