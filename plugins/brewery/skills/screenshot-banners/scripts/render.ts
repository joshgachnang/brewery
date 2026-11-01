#!/usr/bin/env bun
// Composes captured screens into a store gallery, once per slot at that slot's exact pixel size.
//   bun render.ts render <app> [--only a,b] [--root dir]    the panels in the app's `banners` config
//   bun render.ts sheet <app> [--slot id] [--root dir]      a numbered sheet of the captured screens
//   bun render.ts sheet <app> --banners <slot> [--root dir] a sheet of one slot's rendered panels
// Exit 0: done. 2: copy does not fit, or a store limit is broken. 3: UNVERIFIED, no browser or no
// captures for a slot. 1: this script crashed.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dumpDom, findBrowser, screenshotHtml } from "../../screenshot-matrix/scripts/browser.ts";
import { coveragePath, loadApp, type Loaded, parseArgs, type Row } from "../../screenshot-matrix/scripts/matrix.ts";
import { pngInfo, stripAlpha } from "../../screenshot-matrix/scripts/png.ts";
import { SLOTS, type Slot } from "../../screenshot-matrix/scripts/slots.ts";

export interface Panel {
  // hero: one screen across three images, with the headline and points around it. standard: one image.
  layout: "hero" | "standard";
  screen: string;
  headline: string;
  body?: string;
  points?: string[];
  // Shorter copy for Play's phone slot, where text may cover at most 20% of the image.
  capped?: { headline?: string; body?: string; points?: string[] };
}

export interface Banners {
  theme?: { background?: string; backgroundEnd?: string; text?: string; accent?: string; font?: string; googleFontsQuery?: string };
  panels: Panel[];
}

