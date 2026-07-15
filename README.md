# i miss you — live lyric video

A DOM-rendered, frame-accurate recreation of the "I Miss You" lyric video
(clay and kelsy), synced live to the song. Every emoji is a native-resolution
crop of the actual 4K master frame (including the video's recolored ones —
black silhouettes, blue sadness, the black 💯). The cursor is the video's
current emoji, ringed in a circle; drag any word or emoji and fling it away
to dissolve it. Works with mouse and touch.

- `index.html` — stage, emoji cursor, landing, end card. Bump `?v=N` after every edit.
- `styles.css` — type roles, emoji cursor, landing/endcard.
- `app.js` — engine: audio clock → `renderAt(t)`, crisp fit-to-px sizing, pointer interactions, `window.__iam.freeze(t)` debug.
- `cues.js` — the frame-exact timeline (30fps segmentation of the source).
- `assets/i-miss-you.mp3` — the song. `assets/emoji/*.png` — 107 source-frame crops.

Embed on WordPress with `wordpress-embed.html` (full-bleed iframe + iOS chrome sync).
