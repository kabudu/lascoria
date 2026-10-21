# Product film assets

- [Watch the workspace film](lascoria-workspace.mp4)
- [Poster](lascoria-workspace-poster.webp)
- [English captions](lascoria-workspace.vtt)
- [Accessible transcript](lascoria-workspace-transcript.md)

The 24-second film introduces the spatial task map, helper agents, Attention, transcript, diff, revision-bound evidence and progressively disclosed model/usage details. The palette and folded-wing mark follow [Lascoria's identity](../branding.md).

Use the MP4 in a native video player with visible controls, the poster, the English VTT track and a transcript link. Do not force autoplay or hide playback controls. A linked poster is the appropriate GitHub README preview.

Regenerate explicitly with Python 3, Pillow and ffmpeg:

```sh
python3 scripts/media/render-promo.py
```

The generator searches for installed system sans-serif and monospace fonts on macOS, Linux and Windows; use `--font` and `--mono-font` to select specific installed fonts. No font files are redistributed. `--frames-only --out .dev/promo/review` generates the seven review frames. The generator is not part of app runtime or local CI. Output is 1280 by 720, H.264, 30 frames per second, silent, with fast-start metadata for web playback.

Button labels use measured visible glyph bounds for centring, rather than a fixed top offset. The permission frame is reviewed after decoding the encoded MP4.
