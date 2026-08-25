// ==MiruExtension==
// @name         HDGharTV
// @version      v0.0.1
// @author       OshekharO
// @lang         hi
// @license      MIT
// @package      hdghartv
// @type         bangumi
// @icon         https://hdghartv.cc/favicon.ico
// @webSite      https://hdghartv.cc
// @nsfw         false
// ==/MiruExtension==

const SITE_URL = "https://hdghartv.cc";
const API_URL = `${SITE_URL}/api`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export default class extends Extension {
  async latest(page = 1) {
    const pageNumber = Number(page) > 0 ? Number(page) : 1;
    const endpoints = [
      `/movies/public?page=${pageNumber}&limit=24`,
      `/movies?page=${pageNumber}&limit=24`,
      `/trending?page=${pageNumber}&limit=24`,
    ];

    for (const endpoint of endpoints) {
      const data = await this.api(endpoint);
      const movies = this.catalogItems(data);
      if (movies.length) return this.toSearchResults(movies);
    }

    // The public API currently documents search rather than a catalogue
    // endpoint. This keeps the home tab useful if the list endpoint is absent.
    return this.search("a", pageNumber);
  }

  async search(kw, page = 1) {
    const query = String(kw || "").trim();
    if (!query) return [];

    const data = await this.api(`/search?q=${encodeURIComponent(query)}`);
    const items = [
      ...(Array.isArray(data && data.movies) ? data.movies : []).map((item) => ({
        ...item,
        mediaType: "movie",
      })),
      ...(Array.isArray(data && data.series) ? data.series : []).map((item) => ({
        ...item,
        mediaType: "series",
      })),
    ];

    return this.toSearchResults(items);
  }

  async detail(url) {
    const [mediaType, id] = String(url || "").split(":");
    if (!id || !/^(movie|series)$/.test(mediaType)) {
      throw new Error("HDGharTV: invalid catalogue item URL.");
    }

    const data = await this.api(
      `/${mediaType === "series" ? "series" : "movies"}/public/${encodeURIComponent(id)}`
    );
    if (!data || typeof data !== "object") {
      throw new Error("HDGharTV: unable to load the movie details.");
    }

    const title = this.cleanText(data.title || data.name || "HDGharTV");
    const cover = this.firstValue([
      data.poster,
      data.posterUrl,
      data.image,
      data.imageUrl,
      data.thumbnail,
      data.backdrop,
    ]);
    const desc = this.cleanText(
      data.description || data.overview || data.plot || data.synopsis || ""
    );

    const episodes = mediaType === "series"
      ? this.seriesEpisodes(data)
      : this.movieEpisodes(data, title);

    return {
      title,
      cover: this.resolveUrl(cover),
      desc,
      episodes,
    };
  }

  async watch(url) {
    const packed = String(url || "");
    let type = "";
    let streamUrl = packed;

    const match = packed.match(/^hdghartv:(hls|mp4):(.+)$/i);
    if (match) {
      type = match[1].toLowerCase();
      try {
        streamUrl = decodeURIComponent(match[2]);
      } catch (_) {
        streamUrl = match[2];
      }
    }

    streamUrl = this.normaliseUrl(streamUrl);
    if (!/^https?:\/\//i.test(streamUrl)) {
      throw new Error("HDGharTV: invalid stream URL.");
    }

    const isMp4 = type === "mp4" || /\.(?:mp4|webm)(?:$|[?#])/i.test(streamUrl);
    return {
      type: isMp4 ? "mp4" : "hls",
      url: streamUrl,
      // HDGharTV's API returns signed CDN URLs that do not require a
      // referer. Keep a browser user-agent for CDN servers that check it.
      headers: {
        "User-Agent": USER_AGENT,
      },
    };
  }

  async api(path) {
    try {
      const response = await this.request("", {
        headers: {
          "Miru-Url": `${API_URL}${path}`,
          Accept: "application/json, */*",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: `${SITE_URL}/`,
          "User-Agent": USER_AGENT,
        },
      });

      if (typeof response === "string") {
        try {
          return JSON.parse(response);
        } catch (_) {
          return null;
        }
      }
      return response;
    } catch (_) {
      return null;
    }
  }

  catalogItems(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    for (const key of ["movies", "series", "results", "items", "data"]) {
      if (Array.isArray(data[key])) return data[key];
    }
    return [];
  }

  toSearchResults(items) {
    const results = [];
    const seen = new Set();

    for (const item of items || []) {
      const id = item && (item._id || item.id);
      const title = this.cleanText(item && (item.title || item.name));
      const mediaType = item && item.mediaType === "series" ? "series" : "movie";
      if (!id || !title) continue;

      const url = `${mediaType}:${id}`;
      if (seen.has(url)) continue;
      seen.add(url);

      const cover = this.firstValue([
        item.image,
        item.imageUrl,
        item.poster,
        item.posterUrl,
        item.thumbnail,
        item.backdrop,
      ]);
      results.push({
        title,
        url,
        cover: this.resolveUrl(cover),
      });
    }

    return results;
  }

  movieEpisodes(data, title) {
    const links = this.activeLinks(data && data.streamingLinks);
    return [
      {
        title: "HDGharTV",
        urls: links.map((link, index) => ({
          name: link.quality || `${title} Server ${index + 1}`,
          url: this.packSource(link),
        })),
      },
    ];
  }

  seriesEpisodes(data) {
    const episodes = [];
    const seasons = Array.isArray(data && data.seasons) ? data.seasons : [];

    for (const season of seasons) {
      const seasonNumber = season && season.seasonNumber != null
        ? season.seasonNumber
        : episodes.length + 1;
      const urls = [];
      const sourceEpisodes = Array.isArray(season && season.episodes)
        ? season.episodes
        : [];

      for (const episode of sourceEpisodes) {
        const episodeNumber = episode && episode.episodeNumber != null
          ? episode.episodeNumber
          : urls.length + 1;
        const episodeTitle = this.cleanText(
          episode && (episode.name || episode.title || `Episode ${episodeNumber}`)
        );
        const links = this.activeLinks(episode && episode.streamingLinks);

        for (const link of links) {
          urls.push({
            name: `${episodeTitle} ${link.quality || ""}`.trim(),
            url: this.packSource(link),
          });
        }
      }

      if (urls.length) {
        episodes.push({
          title: `Season ${seasonNumber}`,
          urls,
        });
      }
    }

    return episodes;
  }

  activeLinks(links) {
    if (!Array.isArray(links)) return [];
    return links.filter(
      (link) => link && link.url && link.isActive !== false
    );
  }

  packSource(link) {
    const type = /mp4|webm/i.test(String(link.type || link.url))
      ? "mp4"
      : "hls";
    return `hdghartv:${type}:${encodeURIComponent(link.url)}`;
  }

  firstValue(values) {
    return (values || []).find(
      (value) => typeof value === "string" && value.trim()
    ) || "";
  }

  resolveUrl(value) {
    const url = this.normaliseUrl(value);
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith("//")) return `https:${url}`;
    return `${SITE_URL}/${url.replace(/^\/+/, "")}`;
  }

  normaliseUrl(value) {
    return String(value || "")
      .trim()
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&");
  }

  cleanText(value) {
    return String(value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}
