#!/usr/bin/env node
// generate-tray-icon.js — regenerates the CoachBuild Overlay's tray icon
// (assets/tray-icon.png + assets/tray-icon@2x.png) and app icon
// (assets/icon.ico) from one SVG source, so the mark is reproducible rather
// than a binary that appeared from nowhere (2026-07-27, tray redesign round
// -- see HANDOFF-engy.md's A2 item).
//
// WHY A SCRIPT, NOT A HAND-EXPORTED PNG/ICO
// -------------------------------------------------------------------------
// `assets/tray-icon.png` before this round was a 91-byte 16x16 RGBA PNG --
// effectively an empty placeholder, not a logo -- and there was no source
// for it anywhere in the repo. Running this script is how the icon is
// regenerated if the palette ever changes again; the SVG below IS the
// source, not a description of one.
//
// COLOR NOTE -- READ BEFORE CHANGING THE PALETTE BELOW
// -------------------------------------------------------------------------
// The task brief that requested this icon said "the app's accent colour is
// teal (see renderer/ingame.css for the palette)." Checked directly against
// renderer/ingame.css (this app's own stylesheet) AND app/globals.css /
// tailwind.config.ts (the main Next.js app) before writing this: that claim
// is STALE. renderer/ingame.css has no teal token anywhere -- it is a
// gold/navy "hextech" palette (`--cb-gold: #c8aa6e`, `--cb-bg: #0a0d0b`).
// tailwind.config.ts keeps a color KEY literally named `teal` (so old
// `bg-teal`/`text-teal`/`border-teal-dim` call sites across the web app keep
// resolving), but its VALUE is `#c8aa6e` -- the same hextech gold -- and
// globals.css says so explicitly in its own comment: "Primary accent —
// League Hextech gold (was cyan, then lavender-era teal)". There is no
// actual teal hue live in this codebase; the word survives only as a class
// name. This icon uses the two REAL, current tokens (gold + the near-black
// navy panel background) instead of a color that does not exist here
// anymore.
//
// PATH NOTE: the task brief referred to the app icon as `build/icon.ico`.
// There is no `build/` directory in overlay-host. The real app icon lives at
// `assets/icon.ico`, referenced by package.json's `build.win.icon` and by
// `scripts/apply-exe-resources.js`'s `ICON_PATH` -- both checked directly
// before writing this script. This script writes there.
//
// Uses `sharp` (SVG rasterization) + `png-to-ico` (multi-size .ico packing)
// from the existing image toolchain at
// C:/Claude/AI/urgot/.smoke-tools/node_modules -- NOT a new dependency of
// this project. Reused per the brief's own instruction to check that
// toolchain before installing anything new; overlay-host's own
// package.json/node_modules are untouched by this script.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SMOKE_TOOLS_NODE_MODULES = 'C:/Claude/AI/urgot/.smoke-tools/node_modules';

function requireFromSmokeTools(pkg) {
  const pkgPath = path.join(SMOKE_TOOLS_NODE_MODULES, pkg);
  if (!fs.existsSync(pkgPath)) {
    throw new Error(
      `expected "${pkg}" at ${pkgPath} -- the shared image toolchain at ${SMOKE_TOOLS_NODE_MODULES} is missing it. ` +
        'See this file\'s header before installing a fresh copy into overlay-host.'
    );
  }
  return require(pkgPath);
}

const sharp = requireFromSmokeTools('sharp');

// png-to-ico v3 is a PURE ESM package ("type": "module" in its own
// package.json) whose default export only accepts FILE PATHS (it reads PNGs
// off disk itself, and only ever produces the fixed size set
// [256, 48, 32, 16] from one square source) -- neither shape fits what this
// script needs (in-memory PNG buffers, a caller-chosen size list including
// 24). It DOES export `imagesToIco` (a plain, synchronous {width, height,
// data: RGBA Buffer} array -> ICO Buffer packer, sized however the caller
// likes) as a named export, which is exactly the right shape -- reached via
// dynamic `import()` since this script itself is CommonJS (overlay-host's
// package.json has no "type": "module", same as main.js).
async function loadImagesToIco() {
  const indexPath = path.join(SMOKE_TOOLS_NODE_MODULES, 'png-to-ico', 'index.js');
  const mod = await import(pathToFileURL(indexPath).href);
  return mod.imagesToIco;
}

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// Two real tokens from this app's own palette (see the header note above) --
// renderer/ingame.css's --cb-bg (the near-black navy panel background) and
// --cb-gold (the hextech gold accent used for the champion name, marked
// skill cells, the current-level band -- this app's actual "brand" color).
const NAVY = '#0a0d0b';
const GOLD = '#c8aa6e';

