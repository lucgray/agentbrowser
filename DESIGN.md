# AgentBrowser / AgentBrowser design system v1

One brand, two surfaces. AgentBrowser is the Chrome side panel (`agentchat/extension/`). AgentBrowser is the older
bridge extension (`extension/`): a popup plus an on-page overlay injected into the controlled tab.

Every value below is a token. Use the token, not the literal. Where a rule says "must", a review should reject
the change if it is not followed.

Reference direction: restraint, whitespace as the layout tool, a small type scale, one accent used sparingly,
precision over decoration. Colors and fonts are ours: green on near-black, system fonts only.

## 1. Principles

1. Whitespace is the layout. Space separates things before borders or background fills do.
2. One accent. Green means action or live state, nothing else. Never decoration, never a heading color.
3. Text before chrome. A message is text on the background; only the user's own turn gets a container.
4. Motion reports state. If nothing is happening, nothing moves.
5. Nothing overflows sideways. Wide content scrolls inside its own box, never the panel.

## 2. Color tokens

Near-black surface ramp, three steps. `bg-0` is the panel background, `bg-1` is a raised bar or floating
surface, `bg-2` is an inset field or card.

| Token | Value | Use |
|---|---|---|
| `--ac-bg-0` | `#0b0f0d` | body, message list |
| `--ac-bg-1` | `#0f1512` | header, popup surface, banner base |
| `--ac-bg-2` | `#141c18` | composer card, code block, input field, table header |
| `--ac-border` | `#1f2b25` | all 1px borders, control outlines |
| `--ac-border-soft` | `#17211c` | header rule, code block border, hairline dividers |
| `--ac-text` | `#dbe5df` | body copy, headings, primary labels |
| `--ac-text-secondary` | `#9aa8a0` | metadata, chip labels, placeholder, secondary rows |
| `--ac-text-muted` | `#6f7d75` | timestamps, disabled text, micro labels |
| `--ac-accent` | `#22c55e` | primary button fill, links, live state, focus |
| `--ac-accent-hover` | `#2ee06d` | hover on accent-filled controls |
| `--ac-accent-pressed` | `#16a34a` | active/pressed on accent-filled controls, focus-within border |
| `--ac-accent-tint` | `rgba(34, 197, 94, 0.13)` | accent surfaces at rest: logo tile, selected row, dragover |
| `--ac-accent-tint-strong` | `rgba(34, 197, 94, 0.22)` | accent surface under hover, pill fill on page overlay |
| `--ac-success` | `#22c55e` | tool succeeded, hub connected |
| `--ac-error` | `#f87171` | failed turn, failed tool, disconnected |
| `--ac-error-bg` | `rgba(248, 113, 113, 0.12)` | error banner fill, destructive hover fill |
| `--ac-error-border` | `rgba(248, 113, 113, 0.40)` | error banner and Stop button border |
| `--ac-warn` | `#d9a441` | tool pending, degraded state |
| `--ac-warn-bg` | `rgba(217, 164, 65, 0.12)` | warning banner fill |
| `--ac-warn-border` | `rgba(217, 164, 65, 0.40)` | warning banner border |
| `--ac-focus-ring` | `#22c55e` | `outline: 2px solid var(--ac-focus-ring); outline-offset: 2px` |
| `--ac-on-accent` | `#06210f` | text and glyphs on an accent-filled control |

Rules:

- Accent appears at most twice in a resting screen: the status dot and the send button. Anything else that is
  green must be reporting a live state.
- Success and accent share a hex on purpose. Keep both tokens; they diverge if the accent ever changes.
- No gradients. No colored text except accent links, `--ac-error`, `--ac-warn`, and the muted ramp.

### Old to new token mapping

The existing `agentchat/extension/sidepanel.css` `:root` block is replaced. Rename as follows.

| Current | New | Note |
|---|---|---|
| `--bg` | `--ac-bg-0` | same value |
| `--panel` | `--ac-bg-1` | same value |
| `--card` `#111815` | `--ac-bg-2` | value moves to `#141c18`; card and field merge into one step |
| `--field` | `--ac-bg-2` | same value, one token now |
| `--border` | `--ac-border` | same value |
| `--border-soft` | `--ac-border-soft` | same value |
| `--text` | `--ac-text` | same value |
| `--text-dim` `#7f8d85` | `--ac-text-secondary` / `--ac-text-muted` | split; secondary lightens to `#9aa8a0` |
| `--accent` | `--ac-accent` | same value |
| `--accent-dim` | `--ac-accent-pressed` | same value |
| `--accent-soft` | `--ac-accent-tint` | same value |
| `--user-bubble` `#15251d` | `--ac-accent-tint` over `--ac-bg-0` | drop the opaque hex, use the tint |
| `--user-border` `#23412f` | `--ac-border` | user card no longer gets a green border |
| `--ok` | `--ac-success` | same value |
| `--err` | `--ac-error` | same value |
| `--warn` | `--ac-warn` | same value |

## 3. Type

