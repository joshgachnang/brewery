// Every store screenshot slot, keyed on the pixel sizes the store accepts. A captured image's
// size is the authority: device names only say where to look first, and they change with Xcode.
// Sources, checked 2026-11-01:
// https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
// https://support.google.com/googleplay/android-developer/answer/9866151
export type Size = [number, number];

export interface Slot {
  id: string;
  platform: "ios" | "android";
  form: "phone" | "tablet";
  label: string;
  // Required by the store for an app on this form factor.
  required: boolean;
  // Portrait sizes the store accepts. The first is the target when deriving or setting an emulator.
  sizes: Size[];
  // Simulator device types to try, in order. An iOS slot with none cannot be captured.
  simulators?: string[];
  // Emulator display density, which picks the app's phone or tablet layout.
  density?: number;
  // Larger slots to scale down from when this one cannot be captured.
  deriveFrom?: string[];
  // Why no run can capture this slot. Reported on every run, never counted as a miss.
  manual?: string;
  // captions: full banner copy. capped: at most 20% text, Play's phone rule. plain: no added
  // text, Play's rule for large screens, where text may be cropped.
  banner: "captions" | "capped" | "plain";
  maxImages: number;
}

const ios = (slot: Omit<Slot, "platform" | "banner" | "maxImages">): Slot => ({ ...slot, platform: "ios", banner: "captions", maxImages: 10 });
const android = (slot: Omit<Slot, "platform" | "maxImages" | "required"> & { required?: boolean }): Slot => ({ required: false, ...slot, platform: "android", maxImages: 8 });

export const SLOTS: Slot[] = [
  ios({ id: "iphone-6.9", form: "phone", label: 'iPhone 6.9" Dynamic Island (large)', required: false, sizes: [[1320, 2868], [1290, 2796], [1260, 2736]], simulators: ["iPhone 17 Pro Max", "iPhone 16 Pro Max", "iPhone 15 Pro Max", "iPhone Air"] }),
  ios({ id: "iphone-6.5", form: "phone", label: 'iPhone 6.5" Face ID (large)', required: false, sizes: [[1284, 2778], [1242, 2688]], simulators: ["iPhone 14 Plus", "iPhone 13 Pro Max", "iPhone 12 Pro Max", "iPhone 11 Pro Max"], deriveFrom: ["iphone-6.9"] }),
  ios({ id: "iphone-6.3", form: "phone", label: 'iPhone 6.3" Dynamic Island (medium)', required: true, sizes: [[1206, 2622], [1179, 2556]], simulators: ["iPhone 17 Pro", "iPhone 17", "iPhone 16 Pro", "iPhone 16", "iPhone 15 Pro", "iPhone 15"] }),
  ios({ id: "iphone-6.1", form: "phone", label: 'iPhone 6.1" Face ID (medium)', required: false, sizes: [[1170, 2532], [1125, 2436], [1080, 2340]], simulators: ["iPhone 16e", "iPhone 14", "iPhone 13", "iPhone 12", "iPhone 11 Pro"], deriveFrom: ["iphone-6.3", "iphone-6.5"] }),
  ios({ id: "iphone-5.5", form: "phone", label: 'iPhone 5.5" Home Button (large)', required: false, sizes: [[1242, 2208]], simulators: ["iPhone 8 Plus"] }),
  ios({ id: "iphone-4.7", form: "phone", label: 'iPhone 4.7" Home Button (medium)', required: false, sizes: [[750, 1334]], simulators: ["iPhone SE (3rd generation)", "iPhone 8"], deriveFrom: ["iphone-5.5"] }),
  ios({ id: "iphone-4", form: "phone", label: 'iPhone 4" Home Button', required: false, sizes: [[640, 1136], [640, 1096]], deriveFrom: ["iphone-4.7", "iphone-5.5"] }),
  ios({ id: "iphone-3.5", form: "phone", label: 'iPhone 3.5" Home Button', required: false, sizes: [[640, 960], [640, 920]], manual: "2:3 screen with no simulator on a current iOS; App Store Connect scales from iPhone 4\"" }),
  ios({ id: "iphone-duo-outer", form: "phone", label: "iPhone Duo (outer)", required: false, sizes: [[1398, 2034]], manual: "needs a simulator posture this runner does not drive; Apple requires it from April 2027 for apps built with the iOS 27.1 SDK or later" }),
  ios({ id: "iphone-duo-inner", form: "phone", label: "iPhone Duo (inner)", required: false, sizes: [[2007, 2853]], manual: "needs a simulator posture this runner does not drive; Apple requires it from April 2027 for apps built with the iOS 27.1 SDK or later" }),
  ios({ id: "ipad-13", form: "tablet", label: 'iPad 13"', required: true, sizes: [[2064, 2752], [2048, 2732]], simulators: ["iPad Pro 13-inch (M5)", "iPad Pro 13-inch (M4)", "iPad Air 13-inch (M3)", "iPad Air 13-inch (M2)", "iPad Pro (12.9-inch) (6th generation)"] }),
  ios({ id: "ipad-12.9", form: "tablet", label: 'iPad 12.9"', required: false, sizes: [[2048, 2732]], simulators: ["iPad Pro (12.9-inch) (6th generation)", "iPad Air 13-inch (M3)", "iPad Air 13-inch (M2)"], deriveFrom: ["ipad-13"] }),
  ios({ id: "ipad-11", form: "tablet", label: 'iPad 11"', required: false, sizes: [[1668, 2420], [1668, 2388], [1640, 2360], [1488, 2266]], simulators: ["iPad Pro 11-inch (M5)", "iPad Pro 11-inch (M4)", "iPad Air 11-inch (M3)", "iPad Air 11-inch (M2)", "iPad (A16)", "iPad mini (A17 Pro)"] }),
  ios({ id: "ipad-10.5", form: "tablet", label: 'iPad 10.5"', required: false, sizes: [[1668, 2224]], simulators: ["iPad Air (3rd generation)", "iPad Pro (10.5-inch)"], deriveFrom: ["ipad-12.9", "ipad-13"] }),
  ios({ id: "ipad-9.7", form: "tablet", label: 'iPad 9.7"', required: false, sizes: [[1536, 2048], [768, 1024]], simulators: ["iPad mini (5th generation)", "iPad (6th generation)"], deriveFrom: ["ipad-10.5", "ipad-12.9", "ipad-13"] }),
  // Play wants 9:16 for recommendations and rejects anything past 2:1, so a 20:9 device never fits.
  android({ id: "android-phone", form: "phone", label: "Android phone", required: true, sizes: [[1080, 1920]], density: 420, banner: "capped" }),
  android({ id: "android-tablet-7", form: "tablet", label: 'Android 7" tablet', sizes: [[1080, 1920]], density: 280, banner: "plain" }),
  android({ id: "android-tablet-10", form: "tablet", label: 'Android 10" tablet', sizes: [[1440, 2560]], density: 320, banner: "plain" }),
];

export const slotById = (id: string): Slot | undefined => SLOTS.find((slot) => slot.id === id);

export const acceptsSize = (slot: Slot, width: number, height: number): boolean => slot.sizes.some(([w, h]) => w === width && h === height);

// Scaling down is what the stores do themselves, within a 1% aspect difference. Never scale up.
export const canDerive = (from: Size, to: Size): boolean => from[0] >= to[0] && from[1] >= to[1] && Math.abs(from[1] / from[0] / (to[1] / to[0]) - 1) <= 0.01;
