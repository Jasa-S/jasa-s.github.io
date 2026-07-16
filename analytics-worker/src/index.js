const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const DAY_MS = 86400000;
const MAX_SLICE_DAYS = 7;

const query = `
  query Analytics($accountTag: string!, $host: string!, $start: Time!, $end: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        totals: rumPageloadEventsAdaptiveGroups(
          filter: { datetime_geq: $start, datetime_lt: $end, requestHost: $host, bot: 0 }
          limit: 1
        ) {
          count
          sum { visits }
        }
        traffic: rumPageloadEventsAdaptiveGroups(
          filter: { datetime_geq: $start, datetime_lt: $end, requestHost: $host, bot: 0 }
          limit: 40
          orderBy: [count_DESC]
        ) {
          dimensions { refererHost requestPath countryName }
          count
        }
        pages: rumPageloadEventsAdaptiveGroups(
          filter: { datetime_geq: $start, datetime_lt: $end, requestHost: $host, bot: 0 }
          limit: 16
          orderBy: [count_DESC]
        ) {
          dimensions { requestPath }
          count
        }
        countries: rumPageloadEventsAdaptiveGroups(
          filter: { datetime_geq: $start, datetime_lt: $end, requestHost: $host, bot: 0 }
          limit: 16
          orderBy: [count_DESC]
        ) {
          dimensions { countryName }
          count
        }
        referrers: rumPageloadEventsAdaptiveGroups(
          filter: { datetime_geq: $start, datetime_lt: $end, requestHost: $host, bot: 0 }
          limit: 16
          orderBy: [count_DESC]
        ) {
          dimensions { refererHost }
          count
        }
        browsers: rumPageloadEventsAdaptiveGroups(
          filter: { datetime_geq: $start, datetime_lt: $end, requestHost: $host, bot: 0 }
          limit: 16
          orderBy: [count_DESC]
        ) {
          dimensions { userAgentBrowser }
          count
        }
        devices: rumPageloadEventsAdaptiveGroups(
          filter: { datetime_geq: $start, datetime_lt: $end, requestHost: $host, bot: 0 }
          limit: 16
          orderBy: [count_DESC]
        ) {
          dimensions { deviceType }
          count
        }
        systems: rumPageloadEventsAdaptiveGroups(
          filter: { datetime_geq: $start, datetime_lt: $end, requestHost: $host, bot: 0 }
          limit: 16
          orderBy: [count_DESC]
        ) {
          dimensions { userAgentOS }
          count
        }
      }
    }
  }
`;

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.SITE_ORIGIN,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin'
  };
}

function response(body, status, env) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }, corsHeaders(env))
  });
}

function timeSlices(days) {
  const end = Date.now();
  const start = end - days * DAY_MS;
  const sliceMs = MAX_SLICE_DAYS * DAY_MS;
  const slices = [];
  for (let cursor = start; cursor < end; cursor += sliceMs) {
    slices.push({
      start: new Date(cursor).toISOString(),
      end: new Date(Math.min(cursor + sliceMs, end)).toISOString()
    });
  }
  return slices;
}

async function isOwnerToken(token, env) {
  const res = await fetch(
    'https://api.github.com/user',
    {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'User-Agent': 'blue-analytics'
      }
    }
  );
  if (!res.ok) return false;
  const user = await res.json();
  return user.login === env.GITHUB_OWNER;
}

function sourceLabel(value) {
  const host = String(value || '').toLowerCase().replace(/^www\./, '');
  if (!host) return 'Direct';
  if (host === 'l.instagram.com' || host === 'instagram.com' || host.endsWith('.instagram.com')) return 'Instagram';
  if (host === 'm.facebook.com' || host === 'facebook.com' || host.endsWith('.facebook.com')) return 'Facebook';
  if (host === 't.co' || host === 'x.com' || host.endsWith('.x.com')) return 'X';
  if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) return 'YouTube';
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'LinkedIn';
  if (host === 'pinterest.com' || host.endsWith('.pinterest.com')) return 'Pinterest';
  if (host === 'threads.net' || host.endsWith('.threads.net')) return 'Threads';
  if (host === 'google.com' || host.startsWith('google.') || host.includes('.google.')) return 'Google';
  return host;
}