No webfonts. MV3 pages load no remote CSS or font files. Richness comes from the system faces themselves,
not from a downloaded family: the `ui-*` generics lead both stacks, so a modern Chrome picks the UI-optimised
face (SF Pro, Segoe UI Variable, Roboto) over the legacy alias, and the stylistic sets those faces ship are
switched on.

```css
--ac-font: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--ac-font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
--ac-font-features: "cv05" 1, "ss01" 1;
```

Five sizes. There is no sixth. Markdown headings map onto `title` and `body` with weight, not new sizes.

Each type token is a `font:` shorthand, applied as `font: var(--ac-type-body);`. Tracking is a separate
declaration because `font:` cannot carry it; apply it only where the table gives a non-zero value.

| Token | Value (`font:` shorthand) | Size / line-height / weight | Tracking | Use |
|---|---|---|---|---|
| `--ac-type-title` | `600 16.5px/1.35 var(--ac-font)` | 16.5px / 1.35 / 600 | `0.1px` | panel title, settings title, markdown h1 and h2 |
| `--ac-type-body` | `400 15px/1.6 var(--ac-font)` | 15px / 1.6 / 400 | `0` | messages, input, markdown paragraphs and list items |
| `--ac-type-secondary` | `400 13px/1.5 var(--ac-font)` | 13px / 1.5 / 400 | `0` | chip labels, mention rows, banner, work block head, settings labels |
| `--ac-type-code` | `400 13px/1.55 var(--ac-font-mono)` | 13px / 1.55 / 400 | `0` | `code`, `pre`, tool chips, tables, key fields |
| `--ac-type-micro` | `500 11.5px/1.4 var(--ac-font)` | 11.5px / 1.4 / 500 | `0.3px` | message metadata, turn meta line, elapsed counter, file size |

Rules:

- `--ac-type-code` carries the mono family; the other four carry `--ac-font`. Setting a type token sets the
  family too, so do not also declare `font-family`.
- Where a component needs one property only (a weight override on a heading, for example), override that
  property after the shorthand. Never invent a size outside the five above.
- Body line-height is 1.6 and must not drop below 1.5.
- `body` carries `font-feature-settings: var(--ac-font-features)` and `-webkit-font-smoothing: antialiased`.
  Both are page-level; no component re-declares them.
- Anything that shows a number that changes in place (elapsed counter, token counts, file sizes, message
  metadata) sets `font-variant-numeric: tabular-nums`, so the text does not jitter as digits swap.
- Markdown h1 and h2 use `--ac-type-title` at weight 600. h3 through h6 use `--ac-type-body` at weight 600;
  h4 through h6 additionally take `--ac-text-secondary` color. No heading is green.
- Weight carries hierarchy. Do not add a 16px or 17px step to make a heading louder.
- `--ac-type-micro` is the only size allowed to use uppercase, and only for fixed labels.

## 4. Spacing

Eight steps. `N` is the pixel value. 4, 8, 12, 16, 20 and 24 are the layout scale; 10 and 14 are the two
half-steps, and they exist so the values the density mandate fixes by name (a 10px header pad, a 14px
composer pad, a `10px 14px` user bubble, a 10px paragraph gap) are still tokens rather than literals.
Reach for a half-step only where the mandate names one.

| Token | Value |
|---|---|
| `--ac-space-4` | 4px |
| `--ac-space-8` | 8px |
| `--ac-space-10` | 10px (half-step) |
| `--ac-space-12` | 12px |
| `--ac-space-14` | 14px (half-step) |
| `--ac-space-16` | 16px |
| `--ac-space-20` | 20px |
| `--ac-space-24` | 24px |

The scale governs layout spacing: gaps between elements, margins, and the padding of containers (panel,
message list, composer card, popup surface). The interior padding of a control or chip is optical, not layout,
and is specified per component in section 7; those values (`5px 12px` on a ghost button, `4px 10px` in a table
cell) are deliberate and are not scale violations. Layout spacing has no such license.

| Slot | Token |
|---|---|
| inline gap (icon to label, chip internals) | `--ac-space-4` |
| control gap in a row (buttons, chips in a wrap row, action row) | `--ac-space-8` |
| gap inside one turn (work block to reply to action row) | `--ac-space-8` |
| card padding (popup rows, work block body) | `--ac-space-12` |
| panel horizontal padding (header, composer margin) | `--ac-space-12` |
| composer card padding | `--ac-space-14` |
| message list horizontal padding | `--ac-space-16` |
| message gap in the list | `--ac-space-16` |
| message list vertical padding, settings view padding | `--ac-space-20` |
| section gap in the settings view | `--ac-space-20` |
| block gap around a horizontal rule | `--ac-space-24` |

### Density mandate

The panel was cramped, and then it was still tight. These are the concrete before and after values; the
Required column is the spec. The "was" column is the v1 value where v1 already moved it.

