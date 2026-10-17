# Attachments in Lascoria

Status: design and release requirement R14, not an implemented attachment feature.

## Current behaviour

The workspace inspector can insert a bounded repository file excerpt into the task draft. The composer currently submits text or a typed Muse skill. It has no image/file picker, drag and drop, clipboard image intake, staged media store or attachment preview. A path in a prompt is not proof that file bytes were attached.

The pinned official SDK 1.4.10 (schema unchanged from 1.4.9) declares these native paths. Declarations establish the integration shape, not successful native/provider acceptance:

| Content | Native path | Lascoria requirement |
| --- | --- | --- |
| Repository files | Text with `@relative/path`; a structured mention part is rejected | Keep workspace scope visible; distinguish a reference from an included excerpt or uploaded bytes. |
| Images | `image` turn part with media type and base64 bytes | Stage privately, validate format/dimensions/size and submit through the normal explicit Send action. |
| Video | Chunked `media/upload` with session-owned upload receipt, then `video` input | Separate upload/retry/cancellation semantics; expose only after native/model compatibility and limits are proved. |
| PDF, audio, archives or arbitrary binary files | No general file input part in the pinned schema | Do not pretend these are supported by sending a filename or routing them through the video API. Prove a native supported path before enabling each format. |

Primary references: [turn input parts](https://meta-models.github.io/muse-code-sdk/next/generated/msp/types/turninputpart/), [media upload](https://meta-models.github.io/muse-code-sdk/next/generated/msp/methods/media-upload/). The website's next documentation can differ from the pinned SDK; installed types and real native trials on the pinned release determine shipped behaviour. Attachments on answers to Muse questions are reserved/rejected in the pinned schema and must not be advertised.

## Proposed composer experience

Use one small **Add attachment** control beside the composer. Dragging files over the workspace reveals a clear drop target at the composer; pasting an image adds it to the same draft. Selecting or dropping only stages locally. It never interrupts the active task or immediately sends a prompt/upload.

A compact strip above the text shows image thumbnails and file chips with name, type/size, status and an accessible remove action. Selecting a chip opens a preview with a keyboard-accessible close action. A long strip collapses excess items behind a count; it does not open another permanent floating panel. The exact message and attachment order remain visible before Send. Running tasks keep their activity visible while attachments wait in the draft; immediate steering requires a distinct supported action and native validation.

Make states clear: preparing, ready, sending, sent and needs attention. A bad or oversized file explains the limit beside that file. Retry or remove one item without discarding the prompt or other attachments. Unsupported types are rejected with an explanation. An interrupted/unknown send keeps the original request identity and attachment references; recovery must not submit duplicate model/tool work.

## Ownership and bounds

Attachments belong to a session draft, not the selected canvas node or a global clipboard history. Persist references and content fingerprints with the draft, with the same conflict/revision checks as text. Recover after normal close/reopen; explain unavailable/moved inputs. Pending input added by one session must never leak into another.

Keep staged bytes in app-private storage with explicit per-file, total draft, decoded image and retained-storage limits. Verify content signatures, actual file size and decoded dimensions; do not trust filenames or MIME declarations. Never execute attached content or silently follow links outside the selected scope. Treat document/image text as untrusted task data, not permission to run commands.

The normal control request is limited to 64 KiB. Do not raise that global limit or put base64 in the general command journal to make attachments fit. Add a narrow, bounded native staging boundary returning opaque session-owned IDs; stream bounded content through the SDK worker only on explicit send. No arbitrary frontend filesystem read command. Account/provider destination and any conversion must be visible before transmission; no hidden external conversion service.

Define safe cleanup with R5, resource/decode limits with R11, and staging/path/IPC/retention checks with R12. Record native format/model restrictions accurately in the UI. R14 acceptance requires actual image/file workflows on all supported operating systems, recovery, accessibility and privacy validation before completion.