function dimensionRows(accounts, groupName, key, emptyLabel, transform) {
  const totals = new Map();
  accounts.forEach(function (account) {
    (account[groupName] || []).forEach(function (group) {
      if (!group.dimensions) return;
      let label = group.dimensions[key] || emptyLabel;
      if (!label) return;
      if (transform) label = transform(label);
      totals.set(label, (totals.get(label) || 0) + (group.count || 0));
    });
  });
  return Array.from(totals, function (entry) {
    return { label: entry[0], pageviews: entry[1] };
  }).sort(function (a, b) {
    return b.pageviews - a.pageviews || a.label.localeCompare(b.label);
  }).slice(0, 8);
}

function trafficRows(accounts) {
  const totals = new Map();
  accounts.forEach(function (account) {
    (account.traffic || []).forEach(function (group) {
      if (!group.dimensions) return;
      const source = sourceLabel(group.dimensions.refererHost);
      const page = group.dimensions.requestPath || '/';
      const country = group.dimensions.countryName || 'Unknown';
      const key = JSON.stringify([source, page, country]);
      const current = totals.get(key) || { source: source, page: page, country: country, pageviews: 0 };
      current.pageviews += group.count || 0;
      totals.set(key, current);
    });
  });
  return Array.from(totals.values()).sort(function (a, b) {
    return b.pageviews - a.pageviews || a.source.localeCompare(b.source) || a.page.localeCompare(b.page);
  }).slice(0, 16);
}

async function fetchSlice(env, host, slice) {
  const graphql = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.CF_ANALYTICS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: query,
      variables: {
        accountTag: env.CF_ACCOUNT_ID,
        host: host,
        start: slice.start,
        end: slice.end
      }
    })
  });
  let payload;
  try {
    payload = await graphql.json();
  } catch (error) {
    throw new Error('Cloudflare analytics returned an invalid response');
  }
  if (!graphql.ok || payload.errors) {
    const detail = payload.errors && payload.errors[0] && payload.errors[0].message;
    throw new Error(detail || 'Cloudflare analytics request failed');
  }
  const account = payload.data && payload.data.viewer && payload.data.viewer.accounts && payload.data.viewer.accounts[0];
  if (!account) throw new Error('Analytics account not found');
  return account;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (origin && origin !== env.SITE_ORIGIN) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (request.method !== 'GET') return response({ error: 'Method not allowed' }, 405, env);

    const url = new URL(request.url);
    if (url.pathname !== '/analytics') return response({ error: 'Not found' }, 404, env);

    const authorization = request.headers.get('Authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    let authorized = false;
    try {
      authorized = token ? await isOwnerToken(token, env) : false;
    } catch (error) {
      return response({ error: 'GitHub authorization check failed' }, 502, env);
    }
    if (!authorized) {
      return response({ error: 'Unauthorized' }, 401, env);
    }

    const requestedDays = Number(url.searchParams.get('days')) || 7;
    const days = Math.max(1, Math.min(90, Math.floor(requestedDays)));
    let accounts;
    try {
      const host = new URL(env.SITE_ORIGIN).hostname;
      accounts = await Promise.all(timeSlices(days).map(function (slice) {
        return fetchSlice(env, host, slice);
      }));
    } catch (error) {
      console.error('Analytics query failed:', error && error.message ? error.message : error);
      return response({ error: error && error.message ? error.message : 'Cloudflare analytics request failed' }, 502, env);
    }

    const totals = accounts.reduce(function (summary, account) {
      const total = account.totals && account.totals[0] ? account.totals[0] : {};
      summary.visits += total.sum && total.sum.visits ? total.sum.visits : 0;
      summary.pageviews += total.count || 0;
      return summary;
    }, { visits: 0, pageviews: 0 });
    return response({
      days: days,
      visits: totals.visits,
      pageviews: totals.pageviews,
      traffic: trafficRows(accounts),
      pages: dimensionRows(accounts, 'pages', 'requestPath'),
      countries: dimensionRows(accounts, 'countries', 'countryName'),
      referrers: dimensionRows(accounts, 'referrers', 'refererHost', 'Direct', sourceLabel),
      browsers: dimensionRows(accounts, 'browsers', 'userAgentBrowser'),
      devices: dimensionRows(accounts, 'devices', 'deviceType'),
      systems: dimensionRows(accounts, 'systems', 'userAgentOS')
    }, 200, env);
  }
};
