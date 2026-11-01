---
name: screenshot-banners
description: Turn captured store screenshots into the marketing gallery people expect, where the first three images form one banner showing a single screen with more text and the rest are captioned singles. Reads the app, suggests copy, asks the human which screens to use and what the text should say, saves the answers, and renders every image at each store slot's exact size, within Play's text limits. Use when asked for store banners, a screenshot gallery, captioned or marketing screenshots, or `/screenshot-banners`; run after `screenshot-matrix`.
---

# Screenshot banners

Composes what `screenshot-matrix` captured into a store gallery. Needs a browser (Chrome or
Chromium) and no install. `<this skill>` below is the directory holding this file.

```text
 image 1          image 2          image 3          image 4    image 5
┌───────────┬─────────────────┬───────────┐     ┌────────┐ ┌────────┐
│ Headline  │  ┌───────────────────┐ • point│     │Caption │ │Caption │
│ across    │  │   one app screen  │ • point│     │ ┌────┐ │ │ ┌────┐ │
│ the left  │  │   spanning all 3  │ • point│     │ │    │ │ │ │    │ │
└───────────┴──┴───────────────────┴────────┘     └─┴────┴─┘ └─┴────┴─┘
          layout: hero                             layout: standard
```

## 1. Check the captures

Find the app in `storeAssets.config.json` and read `<appDir>/storeScreenshots/coverage.json`.
If the captures are missing or a required slot is `blocked` or `failed`, stop and run
`screenshot-matrix` first. Copy written against screens that do not exist yet gets thrown away.

## 2. Read the app so your suggestions are specific

Read `app.json`, the README, any store listing or marketing copy, the landing page if there is
one, and the routes behind the captured screens. Work out who it is for, what they get, and what
is different about it. Then look at the screens:

```bash
bun <this skill>/scripts/render.ts sheet <app>                  # numbered sheet of iphone-6.3 captures
bun <this skill>/scripts/render.ts sheet <app> --slot ipad-13   # any other slot
```

Read the sheet yourself, and show it to the human, sending the file if they cannot see this
machine's disk. Existing `banners` config in the app means this is a rerun: show what is saved
and ask only about what they want to change.

## 3. Ask which screens

Use the question tool if you have one, otherwise ask in plain messages and wait. Never skip these
questions, and never treat your own suggestion as their answer. If no human can be reached, stop
at this step, report what you would have asked, and render nothing.

1. **Which screen is the hero?** It fills the first three images, so offer the two or three
   captures that best show the app's core value, with your pick first and why.
2. **Which screens follow it, and in what order?** Recommend an order. The limits are 10 images per
   size on the App Store and 8 on Play, and the hero counts as three, so at most five more fit
   Play. Fewer is fine: Play needs at least 4 images per listing type for recommendations.
3. **Style.** Offer colors and a font drawn from the app's theme or design tokens. Never invent a
   brand; if the repository has none, say so and offer neutral options.

## 4. Ask for the text

For each panel, offer two or three drafts that differ in angle (outcome, feature, audience), and
take theirs if they type their own. Ask for one panel at a time or in small batches. Never write a
panel's copy without an answer.

| Field | Hero | Standard |
| --- | --- | --- |
| `headline` | 3 to 8 words, on image 1 | 2 to 6 words |
| `body` | One sentence under the headline | Optional, one short line |
| `points` | 2 to 4 lines on image 3, each under 8 words | Not shown |

Draft against these rules, and call out a draft of theirs that breaks one:

- Name what the user gets, in their words, not the feature's internal name.
- No claims about rank or performance ("#1", "best", "top rated"), no calls to action ("download
  now"), no prices or promotions: Play rejects them and they age badly.
- No claim the app cannot back up. For a health app, no outcome or clinical claim without the
  human confirming it is cleared to say.
- Show the app: each image must show real UI in use.

## 5. Save it

Write the answers to the app in `storeAssets.config.json`, so a rerun or a new capture never asks
again:

```json
{
  "apps": {
    "mobile": {
      "banners": {
        "theme": { "background": "#14323f", "backgroundEnd": "#2a7f6f", "text": "#ffffff", "accent": "#ffd166", "font": "Inter", "googleFontsQuery": "family=Inter:wght@400;600;800" },
        "panels": [
          {
            "layout": "hero",
            "screen": "01-home",
            "headline": "Your whole week, planned in one place",
            "body": "Meals, chores, and school runs, all together.",
            "points": ["See who does what, at a glance", "Reminders the whole family gets"],
            "capped": { "body": "", "points": ["Who does what, at a glance"] }
          },
          { "layout": "standard", "screen": "02-plan", "headline": "Plan in seconds", "body": "Drag a task to any day." }
        ]
      }
    }
  }
}
```

`screen` is a capture's name without `.png`. `capped` replaces fields on the Play phone slot only.
This `banners` key is the gallery. terreno's `banner` key, in the same file, is the separate Play
feature graphic, made by its `store-assets` skill; this skill does not make that image.

## 6. Preview one size, then approve

```bash
bun <this skill>/scripts/render.ts render <app> --only iphone-6.3
bun <this skill>/scripts/render.ts sheet <app> --banners iphone-6.3   # the panels edge to edge
```

Read the sheet, check that the hero reads as one image and no text is clipped, and show it to the
human. Change the copy or the layout choices until they say it is right. Do not render every size
before that answer.

## 7. Render every size

```bash
bun <this skill>/scripts/render.ts render <app>
```

Each slot gets its own images, sized from its own captures, in
`<appDir>/storeScreenshots/banners/<slot>/NN-name.png`, with no alpha. Hero images end in `-a`,
`-b`, `-c`; upload them in order, because the panorama only lines up that way.

The slot's store rules apply automatically:

| Slot | Treatment | Why |
| --- | --- | --- |
| iPhone and iPad | Full copy, shrunk to fit | App Store sets no text limit |
| `android-phone` | Text covers at most 20% of each image, using `capped` copy when set | Play's tagline rule |
| `android-tablet-7`, `android-tablet-10` | Bare screens, one per panel, no text or hero | Play warns that added text on large screens may be cropped |

Exit 2 names the panel when the copy cannot fit or breaks the 20% rule, even at the smallest size
allowed: shorten that text or set `capped`, then ask the human about the new words. Exit 3 means
UNVERIFIED: no browser, or a slot has no capture of a chosen screen. After the full render, read
one sheet per form factor (`android-phone` and `ipad-13` at least), because the layouts differ.

## Report

Where the images are, how many per slot, what you read, any slot not rendered and why, and the
upload order. Saying the hero must go first belongs here too: the stores keep the order you
upload. Uploading is the human's call; never submit to a store.