// The most any phone slot's image may be covered by text, from Play's tagline rule.
export const TEXT_CAP = 0.2;

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const safeCss = (value: string, fallback: string): string => (/^[#\w(),.%\s-]+$/.test(value) ? value : fallback);

interface Resolved {
  background: string;
  backgroundEnd: string;
  text: string;
  accent: string;
  font: string;
  fontsLink: string;
}

const resolveTheme = (theme: Banners["theme"] = {}): Resolved => {
  const background = safeCss(theme.background ?? "#1b2a4a", "#1b2a4a");
  return {
    background,
    backgroundEnd: safeCss(theme.backgroundEnd ?? background, background),
    text: safeCss(theme.text ?? "#ffffff", "#ffffff"),
    accent: safeCss(theme.accent ?? "#ffd166", "#ffd166"),
    font: safeCss(theme.font ?? "", "") ? `'${safeCss(theme.font ?? "", "")}', ` : "",
    fontsLink: theme.googleFontsQuery ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${escapeHtml(theme.googleFontsQuery)}&display=swap">` : "",
  };
};

// Shrinks the copy in steps until every box fits and, on a capped slot, text covers little enough
// of each panel. Writes the outcome where `--dump-dom` can read it. Layout is in fixed pixels.
const FIT_SCRIPT = `
const fit = () => {
  const canvas = document.getElementById("canvas");
  const {width, height, panels, cap, floor} = canvas.dataset;
  const [w, h, count, limit, minimum] = [+width, +height, +panels, +cap, +floor];
  const boxes = [...document.querySelectorAll("[data-box]")];
  const coverage = () => {
    const area = new Array(count).fill(0);
    const left = canvas.getBoundingClientRect().left;
    const walker = document.createTreeWalker(canvas, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const rect of range.getClientRects()) {
        const panel = Math.min(count - 1, Math.max(0, Math.floor((rect.left - left + rect.width / 2) / w)));
        area[panel] += rect.width * rect.height;
      }
    }
    return area.map((value) => value / (w * h));
  };
  const overflowing = () => boxes.filter((box) => box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1);
  let scale = 1;
  const apply = () => canvas.style.setProperty("--s", String(scale));
  apply();
  while (scale > minimum && (overflowing().length > 0 || coverage().some((value) => value > limit))) {
    scale = Math.max(minimum, scale - 0.02);
    apply();
  }
  const pct = coverage();
  document.documentElement.dataset.report = encodeURIComponent(JSON.stringify({scale, coverage: pct, overflow: overflowing().length, over: pct.some((value) => value > limit), images: [...document.images].every((image) => image.naturalWidth > 0)}));
};
// Events, not awaits: awaiting image.decode() or fonts.ready hangs under --virtual-time-budget.
addEventListener("load", fit);
document.fonts.addEventListener("loadingdone", fit);
`;

export const panelHtml = (panel: Panel, slot: Slot, width: number, height: number, screenPath: string, theme: Resolved, offset: number): string => {
  const copy = slot.banner === "capped" ? { ...panel, ...panel.capped } : panel;
  const hero = panel.layout === "hero";
  const panels = hero ? 3 : 1;
  const px = (fraction: number): string => `${(fraction * width).toFixed(1)}px`;
  const size = (fraction: number): string => `calc(${px(fraction)} * var(--s))`;
  const image = `<img src="${pathToFileURL(screenPath).href}" alt="">`;
  const points = (copy.points ?? []).map((point) => `<li>${escapeHtml(point)}</li>`).join("");
  const heading = (fraction: number): string => `font-size:${size(fraction)};line-height:1.08;font-weight:800;letter-spacing:-0.01em;margin:0;`;
  const content = hero
    ? `<div data-box style="position:absolute;left:${px(0.07)};top:${(height * 0.08).toFixed(1)}px;width:${px(0.62)};height:${(height * 0.84).toFixed(1)}px;overflow:hidden">
        <h1 style="${heading(0.112)}">${escapeHtml(copy.headline)}</h1>
        ${copy.body ? `<p style="font-size:${size(0.052)};line-height:1.3;margin:${size(0.05)} 0 0;opacity:.92">${escapeHtml(copy.body)}</p>` : ""}
      </div>
      <div class="screen" style="left:${px(0.75)};top:${(height * 0.09).toFixed(1)}px;width:${px(1.5)}">${image}</div>
      <ul data-box style="position:absolute;left:${px(2.31)};top:${(height * 0.08).toFixed(1)}px;width:${px(0.62)};height:${(height * 0.84).toFixed(1)}px;overflow:hidden;margin:0;padding:0;list-style:none;font-size:${size(0.066)};line-height:1.22;font-weight:600">${points}</ul>`
    : `<div data-box style="position:absolute;left:${px(0.08)};top:${(height * 0.06).toFixed(1)}px;width:${px(0.84)};height:${(height * 0.23).toFixed(1)}px;overflow:hidden;text-align:center">
        <h1 style="${heading(0.088)}">${escapeHtml(copy.headline)}</h1>
        ${copy.body ? `<p style="font-size:${size(0.044)};line-height:1.3;margin:${size(0.026)} 0 0;opacity:.92">${escapeHtml(copy.body)}</p>` : ""}
      </div>
      <div class="screen" style="left:${px(0.12)};top:${(height * 0.31).toFixed(1)}px;width:${px(0.76)}">${image}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8">${theme.fontsLink}<style>
    html,body{margin:0;background:${theme.background}}
    body{width:${width}px;height:${height}px;overflow:hidden;position:relative}
    #canvas{--s:1;position:absolute;left:${-offset * width}px;top:0;width:${panels * width}px;height:${height}px;overflow:hidden;color:${theme.text};background:linear-gradient(115deg,${theme.background},${theme.backgroundEnd});font-family:${theme.font}-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
    .screen{position:absolute;border-radius:${px(hero ? 0.1 : 0.06)};overflow:hidden;box-shadow:0 0 0 ${px(0.012)} rgba(255,255,255,.18),0 ${px(0.03)} ${px(0.1)} rgba(0,0,0,.35)}
    .screen img{display:block;width:100%;height:auto}
    li{margin:0 0 ${size(0.06)};padding-left:${size(0.05)};border-left:${px(0.014)} solid ${theme.accent}}
  </style></head><body><div id="canvas" data-width="${width}" data-height="${height}" data-panels="${panels}" data-cap="${slot.banner === "capped" ? TEXT_CAP : 1}" data-floor="0.4">${content}</div><script>${FIT_SCRIPT}</script></body></html>`;
};

interface FitReport {
  scale: number;
  coverage: number[];
  overflow: number;
  over: boolean;
  images: boolean;
}

const readReport = (dom: string): FitReport | undefined => {
  const match = dom.match(/data-report="([^"]*)"/);
  return match ? (JSON.parse(decodeURIComponent(match[1])) as FitReport) : undefined;
};

const coverageRows = (load: Loaded): Row[] | undefined => (existsSync(coveragePath(load)) ? (JSON.parse(readFileSync(coveragePath(load), "utf8")) as { rows: Row[] }).rows : undefined);

const hasScreens = (dir: string, screens: string[]): string[] => screens.filter((screen) => !existsSync(join(dir, `${screen}.png`)));

const renderSlot = (browser: string, load: Loaded, slot: Slot, banners: Banners, theme: Resolved): string[] => {
  const source = join(load.outDir, slot.id);
  const out = join(load.outDir, "banners", slot.id);
  const work = join(load.root, ".storeAssets", "banners", slot.id);
  const problems: string[] = [];
  const first = readFileSync(join(source, `${banners.panels[0].screen}.png`));
  const { width, height } = pngInfo(first);
  // Large-screen Play slots take the bare screens: added text may be cropped there.
  const imageCount = banners.panels.reduce((total, panel) => total + (panel.layout === "hero" && slot.banner !== "plain" ? 3 : 1), 0);
  if (imageCount > slot.maxImages) problems.push(`${slot.id}: ${imageCount} images, and this slot allows ${slot.maxImages}; drop panels`);
  rmSync(out, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });
  let index = 1;
  const name = (screen: string, part = ""): string => `${String(index++).padStart(2, "0")}-${screen.replace(/^\d{2}-/, "")}${part}.png`;
  for (const [position, panel] of banners.panels.entries()) {
    const screenPath = join(source, `${panel.screen}.png`);
    if (slot.banner === "plain") {
      writeFileSync(join(out, name(panel.screen)), stripAlpha(readFileSync(screenPath)));
      continue;
    }
    const parts = panel.layout === "hero" ? 3 : 1;
    const measure = join(work, `${position}-measure.html`);
    writeFileSync(measure, panelHtml(panel, slot, width, height, screenPath, theme, 0));
    const report = readReport(dumpDom(browser, measure, width, height));
    const label = `${slot.id} panel ${position + 1} (${panel.screen})`;
    if (!report) {
      problems.push(`${label}: the page did not finish rendering`);
      continue;
    }
    if (report.scale < 0.6) console.log(`note: ${label}: copy shrank to ${Math.round(report.scale * 100)}% to fit; shorter copy will read better`);
    if (!report.images) problems.push(`${label}: the screen image did not load`);
    if (report.overflow > 0) problems.push(`${label}: the copy does not fit even at ${Math.round(report.scale * 100)}% size; shorten it`);
    if (report.over) problems.push(`${label}: text covers ${Math.round(Math.max(...report.coverage) * 100)}% of an image and Play allows ${TEXT_CAP * 100}%; set shorter \`capped\` copy on this panel`);
    for (let part = 0; part < parts; part++) {
      const html = join(work, `${position}-${part}.html`);
      const png = join(work, `${position}-${part}.png`);
      writeFileSync(html, panelHtml(panel, slot, width, height, screenPath, theme, part));
      screenshotHtml(browser, html, width, height, png);
      const flat = stripAlpha(readFileSync(png));
      const info = pngInfo(flat);
      if (info.width !== width || info.height !== height) problems.push(`${label}: rendered ${info.width}x${info.height}, wanted ${width}x${height}`);
      writeFileSync(join(out, name(panel.screen, parts === 3 ? `-${"abc"[part]}` : "")), flat);
    }
  }
  return problems;
};

