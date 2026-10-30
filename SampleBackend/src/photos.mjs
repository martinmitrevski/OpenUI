// Real photos for places and dishes, looked up on Wikipedia when they're requested: the lead image
// of the best-matching article, limited to freely licensed images, with a credit line for the
// author and license from Wikimedia Commons. Topics without a confident match or without a free
// image are left out, so a wrong photo is never shown.

const API = "https://en.wikipedia.org/w/api.php";
const USER_AGENT = process.env.WIKIMEDIA_USER_AGENT || "OpenUISampleBackend/1.0 (OpenUI SwiftUI sample app)";
const MAX_TOPICS = 8;
const TIMEOUT_MS = 8000;

/** Lookups by topic and context; `null` records a topic without a usable photo. */
const cache = new Map();

/**
 * Finds photos for `topics` (landmarks, places or dishes). `context` (a city or country) is added
 * to the search to pick the right article. Returns `{ photos }` in the order of the topics.
 */
export async function findPhotos({ topics, context } = {}, { fetchImpl = fetch } = {}) {
  const requested = (Array.isArray(topics) ? topics : [topics]).map((topic) => String(topic ?? "").trim()).filter(Boolean);
  const unique = [...new Map(requested.map((topic) => [normalize(topic), topic])).values()].slice(0, MAX_TOPICS);
  const where = typeof context === "string" ? context.trim() : "";

  const found = await Promise.all(unique.map((topic) => lookup(topic, where, fetchImpl).catch(() => null)));
  const photos = found.filter(Boolean);
  await addCredits(photos, fetchImpl).catch(() => {});
  return {
    photos: photos.map(({ file, ...photo }) => ({ ...photo, credit: photo.credit ?? "Photo: Wikimedia Commons" })),
  };
}

async function lookup(topic, context, fetchImpl) {
  const key = `${normalize(topic)}|${normalize(context)}`;
  if (cache.has(key)) return cache.get(key);

  const query = context && !normalize(topic).includes(normalize(context)) ? `${topic} ${context}` : topic;
  const data = await wikipedia(fetchImpl, {
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "1",
    gsrnamespace: "0",
    prop: "pageimages|description|info|pageprops",
    piprop: "thumbnail|name",
    pithumbsize: "1280",
    pilicense: "free",
    inprop: "url",
    ppprop: "disambiguation",
  });
  const page = data.query?.pages?.[0];
  const usable = page?.thumbnail?.source && page.pageimage && page.pageprops?.disambiguation === undefined;
  const photo =
    usable && isRelevantMatch(topic, page.title)
      ? {
          topic,
          title: page.title,
          description: page.description ?? "",
          image: page.thumbnail.source,
          imageAlt: page.title,
          pageUrl: page.fullurl,
          file: page.pageimage,
        }
      : null;
  cache.set(key, photo);
  return photo;
}

/** Adds "Photo: <author> · <license>" credits from the images' Commons metadata. */
async function addCredits(photos, fetchImpl) {
  const missing = photos.filter((photo) => photo.credit === undefined);
  if (missing.length === 0) return;
  const data = await wikipedia(fetchImpl, {
    action: "query",
    prop: "imageinfo",
    iiprop: "extmetadata",
    iiextmetadatafilter: "Artist|LicenseShortName",
    titles: [...new Set(missing.map((photo) => `File:${photo.file}`))].join("|"),
  });
  const credits = new Map();
  for (const page of data.query?.pages ?? []) {
    const metadata = page.imageinfo?.[0]?.extmetadata ?? {};
    const artist = plainText(metadata.Artist?.value).slice(0, 80);
    const license = plainText(metadata.LicenseShortName?.value);
    credits.set(fileKey(page.title), `Photo: ${artist || "Wikimedia Commons"}${license ? ` · ${license}` : ""}`);
  }
  for (const photo of missing) photo.credit = credits.get(fileKey(`File:${photo.file}`));
}

/** Commons metadata is HTML: keep the text. */
function plainText(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Matches "File:A_b.jpg" with the API's normalized "File:A b.jpg". */
function fileKey(title) {
  return normalize(String(title).replace(/_/g, " "));
}

async function wikipedia(fetchImpl, params) {
  const url = `${API}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  const response = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Wikipedia returned ${response.status}`);
  return response.json();
}

// MARK: - Matching

/** Words that don't identify a place on their own. */
const STOPWORDS = new Set(["the", "of", "at", "in", "on", "and", "by", "de", "la", "le", "el", "di", "da", "du", "des", "der", "st", "saint", "san", "santa", "sv", "sveti"]);
const GENERIC = new Set([
  "old", "new", "town", "city", "centre", "center", "church", "cathedral", "monastery", "temple", "shrine", "mosque",
  "museum", "gallery", "park", "national", "garden", "gardens", "castle", "fortress", "palace", "tower", "bridge",
  "square", "market", "street", "gate", "house", "lake", "river", "beach", "bay", "island", "hill", "mountain",
  "district", "quarter", "theatre", "theater", "harbour", "harbor", "port", "viewpoint",
]);

/** Lowercase, without accents and punctuation. */
export function normalize(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function words(text) {
  return normalize(text)
    .split(" ")
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

function similar(a, b) {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter >= 5 && (a.startsWith(b) || b.startsWith(a))) return true;
  return shorter >= 6 && editDistance(a, b) <= 2;
}

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Whether a search result is about the requested topic: a distinctive word of the topic must
 * appear in the article title ("Church of St. Mark" doesn't match "Church of St. Sophia"). Topics
 * made only of generic words ("Old Town") need half of them. List pages never match.
 */
export function isRelevantMatch(topic, title) {
  if (/^(lists? of|outline of|index of|timeline of|glossary of)\b/i.test(String(title).trim())) return false;
  const titleWords = words(title);
  const matches = (word) => titleWords.some((other) => similar(word, other));
  const topicWords = words(topic);
  const distinctive = topicWords.filter((word) => !GENERIC.has(word));
  if (distinctive.length > 0) return distinctive.some(matches);
  return topicWords.length > 0 && topicWords.filter(matches).length * 2 >= topicWords.length;
}
