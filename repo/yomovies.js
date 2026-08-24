// ==MiruExtension==
// @name         YoMovies
// @version      v0.0.8
// @author       OshekharO
// @lang         hi
// @license      MIT
// @package      yomovies
// @type         bangumi
// @icon         https://dl.memuplay.com/new_market/img/com.wYoMovies_7822289.sc1.2024-05-21-17-59-43.jpg
// @webSite      https://yomovies.energy
// @nsfw         false
// ==/MiruExtension==

export default class extends Extension {
  async latest() {
    const res = await this.request("/");
    const bsxList = await this.querySelectorAll(res, "div.ml-item");
    const novel = [];

    for (const element of bsxList) {
      const html = await element.content;

      const url = await this.getAttributeText(html, "a", "href");
      const title = await this.querySelector(html, "div.qtip-title").text;
      const cover = await this
        .querySelector(html, "img")
        .getAttributeText("data-original");

      novel.push({
        title: title.trim(),
        url,
        cover,
      });
    }

    return novel;
  }

  async search(kw) {
    const res = await this.request(`/?s=${encodeURIComponent(kw)}`);
    const bsxList = await this.querySelectorAll(res, "div.ml-item");
    const novel = [];

    for (const element of bsxList) {
      const html = await element.content;

      const url = await this.getAttributeText(html, "a", "href");
      const title = await this.querySelector(html, "div.qtip-title").text;
      const cover = await this
        .querySelector(html, "img")
        .getAttributeText("data-original");

      novel.push({
        title: title.trim(),
        url,
        cover,
      });
    }

    return novel;
  }

  async detail(url) {
    const res = await this.request("", {
      headers: {
        "Miru-Url": url,
      },
    });

    const title = await this
      .querySelector(res, "meta[property='og:title']")
      .getAttributeText("content");

    const cover = await this
      .querySelector(res, "img[itemprop='image']")
      .getAttributeText("src");

    const desc = await this.querySelector(res, "p.f-desc").text;

    /*
     * Find the video/player URL from the YoMovies page.
     */
    const episodeUrlMatch = res.match(
      /https:\/\/minoplres\.[^\s'"<>]+/
    );

    const episodeUrl = episodeUrlMatch
      ? episodeUrlMatch[0]
      : "";

    return {
      title: title.trim(),
      cover,
      desc,
      episodes: [
        {
          title: "Directory",
          urls: [
            {
              name: title.trim(),
              url: episodeUrl,
            },
          ],
        },
      ],
    };
  }

  async watch(url) {
    const res = await this.request("", {
      headers: {
        "Miru-Url": url,
        "Referer": "https://yomovies.energy/",
      },
    });

    /*
     * Match an HLS .m3u8 URL, including signed query parameters.
     *
     * Example:
     * https://example.com/path/master.m3u8?t=xxx&s=xxx&e=xxx
     */
    const m3u8Match = res.match(
      /https?:\/\/[^\s'"<>\\]+\.m3u8(?:\?[^\s'"<>\\]*)?/i
    );

    /*
     * Fallback for MP4 sources.
     */
    const mp4Match = res.match(
      /https?:\/\/[^\s'"<>\\]+\.mp4(?:\?[^\s'"<>\\]*)?/i
    );

    const directUrl = m3u8Match
      ? m3u8Match[0]
      : mp4Match
        ? mp4Match[0]
        : "";

    if (!directUrl) {
      throw new Error("Video stream URL not found");
    }

    return {
      type: m3u8Match ? "hls" : "mp4",
      url: directUrl,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/89.0.142.86 Safari/537.36",
        "Referer": "https://yomovies.energy/",
      },
    };
  }
}