const renderAll = (load: Loaded, flags: Record<string, string>): number => {
  const banners = (load.app as { banners?: Banners }).banners;
  if (!banners?.panels?.length) throw new Error(`no banners.panels for ${load.appKey} in storeAssets.config.json`);
  const browser = findBrowser();
  if (!browser) {
    console.log("UNVERIFIED: no Chrome or Chromium found; set CHROME_PATH");
    return 3;
  }
  const only = flags.only?.split(",").filter(Boolean);
  const rows = coverageRows(load);
  const theme = resolveTheme(banners.theme);
  const screens = banners.panels.map((panel) => panel.screen);
  const problems: string[] = [];
  const blockers: string[] = [];
  let rendered = 0;
  for (const slot of SLOTS) {
    if (only && !only.includes(slot.id)) continue;
    const row = rows?.find((candidate) => candidate.slot === slot.id);
    if (row && (row.status === "manual" || row.status === "not-applicable")) continue;
    const dir = join(load.outDir, slot.id);
    if (!existsSync(dir)) {
      if (rows || only) blockers.push(`${slot.id}: no captures${row ? ` (${row.status}: ${row.detail})` : ""}`);
      continue;
    }
    const missing = hasScreens(dir, screens);
    if (missing.length > 0) {
      blockers.push(`${slot.id}: no capture of ${missing.join(", ")}`);
      continue;
    }
    let found: string[];
    try {
      found = renderSlot(browser, load, slot, banners, theme);
    } catch (error) {
      found = [`${slot.id}: ${error instanceof Error ? error.message : String(error)}`];
    }
    problems.push(...found);
    rendered++;
    console.log(`${slot.id}: ${found.length > 0 ? "problems" : "ok"}, ${readdirSync(join(load.outDir, "banners", slot.id)).length} images`);
  }
  for (const problem of problems) console.log(`problem: ${problem}`);
  for (const blocker of blockers) console.log(`blocked: ${blocker}`);
  console.log(`Rendered ${rendered} slots to ${join(load.outDir, "banners")}/<slot>/.`);
  if (problems.length > 0) return 2;
  return blockers.length > 0 || rendered === 0 ? 3 : 0;
};

