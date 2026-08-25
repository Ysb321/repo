// ==MiruExtension==
// @name         XDMovies
// @version      v0.0.6
// @author       Ysb321
// @lang         hi
// @license      MIT
// @package      xdmovies.com
// @type         bangumi
// @icon         https://top.xdmovies.wtf/favicon.ico
// @webSite      https://top.xdmovies.wtf
// @nsfw         false
// ==/MiruExtension==

const SITE_URL = "https://top.xdmovies.wtf";
const API_URL = "https://new.xdmovies.wtf";
const SITEMAP_URL = `${SITE_URL}/sitemap.xml`;
// Static token the site's own web app sends (see the public phisher98 /
// nuvio provider). Overridable in the extension settings if it rotates.
const DEFAULT_API_TOKEN = "7297skkihkajwnsgaklakshuwd";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
};
const TMDB_KEY = "9990db75d12d4ecd4ed84628ebc96403";
const PROMO_HOSTS =
  /t\.me|telegram|discord|facebook|twitter|x\.com|instagram|youtube|youtu\.be|whatsapp|pinterest|reddit|play\.google|doubleclick|analytics|tagmanager|adsystem|one\.one\.one/i;
const SIZE_TEXT = /^[\d.,]+\s*(?:GB|MB|TB|GiB|MiB)$/i;

export default class extends Extension {
  async load() {
    // Optional knobs (Miru: extension info page -> settings).
    try {
      this.registerSetting({
        title: "XDMovies API token (only if requests stop working)",
        key: "xdmovies_api_token",
        type: "input",
        defaultValue: "",
      });
      this.registerSetting({
        title:
          "FlareSolverr URL (optional Cloudflare solver, e.g. http://127.0.0.1:8191/v1 — github.com/FlareSolverr/FlareSolverr)",
        key: "xdmovies_solver_url",
        type: "input",
        defaultValue: "",
      });
    } catch (_) {
      /* older Miru builds without settings support */
    }
  }

  async getSettingSafe(key) {
    try {
      const value = await this.getSetting(key);
      return typeof value === "string" ? value.trim() : "";
    } catch (_) {
      return "";
    }
  }

  async ensureToken() {
    if (this._token !== undefined) return;
    this._token = (await this.getSettingSafe("xdmovies_api_token")) || DEFAULT_API_TOKEN;
  }

  // Header set for a request: full browser headers everywhere, plus the
  // site's own app-trust headers (the same ones its official app sends) for
  // any xdmovies host. Cloudflare clearance cookies captured by a solver
  // are replayed only to the site itself.
  siteHeaders(targetUrl, extra = {}) {
    const host = (String(targetUrl).match(/^https?:\/\/([^/]+)/i) || [])[1] || "";
    const headers = { ...BROWSER_HEADERS, ...extra };
    if (/(^|\.)xdmovies\.wtf$/i.test(host)) {
      headers["x-requested-with"] = "XMLHttpRequest";
      headers["x-auth-token"] = this._token || DEFAULT_API_TOKEN;
      if (!extra.Referer) headers.Referer = `${API_URL}/`;
      if (this._cfCookies) {
        headers.Cookie = this._cfCookies;
        if (this._cfUA) headers["User-Agent"] = this._cfUA;
      }
    }
    return headers;
  }

  async latest(page = 1) {
    await this.ensureToken();
    const pageNumber = Number(page) > 0 ? Number(page) : 1;
    const path = pageNumber > 1 ? `/?page=${pageNumber}` : "/";
    const html = await this.getPage(path);
    if (!html && this._lastError) {
      throw new Error(
        `XDMovies: homepage request failed (${this._lastError}). Retry, or try a VPN.`
      );
    }
    return this.scrapeCards(html);
  }

  async search(kw, page = 1) {
    await this.ensureToken();
    const query = String(kw || "").trim();
    if (!query) return [];

    // Primary: the site's own JSON search API (same endpoint its app uses).
    const apiCards = await this.apiSearch(query);
    if (apiCards && apiCards.length) return apiCards;

    const html = await this.getPage(
      `/search.html?q=${encodeURIComponent(query)}`
    );
    const cards = this.scrapeCards(html);
    if (cards.length) return cards;

    // The search page is JS-rendered on some routes. As a fallback (and to
    // support TMDB-ID lookups), walk the full catalogue sitemap locally.
    return this.sitemapSearch(query);
  }

