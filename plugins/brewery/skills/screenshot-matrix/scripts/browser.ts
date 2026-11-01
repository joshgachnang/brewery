// Renders a local HTML file with whichever Chrome or Chromium is on the machine, so the skills
// need no install in the plugin or the app's repository. Pages must lay out in fixed pixels:
// `--dump-dom` reports a viewport shorter than `--window-size`, so vh units measure wrong.
import { existsSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAC_APPS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];

export const findBrowser = (): string | undefined => {
  const named = [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH].find((path) => path && existsSync(path));
  if (named) return named;
  for (const name of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return MAC_APPS.find((path) => existsSync(path));
};

// No --user-data-dir: headless Chrome then makes its own throwaway profile, so runs cannot collide
// with each other or with the user's running Chrome. An explicit fresh directory hung on first
// launch when tried, and a shared one let a stuck process swallow later runs.
const ATTEMPTS = 3;
const ATTEMPT_MS = 45_000;

const invoke = (browser: string, htmlPath: string, width: number, height: number, mode: string, finished: (stdout: string) => boolean): string => {
  // --disable-dev-shm-usage: a container's small /dev/shm otherwise kills large pages silently.
  const args = [browser, "--headless", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars", "--force-device-scale-factor=1", "--virtual-time-budget=15000", `--window-size=${width},${height}`, mode, pathToFileURL(htmlPath).href];
  if (process.platform === "linux") args.splice(1, 0, "--no-sandbox");
  let failure = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const proc = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: ATTEMPT_MS });
    // Exit 0 alone proves little: a launch handed off to another process exits 0 without the work.
    if (proc.exitCode === 0 && finished(proc.stdout.toString())) return proc.stdout.toString();
    failure = `exit ${proc.exitCode ?? `signal ${proc.signalCode}`}: ${proc.stderr.toString().slice(-300)}`;
    Bun.sleepSync(1_000);
  }
  throw new Error(`browser failed ${ATTEMPTS} times, last ${failure}`);
};

export const screenshotHtml = (browser: string, htmlPath: string, width: number, height: number, outPath: string): void => {
  rmSync(outPath, { force: true });
  invoke(browser, htmlPath, width, height, `--screenshot=${outPath}`, () => existsSync(outPath));
};

export const dumpDom = (browser: string, htmlPath: string, width: number, height: number): string => invoke(browser, htmlPath, width, height, "--dump-dom", (stdout) => stdout.includes("</html>"));

// Scales an image to exactly width×height, cropping any sliver of aspect difference.
export const scaleHtml = (imagePath: string, width: number, height: number): string =>
  `<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff"><img src="${pathToFileURL(imagePath).href}" style="display:block;width:${width}px;height:${height}px;object-fit:cover"></body></html>`;
