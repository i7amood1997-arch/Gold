// Renders icons/favicon.svg to the PNG sizes iOS and Android need.
// Usage: node tools/make-icons.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync(new URL('../icons/favicon.svg', import.meta.url), 'utf8');
// Full-bleed square (no rounded corners): the OS applies its own mask.
const square = svg.replace(/<rect([^>]*)rx="112"/, '<rect$1');
// Maskable: shrink the artwork into the 80% safe zone.
const maskable = square.replace(/(<path[\s\S]*<\/svg>)/, '<g transform="translate(51.2 51.2) scale(.8)">$1').replace('</svg>', '</g></svg>');

const out = [
  ['icon-192.png', 192, square], ['icon-512.png', 512, square],
  ['icon-maskable-192.png', 192, maskable], ['icon-maskable-512.png', 512, maskable],
  ['apple-touch-icon.png', 180, square], ['apple-touch-icon-167.png', 167, square],
  ['apple-touch-icon-152.png', 152, square], ['apple-touch-icon-120.png', 120, square],
  ['favicon-32.png', 32, svg],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, art] of out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${art}`);
  writeFileSync(new URL(`../icons/${name}`, import.meta.url), await page.screenshot({ omitBackground: true }));
}
await browser.close();
console.log('icons written');