| Slot | Was | Required |
|---|---|---|
| title type | `15px/1.35` | `16.5px/1.35` |
| body type | `14px/1.55` | `15px/1.6` |
| secondary type | `12.5px/1.5` | `13px/1.5` |
| code type | `12.5px/1.5` | `13px/1.55` |
| micro type | `11px/1.4` | `11.5px/1.4` |
| `#messages` padding | `16px 12px` | `20px 16px` |
| `#messages` gap | `12px` | `16px` |
| `#header` padding | `10px 12px` | `10px 12px`, and the header wraps |
| `#header` gap | `8px` | `8px` |
| `#composer` margin | `0 12px 12px` | `0 12px 12px` |
| `#composer` padding | `12px` | `14px` |
| `#composer` gap | `8px` | `8px` |
| `.msg.user` padding | `8px 12px` | `10px 14px` |
| `.msg.assistant p` margin-bottom | `10px` | `10px` |
| `pre` padding | `10px 12px` | `10px 12px` |
| `th`, `td` padding | `2px 6px` | `4px 10px` |
| `button` padding | `3px 9px` | `5px 12px` |
| icon button hit area | `26px` | `28px` |

Any new gap, margin, or container padding must come from the scale. A layout `gap: 7px` or `margin: 18px` is
a bug; use a step or a named half-step.

## 5. Shape and depth

| Token | Value | Use |
|---|---|---|
| `--ac-radius-control` | `6px` | buttons, inputs, select, icon buttons, code spans |
| `--ac-radius-card` | `10px` | composer, mention popup, `pre`, user message |
| `--ac-radius-pill` | `999px` | tab chips, file chips, on-page agent pill |
| `--ac-shadow-card` | `0 8px 24px rgba(0, 0, 0, 0.55)` | see below |

Border width is always `1px`, written literally. There is no width token because there is no second width.

Rules:

- Separation is a 1px border, not a shadow. There is exactly one shadow token.
- `--ac-shadow-card` has two consumers only: the composer card, and the mention popup that anchors inside it.
  The popup is part of the composer surface, which is why it shares the token. Nothing else gets a shadow.
- The status dot's ring is `box-shadow: 0 0 0 3px var(--ac-accent-tint)`. That is a ring, not depth, and is
  exempt from the shadow rule.
- The user message keeps the asymmetric corner: `10px 10px 4px 10px`.

## 6. Motion

| Token | Value | Use |
|---|---|---|
| `--ac-dur-fast` | `120ms` | hover, focus, color and border transitions |
| `--ac-dur-base` | `200ms` | element appear or dismiss, popup open, overlay fade in |
| `--ac-dur-exit` | `400ms` | on-page overlay fade out after idle |
| `--ac-ease` | `cubic-bezier(0.2, 0, 0.2, 1)` | all one-shot transitions |
| `--ac-ease-loop` | `ease-in-out` | looping animations only |
| `--ac-loop-mic` | `1100ms` | mic listening pulse |
| `--ac-loop-status` | `1600ms` | streaming cursor blink, live status dot |

Rules:

- Motion communicates state: streaming cursor, mic pulse, status dot, tool chip pending. Nothing else animates.
- Looping animations use the loop tokens and are exempt from the 120/200 ramp. Do not "fix" a 1100ms pulse to
  200ms; a state indicator that cycles four times a second reads as a glitch.
- No transitions on layout properties (`width`, `height`, `margin`). Transition `opacity`, `color`,
  `background-color`, `border-color`, `box-shadow`, `transform`.
- Honor `@media (prefers-reduced-motion: reduce)`: drop all looping animations to a static state (cursor stays
  visible, mic button stays filled), keep one-shot transitions.

## 7. Components

### Header

| Property | Value |
|---|---|
| background | `--ac-bg-1` |
| padding | `10px 12px` |
| gap | `--ac-space-8` |
| bottom border | `1px solid var(--ac-border-soft)` |
| logo tile | 22px square, `--ac-radius-control`, `--ac-accent-tint` fill, `--ac-accent` glyph, 14px icon |
| title | `--ac-type-title`, `--ac-text` |
| adapter select | `--ac-bg-2`, `1px solid var(--ac-border)`, `--ac-radius-control`, `--ac-type-secondary`, padding `4px 8px`, `max-width: 160px`, `min-width: 0` |
| model select | same as the adapter select, `max-width: 140px`; `hidden` when the selected adapter reports no models |
| settings button | ghost icon spec below, gear glyph, `aria-label="Settings"`, `aria-expanded` tracks the settings view |
| New chat button | ghost button spec below |

The header sets `flex-wrap: wrap`. Two selects, a gear and a text button do not fit one line in a narrow
panel, and the row must wrap rather than clip or push the body sideways.

### Status dot

| State | Fill | Ring | Motion |
|---|---|---|---|
| connected idle | `--ac-accent` | `0 0 0 3px var(--ac-accent-tint)` | none |
| connected working | `--ac-accent` | same | opacity 1 to 0.4, `--ac-loop-status`, `--ac-ease-loop`, infinite |
| disconnected | `--ac-error` | `0 0 0 3px var(--ac-error-bg)` | none |

Size 8px, `border-radius: 50%`, `flex: none`. The dot carries a `title` attribute with the literal state.

