# jasa-s.github.io

Personal site and photography journal published as a static GitHub Pages site.

## Structure

- `index.html` — homepage
- `blue.html` — photography index
- `blue-post.html` — client-rendered post view
- `posts.json` and `blue-images/` — photography content
- `p/` — crawlable metadata pages that redirect visitors to the post view
- `blue-admin.html` — private-by-convention browser publishing tool
- `oro.html` and `oro.js` — weather view
- `analytics-worker/` — optional Cloudflare Worker proxy for owner-only analytics

There is no production build step. GitHub Pages serves the tracked files from `main`.

## Local checks

Node.js 20 or newer is required.

```sh
npm test
```

When `posts.json` changes outside the admin, regenerate the post redirect pages, then run the checks:

```sh
npm run generate
npm test
```

The validation checks content IDs, image/stub consistency, asset budgets, inline and standalone JavaScript syntax, and security-sensitive admin invariants. GitHub Actions runs the same checks on pushes and pull requests.

## Publishing photographs

Open `/blue-admin.html` on the deployed site and connect with a short-lived fine-grained GitHub personal access token that has **Contents: read and write** permission for this repository only. The token is kept in `sessionStorage`, so closing the tab ends the browser session; revoke the token when it is no longer needed.

Publishing, full edits, and deletion are written through the Git Data API as one commit. This prevents `posts.json`, post stubs, thumbnails, and originals from being left at different versions. Full edits reuse the existing Git blobs for unchanged photographs.

The admin page is not an authentication boundary. GitHub is the authorization layer. Never commit tokens or secrets.

## Analytics worker

The optional Worker needs these encrypted secrets:

- `CF_ANALYTICS_TOKEN`
- `CF_ACCOUNT_ID`

Its checked-in configuration restricts browser access to `https://jasa-s.github.io`. Deploy it with Wrangler, then set the trusted endpoint in `analytics-endpoint-config.js`. The admin deliberately does not accept a runtime endpoint override, because it forwards the GitHub bearer token when requesting analytics.

The admin groups referrer, viewed path, and country into aggregate traffic rows. Cloudflare Web Analytics does not expose city-level data or individual visitor records. Longer ranges are queried in weekly slices to reduce adaptive-sampling gaps.

## Deployment

GitHub Pages deploys from `main`. The `.nojekyll` file keeps the repository as a plain static site. After a push, confirm the **Validate site** and Pages workflows succeed.
