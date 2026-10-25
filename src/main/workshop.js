// Zugriff auf den Steam Workshop von RimWorld – ohne API-Key.
// Suche: eingebettete SSR-Daten der Workshop-Seite. Details: öffentliche ISteamRemoteStorage-API.
// Abhängigkeiten & Screenshots: Detailseite des Mods.

const APPID = 294100;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const API = 'https://api.steampowered.com/ISteamRemoteStorage';

const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.p;
  const p = fn().catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { t: Date.now(), p });
  return p;
}

async function fetchText(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.8', ...(init.headers || {}) },
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error(`Steam antwortet mit HTTP ${res.status}`);
  return res.text();
}

async function postApi(method, params) {
  const body = new URLSearchParams(params).toString();
  const text = await fetchText(`${API}/${method}/v1/`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return JSON.parse(text).response;
}

function versionTags(tags) {
  return (tags || []).map((t) => t.tag || t).filter((t) => /^\d+\.\d+$/.test(t));
}

function normalize(raw, authorName) {
  const tags = (raw.tags || []).map((t) => t.tag || t);
  return {
    id: String(raw.publishedfileid),
    title: raw.title || `Workshop-Item ${raw.publishedfileid}`,
    shortDescription: String(raw.short_description || '').replace(/\[[^\]]*\]|https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim(),
    description: raw.file_description ?? raw.description ?? '',
    preview: raw.preview_url || '',
    creatorId: String(raw.creator || ''),
    author: authorName || '',
    subscriptions: Number(raw.subscriptions || 0),
    lifetimeSubscriptions: Number(raw.lifetime_subscriptions || 0),
    favorited: Number(raw.favorited || 0),
    views: Number(raw.views || 0),
    stars: Number(raw.star_rating ?? -1),
    votes: Number(raw.total_votes || 0),
    size: Number(raw.file_size || 0),
    timeCreated: Number(raw.time_created || 0),
    timeUpdated: Number(raw.time_updated || 0),
    tags: tags.filter((t) => !/^\d+\.\d+$/.test(t)),
    versions: versionTags(raw.tags).sort((a, b) => parseFloat(b) - parseFloat(a)),
    isCollection: raw.file_type === 2,
    ok: raw.result === undefined || raw.result === 1
  };
}

function parseSsr(html) {
  const m = html.match(/<script type="application\/json" id="valve-ssr-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const data = JSON.parse(m[1]);
  let rc = data.renderContext;
  if (typeof rc === 'string') rc = JSON.parse(rc);
  let qd = rc?.queryData;
  if (typeof qd === 'string') qd = JSON.parse(qd);
  return qd?.queries || [];
}

const SORTS = {
  trend: 'trend',
  popular: 'totaluniquesubscribers',
  recent: 'mostrecent',
  updated: 'lastupdated',
  relevance: 'textsearch'
};

// params: { query, sort, page, days, version, tags[] }
async function browse({ query = '', sort = 'trend', page = 1, days = 7, version = '', tags = [] } = {}) {
  const url = new URL('https://steamcommunity.com/workshop/browse/');
  url.searchParams.set('appid', APPID);
  url.searchParams.set('section', 'readytouseitems');
  url.searchParams.set('browsesort', SORTS[sort] || sort);
  url.searchParams.set('actualsort', SORTS[sort] || sort);
  if (query) url.searchParams.set('searchtext', query);
  if (sort === 'trend') url.searchParams.set('days', String(days));
  url.searchParams.set('p', String(page));
  const allTags = [...tags];
  if (version) allTags.push(version);
  allTags.forEach((t) => url.searchParams.append('requiredtags[]', t));

  return cached(url.toString(), 5 * 60 * 1000, async () => {
    const html = await fetchText(url.toString());
    const queries = parseSsr(html);
    const q = queries?.find((x) => x.queryKey?.[0] === 'workshop_browse');
    if (q?.state?.data) {
      const d = q.state.data;
      const names = new Map();
      for (const x of queries) {
        if (x.queryKey?.[0] === 'PlayerLinkDetails' && x.state?.data?.public_data) {
          names.set(String(x.queryKey[1]), x.state.data.public_data.persona_name);
        }
      }
      for (const p of d.creator_player_link_details || []) {
        if (p?.public_data) names.set(String(p.public_data.steamid), p.public_data.persona_name);
      }
      return {
        items: (d.results || []).map((r) => normalize(r, names.get(String(r.creator)))),
        total: d.total_count || 0,
        totalPages: d.total_pages || 1,
        page
      };
    }
    // Fallback für das alte Seitenlayout: IDs aus dem HTML holen und Details nachladen.
    const ids = [...new Set([...html.matchAll(/data-publishedfileid="(\d+)"/g)].map((x) => x[1]))];
    const items = await details(ids);
    return { items, total: items.length, totalPages: page + (items.length >= 30 ? 1 : 0), page };
  });
}

// Details für viele IDs (max. 100 pro Anfrage).
async function details(ids) {
  const unique = [...new Set(ids.map(String))].filter((id) => /^\d+$/.test(id));
  const out = [];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const key = 'details:' + chunk.join(',');
    const part = await cached(key, 2 * 60 * 1000, async () => {
      const params = { itemcount: String(chunk.length) };
      chunk.forEach((id, n) => (params[`publishedfileids[${n}]`] = id));
      const res = await postApi('GetPublishedFileDetails', params);
      return (res.publishedfiledetails || []).map((r) => normalize(r));
    });
    out.push(...part);
  }
  return out;
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// Liest von der Detailseite: benötigte Items, Screenshots, Autor, benötigte DLCs.
async function pageInfo(id) {
  return cached('page:' + id, 10 * 60 * 1000, async () => {
    const html = await fetchText(`https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`);
    const required = [];
    const block = html.match(/id="RequiredItems">([\s\S]*?)<\/div>\s*<\/div>/);
    if (block) {
      for (const m of block[1].matchAll(/filedetails\/\?id=(\d+)"[\s\S]*?class="requiredItem">([\s\S]*?)<\/div>/g)) {
        required.push({ id: m[1], name: decodeHtml(m[2]) });
      }
    }
    const requiredDlc = [];
    const dlcBlock = html.match(/id="RequiredAppItems">([\s\S]*?)<\/div>\s*<\/div>/);
    if (dlcBlock) {
      for (const m of dlcBlock[1].matchAll(/class="requiredItem">([\s\S]*?)<\/div>/g)) requiredDlc.push(decodeHtml(m[1]));
    }
    const screenshots = [...html.matchAll(/'url':\s*'(https:\/\/images\.steamusercontent\.com\/ugc\/[^']+)'/g)]
      .map((m) => m[1].replace(/\?.*$/, ''));
    const author = html.match(/class="friendBlockContent">\s*([^<]+?)\s*<br/);
    return { required, requiredDlc, screenshots: [...new Set(screenshots)], author: author ? decodeHtml(author[1]) : '' };
  });
}

// Löst Abhängigkeiten rekursiv auf. Gibt die IDs in Installationsreihenfolge zurück (Abhängigkeiten zuerst).
async function resolveDependencies(rootIds, isInstalled) {
  const visited = new Set();
  const order = [];
  const names = {};
  async function visit(id, depth) {
    if (visited.has(id) || depth > 8) return;
    visited.add(id);
    let info = { required: [] };
    try {
      info = await pageInfo(id);
    } catch { /* Detailseite nicht erreichbar – ohne Abhängigkeiten weiter */ }
    for (const dep of info.required) {
      names[dep.id] = dep.name;
      if (!isInstalled(dep.id)) await visit(dep.id, depth + 1);
    }
    order.push(id);
  }
  for (const id of rootIds) await visit(String(id), 0);
  return { ids: order, names };
}

function parseId(input) {
  const s = String(input || '').trim();
  const m = s.match(/[?&]id=(\d+)/) || s.match(/^(\d{6,})$/) || s.match(/(\d{6,})/);
  return m ? m[1] : '';
}

// Inhalt einer Collection (inkl. verschachtelter Collections).
async function collection(input) {
  const id = parseId(input);
  if (!id) throw new Error('Keine gültige Collection-ID oder URL');
  const seen = new Set();
  const items = [];
  async function walk(cid, depth) {
    if (seen.has(cid) || depth > 3) return;
    seen.add(cid);
    const res = await postApi('GetCollectionDetails', { collectioncount: '1', 'publishedfileids[0]': cid });
    const entry = res.collectiondetails?.[0];
    if (!entry || entry.result !== 1 || !entry.children) {
      if (depth === 0) throw new Error('Das ist keine öffentliche Collection');
      return;
    }
    for (const c of entry.children) {
      if (c.filetype === 2) await walk(String(c.publishedfileid), depth + 1);
      else items.push(String(c.publishedfileid));
    }
  }
  await walk(id, 0);
  const [info] = await details([id]);
  const mods = await details(items);
  return { id, title: info?.title || 'Collection', preview: info?.preview || '', author: info?.author || '', items: mods };
}

module.exports = { browse, details, pageInfo, resolveDependencies, collection, parseId, APPID };