### Chips and pills

| Type | Spec |
|---|---|
| tab chip | `--ac-radius-pill`, `--ac-bg-2`, `1px solid var(--ac-border)`, padding `3px 4px 3px 10px`, gap `--ac-space-4`, `--ac-type-secondary`, `--ac-text-secondary`, `min-width: 0` |
| tab chip, current tab | border `--ac-accent-pressed`, text `--ac-text`, mark glyph `--ac-accent` |
| tab chip, off | `opacity: 0.65`, italic |
| chip label | `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px` |
| chip dismiss (x) | 20px square, `--ac-radius-pill`, transparent, `--ac-text-muted`; hover `--ac-error` on `--ac-error-bg` |
| file chip | tab chip plus a size suffix in `--ac-type-micro` / `--ac-text-muted` |

### Turn

One assistant turn is one `.turn` wrapper: `display: flex; flex-direction: column; align-self: stretch;
gap: var(--ac-space-8); max-width: 100%; min-width: 0`. Its children arrive in the order the turn produced
them: the work block (normally first, since a `status` event opens it before the first token), the reply,
any info or error line, then the action row and the meta line, which are appended when the turn ends. A
block opened after text has already streamed is appended under that text rather than pushing it down. The
wrapper exists so a hover on the reply can reveal the action row under it; it has no background, border or
padding of its own.

### Work block (thinking / cooking)

The live state of a turn. Exactly one per turn, built by the first `status`, `thinking` or `tool_use` event
and frozen by `done` or `error`. Every tool chip and every piece of exposed reasoning for that turn is
inside it. The shape and behavior follow the ai-elements `Reasoning` component (elements.ai-sdk.dev):
a brain icon, a shimmer "Thinking…" label while live, a down chevron that flips on open, auto-open
while the stream is producing content, and auto-collapse to a duration summary when the turn ends.

| Property | Value |
|---|---|
| block | `--ac-bg-1`, `1px solid var(--ac-border-soft)`, `--ac-radius-card`, `align-self: stretch`, `min-width: 0` |
| head | a `<button>`: full width, `--ac-type-secondary`, `--ac-text-secondary`, padding `8px 12px`, gap `--ac-space-8`, `text-align: left`; hover fills `--ac-bg-2` with a `--ac-border` edge |
| icon | brain glyph, 14px, `--ac-text-muted`, first child of the head |
| label | `--ac-text`, single line, ellipsis. Fixed "Thinking…" (localized) while live, or the event's own `label`, which overrides it |
| step count | `--ac-type-micro`, `--ac-text-muted`, `"4 steps"`, empty at zero |
| caret | `--ac-text-muted`, chevron pointing down at rest, flips 180° when open, `transform` over `--ac-dur-fast` |
| body | opens automatically once it holds content while the turn is live, and stays open until the turn ends or the user toggles it (a manual toggle wins over the automatic state both ways); `hidden` when collapsed; column, gap `--ac-space-8`, padding `0 12px 12px`, `min-width: 0` |
| reasoning text | `--ac-type-secondary`, italic, `--ac-text-muted`, `white-space: pre-wrap`, `overflow-wrap: anywhere` |
| shimmer | `.live .work-label` animates opacity 1 to 0.5 at `--ac-loop-status` / `--ac-ease-loop`, dropped under reduced motion |

Nothing here is green: the block reports work, and the status dot already carries the live accent.
On `done` or `error` an un-toggled block collapses and the head becomes the static summary
`Thought for 12 seconds` (localized; whole seconds, minimum 1) plus the step count — the ai-elements
`Reasoning` end state. A block that ends with no steps and no reasoning text is removed; the meta
line already reports the duration.

Accessibility: the head is a real `<button>`, so Enter and Space toggle it; it carries
`aria-expanded` and an `aria-label`, and the body is hidden with the `hidden` attribute.

### Action row and meta line

| Property | Value |
|---|---|
| row | last-but-one child of `.turn`, `display: flex`, gap `--ac-space-8`, `opacity: 0` at rest, 1 on `.turn:hover`, `.turn:focus-within`, or `.show`; `opacity` only, never `display` or `visibility`, so it stays in the tab order |
| action button | ghost icon-and-label: transparent, `1px solid transparent`, `--ac-text-secondary`, padding `5px 12px`, `min-height: 28px`, gap `--ac-space-4`; hover fills `--ac-bg-2` with a `--ac-border` edge and `--ac-text` |
| copy | copies the raw markdown source of the reply, then shows `Copied` (or `Copy failed`) for 1.6s before reverting |
| retry | the failed-turn Retry joins this row when the turn produced one, and pins it with `.show`; otherwise it sits under the turn as before |
| meta line | last child of `.turn`, `--ac-type-micro`, italic, `--ac-text-muted`, `tabular-nums`: `<model> via <adapter> · 12.4s · 1.2k in / 340 out · $0.021`. Every field is omitted when null, including the cost, which subscription adapters never report; the whole line is omitted when the turn reported no meta |

