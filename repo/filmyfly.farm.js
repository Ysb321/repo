// ==MiruExtension==
// @name         FilmyFly
// @version      v0.0.2
// @author       Ysb321
// @lang         hi
// @license      MIT
// @package      filmyfly.farm
// @type         bangumi
// @icon         https://img.iwebp.store/images/files/afaa901b76bc48d57a346319423035dd384208.png
// @webSite      https://filmyfly.green
// @nsfw         false
// ==/MiruExtension==

// filmyfly.farm is an SEO landing page; the working site is filmyfly.green.
// Chain: title page -> linkmake.in/view/<id> (ungated quality list) ->
// filesdl.in/cloud|drive/<id> -> direct fast .mkv servers + HubCloud/
// Pixeldrain mirrors. Every link at every stage is surfaced as its own
// tappable entry.
// v0.0.2: one channel per quality, one entry per server; server links are
// re-extracted fresh at play time (their tokens expire); media URLs are
// percent-encoded the way browsers do (mpv/ffmpeg cannot send raw spaces)
// and get browser-true origin Referers instead of an Origin header.

const SITE_URL = "https://filmyfly.green";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
const PROMO_HOSTS =
  /t\.me|telegram|discord|facebook|twitter|x\.com|instagram|youtube|youtu\.be|whatsapp|pinterest|reddit|play\.google|doubleclick|analytics|tagmanager|adsystem|linkmake\.in\/(?:login|signup|policy|dmca|contact)|filmyapp\.|share\.google|image\.linkmake/i;
const SIZE_TOKEN = /([\d.,]+\s*(?:GB|MB|TB|GiB|MiB|Gb|Mb))/i;

export default class extends Extension {
  async latest(page = 1) {
    const pageNumber = Number(page) > 0 ? Number(page) : 1;
    const path = pageNumber > 1 ? `/search.html?page=${pageNumber}` : "/";
    const html = await this.getPage(path);
    if (!html && this._lastError) {
      throw new Error(`FilmyFly: homepage request failed (${this._lastError}).`);
    }
    return this.scrapeCards(html);
  }

  async search(kw, page = 1) {
    const query = String(kw || "").trim();
    if (!query) return [];
    const pageNumber = Number(page) > 0 ? Number(page) : 1;
    const html = await this.getPage(
      `/search.html?search=${encodeURIComponent(query)}&page=${pageNumber}`
    );
    const cards = this.scrapeCards(html);
    if (cards.length) return cards;
    if (pageNumber > 1) return [];
    return this.sitemapSearch(query);
  }

  async detail(url) {
    const path = this.toPath(url);
    const html = await this.getPage(path);
    if (this.isBlockedPage(html)) {
      throw new Error("FilmyFly: Cloudflare is verifying this request. Retry in a moment.");
    }
    if (!html || html.length < 1200) {
      const why = this._lastError ? ` (${this._lastError})` : "";
      throw new Error(`FilmyFly: the title page request failed${why}.`);
    }

    const stripSuffix = (value) =>
      String(value || "").replace(/\s*Download\s*-\s*FilmyFly\s*$/i, "").trim();
    const title = this.cleanText(
      this.htmlTagText(html, "h2") ||
        stripSuffix(this.htmlAttributeFromTag(html, "meta", "property", "og:title", "content")) ||
        this.htmlTagText(html, "h1") ||
        stripSuffix(this.htmlTagText(html, "title")) ||
        "FilmyFly"
    );
    const cover = this.posterUrl(html);

    // File Info block: strong-labelled paragraphs.
    const meta = [];
    const labels = {
      Genre: "Genre",
      Duration: "Duration",
      "Release Date": "Release",
      Language: "Language",
      Starcast: "Cast",
      Size: "Sizes",
    };
    for (const label of Object.keys(labels)) {
      const value = this.metaValue(html, label);
      if (value) meta.push(`${labels[label]}: ${value}`);
    }
    const synopsis = this.metaValue(html, "Description");
    const desc =
      (meta.join("\n") + (synopsis ? `\n\n${synopsis}` : "")).trim() ||
      this.metaValue(html, "Name");

    const episodes = [];

    // Every "download" anchor on the title page (one linkmake.in/view link
    // per release/part). Each view page is expanded at detail time so every
    // quality AND every server is directly visible and tappable: one
    // channel per quality, one entry per server.
    const views = this.collectViewLinks(html, path);
    const multi = views.length > 1;
    for (const view of views.slice(0, 4)) {
      const groups = await this.expandView(view.url, view.label, multi);
      if (groups.length) {
        for (const group of groups) {
          if (episodes.length >= 24) break;
          episodes.push(group);
        }
      } else {
        // Keep the link visible even if expansion failed.
        episodes.push({
          title: view.label || "Download Links",
          urls: [{ name: "Open quality list", url: `ff:file:${encodeURIComponent(view.url)}` }],
        });
      }
    }

    // Direct host links placed straight on the title page (rare but seen).
    const viewUrls = new Set(views.map((v) => v.url));
    const direct = this.collectHostLinks(html, path, viewUrls);
    if (direct.length) {
      episodes.push({ title: "Host Links", urls: direct });
    }

    if (!episodes.length) {
      throw new Error("FilmyFly: no download links found on this page — please report this title.");
    }
    return { title, cover, desc, episodes };
  }

