// ==MiruExtension==
// @name         XDMovies
// @version      v0.0.2
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
const SITEMAP_URL = `${SITE_URL}/sitemap.xml`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TMDB_KEY = "9990db75d12d4ecd4ed84628ebc96403";

export default class extends Extension {
  async latest(page = 1) {
    const pageNumber = Number(page) > 0 ? Number(page) : 1;
    const path = pageNumber > 1 ? `/?page=${pageNumber}` : "/";
    const html = await this.text(this.request(path));
    return this.scrapeCards(html);
  }

  async search(kw, page = 1) {
    const query = String(kw || "").trim();
    if (!query) return [];

    const html = await this.text(
      this.request(`/search.html?q=${encodeURIComponent(query)}`)
    );
    const cards = this.scrapeCards(html);
    if (cards.length) return cards;

    // The search page is JS-rendered on some routes. As a fallback (and to
    // support TMDB-ID lookups), walk the full catalogue sitemap locally.
    return this.sitemapSearch(query);
  }

  async detail(url) {
    const path = this.toPath(url);
    const html = await this.text(this.request(path));
    if (this.isBlockedPage(html)) {
      throw new Error(
        "XDMovies: Cloudflare is verifying this request. Open the site once in your browser, then retry."
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
    const watchOnline = this.embeddedPlayers(html, path);
    if (watchOnline.length) {
      episodes.push({ title: "Watch Online", urls: watchOnline });
    }

    const downloadChannels = this.downloadChannels(html);
    for (const channel of downloadChannels) {
      if (channel.urls.length) episodes.push(channel);
    }

    if (!episodes.length) {
      throw new Error("XDMovies: no watch/download links found on this page.");
    }

    return { title, cover, desc, episodes };
  }

  async watch(url) {
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

  embeddedPlayers(html, pagePath) {
    const source = String(html || "");
    const players = [];
    const seen = new Set();
    const add = (candidate) => {
      const url = this.resolveUrl(this.decodeHtmlEntities(candidate || ""), pagePath);
      if (
        !url ||
        seen.has(url) ||
        !/^https?:\/\//i.test(url) ||
        /google|doubleclick|facebook|twitter|discord|telegram|youtube|youtu\.be|analytics|tagmanager|adsystem/i.test(
          url
        )
      ) {
        return;
      }
      seen.add(url);
      players.push({
        name: `Server ${players.length + 1}`,
        url: `xd:page:${encodeURIComponent(url)}`,
      });
    };

    const tagRegex =
      /<(?:iframe|video|source|embed)\b[^>]+(?:src|data-src|data-url|data-video|data-embed)=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = tagRegex.exec(source)) !== null) add(match[1]);
    return players;
  }

  downloadChannels(html) {
    const source = String(html || "");
    const channels = [];
    const byTitle = new Map();
    const push = (channel, entry) => {
      const title = (channel || "Download Links").replace(/:\s*$/, "").trim() ||
        "Download Links";
      let target = byTitle.get(title);
      if (!target) {
        target = { title, urls: [] };
        byTitle.set(title, target);
        channels.push(target);
      }
      target.urls.push(entry);
    };

    let currentChannel = "";
    let lastRelease = "";
    // The content of a release-name block is bounded by a tempered pattern so
    // a match can never swallow an intervening heading or link anchor.
    const tokenRegex =
      /<(?:h2|h3|h4)\b[^>]*>([\s\S]*?)<\/(?:h2|h3|h4)>|<a\b[^>]*href=["']([^"']*link\.xdmovies\.wtf\/download\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>|<(?:p|span|div|strong)\b[^>]*>((?:(?!<(?:h2|h3|h4|a)\b)[^])*?\.(?:mkv|mp4|avi|webm)[^]*?)<\/(?:p|span|div|strong)>/gi;

    let match;
    while ((match = tokenRegex.exec(source)) !== null) {
      const [, heading, linkHref, linkText, releaseText] = match;

      if (heading !== undefined) {
        const text = this.cleanText(heading).replace(/:\s*$/, "").trim();
        if (/download|version|season|episode|pack/i.test(text) && text.length < 80) {
          currentChannel = text;
        }
        continue;
      }

      if (releaseText !== undefined) {
        const text = this.cleanText(releaseText);
        if (/\.(mkv|mp4|avi|webm)$/i.test(text) && text.length < 200) {
          lastRelease = text;
        }
        continue;
      }

      if (linkHref) {
        const size = this.cleanText(linkText);
        const name = lastRelease || size || "Download";
        push(currentChannel, {
          name: lastRelease && size && size !== lastRelease
            ? `${lastRelease} · ${size}`
            : name,
          url: `xd:file:${encodeURIComponent(this.resolveUrl(this.decodeHtmlEntities(linkHref)))}`,
        });
        lastRelease = "";
      }
    }

    return channels;
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

    for (let attempt = 0; attempt < 5 && currentUrl; attempt += 1) {
      // Plain-HTML pages we may safely GET. File/mirror links are never
      // fetched — Dio buffers whole responses, so those are handed to the
      // player directly (it streams them and supports resume).
      const host = (currentUrl.match(/^https?:\/\/([^/]+)/i) || [])[1] || "";
      const looksLikeFile =
        /X-Amz-Signature|response-content-disposition|\.r2\.|storage\.googleapis\.com|pixeldrain\.|\/api\/file\/|\.(?:mkv|mp4|webm|m3u8|avi|mov|zip)(?:[?#%]|\s|"|$)/i.test(
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

      if (
        /turnstile|cf-chl|verify(?:ing)? you are|checking your browser|verify you are human|complete the (?:action|captcha)|timer paused|get your link/i.test(
          html
        )
      ) {
        throw new Error(
          "XDMovies: this short link needs one-time browser verification. Open it in your browser (HubCloud/FSL page loads there), or use the Watch Online server."
        );
      }

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

  async fetchAbsolute(absoluteUrl, referer = SITE_URL) {
    try {
      const response = await this.request("", {
        headers: {
          "Miru-Url": this.resolveUrl(absoluteUrl),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: referer || `${SITE_URL}/`,
          "User-Agent": USER_AGENT,
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
