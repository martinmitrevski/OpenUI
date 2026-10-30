// Mock tool implementations backing Query()/Mutation() calls in generated UIs.
// The OpenUI runtime in the app calls POST /tools/<name> with the evaluated arguments; in live mode
// Claude can also call the read-only tools to inspect real data before writing its answer.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPhotos } from "./photos.mjs";

const toolsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "openui", "tools.json");

/** The tool specs from openui/tools.json (name, description, annotations, input and output schema). */
export async function loadToolSpecs() {
  return JSON.parse(await readFile(toolsPath, "utf8"));
}

const HOTELS = {
  ohrid: [
    { id: "h1", name: "Čaršija Hostel", area: "Old Bazaar", price: 19, rating: 4.4, highlight: "Rooftop terrace a minute from the bazaar" },
    { id: "h2", name: "Kaneo Lakeview Rooms", area: "Kaneo", price: 54, rating: 4.8, highlight: "Balconies over the lake below St. John at Kaneo" },
    { id: "h3", name: "Varoš Stone House", area: "Old Town", price: 68, rating: 4.7, highlight: "Restored 19th-century house next to St. Sophia" },
    { id: "h4", name: "Promenade Boutique Hotel", area: "Lakefront", price: 86, rating: 4.5, highlight: "On the promenade, five minutes from the harbour" },
    { id: "h5", name: "Gorica Bay Resort", area: "Gorica", price: 138, rating: 4.6, highlight: "Private beach and spa south of the centre" },
    { id: "h6", name: "Lagadin Shore Hotel", area: "Lagadin", price: 72, rating: 4.3, highlight: "Sandy beach on the road to St. Naum" },
    { id: "h7", name: "Naum Springs Lodge", area: "St. Naum", price: 95, rating: 4.6, highlight: "A short walk from the monastery and the springs" },
  ],
};

/** Plausible hotels for cities without curated data. */
function genericHotels(city) {
  const templates = [
    ["Central Hostel", "City centre", 24, 4.2, "Social hostel in the middle of town"],
    ["Old Town Guesthouse", "Old town", 52, 4.5, "Family-run rooms on a quiet street"],
    ["Garden Apartments", "Residential", 66, 4.3, "Apartments with kitchens and a garden"],
    ["Waterfront Hotel", "Waterfront", 94, 4.4, "Rooms with a view and a breakfast terrace"],
    ["Grand Hotel", "Centre", 155, 4.7, "Classic hotel with a spa"],
  ];
  return templates.map(([name, area, price, rating, highlight], index) => ({ id: `g${index + 1}`, name: `${city} ${name}`, area, price, rating, highlight }));
}

/** "ohrid" → "Ohrid". */
function displayName(city) {
  const text = String(city).trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const CONDITIONS = ["Sunny", "Partly cloudy", "Sunny", "Light rain", "Cloudy", "Sunny", "Partly cloudy"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Typical daytime highs and night lows in °C. */
const CLIMATE = { ohrid: { high: 18, low: 8 } };
const DEFAULT_CLIMATE = { high: 21, low: 12 };

const RECIPES = {
  carbonara: {
    baseServings: 2,
    caloriesPerServing: 640,
    ingredients: [
      ["Spaghetti", 200, "g"],
      ["Guanciale (or pancetta)", 100, "g"],
      ["Egg yolks", 3, ""],
      ["Whole egg", 1, ""],
      ["Pecorino Romano, grated", 50, "g"],
      ["Black pepper", 1, "tsp"],
    ],
  },
  shakshuka: {
    baseServings: 2,
    caloriesPerServing: 380,
    ingredients: [
      ["Eggs", 4, ""],
      ["Crushed tomatoes", 400, "g"],
      ["Red pepper", 1, ""],
      ["Onion", 1, ""],
      ["Cumin", 1, "tsp"],
      ["Feta", 60, "g"],
    ],
  },
};

function formatAmount(value, unit) {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return unit ? `${text} ${unit}` : text;
}

let savedTrips = 0;
let shoppingItems = 0;

export const tools = {
  async search_hotels({ city = "Ohrid", maxPrice, sort } = {}) {
    const all = HOTELS[String(city).toLowerCase()] ?? genericHotels(displayName(city));
    const limit = Number(maxPrice);
    let hotels = all.filter((hotel) => !Number.isFinite(limit) || limit <= 0 || hotel.price <= limit);
    hotels = [...hotels].sort((a, b) => (sort === "rating" ? b.rating - a.rating : a.price - b.price));
    await delay(350);
    return { city: displayName(city), total: hotels.length, hotels };
  },

  async get_weather({ city = "Ohrid", days = 5 } = {}) {
    const count = Math.max(1, Math.min(7, Number(days) || 5));
    const seed = [...String(city).toLowerCase()].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const climate = CLIMATE[String(city).toLowerCase()] ?? DEFAULT_CLIMATE;
    const forecast = Array.from({ length: count }, (_, index) => {
      const wave = Math.sin((seed + index * 3) / 4);
      return {
        day: DAYS[index % 7],
        high: Math.round(climate.high + wave * 3),
        low: Math.round(climate.low + wave * 2),
        condition: CONDITIONS[(seed + index) % CONDITIONS.length],
        rainChance: CONDITIONS[(seed + index) % CONDITIONS.length] === "Light rain" ? 60 : Math.round(5 + Math.abs(wave) * 15),
      };
    });
    await delay(300);
    return { city: displayName(city), days: forecast };
  },

  async find_photos({ topics = [], context } = {}) {
    return findPhotos({ topics, context });
  },

  async scale_recipe({ recipe = "carbonara", servings = 2 } = {}) {
    const definition = RECIPES[String(recipe).toLowerCase()] ?? RECIPES.carbonara;
    const target = Math.max(1, Number(servings) || definition.baseServings);
    const factor = target / definition.baseServings;
    await delay(250);
    return {
      servings: target,
      calories: definition.caloriesPerServing * target,
      ingredients: definition.ingredients.map(([item, amount, unit]) => ({ item, amount: formatAmount(amount * factor, unit) })),
    };
  },

  async save_trip({ destination = "Ohrid", travelers, budget } = {}) {
    savedTrips += 1;
    await delay(500);
    const details = [travelers ? `${travelers} traveller(s)` : null, budget ? `€${budget} budget` : null].filter(Boolean).join(", ");
    return { id: `trip-${savedTrips}`, message: `Saved your ${destination} trip${details ? ` (${details})` : ""}.` };
  },

  async add_to_shopping_list({ recipe = "carbonara", servings = 2 } = {}) {
    const { ingredients } = await tools.scale_recipe({ recipe, servings });
    shoppingItems += ingredients.length;
    return { added: ingredients.length, message: `Added ${ingredients.length} ingredients (${shoppingItems} on your list).` };
  },
};

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