Token counts read `340`, `1.2k`, `24.1k`, `240k`: one decimal up to 100k, whole thousands above it.
Costs read `$0.021`, `$0.14`, `$1.50`: three decimals with a single trailing zero dropped, so two
decimals is the floor; a charge under `$0.001` prints `<$0.001` rather than rounding to nothing.
Cache token counts ride on the event but stay off the line.

### Session usage readout

One line under the composer buttons, counting the current conversation only. It appears with the first
turn that reports usage and is cleared by New chat.

| Property | Value |
|---|---|
| line | `--ac-type-code`, `font-variant-numeric: tabular-nums`, `--ac-text-muted`, `margin-top: --ac-space-8`, single line with ellipsis, `min-width: 0` |
| text | `session: 24.1k in / 3.2k out · $0.14`, same number formats as the meta line |
| cost | present only when at least one turn reported a price; never `$0.00` for adapters that report none |
| hidden | the `hidden` attribute while there is nothing to report, so no empty row sits in the composer |

Accessibility: a `title` says the numbers cover this conversation only and that New chat clears them.
Monospace and tabular figures are the point: the digits update mid-conversation and must not shuffle.

### Slash command palette

The `/` twin of the mention popup: same surface, same interaction model (filter as you type, arrow keys,
Enter or click to select, Escape to close), different rows. It opens only when the composer text starts
with `/` and the caret is still inside that first token, and it lists the `commands` array from the
capabilities message. There is no built-in command list: a hub that sends no registry offers no palette.

| Property | Value |
|---|---|
| surface | the popup list spec above, unchanged |
| row | popup row, plus a two-line layout: head then summary |
| name | `--ac-type-code`, `--ac-text`, e.g. `/loop` |
| argument hint | `--ac-type-code`, `--ac-text-muted`, e.g. `<n> <instruction>`, single line, ellipsis |
| summary | `--ac-type-micro`, `--ac-text-secondary`, single line, ellipsis |
| selected row | background `--ac-accent-tint`, as in the mention popup |
| empty state | `no matching command`, popup empty-state spec |

Accessibility: the popup is `role="listbox"` with `role="option"` rows and `aria-selected`; the textarea
carries `aria-haspopup="listbox"`, `aria-controls`, and an `aria-expanded` that tracks the palette. Only
one popup owns the composer at a time: opening one closes the other.

### Parallel lanes

A `/parallel` run drives several tabs at once. Its lanes stack vertically inside the turn and are never
laid out side by side: the panel is about 360px and can be dragged to 240px. Each lane collapses to one
status line while it runs and opens on click, the same shape as the work block.

| Property | Value |
|---|---|
| group | column, gap `--ac-space-8`, `align-self: stretch`, `min-width: 0` |
| block | `--ac-bg-1`, `1px solid var(--ac-border-soft)`, `--ac-radius-card` |
| head | a `<button>`: full width, `--ac-type-secondary`, `--ac-text-secondary`, padding `8px 12px`, gap `--ac-space-8`, `text-align: left` |
| title | `Lane 2 · Pricing page` (the wire index is 0-based, the label 1-based), single line, ellipsis; a lane with no title is just `Lane 2` |
| status | `--ac-type-micro`, `--ac-text-muted`, `tabular-nums`: `running · 4 steps`, then `done · 6 steps` or `failed` |
| caret | `--ac-text-muted`, chevron pointing down at rest, flips 180° when open |
| body | `hidden` when collapsed; column, gap `--ac-space-8`, padding `0 12px 12px` — tool chips, reasoning text and the lane's own reply live here |
| live | `.live .lane-status` takes the work block's shimmer, dropped under reduced motion |
| failed | `.failed .lane-status` turns `--ac-error` and stops animating |

A lane that fails marks itself and stops; the turn keeps going, because the other lanes are still
running. Events with no lane field render exactly as they always have.

Accessibility: the head is a real `<button>` with `aria-expanded` and an `aria-label` naming the lane;
the body is hidden with the `hidden` attribute.

### Settings view

Replaces the message list and the composer while it is open; the header and the banner stay.

| Property | Value |
|---|---|
| view | `flex: 1`, `overflow-y: auto`, `overflow-x: clip`, column, gap `--ac-space-20`, padding `20px 16px`, `min-width: 0` |
| title | `--ac-type-title`, `--ac-text` |
| group | column, gap `--ac-space-8`, `min-width: 0` |
| label | `--ac-type-secondary`, `--ac-text-secondary` |
| state | `--ac-type-micro`, `--ac-text-muted`; `configured` turns `--ac-success` |
| key field | `type="password"`, `width: 100%`, `min-width: 0`, `--ac-bg-2`, `1px solid var(--ac-border)`, `--ac-radius-control`, padding `8px 10px`, `--ac-type-code`; focus border `--ac-accent-pressed` |
| button row | `display: flex; flex-wrap: wrap`, gap `--ac-space-8` |
| note | `--ac-type-secondary`, `--ac-text-muted` |

