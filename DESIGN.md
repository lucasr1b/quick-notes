# Design notes

Quick Notes is a small always-on-top utility, so it borrows macOS's own rules
rather than inventing a look: restraint, one real material, type that changes
shape with size, and every action reachable from the keyboard.

## Material

The window is a real `NSVisualEffectView` (`vibrancy: "under-window"`). That was
already true, but the renderer used to paint an opaque `#191919` over it and
throw it away. Now `html` and `body` are fully transparent and exactly one
element tints the vibrancy:

| Layer | Token | Use |
|---|---|---|
| Window | `--material-window` | The single tint over the native blur (`.app-shell`) |
| Chrome | `--material-chrome` | Title bar, formatting bar: structural, barely there |
| Elevated | `--material-elevated` | Palette and browser panels, blurred and shadowed |
| Control | `--material-control` → `-hover` → `-active` | Buttons, fields, rows |

Rules that keep it coherent: nothing else paints an opaque background; floating
surfaces get a brighter top edge (`--edge-highlight`) so they read as light
catching a material; larger surfaces carry a deeper shadow than small chips.

## Typography

System font first (`-apple-system`), because SF ships optical sizing and
tracking tables no web font matches. Tracking is size-specific, never one value:

| Class | Size | Tracking | Rationale |
|---|---|---|---|
| `.type-title` | 13px / 590 | `-0.006em` | Titles tighten slightly |
| `.type-body` | 13px / 400 | `-0.003em` | Body sits near zero |
| `.type-meta` | 11px / 400 | `+0.008em` | Small text opens up to stay legible |
| `.type-section` | 10px / 600 | `+0.06em` | Uppercase needs air |
| Editor body | 13.5px | `-0.004em`, 1.62 leading | Long-form comfort |
| Headings | 1.35 / 1.12 / 0.97rem | `-0.021` → `-0.009em` | Tracking tightens as size grows |

Timestamps and key caps use `tabular-nums` so columns don't jitter.

## Motion

Critically damped, no overshoot: this is chrome that appears, not an object the
user threw. Panels `materialize` (blur + scale + translate together, 260ms,
`cubic-bezier(0.32, 0.72, 0, 1)`) from `transform-origin: top center`, anchored
to the title-bar controls that opened them. Buttons respond on press
(`:active { scale(0.96) }`, 100ms) rather than waiting for the click.

All of it collapses to a plain cross-fade under `prefers-reduced-motion`, and
the materials go solid under `prefers-reduced-transparency` and
`prefers-contrast: more`.

## Restraint

- The separator under the title bar only appears once content scrolls beneath
  it (`.scroll-edge[data-scrolled]`), instead of a permanent rule.
- Lists fade at their bottom edge (`.list-fade`), so a half-visible row reads as
  "there's more" rather than as a clipping bug.
- Row actions are absolutely positioned where the timestamp sits, so hovering a
  row never reflows it.
- The open note keeps a faint resting pill (the control material) and a
  brighter title, instead of a coloured edge or a red dot that read as an error.
- Browser rows show a content snippet instead of a character count: more useful,
  and one line shorter.

## Keyboard

⌘N new · ⌘P browse · ⌘K commands · ⌘R rename · ⏎ open · esc close. Shortcut
hints sit under the placeholder but stay hidden until you hold ⌘, and only on a
blank note - a reminder when reached for, never clutter. Held-key state clears
on blur and tab-hide, or a ⌘Tab away would leave them stuck on. Key caps are a
shared `.kbd` component so every surface shows the same glyphs.
