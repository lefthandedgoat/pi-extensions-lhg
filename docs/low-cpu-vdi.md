# Running pi on a CPU-starved Citrix VDI (no GPU)

Notes on why `pi` eats CPU in Windows Terminal on a GPU-less Citrix VDI, and
everything worth trying, roughly ordered by value. Written to be read on the
VDI itself.

Measured against `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui`
**0.85.1**. Hardcoded constants below may move between versions.

## Why this setup hurts

Every TUI frame pays four times on a GPU-less VDI:

1. **pi** diffs the TUI and writes ANSI.
2. **Windows Terminal** rasterizes the frame in software (WARP).
3. **DWM** composites it in software.
4. **Citrix Thinwire/HDX** encodes the changed pixels and ships them.

Worse: while tokens stream, each appended line scrolls the transcript, so the
changed region is the **entire viewport**, not a few cells. Per-frame cost
scales with rows × cols — a 200×60 window is ~4x the work of 100×30.

## What pi itself does (measured in the installed source)

- `pi-tui/dist/tui.js`: `static MIN_RENDER_INTERVAL_MS = 16` — streaming
  repaints are coalesced to at most ~62 fps. Hardcoded, no setting.
- `pi-tui/dist/components/loader.js`: `DEFAULT_INTERVAL_MS = 80` — the
  `⠋⠙⠹⠸…` working spinner calls `requestRender()` **every 80 ms for the
  whole time a request is in flight**, even with zero tokens arriving
  (~12.5 fps of nothing). `restartAnimation()` returns early when the
  indicator has ≤ 1 frame, so a one-frame indicator means **no timer at all**.
- `markdown.mermaid` defaults to `"streaming"` — diagrams re-render while
  tokens arrive.

## This repo's own contribution: `current-prompt.ts`

It runs its **own** 80 ms repaint loop on top of the built-in one
(`timer = setInterval(() => paint(ctx), 80)`), plus a 120 ms loop while
background subagents/jobs are active. Each tick calls:

- `ctx.ui.setTitle(...)` → terminal OSC write. Cheap, no TUI frame.
- `ctx.ui.setStatus(...)` → `ui.requestRender()` **unconditionally, no
  change detection**. Expensive: a full TUI frame for a one-glyph change.

Two independent 80 ms loops coalesce into ~12.5 fps or interleave into
~25 fps depending on phase. Fixing only the built-in spinner still leaves the
extension's loop. (Fixed in this repo: the footer now only rewrites on real
content change via `setStatusIfChanged`; the animation lives on the tab
title. See the `STATIC_MARK` / `lastStatus` code in
`extensions/current-prompt.ts`.)

A fourth timer, `idleWatchTimer` (2 s), only does a directory + `status.json`
scan while idle and repaints on state change — low CPU, but a recurring
filesystem hit on machines with roaming/network profiles.

## Pi settings that cut per-frame work

`~/.pi/agent/settings.json` (`%USERPROFILE%\.pi\agent\settings.json`):

```json
{
  "markdown": { "mermaid": "off" },
  "terminal": { "showImages": false, "trueColor": false, "hyperlinks": false },
  "hideThinkingBlock": true,
  "outputPad": 0,
  "editorPaddingX": 0
}
```

- `mermaid: "off"` (`"final"` keeps end-state diagrams) — biggest single
  settings win during streaming.
- `trueColor: false` — unique RGB per cell prevents attribute-run batching
  and costs more to encode. Dropping to 256/16 colors makes runs longer.
- `showImages: false` — inline images are pure loss without a GPU.
- Keep `terminal.clearOnShrink: false` and `showHardwareCursor: false`
  (both defaults) — no flicker, no blinking caret to repaint forever.

Syntax highlighting is always on. A custom theme that maps all nine
`syntax*` tokens to one color doesn't stop the tokenizer, but it removes
intra-line attribute churn inside every streaming code block.

## Kill the built-in idle spinner

One-frame indicator ⇒ no `setInterval` ⇒ zero idle repaints. Save as
`low-cpu.ts` in the extensions dir and register it (see Install in README),
then `/reload`. `setWorkingIndicator()` with no args restores the default.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });
  });
}
```

## Windows Terminal

Settings path (Store install):
`%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json`

```jsonc
{
  "profiles": {
    "defaults": {
      "useAcrylic": false,
      "opacity": 100,
      "historySize": 2000,
      "antialiasingMode": "grayscale",
      "experimental.rendering.atlasEngine": true,
      "experimental.rendering.forceFullRepaint": false
    }
  }
}
```

- `atlasEngine` is the big one: glyph caching + damage tracking vs the old
  engine re-rasterizing. Update WT first — old builds are much worse here.
- Try `experimental.rendering.software: true` as an experiment; without a
  real GPU, explicit WARP can beat failing D3D paths.
- These are `experimental.*` keys, so verify against your WT version
  (`wt --version`). WT has **no frame-rate cap**, it repaints on demand.

## Windows, no admin needed

- Settings → Accessibility → Visual effects → **Transparency effects: off**.
- Accessibility → Text cursor → blink rate **None**.
- System Properties → Advanced → Performance → **Adjust for best
  performance** (on a no-GPU box, DWM composites entirely on CPU).
- **Shrink the window.** If fullscreen at 1920×1080 with a small font is the
  norm, dropping to ~100×30 cuts rasterize+encode per scrolled frame roughly
  4x. This may beat every other change here.

## Different terminals

- **mintty** (ships with Git for Windows, pi's default Windows shell):
  GDI/software rendering, dramatically lighter than WT with no GPU. Free to
  test, nothing new to install.
- **WezTerm**: `front_end = "Software"` plus `max_fps = 10`. That is a real
  frame cap, which WT has no equivalent of.
- **Avoid Alacritty** here — OpenGL-or-nothing, routes through llvmpipe/WARP
  poorly.

## Citrix policy (needs the VDI admin)

- **"Use video codec for compression" → Do not use video codec.** H.264
  encoding on a CPU-only VDI is expensive, and a text editor is the wrong
  workload for a video codec. Thinwire is cheaper for text.
- **Preferred color depth → 16-bit.** Halves bytes per pixel through the
  encoder.
- **Desktop composition redirection → on**, if the local endpoint is decent
  and the VDI is the bottleneck — offloads DWM composition to the endpoint.
- Lower the VDI resolution; encode cost is linear in pixels. "Optimize for
  3D workloads" off. Windows Aero/visual effects off via policy.

## Measuring whether any of this worked

`PI_TUI_WRITE_LOG` captures the raw ANSI stream — the exact input the
terminal must render. Bytes/sec while streaming is comparable before/after a
change on identical prompts:

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log pi
# after a streaming response:
wc -c /tmp/tui-ansi.log
```

Attribute the CPU in Task Manager → Details on the VDI:

| Hot process | It means | Fix points at |
|---|---|---|
| `WindowsTerminal.exe` | rasterization | WT settings, font, window size, atlasEngine |
| `node.exe` (pi) | render/highlight work | spinner, mermaid, truecolor, current-prompt |
| `dwm.exe` / `csrss.exe` | software compositing + encoding | Citrix policy, resolution, visual effects |

Check before changing everything — the three point at three different fixes.
