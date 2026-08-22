# Cross-infrastructure integration

Import `CrossInfraView` directly from
`packages/architect/src/cross-infra/CrossInfraView.tsx` (the architect package
barrel is intentionally left to the integration pass). It accepts one required
prop:

```ts
{ onEnterWorkspace: (ws: string) => void }
```

Mount it for the infra deep link `#/architect/infra?scope=all`. Entering a
project must switch to `ws` and route back to that workspace's ordinary infra
view.

The client store is exported from `@crystal/client` as
`crossInfraStoreFor`, `createCrossInfraStore`, and their state/store types. The
view obtains the singleton for its bridge client, lazily loads map and overlay,
subscribes to `infra.crossChanged`, debounces data refreshes, guards local
pending overlay saves, and persists pins/environment selections. Integration
must not fetch these bridge methods or add another event subscription.

The integration pass still owns the architect toolbar/scope switch, mounting
logic, workspace handoff/navigation, and any architect package-barrel export.
