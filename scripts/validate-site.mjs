import { access, readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const fail = (message) => errors.push(message);
const exists = async (file) => access(file).then(() => true, () => false);
const read = (file) => readFile(path.join(ROOT, file), 'utf8');

let data;
try {
  data = JSON.parse(await read('posts.json'));
} catch (error) {
  fail(`posts.json is invalid: ${error.message}`);
  data = { base: '', posts: [] };
}

if (data.base !== '/blue-images/') fail('posts.json base must be /blue-images/.');
if (!Array.isArray(data.posts) || data.posts.length === 0) fail('posts.json must contain posts.');

const postIds = new Set();
const imageIds = new Set();
const expectedImages = new Set();
for (const [index, post] of (data.posts || []).entries()) {
  const label = `posts[${index}]`;
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(post.id || '')) fail(`${label} has an invalid id.`);
  if (postIds.has(post.id)) fail(`${label} duplicates post id ${post.id}.`);
  postIds.add(post.id);
  if (!/^\d{12}$/.test(post.imageId || '')) fail(`${label} has an invalid imageId.`);
  if (imageIds.has(post.imageId)) fail(`${label} duplicates imageId ${post.imageId}.`);
  imageIds.add(post.imageId);
  if (!Number.isInteger(post.count) || post.count < 1 || post.count > 99) fail(`${label} has an invalid count.`);
  const cover = Number(post.cover);
  if (!/^\d{2}$/.test(post.cover || '') || cover < 1 || cover > post.count) fail(`${label} has an invalid cover.`);
  if (!Array.isArray(post.ratios) || post.ratios.length !== post.count) fail(`${label} ratios must match count.`);
  else if (post.ratios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0 || ratio > 10)) fail(`${label} has an invalid ratio.`);
  if (post.captions && (!Array.isArray(post.captions) || post.captions.length !== post.count)) {
    fail(`${label} captions must match count.`);
  }
  for (let number = 1; number <= post.count; number += 1) {
    expectedImages.add(`${post.imageId}_${String(number).padStart(2, '0')}.jpg`);
  }
  expectedImages.add(`${post.imageId}_${post.cover}_thumb.jpg`);
}

const imageDir = path.join(ROOT, 'blue-images');
const actualImages = (await readdir(imageDir)).filter((name) => /^\d{12}_\d{2}(?:_thumb)?\.jpg$/.test(name));
for (const name of expectedImages) {
  if (!(await exists(path.join(imageDir, name)))) fail(`missing blue-images/${name}`);
}
for (const name of actualImages) {
  if (!expectedImages.has(name)) fail(`orphan blue-images/${name}`);
}

for (const name of actualImages.filter((name) => name.endsWith('_thumb.jpg'))) {
  const info = await stat(path.join(imageDir, name));
  if (info.size > 150_000) fail(`blue-images/${name} is too large for a thumbnail (${info.size} bytes).`);
}
for (const [name, limit] of [['J1.jpg', 500_000], ['J2.jpg', 500_000], ['J1.avif', 150_000], ['J2.avif', 150_000]]) {
  try {
    const info = await stat(path.join(imageDir, name));
    if (info.size > limit) fail(`blue-images/${name} exceeds ${limit} bytes.`);
  } catch {
    fail(`missing blue-images/${name}`);
  }
}

const requiredFiles = [
  'index.html', 'blue.html', 'blue-post.html', 'blue-admin.html', 'oro.html', '404.html',
  'site-icon.svg', 'blue-admin.webmanifest',
  'blue-admin-icon-192.png', 'blue-admin-icon-512.png'
];
for (const file of requiredFiles) {
  if (!(await exists(path.join(ROOT, file)))) fail(`missing ${file}`);
}