// A bold, two-tone coin, designed to read at 16x16 -- the actual size
// Windows renders a tray icon at, and the size every design decision below
// is made for, not 256x256 (which only matters for the .ico's largest entry
// and the taskbar/Explorer "Open File Location" view).
//
//   - Navy disc, full bleed: its own dark contrast against a LIGHT taskbar.
//   - Slim gold ring (the navy disc peeking through, r120 minus the r104
//     gold disc drawn on top = a 16-unit ring): its own light contrast
//     against a DARK taskbar -- a solid navy disc alone would nearly
//     disappear on Windows' near-black dark taskbar, but the ring is thin
//     enough not to fight the gold field for attention.
//   - A bold navy upward chevron cut across the gold field: evokes
//     "next / level up," which is literally this app's headline feature
//     (the in-game ability highlight box marks the NEXT ability to level).
//     No text, no fine detail, thick strokes throughout -- legible at 16px.
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <circle cx="128" cy="128" r="120" fill="${NAVY}"/>
  <circle cx="128" cy="128" r="104" fill="${GOLD}"/>
  <path d="M72 150 L128 88 L184 150" fill="none" stroke="${NAVY}"
        stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`.trim();

// Minimum sizes requested for the .ico: 16 (tray-scale), 24 (Windows' own
// "small icon" size in some shell views), 32 (taskbar/Alt-Tab), 48 (desktop
// icon), 256 (Explorer large-icon view, "Open file location", installer UI).
const ICO_SIZES = [16, 24, 32, 48, 256];

async function backupIfPresent(name) {
  const src = path.join(ASSETS_DIR, name);
  const bak = `${src}.bak`;
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(bak)) {
    console.log(`[generate-tray-icon] ${path.basename(bak)} already exists -- leaving it (only ever backs up the ORIGINAL, not a prior regeneration)`);
    return;
  }
  fs.copyFileSync(src, bak);
  console.log(`[generate-tray-icon] backed up ${name} -> ${path.basename(bak)}`);
}

async function renderPng(size) {
  return sharp(Buffer.from(SVG, 'utf8')).resize(size, size).png().toBuffer();
}

// Raw RGBA pixel buffer + dimensions, the exact shape imagesToIco()
// (png-to-ico's internal packer) expects for each frame -- see
// getPixelColor() in png-to-ico's index.js: it reads each pixel as a
// big-endian uint32 (R<<24 | G<<16 | B<<8 | A), which is precisely what
// sharp's raw RGBA output already is byte-for-byte, so no channel-order
// conversion is needed here.
async function renderRawFrame(size) {
  const { data, info } = await sharp(Buffer.from(SVG, 'utf8'))
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

async function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  // Reversible, per the brief -- back up whatever is currently on disk
  // BEFORE any write below touches it.
  await backupIfPresent('tray-icon.png');
  await backupIfPresent('icon.ico');

  // Tray PNG: 16x16 primary + a 32x32 "@2x" sibling. Electron's nativeImage
  // automatically picks up an "@2x"-suffixed file next to the base path on a
  // HiDPI display -- this costs one extra small file and makes the tray
  // icon crisp on a scaled display instead of the OS upscaling the 16x16
  // source.
  const png16 = await renderPng(16);
  const png32 = await renderPng(32);
  fs.writeFileSync(path.join(ASSETS_DIR, 'tray-icon.png'), png16);
  fs.writeFileSync(path.join(ASSETS_DIR, 'tray-icon@2x.png'), png32);
  console.log('[generate-tray-icon] wrote tray-icon.png (16x16) + tray-icon@2x.png (32x32)');

  // App icon: pack every requested size into one .ico (used for the exe icon
  // via package.json's build.win.icon + scripts/apply-exe-resources.js's
  // rcedit --set-icon call -- both point at assets/icon.ico, see this file's
  // header for the build/icon.ico -> assets/icon.ico path correction).
  const imagesToIco = await loadImagesToIco();
  const frames = await Promise.all(ICO_SIZES.map(renderRawFrame));
  const icoBuffer = imagesToIco(frames);
  fs.writeFileSync(path.join(ASSETS_DIR, 'icon.ico'), icoBuffer);
  console.log(`[generate-tray-icon] wrote icon.ico (sizes: ${ICO_SIZES.join(', ')})`);
}

main().catch((err) => {
  console.error('[generate-tray-icon] FAILED:', err);
  process.exitCode = 1;
});
