# Lucienne

Lucienne explores translating familiar creative-workflow preferences into another
application's supported layout and controls. The host validates a bounded plan,
applies supported operations through an adapter, checks readback, and owns session
reset. A passive companion displays the host's public progress snapshots.

This source preview defaults to a **local fixture**. The source profiles are
simulated examples; choosing Photoshop does not inspect an installed Photoshop
workspace. A passing fixture demonstrates the software flow, not a successful
native translation, shortcut-equivalence check, or complete native reset.

## Run the local fixture

Use Node.js **22.22.3 or newer**, npm, and a graphical desktop suitable for Electron.
From this directory:

```sh
npm ci
npm run start:fixture
```

The fixture uses prepared data and simulated adapters. It needs no provider key
or service deployment. `npm start` selects the same fixture. The default build
bundles the product source while skipping macOS native-helper compilation.

Selected deterministic tests and the companion preview are available separately:

```sh
npm test
npm run companion:test
npm run companion:dev
```

Open `http://127.0.0.1:4173/fixture.html` for the companion fixture. This independent
preview is not a connection to the Electron fixture.

This snapshot passed validation in a disposable copy using already-installed,
pinned dependencies:

- Core and contract tests: **96/96 passed**.
- Companion tests: **45/45 passed**.
- Root TypeScript check and fixture build passed.
- Companion TypeScript check, build and browser-boundary checks passed.
- The hidden Electron IPC fixture smoke exited successfully, returned to `idle`
  after 40 updates, kept renderer Node access disabled, and confirmed fixture-only
  and generic-selection flows.

A clean `npm ci` installation was **not rerun**. These checks made no native-app
or provider requests and do not validate native operation or hosted integrations.

## Source layout

- `contracts/` defines validated requests, patches, events and host boundaries.
- `core/` coordinates planning, application, readback, chat changes and reset.
- `apps/main/` contains the Electron host and renderer.
- `adapters/` contains Krita, Blender, REAPER and Kdenlive adapter implementations.
- `apps/companion/` contains the companion and its local fixture.
- `services/planner/` contains Factory and direct Claude transports. The model
  selection is pinned to Opus 5.5; providers never receive authority to execute
  arbitrary native operations.
- `services/preparation/` contains optional preparation, retrieval and quiz code.
- `services/session/` contains the SpacetimeDB transport and module, with a Convex
  implementation retained behind the same session boundary.
- `services/telemetry/` contains optional PostgreSQL/Tiger Data telemetry code.
- `profiles/` contains simulated personas and bounded reference summaries.
- `qa/` contains native evidence collection and acceptance logic, not saved results.

## Native and hosted setup is unfinished in this snapshot

Native source is included for review. Machine-specific paths were replaced with
`PUBLIC_NATIVE_*_REQUIRED` sentinels. Native launch, recovery and pairing still
require an explicitly configured dedicated account, matching console ownership,
application versions, helper paths, permissions and verified baselines. Do not
remove the account/console guards or treat this snapshot as a ready native demo.
`npm run build:native-source` additionally requires macOS and Xcode Command Line
Tools; compiling helpers does not complete native setup or prove a native loop.

No deployment, account configuration, credentials, native captures or saved
acceptance results are included. Factory, Claude, preparation providers, telemetry
and companion backends require the operator's own configuration and separate
verification. The fixture does not exercise those integrations.

Optional MOSS retrieval additionally expects an operator-installed `@moss-js/moss`
1.21.0 with `@moss-js/moss-core` 0.36.0, selected through the trusted host's
`LUCIENNE_MOSS_SDK_PATH`. These packages are not in this lockfile. Persona and
local-curated preparation do not require that optional SDK.

The SpacetimeDB companion entry connects only when the build receives
`VITE_SPACETIME_DATABASE`. Without it, the page shows an unconfigured message. The
database name is configuration, not a credential. Do not place credentials or
pairing capabilities in Vite environment variables or URLs. Backend deployment,
pairing and strict event-validator compatibility remain separate setup work.

The pinned Apify document approvals are absent. The artifact loader deliberately
returns `APIFY_ARTIFACT_REVIEW_REQUIRED`; reviewed document approvals must be
supplied before enabling that path. Local curated reference and persona
preparation remain available in source.

## References and licensing

`profiles/reference/` contains short paraphrases with source titles, public URLs,
version scope and integrity hashes. They describe documented behavior; they do
not establish compatibility with an installed application or native verification.
Application names are used to identify supported source concepts and adapter
targets; third-party applications are not redistributed here.

No project license has been selected for this snapshot. Dependency licenses remain
those of their respective packages. Redistribution of the project and its brand
asset requires the project's licensing and authorship review.
