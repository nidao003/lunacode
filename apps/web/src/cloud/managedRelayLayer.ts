import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";

import { loadOrCreateProofKey } from "./dpop";
import { resolveCloudAuthMode } from "./publicConfig";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "indexed-db",
  loadOrCreateKey: loadOrCreateProofKey(),
});

const layerRelayHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.transformResponse(client, (effect) =>
      resolveCloudAuthMode() === "lunacode"
        ? Effect.provideService(effect, HttpClient.TracerPropagationEnabled, false)
        : effect,
    ),
  ),
);

export const layer = (relayUrl: string | (() => string)) =>
  ManagedRelay.layer({ relayUrl, clientId: RelayWebClientId }).pipe(
    Layer.provide(layerRelayHttpClient),
    Layer.provideMerge(layerRelayDpopSigner),
  );
