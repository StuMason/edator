# Edator style guide

Two distinct visual voices. Never mix them — the contrast is the whole point: a
viewer should instantly know whether they're seeing **the production** (the
presenter's brand) or **the AI's commentary** (EdAtor's).

> The EdAtor bubble palette (§1) is fixed in the renderer. The production palette
> (§2) below is the author's own brand, shown here as a worked example — swap the
> colours/fonts for your own.

## 1. EdAtor commentary — Anthropic / Claude palette

The editor's own voice: cheeky asides, reactions, signed comments. Renders as a
**chat bubble** so it reads as a third party messaging about the speaker.

| Token | Value | Use |
|------|-------|-----|
| Cream | `#F0EEE6` | bubble fill, sender-tag text |
| Ink | `#141413` | message text |
| Coral | `#D97757` | sender tag ("EdAtor") fill |

- Sender tag **"EdAtor"** always present (coral chip, cream text) above the bubble.
- Bubble: cream fill, ink text, Arial Bold.
- **Collision rule:** auto-placed in the corner *opposite* the camera PiP (PiP
  bottom-right → bubble bottom-left). Never overlaps the speaker.
- Renderer: `captions: [{ style:"editor", text, start, end }]` (corner auto).

## 2. Production additions — stumasondev brand

Idents, lower-thirds, section labels, diagrams, code/resource cards. Derived from
**ai.stumason.dev**.

| Token | Value | Use |
|------|-------|-----|
| Navy-black | `#0B0E14` | backgrounds, label strips |
| Orange-red | `#FF5436` | accent: eyebrows, rules, buttons |
| Cool white | `#EAF0F7` | headings |
| Grey | `#7A8294` | sub-headings / secondary |

- **Signature element:** orange, UPPERCASE, monospace **eyebrow** label with a
  leading `—` (e.g. `—  THE SETUP`). Menlo. This is the brand's tell.
- Headings: **Mozilla Headline Bold** — the real font from ai.stumason.dev,
  downloaded to `assets/fonts/MozillaHeadline-Bold.ttf` (via Google Fonts API as
  TTF, since drawtext needs TTF/OTF not woff2). Body: *Instrument Sans*
  (`assets/fonts/`). Eyebrows: Menlo (mono).
- Idents: navy bg, `STU MASON` mono wordmark top-left, orange eyebrow + accent
  rule, big white title. See `assets/ident.mp4`.
- Renderer: `captions: [{ style:"label", text }]` (orange eyebrow strip).

## Fonts
- `EDATOR_FONT` → Arial Bold (headings, EdAtor bubbles)
- `EDATOR_MONO` → Menlo (eyebrow labels, wordmarks)
- `assets/fonts/InstrumentSans.ttf` → body, for future image-based additions

## Known refinements (not yet done)
- drawtext can't letter-space the mono eyebrows (brand uses tracking).
- No colour emoji (drawtext is mono-glyph) — keep additions text/vector.
- Generated diagrams/code cards (the "co-producer" additions) will be authored as
  images in this palette, then composited — keep them on-brand per the tables above.
