// ==MiruExtension==
// @name         FilmyFly
// @version      v0.0.1
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
    // per release/part). Each view page is expanded at detail time so all
    // qualities are directly visible and tappable.
    const views = this.collectViewLinks(html, path);
    for (const view of views.slice(0, 4)) {
      const expanded = await this.expandView(view.url, view.label);
      if (expanded.urls.length) {
        episodes.push(expanded);
      } else {
        // Keep the link visible even if expansion failed.
        episodes.push({
          title: view.label || "Download Links",
          urls: [{ name: "Open quality list", url: `xd:file:${encodeURIComponent(view.url)}` }],
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

  // Fetch one linkmake view page and turn every quality anchor into an
  // entry. The raw HTML is server-rendered; the miner below also catches
  // script-injected variants.
  async expandView(viewUrl, label) {
    const html = await this.getPage(viewUrl);
    const entries = [];
    const seen = new Set();

    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
      const url = this.resolveUrl(this.decodeHtmlEntities(match[1]), viewUrl);
      const text = this.cleanText(match[2]);
      if (!/^https?:\/\//i.test(url) || seen.has(url) || PROMO_HOSTS.test(url)) continue;
      const entry = this.hostEntry(url, text);
      if (!entry) continue;
      seen.add(entry.url);
      entries.push(entry);
    }

    if (!entries.length) {
      // Fallback: plain URL strings anywhere (data-attrs/scripts).
      const urlRegex =
        /https?:\/\/[\w.-]*filesdl[\w.-]*\/(?:cloud|drive)\/[A-Za-z0-9_\-]+|https?:\/\/hubcloud\.[a-z.]+\/(?:drive|file)\/[A-Za-z0-9_\-?=&]+/gi;
      const raw = String(html || "").replace(/\\\//g, "/");
      let m;
      while ((m = urlRegex.exec(raw)) !== null) {
        const url = this.normaliseUrl(m[0]);
        if (seen.has(url)) continue;
        seen.add(url);
        entries.push({ name: `Mirror ${entries.length + 1}`, url: `xd:file:${encodeURIComponent(url)}` });
      }
    }

    for (const e of entries) {
      if (e.url.startsWith("xd:file:")) e.url = `ff:file:${e.url.slice("xd:file:".length)}`;
    }
    return { title: label || "Download Links", urls: entries };
  }

  // ---------- playback resolution ----------

  async resolveChain(pageUrl) {
    let currentUrl = this.resolveUrl(pageUrl);

    for (let attempt = 0; attempt < 6 && currentUrl; attempt += 1) {
      // Never let Dio fetch a real file body (it buffers everything). Any
      // file-shaped URL goes straight to the player.
      if (this.looksLikeFile(currentUrl)) {
        return this.playable(currentUrl, /\.m3u8/i.test(currentUrl) ? "hls" : "mp4", currentUrl);
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
      if (this.looksLikeFile(link.url) && /awsastor|awsstor|fffast|10gbps|cloud|fast|direct/i.test(link.url + " " + link.text)) {
        return this.playable(link.url, /\.m3u8/i.test(link.url) ? "hls" : "mp4", pageUrl);
      }
    }
    // 2. Any file-shaped anchor at all.
    for (const link of links) {
      if (this.looksLikeFile(link.url) && !PROMO_HOSTS.test(link.url)) {
        return this.playable(link.url, /\.m3u8/i.test(link.url) ? "hls" : "mp4", pageUrl);
      }
    }
    // 3. Genuine pixeldrain /u/ links -> direct api download URL. (Mirror
    // hosts ending in ?download were already handled raw by step 2.)
    for (const link of links) {
      const pd = link.url.match(/pixeldrain\.(?:com|dev)\/u\/([A-Za-z0-9_-]+)(?:\?download)?$/i);
      if (pd) {
        return this.playable(`https://pixeldrain.com/api/file/${pd[1]}?download`, "mp4", pageUrl);
      }
    }
    // 4. HubCloud mirror pick (FSLv2 etc.).
    const mirror = this.pickMirror(html, pageUrl);
    if (mirror) {
      return this.playable(mirror.url, /\.m3u8/i.test(mirror.url) ? "hls" : "mp4", pageUrl);
    }
    // 5. Loose media URL anywhere in the markup.
    const loose = this.extractMediaUrls(html);
    if (loose.length) return this.playable(loose[0], "", pageUrl);
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
    return /X-Amz-Signature|response-content-disposition|\.r2\.|storage\.googleapis\.com|pixeldrain\.|\/api\/file\/|zdownload\.php|aws[a-z]*stor[a-z]*\d*\.[a-z]+|\.(?:mkv|mp4|webm|m3u8|avi|mov|zip)(?:[?#%&]|\s|"|$)|[?&]download(?:=|&|$)/i.test(
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
    const url = this.normaliseUrl(streamUrl);
    if (!/^https?:\/\//i.test(url)) throw new Error("FilmyFly: invalid stream URL.");
    const isMp4 =
      /^(mp4|webm|mkv)$/i.test(typeHint) || /\.(?:mp4|webm|mkv)(?:$|[?#%])/i.test(url);
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
      if (got.body && (this.isBlockedPage(got.body) || got.body.length >= 200)) {
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
      if (got.body && !/error code 5\d\d|connection timed out|rate limit exceeded|temporarily rate limited/i.test(got.body) && got.body.length >= 200) {
        return got.body;
      }
      reasons.push(got.error || "relay empty");
      if (got.error && !firstError) firstError = got.error;
    }

    this._lastError = firstError || reasons.find(Boolean) || "";
    return "";
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