  // JSON catalogue search: GET /php/search_api.php?query=<kw>&fuzzy=true
  // with the app headers. Returns [{tmdb_id, path, ...}] — field names
  // beyond those two are parsed defensively.
  async apiSearch(query) {
    const url = `${API_URL}/php/search_api.php?query=${encodeURIComponent(
      query
    )}&fuzzy=true`;
    try {
      const response = await this.request("", {
        headers: { "Miru-Url": url, ...this.siteHeaders(url, { Accept: "application/json" }) },
      });
      const text = typeof response === "string" ? response : JSON.stringify(response || "");
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = null;
      }
      if (!data) return null;
      const items = Array.isArray(data) ? data : data.results || data.data || [];
      if (!Array.isArray(items)) return null;

      const results = [];
      const posterJobs = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const route = String(item.path || item.url || "").match(
          /\/(movies|series)\/([a-z0-9-]+)-download-(\d+)/i
        );
        if (!route) continue;
        const mediaType = route[1].toLowerCase() === "series" ? "tv" : "movie";
        let cover =
          item.poster || item.image || item.poster_path || item.posterPath || "";
        if (typeof cover === "string" && /^\/[\w/.-]+\.(?:jpe?g|png|webp)$/i.test(cover)) {
          cover = `https://image.tmdb.org/t/p/w500${cover}`;
        }
        const entry = {
          title:
            this.cleanText(item.title || item.name || item.post_title || "") ||
            this.prettifySlug(route[2]) ||
            "XDMovies",
          url: `/${route[1].toLowerCase()}/${route[2]}-download-${route[3]}`,
          cover: cover ? this.resolveUrl(cover) : "",
        };
        results.push(entry);
        const tmdbId = String(item.tmdb_id || item.tmdbId || "");
        if (!entry.cover && /^\d+$/.test(tmdbId) && posterJobs.length < 12) {
          posterJobs.push([entry, tmdbId, mediaType]);
        }
        if (results.length >= 24) break;
      }
      for (const [entry, id, mediaType] of posterJobs) {
        entry.cover = await this.tmdbImage(id, mediaType);
      }
      return results;
    } catch (_) {
      return null;
    }
  }

  async detail(url) {
    await this.ensureToken();
    const path = this.toPath(url);
    const html = await this.getPage(path);
    if (this.isBlockedPage(html)) {
      throw new Error(
        "XDMovies: Cloudflare is verifying this request. Open the site once in your browser, then retry."
      );
    }
    if (!html || html.length < 1200) {
      const why = this._lastError ? ` (${this._lastError})` : "";
      throw new Error(
        `XDMovies: the title page request failed${why}. The site may be blocking Miru's requests — retry, try a VPN, and report this exact message.`
      );
    }

    const title = this.cleanText(
      this.htmlTagText(html, "h1") ||
        this.htmlTagText(html, "h2") ||
        this.htmlAttributeFromTag(html, "meta", "property", "og:title", "content") ||
        this.htmlTagText(html, "title") ||
        "XDMovies"
    );
    const cover = this.resolveUrl(
      this.htmlAttributeFromTag(html, "meta", "property", "og:image", "content") ||
        (html.match(/https:\/\/image\.tmdb\.org\/t\/p\/[^"'<>\s]+/i) || [])[0] ||
        ""
    );

    const meta = [];
    const metaLabels = {
      Rating: "Rating",
      Genres: "Genres",
      "Release Date": "Release",
      "First Air Date": "Release",
      Audios: "Audio",
      Sources: "Source",
    };
    for (const label of Object.keys(metaLabels)) {
      const value = this.metaValue(html, label);
      if (value) meta.push(`${metaLabels[label]}: ${value}`);
    }
    const synopsis = this.cleanText(
      this.synopsisText(html) ||
        this.htmlAttributeFromTag(html, "meta", "name", "description", "content") ||
        ""
    );
    const desc = (meta.join("\n") + (synopsis ? `\n\n${synopsis}` : "")).trim();

    const episodes = [];
    const watchOnline = this.watchServers(html, path);
    if (watchOnline.length) {
      episodes.push({ title: "Watch Online", urls: watchOnline });
    }

    let downloadChannels = this.downloadChannels(html, path);
    if (!downloadChannels.length) {
      // Fallback: the site may hand the links to the page via a script (which
      // Miru never executes). Mine the raw markup — scripts included — for
      // download tokens/host URLs rather than only looking at anchors.
      const mined = this.mineDownloads(html, path);
      if (mined.length) {
        downloadChannels = [{ title: "Download Links", urls: mined }];
      }
    }
    for (const channel of downloadChannels) {
      if (channel.urls.length) episodes.push(channel);
    }

    if (!episodes.length) {
      throw new Error(
        "XDMovies: no watch/download links found on this page. The site may build them with a script Miru can't run — please report this title."
      );
    }

    return { title, cover, desc, episodes };
  }

  async watch(url) {
    await this.ensureToken();
    const packed = String(url || "");

    const pageMatch = packed.match(/^xd:page:(.+)$/i);
    if (pageMatch) {
      return this.resolveEmbed(this.decodeURIComponentSafe(pageMatch[1]), SITE_URL);
    }

    const fileMatch = packed.match(/^xd:file:(.+)$/i);
    if (fileMatch) {
      return this.resolveDownload(this.decodeURIComponentSafe(fileMatch[1]));
    }

    const directMatch = packed.match(/^xd:direct:(m3u8|mp4):(.+)$/i);
    if (directMatch) {
      const streamUrl = this.decodeURIComponentSafe(directMatch[2]);
      return this.playable(streamUrl, directMatch[1], `${SITE_URL}/`);
    }

    throw new Error("XDMovies: invalid source URL.");
  }

  // ---------- catalogue scraping ----------

  scrapeCards(html) {
    const source = String(html || "");
    if (!source || this.isBlockedPage(source)) return [];

    const results = [];
    const seen = new Set();
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(source)) !== null) {
      const route = this.decodeHtmlEntities(match[1]).match(
        /\/(movies|series)\/([a-z0-9-]+)-download-(\d+)/i
      );
      if (!route) continue;

      const path = `/${route[1].toLowerCase()}/${route[2]}-download-${route[3]}`;
      if (seen.has(path)) continue;
      seen.add(path);

      const content = match[2];
      const imageTag = content.match(/<img\b[^>]*>/i);
      const title = this.cleanText(
        (imageTag && this.htmlAttribute(imageTag[0], "alt")) ||
          this.htmlTagText(content, "h1|h2|h3|h4|strong|b") ||
          this.htmlAttribute(match[0].slice(0, match[0].indexOf(">") + 1), "title") ||
          this.prettifySlug(route[2]) ||
          "XDMovies"
      );
      const image = imageTag &&
        (this.htmlAttribute(imageTag[0], "src") ||
          this.htmlAttribute(imageTag[0], "data-src") ||
          this.htmlAttribute(imageTag[0], "data-lazy-src"));

      results.push({
        title,
        url: path,
        cover: this.resolveUrl(this.decodeHtmlEntities(image || "")),
      });
    }
    return results;
  }

  async sitemapSearch(query) {
    let xml = this._sitemapCache;
    if (!xml) {
      xml = await this.fetchAbsolute(SITEMAP_URL, SITE_URL);
      this._sitemapCache = xml || "";
    }
    const words = query.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length >= 2);
    const numeric = /^\d+$/.test(query.trim());

    const locRegex = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
    const hits = [];
    let loc;
    while ((loc = locRegex.exec(xml)) !== null && hits.length < 24) {
      const route = loc[1].match(/\/(movies|series)\/([a-z0-9-]+)-download-(\d+)/i);
      if (!route) continue;
      const slugWords = route[2].toLowerCase();
      const id = route[3];
      const matches = numeric
        ? id === query.trim()
        : words.length > 0 && words.every((w) => slugWords.includes(w));
      if (!matches) continue;

      hits.push({
        title: this.prettifySlug(route[2]) || id,
        url: `/${route[1].toLowerCase()}/${route[2]}-download-${id}`,
        cover: "",
        tmdbId: /^\d+$/.test(id) ? id : "",
        mediaType: route[1].toLowerCase() === "series" ? "tv" : "movie",
      });
    }

    for (const hit of hits) {
      if (hit.tmdbId) hit.cover = await this.tmdbImage(hit.tmdbId, hit.mediaType);
      delete hit.tmdbId;
      delete hit.mediaType;
    }
    return hits;
  }

  prettifySlug(slug) {
    if (!slug) return "";
    const quality = slug.search(
      /-(?:2160p|1440p|1080p|720p|480p|360p|4k|hdrip|web-dl|bluray)\b/i
    );
    const base = (quality > 0 ? slug.slice(0, quality) : slug).replace(/-/g, " ").trim();
    return base
      .split(" ")
      .filter(Boolean)
      .map((w) => (/^\d+$/.test(w) && w.length < 4 ? w : w[0].toUpperCase() + w.slice(1)))
      .join(" ");
  }

  metaValue(html, label) {
    const match = String(html || "").match(
      new RegExp(
        `<(?:strong|b|span|th)[^>]*>\\s*${label}\\s*:??\\s*<\\/(?:strong|b|span|th)>\\s*([\\s\\S]{0,300}?)<\\/(?:p|td|div|li)>`,
        "i"
      )
    );
    return match ? this.cleanText(match[1]) : "";
  }

  synopsisText(html) {
    const cast = String(html || "").split(/star\s*cast/i);
    const before = cast.length > 1 ? cast[0] : String(html || "");
    const paragraphs = [];
    const pRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = pRegex.exec(before)) !== null) {
      const text = this.cleanText(m[1]);
      if (text.length > 80) paragraphs.push(text);
    }
    return paragraphs.sort((a, b) => b.length - a.length)[0] || "";
  }

  // ---------- link extraction ----------

  // Flatten the markup into an ordered line stream in which every anchor is a
  // sentinel token. This makes channel/release/link association immune to the
  // page's exact tag nesting (p > a, p > text + a, h4 file names, ...).
  linkStream(html) {
    let s = String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ");
    // Anchors become sentinel lines; keep the raw opening tag too so links
    // hidden in data-* attributes or onclick handlers are still recoverable.
    s = s.replace(
      /<a\b([^>]*)href\s*=\s*["']([^"']*)["']([^>]*)>([\s\S]*?)<\/a>/gi,
      (all, pre, href, post, text) =>
        `\n\u0001${href}\u0002${String(text).replace(/<[^>]+>/g, " ")}\u0003\u0005${
          pre || ""
        } ${post || ""}\u0006\n`
    );
    // Block-level boundaries become newlines (inline tags are just stripped).
    s = s.replace(
      /<\/?(?:p|div|h[1-6]|li|ul|ol|tr|td|th|section|article|header|footer|nav|br|hr|button|figure|figcaption)\b[^>]*>/gi,
      "\n"
    );
    s = s.replace(/<[^>]+>/g, " ");
    return this.decodeHtmlEntities(s).split(/\n+/);
  }

  releaseName(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (t.length < 8 || t.length > 220) return "";
    if (/https?:|www\.|@|\||\.(?:jpe?g|png|webp|gif|ico)\b/i.test(t)) return "";
    // Find the release name anywhere in the line (a codec badge like "H.264"
    // may share the flattened line after it).
    const m = t.match(/[\w[(][\w.\s\-+()\[\]]*?\.\s*(?:mkv|mp4|avi|webm|zip|mov|ts)\b/i);
    if (!m) return "";
    return m[0].replace(/\s*\.\s*(mkv|mp4|avi|webm|zip|mov|ts)$/i, ".$1").trim();
  }

  isGroupHeading(text) {
    const t = String(text || "").trim();
    if (!t || t.length > 60) return false;
    if (this.releaseName(t)) return false;
    if (/https?:|www\.|@/i.test(t)) return false;
    return /season|series|packs?|zips?|episodes?|versions?|batch|parts?|collection|download|quality|encode/i.test(
      t
    );
  }

  isQualityHeading(text) {
    const t = String(text || "").trim();
    if (!t || t.length > 36) return false;
    if (this.releaseName(t)) return false;
    if (/(?:^|\s)(?:gb|mb|tb)(?:\s|$)/i.test(t)) return false;
    // Resolution is mandatory so codec-only badges like "H.264" stay ignored.
    return /(\b\d{3,4}\s?p\b|\b[48]k\b)/i.test(t);
  }

  isDownloadAnchor(rawHref, rawText, attrs, pageUrl) {
    let href = this.decodeHtmlEntities(String(rawHref || "")).trim();
    const text = String(rawText || "").replace(/\s+/g, " ").trim();
    const attrText = String(attrs || "");
    if (!href || href === "#" || /^javascript:/i.test(href)) {
      const alt =
        attrText.match(
          /(?:data-(?:href|url|link|file|src|target|redirect)|data)\s*=\s*["']([^"'#]{8,})["']/i
        ) || attrText.match(/(?:location\.href|window\.open)\s*[=(]\s*['"]([^'"]+)['"]/i);
      if (alt) href = this.decodeHtmlEntities(alt[1]).trim();
    }
    const url = this.resolveUrl(href, pageUrl);
    if (!/^https?:\/\//i.test(url)) return null;
    if (PROMO_HOSTS.test(url)) return null;
    if (/how-to|telegram|discord/i.test(url)) return null;

    const host = (url.match(/^https?:\/\/([^/?#]+)/i) || [])[1] || "";
    const siteHost = /(^|\.)xdmovies\.(wtf|com|icu|lol|quest)$/i.test(host) && !/^link/i.test(host);
    const tokenPath =
      /\/(download|dl|file|files|get|go|redirect|r|link)\/[A-Za-z0-9_\-=%.]{6,}/i.test(url) ||
      /[?&](?:download|dl|file|id|token|key|url|u|to)=[A-Za-z0-9_\-.%/]{8,}/i.test(url);
    const mirrorHost =
      /hubcloud[a-z0-9.-]*|gamerxyt\.com|pixeldrain\.(?:com|dev)|drive\.google\.com\/(?:file|drive|open)|[\w.-]*\.r2\.(?:dev|cloudflarestorage\.com)|storage\.googleapis\.com/i.test(
        url
      );
    const sizeButton = SIZE_TEXT.test(text);

    if (tokenPath || mirrorHost) return { url, text };
    // A bare size button ("1.08 GB") off-site is a download mirror even on a
    // host we've never seen (covers domain rotation of the short-linker).
    if (sizeButton && !siteHost) return { url, text };
    return null;
  }

  downloadChannels(html, pageUrl) {
    const lines = this.linkStream(html);
    const channels = [];
    const byTitle = new Map();
    const push = (group, quality, entry) => {
      const title =
        [group, quality].filter(Boolean).join(" · ") || "Download Links";
      let target = byTitle.get(title);
      if (!target) {
        target = { title, urls: [] };
        byTitle.set(title, target);
        channels.push(target);
      }
      if (target.urls.some((u) => u.url === entry.url)) return;
      target.urls.push(entry);
    };

    let group = "";
    let quality = "";
    let lastRelease = "";
    const sentinel = /\u0001([^\u0002]*)\u0002([^\u0003]*)\u0003\u0005?([^\u0006]*)\u0006?/g;

    for (const rawLine of lines) {
      const line = String(rawLine || "");
      let cursor = 0;
      let m;
      const handleText = (segment) => {
        const text = String(segment || "").replace(/\s+/g, " ").trim();
        if (!text) return;
        const release = this.releaseName(text);
        if (release) {
          lastRelease = release;
          return;
        }
        if (this.isGroupHeading(text)) {
          group = text.replace(/[:\s]+$/, "");
          quality = "";
          return;
        }
        if (this.isQualityHeading(text)) {
          quality = text.replace(/[:\s]+$/, "");
        }
      };
      sentinel.lastIndex = 0;
      while ((m = sentinel.exec(line)) !== null) {
        handleText(line.slice(cursor, m.index));
        cursor = m.index + m[0].length;
        const anchor = this.isDownloadAnchor(m[1], m[2], m[3] || "", pageUrl);
        if (!anchor) continue;
        const size = SIZE_TEXT.test(anchor.text) ? anchor.text : "";
        const release = lastRelease
          ? lastRelease.replace(/[-.\s]?xdmovies\.com/i, "").replace(/[-.\s]+$/, "")
          : "";
        const name = (
          release && size ? `${release} · ${size}` : release || anchor.text || "Download"
        ).slice(0, 200);
        push(group, quality, {
          name,
          url: `xd:file:${encodeURIComponent(anchor.url)}`,
        });
        lastRelease = "";
      }
      handleText(line.slice(cursor));
    }
    return channels.filter((c) => c.urls.length);
  }

  // Hail-Mary for script-injected links: hunt the WHOLE response (scripts,
  // data attributes, JSON blobs) for anything shaped like a download token or
  // a known mirror host URL.
  mineDownloads(html, pageUrl) {
    const raw = String(html || "")
      .replace(/\\\//g, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u003d/gi, "=")
      .replace(/\\x3d/gi, "=");
    const decoded = this.decodeHtmlEntities(raw);
    const found = [];
    const seen = new Set();
    const add = (candidate, label) => {
      const url = this.resolveUrl(this.normaliseUrl(candidate), pageUrl);
      if (!/^https?:\/\//i.test(url) || seen.has(url) || PROMO_HOSTS.test(url)) return;
      seen.add(url);
      found.push({
        name: label || `Download Link ${found.length + 1}`,
        url: `xd:file:${encodeURIComponent(url)}`,
      });
    };

    let m;
    const tokenRegex =
      /https?:\/\/[\w.-]*xdmovies[\w.-]*\/download\/[A-Za-z0-9_\-]{8,}|["'(\s=](\/download\/[A-Za-z0-9_\-]{12,})["')\s]|https?:\/\/[\w.-]*hubcloud[\w.-]*\/(?:drive|file)\/[A-Za-z0-9_\-]+|https?:\/\/gamerxyt\.com\/hubcloud\.php\?[^"'<>\s\]})]{10,}|https?:\/\/pixeldrain\.(?:com|dev)\/u\/[A-Za-z0-9]+/gi;
    while ((m = tokenRegex.exec(decoded)) !== null) {
      add(m[1] || m[0]);
    }
    // Base64-encoded URLs ("aHR0cHM6Ly8..." === "https://...") are a common
    // obfuscation on gated pages; decode and check for known hosts.
    if (typeof atob === "function") {
      const b64 = /aHR0cHM6Ly9[A-Za-z0-9+/=]{16,}/g;
      while ((m = b64.exec(decoded)) !== null) {
        try {
          const plain = atob(m[0]);
          if (/hubcloud|gamerxyt|pixeldrain|xdmovies/i.test(plain)) add(plain);
        } catch (_) {
          /* not valid base64 */
        }
      }
    }
    return found;
  }

  watchServers(html, pagePath) {
    const source = String(html || "");
    const players = [];
    const seen = new Set();
    const add = (candidate, label) => {
      const url = this.resolveUrl(this.decodeHtmlEntities(candidate || ""), pagePath);
      if (!url || seen.has(url) || !/^https?:\/\//i.test(url) || PROMO_HOSTS.test(url)) {
        return;
      }
      if (/\/?(download|dl)\//i.test(url) || /link\.xdmovies/i.test(url)) return;
      seen.add(url);
      players.push({
        name: label || `Server ${players.length + 1}`,
        url: `xd:page:${encodeURIComponent(url)}`,
      });
    };

    const tagRegex =
      /<(?:iframe|video|source|embed)\b[^>]+(?:src|data-src|data-url|data-video|data-embed|data-lazy-src)=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = tagRegex.exec(source)) !== null) add(match[1]);

    // "Watch Online / Play" buttons that link to a player page instead of an
    // inline iframe.
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = anchorRegex.exec(source)) !== null) {
      const text = this.cleanText(match[2]);
      const href = match[1];
      if (
        /(watch\s*(online|now)|play\s*(now|online)|stream\s*(now|online))/i.test(text) ||
        /\/(watch|play|embed|player|stream)[/?=-]/i.test(href)
      ) {
        add(href, text && text.length <= 30 ? text : "");
      }
    }
    return players.slice(0, 8);
  }

  // ---------- playback resolution ----------

  async resolveEmbed(url, referer) {
    let currentUrl = this.resolveUrl(url);
    let currentReferer = referer || SITE_URL;

    for (let attempt = 0; attempt < 4 && currentUrl; attempt += 1) {
      const html = await this.fetchAbsolute(currentUrl, currentReferer);
      const media = this.extractMediaUrls(html);
      if (media.length) return this.playable(media[0], "", currentUrl);

      const nextTag = html.match(
        /<iframe\b[^>]+(?:src|data-src|data-url)=["']([^"']+)["'][^>]*>/i
      );
      if (!nextTag) break;
      const nextUrl = this.resolveUrl(this.decodeHtmlEntities(nextTag[1]), currentUrl);
      if (!nextUrl || nextUrl === currentUrl) break;
      currentReferer = currentUrl;
      currentUrl = nextUrl;
    }

    throw new Error(
      "XDMovies: the online player didn't expose a stream. Try the Download Links instead."
    );
  }

  async resolveDownload(pageUrl) {
    let currentUrl = this.resolveUrl(pageUrl);

    for (let attempt = 0; attempt < 6 && currentUrl; attempt += 1) {
      // File/mirror links are never fetched — Dio buffers whole responses, so
      // those are handed to the player directly (it streams them and supports
      // resume). Only page-shaped URLs get GET-ed.
      const looksLikeFile =
        /X-Amz-Signature|response-content-disposition|\.r2\.|storage\.googleapis\.com|pixeldrain\.|\/api\/file\/|\.(?:mkv|mp4|webm|m3u8|avi|mov|zip)(?:[?#%&]|\s|"|$)/i.test(
          currentUrl
        );
      if (looksLikeFile) {
        return this.playable(
          currentUrl,
          /\.m3u8/i.test(currentUrl) ? "hls" : "mp4",
          `${SITE_URL}/`
        );
      }

      const html = await this.fetchAbsolute(currentUrl, SITE_URL);

      const media = this.extractMediaUrls(html);
      if (media.length) return this.playable(media[0], "", currentUrl);

      const turnstile =
        /turnstile|cf-chl|verify(?:ing)? you are|checking your browser|verify you are human|complete the (?:action|captcha)|timer paused|get your link/i.test(
          html
        );

      // HubCloud drive page: jump to the generated mirror list.
      if (!/hubcloud\.php\?/i.test(currentUrl)) {
        const generate = html.match(
          /<a\b[^>]*href=["']([^"']*(?:hubcloud\.php\?[^"']*|drive\/dl\?[^"']*)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i
        );
        if (generate && /generate|direct download/i.test(this.cleanText(generate[2]))) {
          const next = this.resolveUrl(this.decodeHtmlEntities(generate[1]), currentUrl);
          if (/hubcloud\.php\?/i.test(next)) {
            currentUrl = next;
            continue;
          }
        }
      }

      // Generated mirror page: every labelled server button links straight to
      // a resumable direct file (FSL/FSLv2 -> R2 presigned URLs, Pixeldrain,
      // S3, ZipDisk...). Pick by preference and return WITHOUT fetching it.
      const mirror = this.pickMirror(html, currentUrl);
      if (mirror) {
        return this.playable(
          mirror.url,
          /\.m3u8/i.test(mirror.url) ? "hls" : "mp4",
          currentUrl
        );
      }

      // The page may embed a HubCloud/Pixeldrain/direct-file URL anywhere
      // (script, data attribute, base64). Follow it if found.
      const embedded = this.knownHostUrl(html, currentUrl);
      if (embedded && embedded !== currentUrl) {
        currentUrl = embedded;
        continue;
      }

      if (turnstile) {
        throw new Error(
          "XDMovies: this short link needs one-time browser verification. Open it in your browser (HubCloud/FSL page loads there), or use the Watch Online server."
        );
      }

      // Fallback: first plausible external anchor that isn't a promo/gate.
      const fallback = this.firstExternalAnchor(html, currentUrl);
      if (fallback && fallback !== currentUrl) {
        currentUrl = fallback;
        continue;
      }
      break;
    }

    throw new Error(
      "XDMovies: couldn't reach a playable FSL/direct link. The mirror steps may require a browser."
    );
  }

  knownHostUrl(html, pageUrl) {
    const unescaped = String(html || "")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&");
    const direct = unescaped.match(
      /https?:\/\/(?:[\w.-]*hubcloud[\w.-]*|gamerxyt\.com|pixeldrain\.(?:com|dev)|[\w.-]*\.r2\.(?:dev|cloudflarestorage\.com)|storage\.googleapis\.com)[^"'<>\s)\]}]{4,}/i
    );
    if (direct) return this.resolveUrl(this.normaliseUrl(direct[0]), pageUrl);
    if (typeof atob === "function") {
      const b64 = /aHR0cHM6Ly9[A-Za-z0-9+/=]{16,}/g;
      let m;
      while ((m = b64.exec(unescaped)) !== null) {
        try {
          const plain = atob(m[0]);
          if (/hubcloud|gamerxyt|pixeldrain|\.r2\.|googleapis/i.test(plain)) {
            return this.resolveUrl(this.normaliseUrl(plain), pageUrl);
          }
        } catch (_) {
          /* ignore */
        }
      }
    }
    return "";
  }

  pickMirror(html, pageUrl) {
    const source = String(html || "");
    const candidates = [];
    const seen = new Set();
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(source)) !== null) {
      const href = this.resolveUrl(this.decodeHtmlEntities(match[1]), pageUrl);
      const text = this.cleanText(match[2]);
      if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
      seen.add(href);

      let weight = -1;
      let finalHref = href;
      if (/FSL\s*v?2/i.test(text)) weight = 0;
      else if (/FSL\s*Server/i.test(text)) weight = 1;
      else if (/pixeldra|pixel/i.test(text)) {
        weight = 2;
        finalHref = this.pixeldrainDirect(href);
      } else if (/S3\s*Server/i.test(text)) weight = 3;
      else if (/^\s*Download\s+(File|Now|\[?\s*File)/i.test(text) || /Download\s*\[?\s*File\s*Server/i.test(text)) weight = 4;
      else if (/ZipDisk/i.test(text)) weight = 5;
      else if (/Mega\s*Server/i.test(text)) weight = 6;
      else if (/10\s*Gbps|Server\s*:/i.test(text)) weight = 7;
      else if (/BuzzServer/i.test(text)) continue; // needs hx-redirect headers Miru can't read
      else if (/download|server|resume|direct/i.test(text) &&
        !/t\.me|tinyurl|one\.one\.one|google\.com|xdmovies|hubcloud\.(?:foo|cx|boats|top)|gamerxyt\.com/i.test(href)) weight = 8;
      else continue;

      candidates.push({ weight, url: finalHref, text });
    }

    candidates.sort((a, b) => a.weight - b.weight);
    return candidates.length ? candidates[0] : null;
  }

  pixeldrainDirect(url) {
    const value = String(url || "");
    if (/\/api\/file\//i.test(value)) return value;
    const m = value.match(/pixeldrain\.(?:com|dev)\/u\/([A-Za-z0-9]+)/i);
    if (m) return `https://pixeldrain.com/api/file/${m[1]}?download`;
    return value;
  }

  firstExternalAnchor(html, pageUrl) {
    const source = String(html || "");
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(source)) !== null) {
      const href = this.resolveUrl(this.decodeHtmlEntities(match[1]), pageUrl);
      if (
        /^https?:\/\//i.test(href) &&
        !/t\.me|tinyurl|one\.one\.one|google\.com|youtube|youtu\.be|facebook|twitter|instagram|discord|xdmovies|latestnewsonline\.|hdhub4u/i.test(href)
      ) {
        return href;
      }
    }
    return "";
  }

  extractMediaUrls(value) {
    const source = String(value || "").replace(/\\\//g, "/");
    const urls = [];
    const seen = new Set();
    const add = (candidate) => {
      const url = this.normaliseUrl(candidate);
      if (
        !url ||
        seen.has(url) ||
        !/^https?:\/\//i.test(url) ||
        /\.(?:jpe?g|png|webp|avif|gif|svg|ico|css|js|woff2?)(?:$|[?#])/i.test(url) ||
        !/\.(?:m3u8|mp4|webm|mkv)(?:$|[?#])/i.test(url)
      ) {
        return;
      }
      seen.add(url);
      urls.push(url);
    };
    const urlRegex = /https?:\/\/[^"'<>\s]+/gi;
    let match;
    while ((match = urlRegex.exec(source)) !== null) add(match[0]);
    return urls;
  }

  playable(streamUrl, typeHint = "", referer = SITE_URL) {
    const url = this.normaliseUrl(streamUrl);
    if (!/^https?:\/\//i.test(url)) throw new Error("XDMovies: invalid stream URL.");
    const isMp4 =
      /^(mp4|webm|mkv)$/i.test(typeHint) || /\.(?:mp4|webm|mkv)(?:$|[?#])/i.test(url);
    const safeReferer = /^https?:\/\//i.test(referer) ? referer : `${SITE_URL}/`;
    const originMatch = safeReferer.match(/^(https?:\/\/[^/]+)/i);
    return {
      type: isMp4 ? "mp4" : "hls",
      url,
      headers: {
        "User-Agent": USER_AGENT,
        Referer: safeReferer.endsWith("/") ? safeReferer : `${safeReferer}/`,
        ...(originMatch ? { Origin: originMatch[1] } : {}),
      },
    };
  }

  // ---------- networking helpers ----------

  // Page GET. For xdmovies hosts the same path is tried on the app's own
  // host first (new.xdmovies.wtf + app-trust headers — the combination its
  // official app uses), then directly. If both fail: one optional
  // FlareSolverr call (real browser solve; its clearance cookies are cached
  // and replayed for the rest of the session), then public raw-HTML relays.
  // Miru throws (Dio) on any >=400 — the first observed reason is kept in
  // _lastError for the user-facing message.
  async getPage(pathOrUrl) {
    const absolute = this.resolveUrl(pathOrUrl);
    this._lastError = "";
    const relayBase = absolute.replace(/^(https):\/\/new\.(xdmovies\.wtf)/i, "$1://top.$2");
    const relayUrls = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(relayBase)}`,
      `https://api.codetabs.com/v1/proxy?quest=${relayBase}`,
      `https://proxy.corsfix.com/?${relayBase}`,
      `https://api.cors.lol/?url=${encodeURIComponent(relayBase)}`,
    ];

    // Direct candidates: for xdmovies paths try both site hosts.
    const pathQuery = absolute.replace(/^https?:\/\/[^/]+/i, "") || "/";
    const isXdm = /(^|\.)xdmovies\.wtf$/i.test(
      (absolute.match(/^https?:\/\/([^/]+)/i) || [])[1] || ""
    );
    const directUrls = [];
    if (isXdm) {
      directUrls.push(`${API_URL}${pathQuery}`);
      directUrls.push(`${SITE_URL}${pathQuery}`);
    } else {
      directUrls.push(absolute);
    }

    const tryGet = async (target, extraHeaders = {}) => {
      try {
        const response = await this.request("", {
          headers: { "Miru-Url": target, ...this.siteHeaders(target, extraHeaders) },
        });
        const body =
          typeof response === "string" ? response : JSON.stringify(response || "");
        return { body, error: "" };
      } catch (e) {
        return {
          body: "",
          error: String((e && (e.message || e)) || "request failed")
            .replace(/\s+/g, " ")
            .slice(0, 160),
        };
      }
    };
    const usable = (body) =>
      !!body &&
      (this.isBlockedPage(body) || (body.length >= 200 && !this.isDenyStub(body)));

    const reasons = [];
    let firstError = "";
    const note = (r) => {
      reasons.push(r.error || (r.body ? "deny stub" : "empty body"));
      if (r.error && !firstError) firstError = r.error;
    };
    // Pass 1: direct candidates, twice, with a homepage warm-up in between.
    for (let round = 0; round < 2; round += 1) {
      for (const target of directUrls) {
        const got = await tryGet(target);
        if (usable(got.body)) return got.body;
        note(got);
      }
      if (round === 0) await tryGet(`${API_URL}/`).catch(() => {});
    }

    // Pass 2: optional FlareSolverr solve (user-configured local solver).
    const solver = await this.getSettingSafe("xdmovies_solver_url");
    if (/^https?:\/\//i.test(solver)) {
      try {
        const response = await this.request("", {
          headers: { "Miru-Url": solver, "Content-Type": "application/json" },
          method: "post",
          data: JSON.stringify({
            cmd: "request.get",
            url: directUrls[directUrls.length - 1],
            maxTimeout: 90000,
          }),
        });
        const text = typeof response === "string" ? response : JSON.stringify(response || "");
        const solved = JSON.parse(text);
        const html = solved && solved.solution && solved.solution.response;
        if (solved.status === "ok" && typeof html === "string" && html.length >= 200) {
          const cookies = (solved.solution.cookies || [])
            .map((c) => `${c.name}=${c.value}`)
            .join("; ");
          if (cookies) {
            this._cfCookies = cookies;
            this._cfUA = solved.solution.userAgent || "";
          }
          if (!this.isBlockedPage(html) && !this.isDenyStub(html)) return html;
          reasons.push("solver passed a challenge page");
        } else {
          reasons.push("solver failed");
        }
      } catch (e) {
        reasons.push("solver unreachable");
      }
    }

    // Pass 3: relays (their servers fetch the page, not the local client).
    for (const relay of relayUrls) {
      const extra = relay.includes("corsfix") ? { Origin: "https://miru.local" } : {};
      const got = await tryGet(relay, extra);
      if (got.body && !this.isRelayJunk(got.body) && !this.isDenyStub(got.body) && got.body.length >= 200) {
        return got.body;
      }
      note(got);
    }

    this._lastError = firstError || reasons.find(Boolean) || "";
    return "";
  }

  // The site's tiny "keep out" bodies.
  isDenyStub(body) {
    const source = String(body || "");
    return source.length < 4000 && /direct access not permitted|access denied/i.test(source);
  }

  // Error/rate-limit pages of the relay services themselves.
  isRelayJunk(body) {
    const source = String(body || "");
    return /error code 5\d\d|connection timed out|rate limit exceeded|invalid_origin|missing a valid origin|temporarily rate limited|please check back later|usage is limited to localhost/i.test(
      source
    );
  }

  async fetchAbsolute(absoluteUrl, referer = SITE_URL) {
    try {
      const target = this.resolveUrl(absoluteUrl);
      const response = await this.request("", {
        headers: {
          "Miru-Url": target,
          ...this.siteHeaders(target, {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Referer: referer || `${API_URL}/`,
          }),
        },
      });
      return this.text(response);
    } catch (_) {
      return "";
    }
  }

  async text(promise) {
    try {
      const response = await promise;
      if (typeof response === "string") return response;
      return JSON.stringify(response || "");
    } catch (_) {
      return "";
    }
  }

  // ---------- generic helpers ----------

  isBlockedPage(value) {
    const source = String(value || "");
    return /attention required!|sorry,?\s+you have been blocked|you are unable to access|just a moment|verify(?:ing)? you are human|cf-chl|challenge-platform|challenge-error-text|needs to review the security of your connection|enable javascript and cookies to continue|performing security verification/i.test(
      source
    );
  }

  toPath(url) {
    const value = this.decodeURIComponentSafe(String(url || ""));
    if (/^https?:\/\//i.test(value)) {
      const m = value.match(/^https?:\/\/[^/]+(\/[^?#]*)/i);
      return m ? m[1] : "/";
    }
    return value.startsWith("/") ? value : `/${value}`;
  }

  htmlTagText(html, tags) {
    const match = String(html || "").match(
      new RegExp(`<(${tags})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, "i")
    );
    return match ? this.cleanText(match[2]) : "";
  }

  htmlAttribute(tag, attribute) {
    if (!tag) return "";
    const match = String(tag).match(
      new RegExp(`${attribute}\\s*=\\s*["']([^"']*)["']`, "i")
    );
    return match ? match[1] : "";
  }

  htmlAttributeFromTag(html, tag, key, value, attribute) {
    const tagRegex = key
      ? new RegExp(`<${tag}\\b[^>]*${key}=["']${value}["'][^>]*>`, "i")
      : new RegExp(`<${tag}\\b[^>]*>`, "i");
    const match = String(html || "").match(tagRegex);
    return match ? this.htmlAttribute(match[0], attribute || "content") : "";
  }

  decodeHtmlEntities(value) {
    return String(value || "")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&nbsp;/gi, " ");
  }

  cleanText(value) {
    return this.decodeHtmlEntities(String(value || ""))
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  normaliseUrl(value) {
    return String(value || "")
      .trim()
      .replace(/\\\//g, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u003f/gi, "?")
      .replace(/\\u003d/gi, "=")
      .replace(/&amp;/gi, "&")
      .replace(/[),;}\]]+$/g, "");
  }

  resolveUrl(value, base = SITE_URL) {
    const url = this.normaliseUrl(value);
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith("//")) return `https:${url}`;

    const baseMatch = String(base || SITE_URL).match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
    const origin = baseMatch ? baseMatch[1] : SITE_URL;
    if (url.startsWith("/")) return `${origin}${url}`;

    const basePath = (baseMatch && baseMatch[2]) || "/";
    const directory = basePath.endsWith("/") ? basePath : basePath.replace(/[^/]*$/, "");
    const path = `${directory}${url}`.split("/");
    const cleanPath = [];
    for (const part of path) {
      if (!part || part === ".") continue;
      if (part === "..") cleanPath.pop();
      else cleanPath.push(part);
    }
    return `${origin}/${cleanPath.join("/")}`;
  }

  decodeURIComponentSafe(value) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }

  async tmdbImage(id, mediaType = "movie") {
    const endpoint = `https://api.themoviedb.org/3/${mediaType}/${encodeURIComponent(
      id
    )}?api_key=${TMDB_KEY}`;
    try {
      const response = await this.request("", {
        headers: {
          "Miru-Url": endpoint,
          Accept: "application/json, */*",
          "User-Agent": USER_AGENT,
        },
      });
      const data = typeof response === "string" ? JSON.parse(response) : response;
      const path = data && (data.poster_path || data.backdrop_path);
      return path
        ? `https://image.tmdb.org/t/p/w500/${String(path).replace(/^\/+/, "")}`
        : "";
    } catch (_) {
      return "";
    }
  }
}