const htmlFiles = (await readdir(ROOT)).filter((name) => name.endsWith('.html'));
htmlFiles.push(...(await readdir(path.join(ROOT, 'p'))).filter((name) => name.endsWith('.html')).map((name) => `p/${name}`));
for (const file of htmlFiles) {
  const html = await read(file);
  if (!/<html\b[^>]*\blang=/i.test(html)) fail(`${file} is missing html lang.`);
  if (!/rel=["']icon["']/i.test(html)) fail(`${file} is missing a favicon.`);
  if (/\b(?:theme-toggle|theme-icon)\b/.test(html)) fail(`${file} contains a manual theme control.`);
  if (/localStorage\.(?:getItem|setItem)\(["']theme["']/.test(html)) fail(`${file} persists a manual theme preference.`);
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    if (/\bsrc\s*=/i.test(match[1]) || /type=["']application\/ld\+json/i.test(match[1])) continue;
    try {
      new vm.Script(match[2], { filename: file });
    } catch (error) {
      fail(`${file} has invalid inline JavaScript: ${error.message}`);
    }
  }
  const referencePattern = /\b(?:href|src)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(referencePattern)) {
    const reference = match[1];
    if (/^(?:[a-z]+:|#|\/\/)/i.test(reference)) continue;
    const withoutFragment = reference.split('#')[0].split('?')[0];
    if (!withoutFragment) continue;
    const relativePath = withoutFragment.startsWith('/')
      ? withoutFragment.slice(1)
      : path.posix.normalize(path.posix.join(path.posix.dirname(file), withoutFragment));
    const target = relativePath.endsWith('/') ? `${relativePath}index.html` : relativePath;
    if (!(await exists(path.join(ROOT, target)))) fail(`${file} references missing ${reference}`);
  }
}

try {
  const manifest = JSON.parse(await read('blue-admin.webmanifest'));
  if (!Array.isArray(manifest.icons) || !manifest.icons.some((icon) => icon.sizes === '192x192')
      || !manifest.icons.some((icon) => icon.sizes === '512x512')) {
    fail('blue-admin.webmanifest must provide 192px and 512px icons.');
  }
} catch (error) {
  fail(`blue-admin.webmanifest is invalid: ${error.message}`);
}

const admin = await read('blue-admin.html');
if (!/body\s+class=["'][^"']*page-admin/.test(admin)) fail('blue-admin.html is missing its page design scope.');
if (!admin.includes('let item = items[i++]')) fail('blue-admin runPool must capture each item with block scope.');
try {
  const start = admin.indexOf('function runPool(');
  const end = admin.indexOf('\n        function updatePublishState', start);
  if (start < 0 || end < 0) throw new Error('runPool source not found');
  const runPool = vm.runInNewContext(`(${admin.slice(start, end).trim()})`, { Promise });
  const seen = [];
  await runPool([1, 2, 3, 4, 5, 6], 3, async (item) => {
    await Promise.resolve();
    seen.push(item);
  });
  if (seen.slice().sort().join(',') !== '1,2,3,4,5,6') throw new Error(`processed ${seen.join(',')}`);
} catch (error) {
  fail(`blue-admin runPool regression: ${error.message}`);
}
if (!admin.includes("sessionStorage.setItem(TOKEN_KEY")) fail('blue-admin token must be stored in sessionStorage.');
if (/localStorage\.setItem\(TOKEN_KEY/.test(admin)) fail('blue-admin must not persist its token in localStorage.');
if (admin.includes('blueAnalyticsEndpoint')) fail('blue-admin must not accept an untrusted analytics endpoint override.');
if (!admin.includes('ghCommitTree')) fail('blue-admin is missing atomic Git tree commits.');
if (!admin.includes('expectedPostsSha') || !admin.includes('force: false')) fail('blue-admin is missing optimistic commit conflict protection.');
if (admin.includes('editingOriginalCount')) fail('blue-admin contains unused editingOriginalCount state.');

const home = await read('index.html');
if (/market-note|SPCX|fetchMarketNote|corsproxy|query1\.finance/.test(home)) {
  fail('index.html contains orphaned market-ticker UI or code.');
}
if (!/body\s+class=["'][^"']*page-home/.test(home)) fail('index.html is missing its page design scope.');

const blue = await read('blue.html');
if (/J[12]\.png/.test(blue)) fail('blue.html still references oversized PNG feature art.');
if (!blue.includes('J1.avif') || !blue.includes('J2.avif')) fail('blue.html is missing AVIF feature art.');
if (/\.feature-credit\s*\{[^}]*text-align:\s*left/.test(blue)) {
  fail('blue.html must keep the feature credit right-aligned at every viewport size.');
}
if (/\.feature-credit\s+a\s*\{[^}]*border(?:-bottom)?\s*:/.test(blue)
    || !/\.feature-credit\s+a\s*\{[^}]*text-decoration:\s*none/.test(blue)) {
  fail('blue.html must show the feature credit link without an underline.');
}
if (!/body\s+class=["'][^"']*page-blue/.test(blue)) fail('blue.html is missing its page design scope.');
const bluePost = await read('blue-post.html');
if (!/body\s+class=["'][^"']*page-post/.test(bluePost)) fail('blue-post.html is missing its page design scope.');
if (await exists(path.join(ROOT, 'blue-feature-overrides.css'))) fail('obsolete blue-feature-overrides.css still exists.');

const oro = await read('oro.html');
if (oro.includes('oro-shared.css') || oro.includes(':has(') || oro.includes('--accent-blue')) {
  fail('oro.html contains obsolete shared-style overrides.');
}
if (!/body\s+class=["'][^"']*page-oro/.test(oro)) fail('oro.html is missing its page design scope.');
if (await exists(path.join(ROOT, 'oro-shared.css'))) fail('obsolete oro-shared.css still exists.');

const shared = await read('shared.css');
if (!shared.includes('.nav-pill:visited { color: var(--text-muted); }')) {
  fail('shared.css must preserve muted navigation-pill color for visited links.');
}
if (!shared.includes('--glass-filter:') || !shared.includes('-webkit-backdrop-filter: var(--glass-filter)')) {
  fail('shared.css is missing the cross-browser liquid-glass material.');
}
if (/--page-glow|radial-gradient\(/.test(shared)) fail('shared.css must keep the page background neutral.');
if (!shared.includes('--bg: #ffffff;') || !shared.includes('--card: rgba(242,242,247,0.76);')) {
  fail('shared.css must keep the light theme white with gray glass surfaces.');
}

const theme = await read('theme.js');
if (!theme.includes("matchMedia('(prefers-color-scheme: dark)')") || /localStorage|theme-toggle|theme-icon/.test(theme)) {
  fail('theme.js must follow the device color scheme without a manual override.');
}

const serviceWorker = await read('sw.js');
if (!serviceWorker.includes('SHELL.includes(url.pathname)')) fail('service worker must limit caching to shell assets.');

if (errors.length) {
  console.error(`Validation failed with ${errors.length} issue${errors.length === 1 ? '' : 's'}:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`Validated ${data.posts.length} posts, ${actualImages.length} post images, and ${htmlFiles.length} HTML files.`);