The field never shows a stored key. The hub never sends one back, so the row shows `configured` or `not
set` and nothing else. No px width anywhere in this view: the panel narrows to about 240px.

### Tool chip

A tool call renders as one full-width row, not a bubble, inside the work block body.

| Property | Value |
|---|---|
| background | `--ac-bg-2` |
| border | `1px solid var(--ac-border)` |
| radius | `--ac-radius-control` |
| padding | `6px 10px` |
| font | `--ac-font-mono` at `--ac-type-code` |
| tool name | `--ac-text` |
| args | `--ac-text-secondary`, truncated to one line, `overflow-wrap: anywhere` when wrapped |
| status glyph | pending `--ac-warn` (pulses at `--ac-loop-status`), ok `--ac-success`, failed `--ac-error` |
| align | `align-self: stretch`, `max-width: 100%` |

### Messages

| Role | Spec |
|---|---|
| user | `align-self: flex-end`, `max-width: 85%`, background `--ac-accent-tint`, `1px solid var(--ac-border)`, radius `10px 10px 4px 10px`, padding `8px 12px`, `--ac-type-body` |
| assistant | `align-self: stretch`, no background, no border, no padding, `--ac-type-body` on `--ac-bg-0`, `min-width: 0` |
| metadata | `--ac-type-micro`, `--ac-text-muted`, `margin-top: var(--ac-space-4)` |
| info line | `--ac-type-secondary`, `--ac-text-secondary`, italic |
| error line | `--ac-type-secondary`, `--ac-error` |
| streaming cursor | `\258B` in `--ac-accent`, appended inside the last rendered block, blink at `--ac-loop-status` |

The assistant turn is plain text on the panel background. Do not give it a card, a border, or an avatar.

### Composer card

| Property | Value |
|---|---|
| margin | `0 12px 12px` |
| padding | `--ac-space-12` |
| background | `--ac-bg-2` |
| border | `1px solid var(--ac-border)` |
| radius | `--ac-radius-card` |
| shadow | `--ac-shadow-card` |
| gap | `--ac-space-8` |
| focus-within | border `--ac-accent-pressed`, transition `--ac-dur-fast` |
| dragover | border `--ac-accent`, background `--ac-accent-tint-strong` |
| textarea | transparent, no border, `--ac-type-body`, `min-height: 24px`, `max-height: 180px`, `overflow-y: auto` |
| placeholder | `--ac-text-muted` |
| button row | gap `--ac-space-8`, `align-items: center` |

### Buttons

| Variant | Spec |
|---|---|
| primary (send) | fill `--ac-accent`, border same, glyph `--ac-on-accent`, 30x28px, `--ac-radius-control`; hover `--ac-accent-hover`; active `--ac-accent-pressed` |
| primary disabled | fill `--ac-bg-2`, border `--ac-border`, glyph `--ac-text-muted`, `opacity: 0.6` |
| ghost text | transparent, `1px solid var(--ac-border)`, `--ac-text`, padding `5px 12px`, `--ac-type-secondary`, `--ac-radius-control`; hover border `--ac-accent-pressed` |
| ghost icon | transparent, `1px solid transparent`, `--ac-text-secondary`, 28px square, `--ac-radius-control`; hover fill `--ac-bg-2`, border `--ac-border`, glyph `--ac-text` |
| destructive (Stop) | transparent, border `--ac-error-border`, text `--ac-error`; hover fill `--ac-error-bg` |
| disabled, any | `opacity: 0.4`, `cursor: default`, no hover change |
| focus, any | `outline: 2px solid var(--ac-focus-ring); outline-offset: 2px` on `:focus-visible` |

Icon stroke width is `1.8`, icon box 15px, `stroke-linecap: round`, `stroke-linejoin: round`.
Mic listening state: fill `#b91c1c`, border `#ef4444`, glyph `#fff`, pulse `--ac-loop-mic`. Red here is
deliberate: recording is not an agent state and must not read as accent green.

### Popup list (mention popup, and AgentBrowser popup rows)

| Property | Value |
|---|---|
| surface | `--ac-bg-1`, `1px solid var(--ac-border)`, `--ac-radius-card`, `--ac-shadow-card`, padding `--ac-space-4` |
| max height | 220px, `overflow-y: auto` |
| row | padding `6px 8px`, `--ac-radius-control`, `min-width: 0` |
| row selected | background `--ac-accent-tint` |
| row title | `--ac-type-body`, `--ac-text`, single line, ellipsis |
| row subtitle | `--ac-type-micro`, `--ac-text-muted`, single line, ellipsis |
| empty state | `--ac-type-secondary`, `--ac-text-muted`, padding `8px` |

### Banner

Full-width, above the message list, `flex: none`.

| Kind | Spec |
|---|---|
| error | background `--ac-error-bg`, bottom border `1px solid var(--ac-error-border)`, text `--ac-error` |
| warn | background `--ac-warn-bg`, bottom border `1px solid var(--ac-warn-border)`, text `--ac-warn` |
| both | padding `8px 12px`, `--ac-type-secondary` |

### Retry affordance

