# Attachments in Lascoria

Status: R14 is partially implemented. Images (PNG, JPEG, GIF, WebP) can be added to a session's next task from 17 October; video, PDFs and other files are not supported yet. Native platform acceptance remains open.

## Current behaviour

The workspace inspector can insert a bounded repository file excerpt into the task draft. The composer submits text, a typed Muse skill, or text with images (see [Images](#images-implemented-17-october)). A path in a prompt is not proof that file bytes were attached.

The pinned official SDK 1.4.10 (schema unchanged from 1.4.9) declares these native paths. Declarations establish the integration shape, not successful native/provider acceptance:

| Content | Native path | Lascoria requirement |
| --- | --- | --- |
| Repository files | Text with `@relative/path`; a structured mention part is rejected | Keep workspace scope visible; distinguish a reference from an included excerpt or uploaded bytes. |
| Images | `image` turn part with media type and base64 bytes | Stage privately, validate format/dimensions/size and submit through the normal explicit Send action. |
| Video | Chunked `media/upload` with session-owned upload receipt, then `video` input | Separate upload/retry/cancellation semantics; expose only after native/model compatibility and limits are proved. |
| PDF, audio, archives or arbitrary binary files | No general file input part in the pinned schema | Do not pretend these are supported by sending a filename or routing them through the video API. Prove a native supported path before enabling each format. |

Primary references: [turn input parts](https://meta-models.github.io/muse-code-sdk/next/generated/msp/types/turninputpart/), [media upload](https://meta-models.github.io/muse-code-sdk/next/generated/msp/methods/media-upload/). The website's next documentation can differ from the pinned SDK; installed types and real native trials on the pinned release determine shipped behaviour. Attachments on answers to Muse questions are reserved/rejected in the pinned schema and must not be advertised.

## Images (implemented 17 October)

**Experience.** One **Add image** control sits under the composer text. Choosing, pasting into the composer or dropping onto it stages images for that session only; nothing is sent until the user starts a task. A compact strip shows each image with a thumbnail (for images added in this window), name, size and dimensions, preparing progress, a per-item error with Retry, and Remove. Waiting images survive reloads and appear in every window of the session. Send waits while an image is preparing or when more than four are waiting. Images are never sent with steering; the strip says so while a task runs. The transcript marks a user message that carried images ("1 image attached"). Help describes the limits.

**Boundary.** The supervisor owns staging under `<state>/attachments/<session>/`, created private (no links, user-only) and written only by these owner-authenticated operations: `attachment/begin` (open session only, announced size), `attachment/append` (ordered base64 chunks of at most 44 KiB, so the 64 KiB control limit is unchanged; an identical retried chunk is accepted, a different one refused), `attachment/finish` (complete size, SHA-256 and content check), `attachment/discard` and `attachment/list`. The type comes from the file header, never the name or declared MIME type, and dimensions come from the PNG, GIF, WebP or JPEG header. Limits: 5 MB per image, 6 MB and four images per task, eight waiting per session, 64 MB in total, 8192 pixels per side and 40 megapixels. Unfinished uploads expire after ten minutes when another begins. There is no frontend file-read command: bytes come from the browser's own file, paste or drop objects.

**Sending.** `turn.attachments` lists staged IDs in order. The supervisor resolves them for that session only and passes verified file paths to the session worker, which re-checks each SHA-256 and sends official `image` input parts after the task text. The command journal keeps IDs only, never bytes. After Muse acknowledges the task, which keeps the bytes in its own durable log, the staged copies are deleted; a retry with the same request returns the original command and sends nothing again. Archiving or removing a session deletes its waiting images. Images live outside the journal, so backups and exports do not include unsent images.

**Evidence.** Rust tests cover base64, header parsing for all four formats, malformed and oversized images, a PDF named `.png`, chunk order and retries, cross-session refusal and bounds. The real-Muse test (`test/attachments.test.js`, Muse 1.4.10 with a controlled loopback model) proves the image bytes reach the model request, the journal holds no bytes, Muse records image metadata on the user message, the staged copy is removed after sending and a retry sends nothing, and that unknown, cross-session, steering and archived-session cases are refused. The Rust-backed UI test (`test/ui/images.spec.ts`) covers choosing, an unsupported file, paste, reload persistence, remove, sending, the transcript marker, accessibility and narrow layout.

**Open.** Native picker, paste and drag-and-drop on macOS, Windows and Linux (the window now disables Tauri's own file-drop handling so the composer receives HTML drops; that needs native confirmation); behaviour with real provider models, including models without image input; R11 memory and CPU measurements for large images; video, PDFs and other files.

## Proposed composer experience

Use one small **Add attachment** control beside the composer. Dragging files over the workspace reveals a clear drop target at the composer; pasting an image adds it to the same draft. Selecting or dropping only stages locally. It never interrupts the active task or immediately sends a prompt/upload.

A compact strip above the text shows image thumbnails and file chips with name, type/size, status and an accessible remove action. Selecting a chip opens a preview with a keyboard-accessible close action. A long strip collapses excess items behind a count; it does not open another permanent floating panel. The exact message and attachment order remain visible before Send. Running tasks keep their activity visible while attachments wait in the draft; immediate steering requires a distinct supported action and native validation.

Make states clear: preparing, ready, sending, sent and needs attention. A bad or oversized file explains the limit beside that file. Retry or remove one item without discarding the prompt or other attachments. Unsupported types are rejected with an explanation. An interrupted/unknown send keeps the original request identity and attachment references; recovery must not submit duplicate model/tool work.

## Ownership and bounds

Attachments belong to a session draft, not the selected canvas node or a global clipboard history. Persist references and content fingerprints with the draft, with the same conflict/revision checks as text. Recover after normal close/reopen; explain unavailable/moved inputs. Pending input added by one session must never leak into another.

Keep staged bytes in app-private storage with explicit per-file, total draft, decoded image and retained-storage limits. Verify content signatures, actual file size and decoded dimensions; do not trust filenames or MIME declarations. Never execute attached content or silently follow links outside the selected scope. Treat document/image text as untrusted task data, not permission to run commands.

The normal control request is limited to 64 KiB. Do not raise that global limit or put base64 in the general command journal to make attachments fit. Add a narrow, bounded native staging boundary returning opaque session-owned IDs; stream bounded content through the SDK worker only on explicit send. No arbitrary frontend filesystem read command. Account/provider destination and any conversion must be visible before transmission; no hidden external conversion service.

Define safe cleanup with R5, resource/decode limits with R11, and staging/path/IPC/retention checks with R12. Record native format/model restrictions accurately in the UI. R14 acceptance requires actual image/file workflows on all supported operating systems, recovery, accessibility and privacy validation before completion.
