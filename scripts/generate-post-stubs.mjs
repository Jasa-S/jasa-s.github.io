import { readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHECK = process.argv.includes('--check');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildStub(post) {
  const hidden = Boolean(post.hidden);
  const target = hidden ? '/blue.html' : `/blue-post.html#${post.id}`;
  const imgUrl = `https://jasa-s.github.io/blue-images/${post.imageId}_${post.cover}.jpg`;
  const postUrl = `https://jasa-s.github.io/p/${post.id}.html`;
  const title = post.title || '';

  return '<!doctype html><html lang="en"><head><meta charset="utf-8">\n'
    + `<title>${escapeHtml(title)} | BlUE</title>\n`
    + '<link rel="icon" href="/site-icon.svg" type="image/svg+xml">\n'
    + `<meta property="og:title" content="${escapeHtml(title)} | BlUE">\n`
    + `<meta property="og:image" content="${escapeHtml(imgUrl)}">\n`
    + `<meta property="og:url" content="${escapeHtml(postUrl)}">\n`
    + '<meta property="og:type" content="article">\n'
    + '<meta property="og:site_name" content="BlUE">\n'
    + '<meta name="twitter:card" content="summary_large_image">\n'
    + `<meta name="twitter:title" content="${escapeHtml(title)} | BlUE">\n`
    + `<meta name="twitter:image" content="${escapeHtml(imgUrl)}">\n`
    + `<meta http-equiv="refresh" content="0; url=${escapeHtml(target)}">\n`
    + `<script>location.replace(${JSON.stringify(target)});</script>\n`
    + `</head><body><a href="${escapeHtml(target)}">${hidden ? 'Gallery' : 'View post'}</a></body></html>\n`;
}

const data = JSON.parse(await readFile(path.join(ROOT, 'posts.json'), 'utf8'));
const expected = new Map(data.posts.map((post) => [`${post.id}.html`, buildStub(post)]));
const postsDir = path.join(ROOT, 'p');
await mkdir(postsDir, { recursive: true });
const actualNames = (await readdir(postsDir)).filter((name) => name.endsWith('.html'));

if (CHECK) {
  const errors = [];
  for (const [name, contents] of expected) {
    try {
      const actual = await readFile(path.join(postsDir, name), 'utf8');
      if (actual !== contents) errors.push(`outdated p/${name}`);
    } catch {
      errors.push(`missing p/${name}`);
    }
  }
  for (const name of actualNames) {
    if (!expected.has(name)) errors.push(`orphan p/${name}`);
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`Post stubs are current (${expected.size} posts).`);
} else {
  await Promise.all([...expected].map(([name, contents]) =>
    writeFile(path.join(postsDir, name), contents)
  ));
  await Promise.all(actualNames
    .filter((name) => !expected.has(name))
    .map((name) => rm(path.join(postsDir, name))));
  console.log(`Generated ${expected.size} post stubs.`);
}