  async watch(url) {
    const packed = String(url || "");

    const srvMatch = packed.match(/^ff:srv:(.+)$/i);
    if (srvMatch) {
      let payload = null;
      try {
        payload = JSON.parse(this.decodeURIComponentSafe(srvMatch[1]));
      } catch (_) {}
      if (payload && payload.u) return this.resolveServer(payload);
      throw new Error("FilmyFly: invalid source URL.");
    }

    const fileMatch = packed.match(/^ff:file:(.+)$/i);
    if (fileMatch) {
      return this.resolveChain(this.decodeURIComponentSafe(fileMatch[1]));
    }
    const legacy = packed.match(/^xd:file:(.+)$/i);
    if (legacy) {
      return this.resolveChain(this.decodeURIComponentSafe(legacy[1]));
    }
    const pageMatch = packed.match(/^ff:page:(.+)$/i);
    if (pageMatch) {
      return this.resolveEmbed(this.decodeURIComponentSafe(pageMatch[1]));
    }

    throw new Error("FilmyFly: invalid source URL.");
  }

  // ---------- server entries ----------

  packServer(url, pageUrl, label) {
    return `ff:srv:${encodeURIComponent(JSON.stringify({ u: url, p: pageUrl, n: label }))}`;
  }

  // Name the real host behind an anchor; "" means "not a usable server".
  serverLabel(text, url) {
    const source = `${String(text || "")} ${String(url || "")}`;
    if (/slowcloud/i.test(source)) return "";
    if (/filesdl\.[a-z.]+\/?(?:[?#]|$)/i.test(url)) return "";
    if (/\/(?:login|signin|signup|register|dmca|policy|privacy|contact|terms|report|faq)(?:\.html|\.php)?\/?(?:[?#]|$)/i.test(url)) return "";
    if (/linkmake\.in/i.test(url)) return "";
    if (/gofile\.io/i.test(source)) return "GoFile (browser only)";
    if (/gdflix/i.test(source)) return "GDFLIX (browser only)";
    if (/buzz|fuckingfast/i.test(source)) return "Buzz (browser only)";
    if (/10\s?gbps|zdownload\.php/i.test(source)) return "10Gbps Direct";
    if (/cloud direct|fast cloud|aws[a-z_]*stor/i.test(source)) return "Cloud Direct (fast)";
    if (/hubcloud|hubdrive|hubcdn|gamerxyt/i.test(source)) return "HubCloud";
    if (/pixeldra|\/u\/[A-Za-z0-9_-]+\?download/i.test(source)) return "Pixeldrain";
    if (this.looksLikeFile(url)) return "Direct file";
    return "";
  }

  // Fetch one filesdl cloud/drive page at detail time and turn every real
  // server anchor into its own entry.
  async expandServerPage(pageUrl) {
    if (!/filesdl\.[a-z.]+\/(?:cloud|drive)\//i.test(pageUrl)) return [];
    const html = await this.getPage(pageUrl);
    if (!html || this.isBlockedPage(html)) return [];
    const entries = [];
    const seen = new Set();
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
      const url = this.resolveUrl(this.decodeHtmlEntities(match[1]), pageUrl);
      const text = this.cleanText(match[2]);
      if (!/^https?:\/\//i.test(url) || seen.has(url) || PROMO_HOSTS.test(url)) continue;
      const label = this.serverLabel(text, url);
      if (!label) continue;
      seen.add(url);
      entries.push({ name: label, url: this.packServer(url, pageUrl, label) });
    }
    return entries;
  }

  // Find the fresh href of one named server on a just-fetched page.
  findServerAnchor(html, pageUrl, hint, stored) {
    const want = String(hint || "").toLowerCase().trim();
    const storedHost = (String(stored || "").match(/^https?:\/\/([^/]+)/i) || [])[1] || "";
    let hostFallback = null;
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
      const url = this.resolveUrl(this.decodeHtmlEntities(match[1]), pageUrl);
      const text = this.cleanText(match[2]);
      if (!/^https?:\/\//i.test(url) || PROMO_HOSTS.test(url)) continue;
      const label = this.serverLabel(text, url);
      if (!label) continue;
      const host = ((url.match(/^https?:\/\/([^/]+)/i) || [])[1] || "").toLowerCase();
      if (!hostFallback && storedHost && host && host === storedHost.toLowerCase()) {
        hostFallback = { url, label };
      }
      if (want && label.toLowerCase() === want) return { url, label };
    }
    return hostFallback;
  }

  // Play one specific server entry. Its filesdl page is refetched at play
  // time so short-lived token links are always fresh; falls back to the
  // page's best server, then to the link captured at detail time.
  async resolveServer(payload) {
    const hint = String(payload.n || "");
    const pageUrl = String(payload.p || "");
    const stored = String(payload.u || "");

    if (/\(browser only\)/i.test(hint) || /gofile\.io|fuckingfast\.net|gdflix/i.test(stored)) {
      throw new Error(
        "FilmyFly: this mirror only works in a real browser. Pick Cloud Direct, 10Gbps, Pixeldrain or HubCloud instead."
      );
    }

    if (pageUrl) {
      const html = await this.getPage(pageUrl);
      if (html && !this.isBlockedPage(html)) {
        const base = this.pageBaseUrl(html, pageUrl);
        const anchor = this.findServerAnchor(html, pageUrl, hint, stored);
        if (anchor) {
          if (this.isArchive(anchor.url)) {
            throw new Error("FilmyFly: this server offers a ZIP archive — pick another server.");
          }
          if (this.looksLikeFile(anchor.url)) {
            return this.playable(anchor.url, this.mediaTypeHint(anchor.url), base);
          }
          return this.resolveChain(anchor.url, { referer: base });
        }
        // Server renamed/removed: fall back to the page's best playable link.
        const best = this.pickDirect(html, pageUrl);
        if (best) return best;
      }
    }

    if (stored) return this.resolveChain(stored, { referer: pageUrl || SITE_URL });
    throw new Error("FilmyFly: no playable server responded. Pick another server.");
  }

  // ---------- catalogue ----------

  scrapeCards(html) {
    const source = String(html || "");
    if (!source || this.isBlockedPage(source)) return [];

    const results = [];
    const seen = new Set();
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(source)) !== null) {
      const route = this.decodeHtmlEntities(match[1]).match(
        /\/page-download\/(\d+)\/([a-z0-9-]+?)\.html/i
      );
      if (!route) continue;
      const path = `/page-download/${route[1]}/${route[2]}.html`;
      if (seen.has(path)) continue;
      seen.add(path);

      const content = match[2];
      const imageTag = content.match(/<img\b[^>]*>/i);
      const title = this.cleanText(
        (imageTag && this.htmlAttribute(imageTag[0], "alt")) ||
          this.htmlTagText(content, "h1|h2|h3|h4|strong|b") ||
          this.htmlAttribute(match[0].slice(0, match[0].indexOf(">") + 1), "title") ||
          this.prettifySlug(route[2]) ||
          "FilmyFly"
      );
      const rawImage =
        (imageTag &&
          (this.htmlAttribute(imageTag[0], "src") ||
            this.htmlAttribute(imageTag[0], "data-src") ||
            this.htmlAttribute(imageTag[0], "data-lazy-src"))) ||
        "";

      if (!title) continue;
      results.push({ title, url: path, cover: this.normalisePoster(rawImage) });
    }
    return results;
  }

  async sitemapSearch(query) {
    // sitemap.xml is an index -> post-sitemap.xml carries every title URL.
    let xml = this._postMapCache;
    if (!xml) {
      const index = await this.getPage("/sitemap.xml");
      const postMap =
        (index.match(/https?:\/\/[^<>\s]*?post-sitemap\d*\.xml/i) || [])[0] || "";
      xml = postMap ? await this.getPage(postMap) : "";
      this._postMapCache = xml || "";
    }
    const words = query.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length >= 2);
    if (!words.length) return [];
    const locRegex = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
    const hits = [];
    let loc;
    while ((loc = locRegex.exec(xml)) !== null && hits.length < 24) {
      const route = loc[1].match(/\/page-download\/(\d+)\/([a-z0-9-]+?)\.html/i);
      if (!route) continue;
      const slug = route[2].toLowerCase();
      if (!words.every((w) => slug.includes(w))) continue;
      hits.push({
        title: this.prettifySlug(route[2]),
        url: `/page-download/${route[1]}/${route[2]}.html`,
        cover: this.posterFromId(route[1]),
      });
    }
    return hits;
  }

  prettifySlug(slug) {
    if (!slug) return "";
    const clean = slug.replace(/-download$/i, "").replace(/[-_]+/g, " ").trim();
    return clean
      .split(" ")
      .filter(Boolean)
      .map((w) => (/^\d+$/.test(w) && w.length < 4 ? w : w[0].toUpperCase() + w.slice(1)))
      .join(" ");
  }

  posterFromId(id) {
    // Post ids and poster ids track each other closely but not perfectly;
    // only used for the sitemap fallback where a missing poster is harmless.
    return /^\d+$/.test(String(id || ""))
      ? `https://img.iwebp.store/images/imagecloud/poster_${id}.png`
      : "";
  }

  normalisePoster(raw) {
    const url = this.normaliseUrl(this.decodeHtmlEntities(raw || ""));
    if (!url) return "";
    // webp.iwebp.store/webp/<params>-img.iwebp.store/<path> -> origin image
    const direct = url.match(
      /(?:webp\.iwebp\.store\/webp\/[\w-]+-)?img\.iwebp\.store\/(images\/[^\s"']+)/i
    );
    if (direct) return `https://img.iwebp.store/${direct[1]}`.replace(/\?[^?]*$/, "");
    return /^https?:\/\//i.test(url) ? url : "";
  }

  posterUrl(html) {
    const source = String(html || "");
    const og = this.htmlAttributeFromTag(source, "meta", "property", "og:image", "content");
    if (og) return this.normalisePoster(og) || og;
    const big = source.match(
      /(?:webp\.iwebp\.store\/webp\/[\w-]+-)?img\.iwebp\.store\/images\/imagecloud\/poster_\d+\.png/i
    );
    if (big) return this.normalisePoster(big[0]);
    return "";
  }

  metaValue(html, label) {
    const match = String(html || "").match(
      new RegExp(
        `<(?:strong|b|span|th)[^>]*>\\s*${label}\\s*:??\\s*<\\/(?:strong|b|span|th)>\\s*([\\s\\S]{0,500}?)<\\/(?:p|td|div|li)>`,
        "i"
      )
    );
    return match ? this.cleanText(match[1]).replace(/:\s*$/, "").trim() : "";
  }

  // ---------- detail page -> link collection ----------

  // linkmake.in/view anchors (and rotated protector hosts) with their
  // button labels.
  collectViewLinks(html, pagePath) {
    const source = String(html || "");
    const links = [];
    const seen = new Set();
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(source)) !== null) {
      const url = this.resolveUrl(this.decodeHtmlEntities(match[1]), pagePath);
      const text = this.cleanText(match[2]);
      if (!/linkmake\.in\/view\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      links.push({ url, label: text.replace(/^download\s*/i, "").trim() });
    }
    return links;
  }

  // Anchors on a page which already point at a file host (filesdl,
  // hubcloud, pixeldrain, gdflix, gofile...). Used both for rare direct
  // links on title pages and inside the watch-chain fallbacks.
  collectHostLinks(html, pagePath, skipUrls = new Set()) {
    const source = String(html || "");
    const entries = [];
    const seen = new Set(skipUrls);
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(source)) !== null) {
      const url = this.resolveUrl(this.decodeHtmlEntities(match[1]), pagePath);
      const text = this.cleanText(match[2]);
      if (!/^https?:\/\//i.test(url) || seen.has(url) || PROMO_HOSTS.test(url)) continue;
      seen.add(url);
      const entry = this.hostEntry(url, text);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  hostEntry(url, text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (/filesdl\.[a-z.]+\/(?:cloud|drive)\//i.test(url)) {
      return { name: this.entryName(clean, url), url: `xd:file:${encodeURIComponent(url)}` };
    }
    if (/hubcloud\.[a-z.]+/i.test(url)) {
      return { name: this.entryName(clean || "HubCloud", url), url: `xd:file:${encodeURIComponent(url)}` };
    }
    if (/linkmake\.in\/view\//i.test(url)) {
      return { name: clean || "Quality list", url: `xd:file:${encodeURIComponent(url)}` };
    }
    if (this.looksLikeFile(url)) {
      return { name: this.entryName(clean, url), url: `xd:file:${encodeURIComponent(url)}` };
    }
    if (/pixeldrain\.|iwebp\.store\/u\/|gofile\.io|gdflix|fuckingfast\.net|buzzheavier/i.test(url)) {
      return { name: this.entryName(clean, url), url: `xd:file:${encodeURIComponent(url)}` };
    }
    return null;
  }

  entryName(text, url) {
    if (!text) return "Download";
    // "Download 630Mb {480p-HEVC}" -> "480p-HEVC · 630Mb"
    const brace = text.match(/\{([^}]+)\}/);
    const size = text.match(SIZE_TOKEN);
    if (brace && size) return `${brace[1].trim()} · ${size[1].replace(/\s+/g, "")}`;
    if (size) return text.replace(/^download\s*/i, "").trim();
    return text.replace(/^download\s*/i, "").trim().slice(0, 120) || "Download";
  }

  // Fetch one linkmake view page, then every quality's filesdl page, and
  // surface EVERY server link as its own entry. Returns one channel per
  // quality ("480p-HEVC · 630Mb") holding an Auto entry plus one entry per
  // real server on that quality's page.
  async expandView(viewUrl, label, multi = false) {
    const html = await this.getPage(viewUrl);
    const qualities = [];
    const seen = new Set();

    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
      const url = this.resolveUrl(this.decodeHtmlEntities(match[1]), viewUrl);
      const text = this.cleanText(match[2]);
      if (!/^https?:\/\//i.test(url) || seen.has(url) || PROMO_HOSTS.test(url)) continue;
      if (
        !/filesdl\.[a-z.]+\/(?:cloud|drive)\//i.test(url) &&
        !/hubcloud\.[a-z.]+/i.test(url) &&
        !this.looksLikeFile(url)
      ) {
        continue;
      }
      seen.add(url);
      qualities.push({ name: this.entryName(text, url), url });
    }

    if (!qualities.length) {
      // Fallback: plain URL strings anywhere (data-attrs/scripts).
      const urlRegex =
        /https?:\/\/[\w.-]*filesdl[\w.-]*\/(?:cloud|drive)\/[A-Za-z0-9_\-]+|https?:\/\/hubcloud\.[a-z.]+\/(?:drive|file)\/[A-Za-z0-9_\-?=&]+/gi;
      const raw = String(html || "").replace(/\\\//g, "/");
      let m;
      while ((m = urlRegex.exec(raw)) !== null) {
        const url = this.normaliseUrl(m[0]);
        if (seen.has(url)) continue;
        seen.add(url);
        qualities.push({ name: `Mirror ${qualities.length + 1}`, url });
      }
    }

    const groups = [];
    const maxServerFetches = 6;
    for (let i = 0; i < qualities.length && groups.length < 12; i += 1) {
      const quality = qualities[i];
      const urls = [
        { name: "Auto (best server)", url: `ff:file:${encodeURIComponent(quality.url)}` },
      ];
      if (i < maxServerFetches) {
        let servers = [];
        try {
          servers = await this.expandServerPage(quality.url);
        } catch (_) {}
        for (const server of servers) urls.push(server);
      }
      const title =
        quality.name && multi
          ? `${quality.name} — ${label}`
          : quality.name || label || "Download Links";
      groups.push({ title, urls });
    }
    return groups;
  }

  // ---------- playback resolution ----------

  async resolveChain(pageUrl, opts = {}) {
    let currentUrl = this.resolveUrl(pageUrl);
    let referer = this.pageBaseUrl("", opts.referer || SITE_URL);

    for (let attempt = 0; attempt < 6 && currentUrl; attempt += 1) {
      // Browser-only mirrors: fail fast with a useful message.
      if (/gofile\.io\/d\/|fuckingfast\.net|gdflix/i.test(currentUrl)) {
        throw new Error(
          "FilmyFly: this mirror only works in a real browser. Pick Cloud Direct, 10Gbps, Pixeldrain or HubCloud instead."
        );
      }
      // Archives can't play in the video player.
      if (this.isArchive(currentUrl)) {
        throw new Error("FilmyFly: this server offers a ZIP archive — pick another server.");
      }
      // Never let Dio fetch a real file body (it buffers everything). Any
      // file-shaped URL goes straight to the player.
      if (this.looksLikeFile(currentUrl)) {
        return this.playable(currentUrl, this.mediaTypeHint(currentUrl), referer);
      }

      const html = await this.getPage(currentUrl);
      if (!html) break;

      const direct = this.pickDirect(html, currentUrl);
      if (direct) return direct;

      if (this.isGate(html)) {
        throw new Error(
          "FilmyFly: this server wants a one-time browser verification — copy its link from the title page in your browser."
        );
      }

      const next = this.pickNext(html, currentUrl);
      if (next && next !== currentUrl) {
        referer = this.pageBaseUrl(html, currentUrl);
        currentUrl = next;
        continue;
      }
      break;
    }

    throw new Error(
      "FilmyFly: no playable server responded. Pick another quality/server."
    );
  }

  // Choose the best definitely-playable URL on a mirror/filesdl page.
  pickDirect(html, pageUrl) {
    const base = this.pageBaseUrl(html, pageUrl);
    const links = [];
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
      const url = this.resolveUrl(this.decodeHtmlEntities(match[1]), pageUrl);
      const text = this.cleanText(match[2]);
      if (/^https?:\/\//i.test(url)) links.push({ url, text });
    }

    // 1. Fast direct file CDNs (awsastorge8 "Cloud/Fast Cloud", 10Gbps).
    for (const link of links) {
      if (this.isArchive(link.url)) continue;
      if (this.looksLikeFile(link.url) && /awsastor|awsstor|aws_[a-z]*stor|fffast|10gbps|cloud|fast|direct/i.test(link.url + " " + link.text)) {
        return this.playable(link.url, this.mediaTypeHint(link.url), base);
      }
    }
    // 2. Any file-shaped anchor at all.
    for (const link of links) {
      if (this.isArchive(link.url)) continue;
      if (this.looksLikeFile(link.url) && !PROMO_HOSTS.test(link.url)) {
        return this.playable(link.url, this.mediaTypeHint(link.url), base);
      }
    }
    // 3. Genuine pixeldrain /u/ links -> direct api download URL. (Mirror
    // hosts ending in ?download were already handled raw by step 2.)
    for (const link of links) {
      const pd = link.url.match(/pixeldrain\.(?:com|dev)\/u\/([A-Za-z0-9_-]+)(?:\?download)?$/i);
      if (pd) {
        return this.playable(`https://pixeldrain.com/api/file/${pd[1]}?download`, "mp4", base);
      }
    }
    // 4. HubCloud mirror pick (FSLv2 etc.).
    const mirror = this.pickMirror(html, pageUrl);
    if (mirror && !this.isArchive(mirror.url)) {
      return this.playable(mirror.url, this.mediaTypeHint(mirror.url), base);
    }
    // 5. Loose media URL anywhere in the markup.
    const loose = this.extractMediaUrls(html).filter((u) => !this.isArchive(u));
    if (loose.length) return this.playable(loose[0], this.mediaTypeHint(loose[0]), base);
    return null;
  }

  // Where to hop next when the current page has no direct URL.
  pickNext(html, pageUrl) {
    // HubCloud drive pages: the "Generate Direct Download Link" jump.
    if (!/hubcloud\.php\?/i.test(pageUrl) && /hubcloud\.[a-z.]+/i.test(pageUrl)) {
      const generate = html.match(
        /<a\b[^>]*href=["']([^"']*hubcloud\.php\?[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i
      );
      if (generate && /generate|direct download/i.test(this.cleanText(generate[2]))) {
        return this.resolveUrl(this.decodeHtmlEntities(generate[1]), pageUrl);
      }
    }
    const links = [];
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
      const url = this.resolveUrl(this.decodeHtmlEntities(match[1]), pageUrl);
      const text = this.cleanText(match[2]);
      if (/^https?:\/\//i.test(url) && !PROMO_HOSTS.test(url)) links.push({ url, text });
    }
    // linkmake view -> first filesdl page
    for (const link of links) {
      if (/filesdl\.[a-z.]+\/(?:cloud|drive)\//i.test(link.url)) return link.url;
    }
    // any page -> hubcloud host page
    for (const link of links) {
      if (/hubcloud\.[a-z.]+\/(?:drive|video|file)\//i.test(link.url)) return link.url;
    }
    for (const link of links) {
      if (/hubcloud\.php\?/i.test(link.url)) return link.url;
    }
    // embedded known host anywhere in raw markup
    const embedded = String(html || "").replace(/\\\//g, "/").match(
      /https?:\/\/(?:[\w.-]*hubcloud[\w.-]*|gamerxyt\.com|pixeldrain\.(?:com|dev)|[\w.-]*filesdl[\w.-]*)[^"'<>\s)\]}]{4,}/i
    );
    if (embedded) return this.resolveUrl(this.normaliseUrl(embedded[0]), pageUrl);
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
      else if (/pixeldra|pixel/i.test(text)) weight = 2;
      else if (/S3\s*Server/i.test(text)) weight = 3;
      else if (/^\s*Download\s+(File|Now|\[?\s*File)/i.test(text) || /Download\s*\[?\s*File\s*Server/i.test(text)) weight = 4;
      else if (/ZipDisk/i.test(text)) weight = 5;
      else if (/Mega\s*Server/i.test(text)) weight = 6;
      else if (/10\s*Gbps|Server\s*:/i.test(text)) weight = 7;
      else if (/BuzzServer/i.test(text)) continue;
      else continue;

      if (weight === 2) finalHref = this.pixeldrainDirect(href);
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

  async resolveEmbed(url) {
    let currentUrl = this.resolveUrl(url);
    for (let attempt = 0; attempt < 4 && currentUrl; attempt += 1) {
      const html = await this.getPage(currentUrl);
      const media = this.extractMediaUrls(html);
      if (media.length) return this.playable(media[0], "", currentUrl);
      const nextTag = html.match(/<iframe\b[^>]+(?:src|data-src|data-url)=["']([^"']+)["'][^>]*>/i);
      if (!nextTag) break;
      const nextUrl = this.resolveUrl(this.decodeHtmlEntities(nextTag[1]), currentUrl);
      if (!nextUrl || nextUrl === currentUrl) break;
      currentUrl = nextUrl;
    }
    throw new Error("FilmyFly: the online player didn't expose a stream.");
  }

  looksLikeFile(url) {
    const value = String(url || "");
    return /X-Amz-Signature|response-content-disposition|\.r2\.|storage\.googleapis\.com|pixeldrain\.|\/api\/file\/|zdownload\.php|aws[a-z]*stor[a-z]*\d*\.[a-z]+|\.(?:mkv|mp4|webm|m3u8|avi|mov|zip)(?:[?#%&'"\s]|$)|[?&]download(?:=|&|$)/i.test(
      value
    );
  }

  isGate(html) {
    return /turnstile|cf-chl|verify(?:ing)? you are|checking your browser|verify you are human|complete the (?:action|captcha)|slowcloud mf|login to download/i.test(
      String(html || "")
    );
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
        !/\.(?:m3u8|mp4|webm|mkv)(?:$|[?#%])/i.test(url)
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
    const url = this.encodeMediaUrl(this.normaliseUrl(streamUrl));
    if (!/^https?:\/\//i.test(url)) throw new Error("FilmyFly: invalid stream URL.");
    const isMp4 =
      /^(mp4|webm|mkv)$/i.test(typeHint) ||
      (!/^hls$/i.test(typeHint || "") && /\.(?:mp4|webm|mkv|avi|mov)(?:[?#%&'"\s]|$)/i.test(url));
    const refSource = /^https?:\/\//i.test(referer) ? referer : `${SITE_URL}/`;
    const origin = (refSource.match(/^(https?:\/\/[^/]+)/i) || [SITE_URL])[0];
    return {
      type: isMp4 ? "mp4" : "hls",
      url,
      headers: {
        "User-Agent": USER_AGENT,
        Referer: `${origin}/`,
      },
    };
  }

  // mpv/ffmpeg cannot send raw spaces or control characters in the request
  // line — the server then answers an HTML error page and the player
  // reports "failed to recognize file format". Percent-encode the unsafe
  // characters exactly like a browser would, leaving existing %XX
  // sequences untouched.
  encodeMediaUrl(url) {
    return String(url || "").replace(/[\x00-\x20"<>`\\^{|}\x7f-\uffff]/g, (ch) => encodeURIComponent(ch));
  }

  mediaTypeHint(url) {
    return /\.m3u8(?:[?#%&'"\s]|$)/i.test(String(url || "")) ? "hls" : "mp4";
  }

  isArchive(url) {
    return /\.(?:zip|rar|7z)(?:[?#%&'"\s]|$)/i.test(String(url || ""));
  }

  // Origin of the page a link was found on. filesdl hosts redirect
  // (new1.filesdl.in -> new6.filesdl.top) and their CDN only trusts the
  // real page host as Referer, so prefer the page's canonical/og URL when
  // present; fall back to the URL we requested.
  pageBaseUrl(html, fallbackUrl) {
    const source = String(html || "");
    const canon =
      (source.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1] ||
      (source.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i) || [])[1] ||
      (source.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i) || [])[1] ||
      (source.match(/<meta\b[^>]*content=["'](https?:\/\/[^"']+)["'][^>]*property=["']og:url["']/i) || [])[1];
    const candidate = canon || String(fallbackUrl || "");
    const m = String(candidate).match(/^https?:\/\/[^/]+/i);
    return m ? m[0] : SITE_URL;
  }

  // ---------- networking ----------

  async getPage(pathOrUrl) {
    const absolute = this.resolveUrl(pathOrUrl);
    this._lastError = "";
    const relayUrls = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(absolute)}`,
      `https://api.codetabs.com/v1/proxy?quest=${absolute}`,
      `https://api.cors.lol/?url=${encodeURIComponent(absolute)}`,
    ];

    const reasons = [];
    let firstError = "";
    const tryGet = async (target, extraHeaders = {}) => {
      try {
        const response = await this.request("", {
          headers: { "Miru-Url": target, ...BROWSER_HEADERS, ...extraHeaders },
        });
        const body = typeof response === "string" ? response : JSON.stringify(response || "");
        return { body, error: "" };
      } catch (e) {
        return {
          body: "",
          error: String((e && (e.message || e)) || "request failed").replace(/\s+/g, " ").slice(0, 160),
        };
      }
    };

    for (let round = 0; round < 2; round += 1) {
      const got = await tryGet(absolute);
      if (this.looksLikePayload(got.body)) {
        return got.body;
      }
      reasons.push(got.error || "empty body");
      if (got.error && !firstError) firstError = got.error;
      if (round === 0 && /filmyfly\.green$/i.test((absolute.match(/^https?:\/\/([^/]+)/i) || [])[1] || "")) {
        await tryGet(`${SITE_URL}/`);
      }
    }

    for (const relay of relayUrls) {
      const got = await tryGet(relay);
      if (got.body && !/error code 5\d\d|connection timed out|rate limit exceeded|temporarily rate limited/i.test(got.body) && this.looksLikePayload(got.body)) {
        return got.body;
      }
      reasons.push(got.error || "relay empty");
      if (got.error && !firstError) firstError = got.error;
    }

    this._lastError = firstError || reasons.find(Boolean) || "";
    return "";
  }

  // Junk/error stubs (proxy failure pages, empty bodies) are rejected, but
  // so once were legitimately tiny XML sitemaps — accept those.
  looksLikePayload(body) {
    const source = String(body || "");
    if (!source) return false;
    if (this.isBlockedPage(source)) return true;
    if (source.length >= 200) return true;
    return /^\s*(?:<\?xml|<sitemapindex|<urlset)/i.test(source);
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

  // ---------- helpers ----------

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
}