Two halves, both required.

| Half | Spec |
|---|---|
| failed turn | A ghost icon button appears directly under the failed assistant turn, `margin-top: --ac-space-8`, aligned left with the message. Glyph: refresh (circular arrow), 14px, stroke 1.8. Label text "Retry" in `--ac-type-secondary`, `--ac-text-secondary`, gap `--ac-space-4`. Hover follows ghost icon rules. Persists until the turn is retried or the chat is cleared. When the failed turn produced an action row, Retry joins that row instead and pins it open with `.show`; a turn with no reply at all keeps the standalone button under the list. |
| any user message | A resend icon button appears on `:hover` and on `:focus-within` of any `.msg.user`. Position absolute, right-aligned outside the card by `--ac-space-4`, vertically centered. 24px square, ghost icon spec, `--ac-text-muted` at rest. `opacity` 0 to 1 over `--ac-dur-fast`. Never visible at rest, always reachable by keyboard focus. |

Both resend the user turn that precedes them. Neither is green; retry is not a live state.

## 8. AgentBrowser

Same tokens, applied to a page we do not own. Two problems to fix first:

1. AgentBrowser is `#10b981` everywhere; AgentBrowser is `#22c55e`. One brand means one green. Move AgentBrowser
   to `--ac-accent`.
2. `extension/popup/popup.css:1` imports Inter and JetBrains Mono from `fonts.googleapis.com`. Remove the
   `@import` and use `--ac-font` and `--ac-font-mono`. A remote font in an extension is a CSP and offline
   failure, and it contradicts the no-webfonts rule above.

### Exact overlay swaps

`extension/background.js` `agentVisualFeedback()` and `extension/content.js`:

| Element | Current | New |
|---|---|---|
| pill fill | `rgba(16,185,129,.16)` | `rgba(34, 197, 94, 0.16)` |
| pill border | `1.5px solid #10b981` | `1.5px solid #22c55e` |
| pill text | `#10b981` | `#22c55e` |
| pill glow | `0 0 16px rgba(16,185,129,.7)` | `0 0 16px rgba(34, 197, 94, 0.55)` |
| pill padding | `7px 13px` | `8px 12px` |
| pill font | `600 13px/1.2 -apple-system,...` | `600 14px/1.35 <--ac-font>` |
| viewport border | `2px solid rgba(16,185,129,.55)` | `2px solid rgba(34, 197, 94, 0.55)` |
| viewport inner glow | `inset 0 0 26px rgba(16,185,129,.32)` | `inset 0 0 26px rgba(34, 197, 94, 0.32)` |
| ripple border | `2px solid #10b981` | `2px solid #22c55e` |
| ripple fill | `rgba(16,185,129,.2)` | `rgba(34, 197, 94, 0.20)` |
| ripple glow | `0 0 12px #10b981` | `0 0 12px rgba(34, 197, 94, 0.60)` |
| element outline | `2px solid #10b981` | `2px solid #22c55e` |
| element glow | `0 0 10px #10b981` | `0 0 10px rgba(34, 197, 94, 0.60)` |

The overlay cannot use CSS custom properties (it is injected into arbitrary pages and must not inherit or leak).
Inline the literal values above and keep this table as the source of truth.

### Overlay rules

Values are literal because the overlay cannot read custom properties; the token each one mirrors is in
parentheses.

| Rule | Value |
|---|---|
| pill radius | `999px` (`--ac-radius-pill`) |
| pill position | `fixed; top: 14px; right: 14px`, `z-index: 2147483647` |
| viewport border z-index | `2147483646`, `pointer-events: none` |
| fade in | `200ms` (`--ac-dur-base`) |
| fade out after idle | `400ms` (`--ac-dur-exit`), idle threshold 4000ms |
| one-shot easing | `cubic-bezier(0.2, 0, 0.2, 1)` (`--ac-ease`) |
| ripple duration | `600ms` one-shot |
| element highlight duration | `1200ms` |
| bolt pulse | `1600ms ease-in-out` (`--ac-loop-status`, `--ac-ease-loop`); currently 1s, align it |
| pointer events | every overlay node is `pointer-events: none` |
| reduced motion | drop the bolt pulse and the ripple; keep the pill and the viewport border static |

The pill is the same object as the panel's status dot: it says the agent is live on this tab. It carries the
task label and the current action, at the literal `600 14px/1.35` in the table above. That size is frozen:
the overlay sits on pages we do not own, at a fixed pill size, and does not follow `--ac-type-body` when the
panel's body type moves. It gets no shadow beyond its glow, and the glow is state, not depth.

The AgentBrowser popup uses the panel tokens directly: `--ac-bg-0` body (no gradient), `--ac-bg-1` cards,
`--ac-border` hairlines, `--ac-text` / `--ac-text-secondary` / `--ac-text-muted` for the text ramp, the five
type sizes, the spacing scale. Drop `--bg-gradient`, `--card-bg` with its alpha, and the per-color `-glow`
tokens; status colors come from `--ac-success` / `--ac-warn` / `--ac-error`.