// A grid of images with their names, so the human can choose screens or judge a set at a glance.
const sheet = (load: Loaded, flags: Record<string, string>): number => {
  const browser = findBrowser();
  if (!browser) {
    console.log("UNVERIFIED: no Chrome or Chromium found; set CHROME_PATH");
    return 3;
  }
  const slotId = flags.banners ?? flags.slot ?? "iphone-6.3";
  const dir = flags.banners ? join(load.outDir, "banners", slotId) : join(load.outDir, slotId);
  if (!existsSync(dir)) throw new Error(`nothing at ${dir}`);
  const files = readdirSync(dir).filter((file) => file.endsWith(".png")).sort();
  if (files.length === 0) throw new Error(`no images in ${dir}`);
  const cell = 300;
  // Rendered panels sit edge to edge so a hero's three images read as one.
  const gap = flags.banners ? 0 : 24;
  const columns = Math.min(files.length, flags.banners ? 8 : 5);
  const { width, height } = pngInfo(readFileSync(join(dir, files[0])));
  const imageHeight = Math.round((cell * height) / width);
  const rows = Math.ceil(files.length / columns);
  const totalWidth = columns * cell + (columns + 1) * gap;
  const totalHeight = rows * (imageHeight + 44) + gap;
  const items = files.map((file) => `<figure style="margin:0;width:${cell}px"><img src="${pathToFileURL(join(dir, file)).href}" style="display:block;width:${cell}px;height:${imageHeight}px"><figcaption style="height:44px;font:15px/44px sans-serif;text-align:center;overflow:hidden">${escapeHtml(file.slice(0, -4))}</figcaption></figure>`).join("");
  const work = join(load.root, ".storeAssets", "banners");
  mkdirSync(work, { recursive: true });
  const html = join(work, "sheet.html");
  const out = join(work, flags.banners ? `sheet-banners-${slotId}.png` : `sheet-${slotId}.png`);
  writeFileSync(html, `<!doctype html><html><body style="margin:0;width:${totalWidth}px;height:${totalHeight}px;background:#fff;overflow:hidden"><div style="display:flex;flex-wrap:wrap;gap:0 ${gap}px;padding:${gap}px 0 0 ${gap}px">${items}</div></body></html>`);
  screenshotHtml(browser, html, totalWidth, totalHeight, out);
  console.log(out);
  return 0;
};

if (import.meta.main) {
  try {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const [command, appKey] = positional;
    if ((command !== "render" && command !== "sheet") || !appKey) throw new Error("usage: render.ts render|sheet <app> [--only a,b] [--slot id] [--banners slot] [--root dir]");
    const load = loadApp(appKey, flags.root);
    process.exit(command === "render" ? renderAll(load, flags) : sheet(load, flags));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
