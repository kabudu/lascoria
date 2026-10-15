# Lascoria identity

Lascoria is the product name. The descriptor is **The spatial coding workspace** and the welcome line is **Give your agents room to work.** The lowercase wordmark is paired with an abstract folded-wing mark and a central point. It suggests the moth origin without an illustrated mascot or decorative star field.

## Product application

- Light mode remains the default: warm porcelain canvas, ink navy text, neutral lavender surfaces and periwinkle selection and actions.
- Dark mode uses the same hierarchy with ink surfaces and lighter periwinkle. Existing theme preferences are retained.
- Green means successful work, amber means attention and red means failure. Brand colours never replace those semantic signals. Status labels accompany colour.
- System sans-serif typography avoids external font requests. Monospace remains for code and technical values. Existing canvas gestures, floating panels, focus states and reduced-motion support are retained.
- Native window, app bundle, HTML title, welcome state, wordmark, favicon and private package metadata use Lascoria.

## Assets

`ui/public/brand/lascoria-mark.svg` is the compact transparent mark. `ui/public/brand/lascoria-icon.svg` is the native app icon source, with a rounded ink tile and lighter wings. Both are code-native vectors. The header mark is decorative alongside the accessible link name, "Lascoria workspace".

Generate native assets with the installed Tauri CLI:

```sh
npx tauri icon ui/public/brand/lascoria-icon.svg --output .dev/lascoria-icons
cp .dev/lascoria-icons/icon.png src-tauri/icons/icon.png
cp .dev/lascoria-icons/icon.icns src-tauri/icons/icon.icns
```

The Tauri configuration explicitly includes these icons. The ordinary desktop build remains unsigned and unbundled; an explicit development app build is `npx tauri build --bundles app`. This is not a signed or notarised distribution.

## Compatibility

The repository URL, Rust package/binary names, `SCH_*` configuration, `dev.constellation.harness` application identifier and `~/.spatial-constellation` state location remain stable. The original plan document retains its historical title. No state migration is needed for branding.

New isolated tasks use `lascoria/<session-id>` consistently in planned journal state and Git creation. Existing `weftara/` branches remain valid and are not renamed. The `weftara-workspace-v1` hash domain is intentionally unchanged so a cosmetic rebrand cannot invalidate existing workspace content identities or evidence. Archived sessions and presentation preferences remain in the existing store.

The name is user-selected following a preliminary collision screen, not trademark or domain clearance. No domain, package or trademark has been registered by this change.

## Validation, 15 October 2026

- Backend: all 24 Node tests and six Rust tests passed on Muse/SDK 1.4.9. The native saturation case emitted 1,536 actual Muse tool events, recovered a real stream gap on generation 1 and matched exact final text. The isolated-workspace lifecycle asserts that the journaled and actual new Git branch both use `lascoria/<session-id>`.
- Browser/bridge: all three Playwright workflows passed after the final UI changes, covering the synthetic projection benchmark, real Muse with a scripted loopback model through the Rust bridge, and isolated context/test/commit/archive operations. Welcome screens passed automated WCAG A/AA checks in light and dark modes at 800 x 600; the new mark loaded, the first-run panels were absent, and no horizontal overflow was observed. Repository-name and custom session-label headings were checked.
- Static/build: formatting, TypeScript and both Rust Clippy checks passed. The unsigned optimized native build and explicit `Lascoria.app` bundle build passed. Bundle metadata reports Lascoria for display/name, the existing application identifier, and the generated `icon.icns` resource.
- Native interaction: inspected the rebuilt Tauri WebView, light/dark themes, welcome state, wordmark, window/menu naming, archive checkbox alignment, native model selection, dragged effort slider, fit, zoom and panel collapse. Closed and reopened the GUI without stopping the separate supervisor. A fresh-state native launch confirmed the final uncluttered welcome screen.
- Live provider: the catalog-default route and Wonder initially returned `authRequired` despite the reported browser login. Imported the previously user-supplied ignored API credential through Muse's stdin command without printing it, then explicitly resumed the trial host. Wonder reached the live provider but returned HTTP 402, `billing_error`, with "Billing verification failed. Please check your payment method." The app retained and displayed the native error in the task map, inspector and attention queue. That API-key trial did not prove successful implementation or question resumption. The subscription-account follow-up below supersedes the earlier billing blocker.

The native trial repository and state are separate ignored `.dev/lascoria-live-source` and `.dev/lascoria-live-state` directories. A separate `.dev/lascoria-welcome-state` supports the first-run native inspection. Existing user sessions were not stopped or migrated. No API credential, account data or trial transcript is included in source control.


## Subscription-account follow-up, 15 October 2026

Muse's supported `muse login` browser flow completed with "Model API access verified." No environment `META_API_KEY` was set. A fresh trial host recovered the existing session and its Wonder model selection. An actual `muse-wonder-1.0` turn then read the fixture, raised a structured touching-endpoints question in native Attention, accepted an answer through the native app, implemented the interval merge function, expanded the tests and settled with native `terminal: completed`.

Muse's test run passed nine tests. A separate `node --test` invocation through the native Workspace panel also passed nine, with exit code 0 and identical before/after workspace content fingerprints. The native Diff panel captured and displayed the real changes; the Evidence panel reported current captured content after testing. No human attestation or automatic acceptance was fabricated. Failed API-key turns remain retained separately.

The prior HTTP 402 was an API-key-path result, not proof of a subscription billing problem. Browser-account access through the official Muse host and SDK is now verified for this trial. The original native app build and branding commit did not need code changes for the authentication route. Trial files remain isolated and uncommitted; account credentials remain managed by Muse and are not included in the repository.