## 9. Overflow

Hard requirements. A change that breaks any of these is a bug.

| Rule | Implementation |
|---|---|
| the panel body never scrolls horizontally | `#messages { overflow-x: hidden; overflow-y: auto; }` and no descendant may exceed `100%` width |
| wide blocks scroll inside themselves | `pre`, and every table wrapped in `.md-table-wrap`, get `overflow-x: auto; max-width: 100%` |
| code inside `pre` does not wrap | `pre code { white-space: pre; overflow-wrap: normal; word-break: normal; }` |
| table cells do not wrap | `th, td { white-space: nowrap; }`; the wrapper scrolls |
| long words and URLs break | `overflow-wrap: anywhere` on `.msg`, `.msg.assistant a`, inline `code`, chip labels that wrap, tool chip args. Use `overflow-wrap: anywhere`, not `word-break: break-word` |
| flex children holding wide content get `min-width: 0` | required on `.msg.assistant`, `.turn`, `.work-block`, `.work-body`, `.grow`, `.tab-chip`, `.mention-row`, `#composer`, `#settings-view`, and any new flex child that can contain a table, `pre`, URL, or long token |
| images cap at container width | `img { max-width: 100%; height: auto; }` |
| single-line labels truncate, not wrap | `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` plus `min-width: 0` on the flex parent |

`min-width: 0` is the one that gets forgotten. A flex child defaults to `min-width: auto`, so a wide table or
`pre` stretches the panel instead of scrolling inside its own box. Any new flex container in the message list
must set it.

## Appendix: the token block

Paste this into `agentchat/extension/sidepanel.css` and `extension/popup/popup.css`, replacing their existing
`:root` blocks. The tables above annotate these values; this block is the implementation.

```css
:root {
  /* surface */
  --ac-bg-0: #0b0f0d;
  --ac-bg-1: #0f1512;
  --ac-bg-2: #141c18;
  --ac-border: #1f2b25;
  --ac-border-soft: #17211c;

  /* text */
  --ac-text: #dbe5df;
  --ac-text-secondary: #9aa8a0;
  --ac-text-muted: #6f7d75;

  /* accent */
  --ac-accent: #22c55e;
  --ac-accent-hover: #2ee06d;
  --ac-accent-pressed: #16a34a;
  --ac-accent-tint: rgba(34, 197, 94, 0.13);
  --ac-accent-tint-strong: rgba(34, 197, 94, 0.22);
  --ac-on-accent: #06210f;

  /* state */
  --ac-success: #22c55e;
  --ac-error: #f87171;
  --ac-error-bg: rgba(248, 113, 113, 0.12);
  --ac-error-border: rgba(248, 113, 113, 0.4);
  --ac-warn: #d9a441;
  --ac-warn-bg: rgba(217, 164, 65, 0.12);
  --ac-warn-border: rgba(217, 164, 65, 0.4);
  --ac-focus-ring: #22c55e;

  /* type */
  --ac-font: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --ac-font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --ac-font-features: "cv05" 1, "ss01" 1;
  --ac-type-title: 600 16.5px/1.35 var(--ac-font);
  --ac-type-body: 400 15px/1.6 var(--ac-font);
  --ac-type-secondary: 400 13px/1.5 var(--ac-font);
  --ac-type-code: 400 13px/1.55 var(--ac-font-mono);
  --ac-type-micro: 500 11.5px/1.4 var(--ac-font);

  /* space */
  --ac-space-4: 4px;
  --ac-space-8: 8px;
  --ac-space-10: 10px;
  --ac-space-12: 12px;
  --ac-space-14: 14px;
  --ac-space-16: 16px;
  --ac-space-20: 20px;
  --ac-space-24: 24px;

  /* shape */
  --ac-radius-control: 6px;
  --ac-radius-card: 10px;
  --ac-radius-pill: 999px;
  --ac-shadow-card: 0 8px 24px rgba(0, 0, 0, 0.55);

  /* motion */
  --ac-dur-fast: 120ms;
  --ac-dur-base: 200ms;
  --ac-dur-exit: 400ms;
  --ac-ease: cubic-bezier(0.2, 0, 0.2, 1);
  --ac-ease-loop: ease-in-out;
  --ac-loop-mic: 1100ms;
  --ac-loop-status: 1600ms;
}
```

## Checklist for a change

- Every color, size, space, radius, and duration is a token from this file.
- No new type size, no new spacing value.
- Nothing new is green unless it reports a live state.
- No new shadow.
- Animation added only for a state; looping animations use loop tokens and are listed in the
  reduced-motion block.
- New flex children that can hold wide content have `min-width: 0`.
- A control that is hidden until hover is hidden with `opacity`, never `display` or `visibility`.
- Numbers that change in place carry `font-variant-numeric: tabular-nums`.
- New interactive nodes carry an `aria-label`, and anything expandable carries `aria-expanded` and is a
  real `<button>` so the keyboard reaches it.
- Resize the panel to its narrowest width: no horizontal scrollbar on the body.
