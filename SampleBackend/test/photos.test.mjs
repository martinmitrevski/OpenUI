// The photo lookup against a fake Wikipedia API: matching, credits, caching and failures.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findPhotos, isRelevantMatch, normalize } from "../src/photos.mjs";

/** A fake Wikipedia: search results by query, and Commons metadata by file title. */
function fakeWikipedia(pagesByQuery, metadataByFile = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const params = new URL(url).searchParams;
    calls.push({ params, headers: options.headers });
    if (params.get("generator") === "search") {
      const page = pagesByQuery[params.get("gsrsearch")];
      return Response.json(page ? { query: { pages: [page] } } : { batchcomplete: true });
    }
    if (params.get("prop") === "imageinfo") {
      const pages = params
        .get("titles")
        .split("|")
        .map((title) => ({ title: title.replaceAll("_", " "), imageinfo: [{ extmetadata: metadataByFile[title] ?? {} }] }));
      return Response.json({ query: { pages } });
    }
    return new Response("unexpected request", { status: 500 });
  };
  return { fetchImpl, calls };
}

function article(title, file, extra = {}) {
  return {
    title,
    description: `About ${title}`,
    fullurl: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
    pageimage: file,
    thumbnail: { source: `https://upload.wikimedia.org/thumb/${file}/1280px-${file}` },
    ...extra,
  };
}

describe("findPhotos", () => {
  test("returns photos in topic order with credits", async () => {
    const { fetchImpl, calls } = fakeWikipedia(
      {
        "Kinkaku-ji Kyoto": article("Kinkaku-ji", "Golden_Pavilion.jpg"),
        "Gion Kyoto": article("Gion", "Gion_street.jpg"),
      },
      {
        "File:Golden_Pavilion.jpg": { Artist: { value: '<a href="https://example.org">Jane Doe</a>' }, LicenseShortName: { value: "CC BY-SA 4.0" } },
      },
    );
    const { photos } = await findPhotos({ topics: ["Kinkaku-ji", "Gion"], context: "Kyoto" }, { fetchImpl });

    assert.deepEqual(photos, [
      {
        topic: "Kinkaku-ji",
        title: "Kinkaku-ji",
        description: "About Kinkaku-ji",
        image: "https://upload.wikimedia.org/thumb/Golden_Pavilion.jpg/1280px-Golden_Pavilion.jpg",
        imageAlt: "Kinkaku-ji",
        pageUrl: "https://en.wikipedia.org/wiki/Kinkaku-ji",
        credit: "Photo: Jane Doe · CC BY-SA 4.0",
      },
      {
        topic: "Gion",
        title: "Gion",
        description: "About Gion",
        image: "https://upload.wikimedia.org/thumb/Gion_street.jpg/1280px-Gion_street.jpg",
        imageAlt: "Gion",
        pageUrl: "https://en.wikipedia.org/wiki/Gion",
        credit: "Photo: Wikimedia Commons",
      },
    ]);

    const search = calls.find((call) => call.params.get("generator") === "search");
    assert.equal(search.params.get("pilicense"), "free", "only freely licensed images");
    assert.match(search.headers["User-Agent"], /^OpenUISampleBackend\//);
  });

  test("leaves out unrelated results, disambiguation pages and pages without a free image", async () => {
    const { fetchImpl } = fakeWikipedia({
      "Bay of Bones Ohrid": article("List of lakes by country", "Lakes.jpg"),
      "Church of St. Mark Ohrid": article("Church of St. Panteleimon, Ohrid", "Panteleimon.jpg"),
      "Mercury Ohrid": article("Mercury", "Mercury.jpg", { pageprops: { disambiguation: "" } }),
      "Plaošnik Ohrid": { ...article("Plaošnik", "Plaosnik.jpg"), thumbnail: undefined },
    });
    const { photos } = await findPhotos(
      { topics: ["Bay of Bones", "Church of St. Mark", "Mercury", "Plaošnik"], context: "Ohrid" },
      { fetchImpl },
    );
    assert.deepEqual(photos, []);
  });

  test("caches lookups, including misses", async () => {
    const { fetchImpl, calls } = fakeWikipedia({ "Nishiki Market Kyoto": article("Nishiki Market", "Nishiki.jpg") });
    await findPhotos({ topics: ["Nishiki Market", "Unknown Corner"], context: "Kyoto" }, { fetchImpl });
    const searches = calls.filter((call) => call.params.get("generator") === "search").length;
    const { photos } = await findPhotos({ topics: ["nishiki market", "Unknown Corner"], context: "Kyoto" }, { fetchImpl });
    assert.equal(photos[0].title, "Nishiki Market");
    assert.equal(calls.filter((call) => call.params.get("generator") === "search").length, searches);
  });

  test("returns no photos when Wikipedia is unreachable", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    assert.deepEqual(await findPhotos({ topics: ["Fushimi Inari-taisha"], context: "Kyoto" }, { fetchImpl }), { photos: [] });
  });

  test("dedupes topics, ignores blanks and looks up at most eight", async () => {
    const { fetchImpl, calls } = fakeWikipedia({});
    const topics = ["A1", "a1", " ", "", ...Array.from({ length: 10 }, (_, index) => `Place ${index}`)];
    await findPhotos({ topics, context: "Testville" }, { fetchImpl });
    assert.equal(calls.filter((call) => call.params.get("generator") === "search").length, 8);
  });
});

describe("isRelevantMatch", () => {
  test("needs a distinctive word of the topic in the title", () => {
    const cases = [
      ["Church of St. Sophia", "Church of Saint Sophia, Ohrid", true],
      ["Samuel's Fortress", "Samuel's Fortress, Ohrid", true],
      ["Arashiyama Bamboo Grove", "Bamboo Forest (Kyoto)", true],
      ["Shakshuka", "Shakshouka", true],
      ["Tavče gravče", "Tavče gravče", true],
      ["Spaghetti alla carbonara", "Carbonara", true],
      ["Old Town", "Old Town, Prague", true],
      ["Church of St. Mark", "Church of St. Panteleimon, Ohrid", false],
      ["Old Town", "Ohrid", false],
      ["Bay of Bones", "List of lakes by country", false],
      ["Old Bazaar", "List of bazaars and souks", false],
    ];
    for (const [topic, title, expected] of cases) {
      assert.equal(isRelevantMatch(topic, title), expected, `${topic} → ${title}`);
    }
  });

  test("normalize drops accents, case and punctuation", () => {
    assert.equal(normalize("Plaošnik — St. Clement's"), "plaosnik st clement s");
  });
});
