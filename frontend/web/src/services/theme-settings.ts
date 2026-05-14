export type ThemeCategory = "Base" | "Colors" | "Nature" | "Kawaii" | "Aesthetic" | "Special";
export type ThemeFilter = "All" | ThemeCategory;
export type LayoutStyle = "classic" | "modern";
export type FontChoice = "Inter" | "Quicksand" | "Nunito" | "Comfortaa" | "Fredoka" | "Comic Neue" | "Outfit" | "Indie Flower" | "Patrick Hand" | "Bubblegum Sans" | "Sniglet" | "Dancing Script" | "Pacifico" | "Custom";
export type RadiusChoice = "small" | "medium" | "large" | "pill";

export interface ThemeColors {
  background: string;
  foreground: string;
  card: string;
  muted: string;
  mutedForeground: string;
  border: string;
  primary: string;
  primaryForeground: string;
  success: string;
  warning: string;
  danger: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  category: ThemeCategory;
  dark: boolean;
  colors: ThemeColors;
  logoFilter: string;
}

export interface AppearanceSettings {
  themeId: string;
  layout: LayoutStyle;
  font: FontChoice;
  radius: RadiusChoice;
  customFontUrl?: string;
  customFontFamily?: string;
}

type ThemeMode = "dark" | "light";
type ThemeOptions = Partial<Pick<ThemeColors, "background" | "foreground" | "card" | "muted" | "mutedForeground" | "border">>;

const storageKey = "luna_appearance_settings";

export const APPEARANCE_SETTINGS_CHANGED = "luna:appearance-settings-changed";
export const themeFilters: readonly ThemeFilter[] = ["All", "Base", "Colors", "Nature", "Kawaii", "Aesthetic", "Special"];

export const fontOptions: Record<FontChoice, { label: string; css: string }> = {
  Inter: { label: "Default (Inter)", css: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  Quicksand: { label: "Quicksand (Rounded)", css: "Quicksand, Inter, system-ui, sans-serif" },
  Nunito: { label: "Nunito (Soft)", css: "Nunito, Inter, system-ui, sans-serif" },
  Comfortaa: { label: "Comfortaa (Display)", css: "Comfortaa, Inter, system-ui, sans-serif" },
  Fredoka: { label: "Fredoka (Bubbly)", css: "Fredoka, Inter, system-ui, sans-serif" },
  "Comic Neue": { label: "Comic Neue (Casual)", css: "'Comic Neue', Inter, system-ui, sans-serif" },
  Outfit: { label: "Outfit (Modern)", css: "Outfit, Inter, system-ui, sans-serif" },
  "Indie Flower": { label: "Indie Flower (Cute)", css: "'Indie Flower', Inter, system-ui, sans-serif" },
  "Patrick Hand": { label: "Patrick Hand (Hand)", css: "'Patrick Hand', Inter, system-ui, sans-serif" },
  "Bubblegum Sans": { label: "Bubblegum (Bubbly)", css: "'Bubblegum Sans', Inter, system-ui, sans-serif" },
  Sniglet: { label: "Sniglet (Rounded)", css: "Sniglet, Inter, system-ui, sans-serif" },
  "Dancing Script": { label: "Dancing (Fancy)", css: "'Dancing Script', Inter, system-ui, sans-serif" },
  Pacifico: { label: "Pacifico (Fancy)", css: "Pacifico, Inter, system-ui, sans-serif" },
  Custom: { label: "Custom Font...", css: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }
};

export const fontImportUrl = "https://fonts.googleapis.com/css2?family=Bubblegum+Sans&family=Comfortaa:wght@300..700&family=Comic+Neue:wght@300;400;700&family=Dancing+Script:wght@400..700&family=Fredoka:wght@300..700&family=Indie+Flower&family=Nunito:wght@200..1000&family=Outfit:wght@100..900&family=Pacifico&family=Patrick+Hand&family=Quicksand:wght@300..700&family=Sniglet:wght@400;800&display=swap";

export const radiusOptions: Record<RadiusChoice, { label: string; css: string }> = {
  small: { label: "Small (0.25rem)", css: "0.25rem" },
  medium: { label: "Medium (0.5rem)", css: "0.5rem" },
  large: { label: "Large (0.85rem)", css: "0.85rem" },
  pill: { label: "Soft Pill (1.25rem)", css: "1.25rem" }
};

export const defaultAppearanceSettings: AppearanceSettings = {
  themeId: "dark",
  layout: "classic",
  font: "Inter",
  radius: "medium"
};

function isBrowser() {
  return typeof window !== "undefined";
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function accentForeground(accent: string) {
  const lightness = Number(accent.match(/(\d+(?:\.\d+)?)%$/)?.[1] ?? 50);
  return lightness > 62 ? "240 10% 4%" : "0 0% 100%";
}

function makeLogoFilter() {
  return "none";
}

function makeTheme(name: string, category: ThemeCategory, mode: ThemeMode, primary: string, options: ThemeOptions = {}): ThemeDefinition {
  const dark = mode === "dark";
  const colors: ThemeColors = dark
    ? {
      background: options.background ?? "240 10% 4%",
      foreground: options.foreground ?? "0 0% 98%",
      card: options.card ?? "240 7% 10%",
      muted: options.muted ?? "240 6% 14%",
      mutedForeground: options.mutedForeground ?? "240 6% 70%",
      border: options.border ?? "240 5% 24%",
      primary,
      primaryForeground: accentForeground(primary),
      success: "142 72% 47%",
      warning: "38 92% 50%",
      danger: "0 84% 60%"
    }
    : {
      background: options.background ?? "0 0% 98%",
      foreground: options.foreground ?? "240 10% 5%",
      card: options.card ?? "0 0% 100%",
      muted: options.muted ?? "240 6% 94%",
      mutedForeground: options.mutedForeground ?? "240 6% 34%",
      border: options.border ?? "240 6% 82%",
      primary,
      primaryForeground: accentForeground(primary),
      success: "142 70% 36%",
      warning: "32 95% 44%",
      danger: "0 74% 47%"
    };

  return { id: slug(name), name, category, dark, colors, logoFilter: makeLogoFilter() };
}

export const themes: readonly ThemeDefinition[] = [
  makeTheme("Dark", "Base", "dark", "0 0% 98%", { background: "0 0% 4%", card: "0 0% 10%", muted: "0 0% 13%", border: "0 0% 22%" }),
  makeTheme("Light", "Base", "light", "240 10% 5%"),
  makeTheme("Really Dark", "Base", "dark", "0 0% 100%", { background: "0 0% 0%", card: "0 0% 5%", muted: "0 0% 8%", border: "0 0% 16%" }),
  makeTheme("Light Dark", "Base", "dark", "0 0% 92%", { background: "240 7% 8%", card: "240 6% 13%", muted: "240 5% 18%" }),
  makeTheme("Eighth Dark", "Base", "dark", "0 0% 86%", { background: "240 8% 6%", card: "240 6% 11%", muted: "240 5% 16%" }),

  makeTheme("Blue", "Colors", "dark", "217 91% 60%"),
  makeTheme("Blue Light", "Colors", "light", "217 91% 56%"),
  makeTheme("Green", "Colors", "dark", "142 71% 45%"),
  makeTheme("Green Light", "Colors", "light", "142 69% 38%"),
  makeTheme("Purple", "Colors", "dark", "263 85% 66%"),
  makeTheme("Purple Light", "Colors", "light", "263 75% 56%"),
  makeTheme("Pink", "Colors", "dark", "346 77% 50%"),
  makeTheme("Pink Light", "Colors", "light", "346 77% 48%"),
  makeTheme("Red", "Colors", "dark", "0 85% 60%"),
  makeTheme("Red Light", "Colors", "light", "0 74% 51%"),
  makeTheme("Orange", "Colors", "dark", "25 95% 53%"),
  makeTheme("Orange Light", "Colors", "light", "25 90% 48%"),

  makeTheme("Forest", "Nature", "dark", "142 65% 44%", { background: "150 28% 7%", card: "150 24% 11%", muted: "150 18% 15%", border: "150 16% 23%" }),
  makeTheme("Forest Light", "Nature", "light", "142 55% 38%", { background: "120 28% 96%", card: "120 28% 99%", muted: "120 20% 91%" }),
  makeTheme("Ocean", "Nature", "dark", "181 82% 52%", { background: "202 38% 7%", card: "202 30% 11%", muted: "202 24% 16%", border: "202 20% 25%" }),
  makeTheme("Ocean Light", "Nature", "light", "184 75% 43%", { background: "190 55% 96%", card: "190 55% 99%", muted: "190 35% 90%" }),
  makeTheme("Sunset", "Nature", "dark", "25 95% 53%", { background: "14 42% 7%", card: "14 34% 11%", muted: "14 26% 16%" }),
  makeTheme("Sunset Light", "Nature", "light", "25 90% 48%", { background: "35 78% 96%", muted: "35 42% 90%" }),
  makeTheme("Desert", "Nature", "dark", "16 73% 55%", { background: "28 28% 8%", card: "28 23% 12%", muted: "28 18% 17%" }),
  makeTheme("Desert Light", "Nature", "light", "18 76% 48%", { background: "36 62% 94%", muted: "34 38% 87%" }),
  makeTheme("Notebook", "Nature", "light", "0 0% 49%", { background: "45 36% 96%", card: "42 60% 99%", muted: "45 22% 90%" }),
  makeTheme("Ghibli", "Nature", "light", "142 55% 44%", { background: "95 45% 95%", card: "92 50% 99%", muted: "95 30% 89%" }),
  makeTheme("Ghibli Dark", "Nature", "dark", "142 58% 48%", { background: "130 28% 7%", card: "130 24% 11%", muted: "130 18% 15%" }),
  makeTheme("Matcha", "Nature", "light", "93 42% 50%", { background: "88 45% 95%", muted: "88 30% 88%" }),
  makeTheme("Mint Cream", "Nature", "light", "161 52% 52%", { background: "150 58% 97%", muted: "150 36% 91%" }),
  makeTheme("Seafoam", "Nature", "light", "175 52% 48%", { background: "178 56% 96%", muted: "178 36% 90%" }),
  makeTheme("Honey", "Nature", "light", "43 85% 50%", { background: "48 92% 96%", muted: "48 52% 88%" }),
  makeTheme("Cloud", "Nature", "light", "205 24% 74%", { background: "210 30% 98%", muted: "210 24% 92%" }),
  makeTheme("Mocha", "Nature", "dark", "31 39% 45%", { background: "25 20% 8%", card: "25 18% 12%", muted: "25 15% 17%" }),
  makeTheme("Coral", "Nature", "light", "14 78% 65%", { background: "12 80% 97%", muted: "12 45% 91%" }),
  makeTheme("Midnight Blue", "Nature", "dark", "222 90% 60%", { background: "225 46% 7%", card: "225 38% 11%", muted: "225 30% 16%" }),
  makeTheme("Slate", "Nature", "dark", "210 28% 60%", { background: "215 24% 8%", card: "215 20% 12%", muted: "215 16% 17%" }),
  makeTheme("Terracotta", "Nature", "dark", "16 58% 55%", { background: "17 25% 8%", card: "17 20% 12%", muted: "17 18% 17%" }),
  makeTheme("Olive", "Nature", "dark", "82 40% 45%", { background: "76 22% 8%", card: "76 18% 12%", muted: "76 15% 17%" }),
  makeTheme("Sandstone", "Nature", "light", "30 34% 58%", { background: "36 48% 95%", muted: "36 28% 88%" }),
  makeTheme("Evergreen", "Nature", "dark", "152 50% 35%", { background: "154 30% 7%", card: "154 26% 11%", muted: "154 19% 15%" }),
  makeTheme("Cool Breeze", "Nature", "light", "190 78% 55%", { background: "196 84% 97%", muted: "196 48% 91%" }),
  makeTheme("Iced Coffee", "Nature", "light", "30 28% 48%", { background: "32 48% 95%", muted: "32 28% 88%" }),
  makeTheme("Aloe", "Nature", "light", "174 48% 52%", { background: "160 48% 97%", muted: "160 31% 90%" }),
  makeTheme("Graphite Dark", "Nature", "dark", "220 9% 60%", { background: "220 8% 6%", card: "220 7% 10%", muted: "220 6% 15%" }),

  makeTheme("Marshmallow", "Kawaii", "light", "335 82% 52%", { background: "336 80% 98%", muted: "336 44% 92%" }),
  makeTheme("Peach Blossom", "Kawaii", "light", "350 78% 75%", { background: "18 100% 97%", muted: "18 55% 91%" }),
  makeTheme("Lavender Mist", "Kawaii", "light", "270 63% 70%", { background: "260 100% 98%", muted: "260 45% 93%" }),
  makeTheme("Cotton Candy", "Kawaii", "light", "318 75% 72%", { background: "310 100% 98%", muted: "310 50% 93%" }),
  makeTheme("Sakura", "Kawaii", "light", "342 82% 76%", { background: "342 100% 98%", muted: "342 45% 92%" }),
  makeTheme("Red Kawaii", "Kawaii", "light", "0 78% 75%", { background: "0 95% 98%", muted: "0 45% 92%" }),
  makeTheme("Strawberry Milk", "Kawaii", "light", "343 87% 75%", { background: "348 100% 98%", muted: "348 48% 92%" }),
  makeTheme("Taro", "Kawaii", "light", "260 51% 70%", { background: "262 100% 98%", muted: "262 42% 92%" }),
  makeTheme("Mint Choco", "Kawaii", "light", "160 50% 52%", { background: "158 55% 97%", muted: "158 34% 91%" }),
  makeTheme("Banana Milk", "Kawaii", "light", "45 88% 65%", { background: "48 100% 97%", muted: "48 50% 90%" }),
  makeTheme("Blueberry", "Kawaii", "light", "231 69% 75%", { background: "230 100% 98%", muted: "230 44% 92%" }),
  makeTheme("Pistachio", "Kawaii", "light", "101 42% 62%", { background: "96 62% 96%", muted: "96 34% 90%" }),
  makeTheme("Earl Grey", "Kawaii", "light", "26 18% 60%", { background: "34 30% 96%", muted: "34 18% 89%" }),
  makeTheme("Bubblegum", "Kawaii", "light", "326 87% 70%", { background: "326 100% 98%", muted: "326 50% 92%" }),
  makeTheme("Lemonade", "Kawaii", "light", "58 90% 60%", { background: "58 100% 97%", muted: "58 56% 89%" }),
  makeTheme("Cantaloupe", "Kawaii", "light", "24 86% 70%", { background: "24 100% 97%", muted: "24 48% 91%" }),
  makeTheme("Lilac Dream", "Kawaii", "light", "280 55% 70%", { background: "280 100% 98%", muted: "280 44% 93%" }),
  makeTheme("Sky", "Kawaii", "light", "200 84% 70%", { background: "200 100% 98%", muted: "200 50% 92%" }),
  makeTheme("Periwinkle", "Kawaii", "light", "240 70% 76%", { background: "240 100% 98%", muted: "240 45% 93%" }),
  makeTheme("Sherbet", "Kawaii", "light", "350 88% 75%", { background: "32 100% 97%", muted: "32 48% 91%" }),

  makeTheme("Neo Brutalism", "Aesthetic", "light", "0 0% 0%", { background: "51 100% 94%", card: "0 0% 100%", muted: "51 60% 84%", border: "0 0% 5%" }),
  makeTheme("Amber", "Aesthetic", "dark", "37 90% 55%", { background: "35 32% 7%", card: "35 26% 11%", muted: "35 20% 16%" }),
  makeTheme("Rose Gold", "Aesthetic", "dark", "349 50% 65%", { background: "348 24% 8%", card: "348 20% 12%", muted: "348 18% 17%" }),
  makeTheme("Berry", "Aesthetic", "dark", "318 70% 50%", { background: "319 30% 8%", card: "319 25% 12%", muted: "319 20% 17%" }),
  makeTheme("Twilight", "Aesthetic", "dark", "260 50% 45%", { background: "252 32% 8%", card: "252 27% 12%", muted: "252 22% 17%" }),
  makeTheme("Monochrome", "Aesthetic", "dark", "0 0% 100%", { background: "0 0% 5%", card: "0 0% 10%", muted: "0 0% 15%" }),
  makeTheme("Electric Violet", "Aesthetic", "dark", "270 90% 60%", { background: "266 38% 7%", card: "266 32% 11%", muted: "266 26% 16%" }),
  makeTheme("Neon Cyan", "Aesthetic", "dark", "180 100% 50%", { background: "190 42% 6%", card: "190 36% 10%", muted: "190 30% 15%" }),
  makeTheme("Hot Pink", "Aesthetic", "dark", "330 100% 60%", { background: "328 34% 7%", card: "328 28% 11%", muted: "328 24% 16%" }),
  makeTheme("Lime Zest", "Aesthetic", "dark", "77 90% 50%", { background: "80 30% 7%", card: "80 24% 11%", muted: "80 20% 16%" }),
  makeTheme("Soft Lilac", "Aesthetic", "light", "260 58% 80%", { background: "260 100% 98%", muted: "260 40% 93%" }),
  makeTheme("Pale Yellow", "Aesthetic", "light", "50 82% 70%", { background: "52 100% 98%", muted: "52 45% 91%" }),
  makeTheme("Baby Blue", "Aesthetic", "light", "200 70% 80%", { background: "200 100% 98%", muted: "200 42% 93%" }),
  makeTheme("Minty Fresh", "Aesthetic", "light", "150 62% 75%", { background: "150 100% 98%", muted: "150 40% 92%" }),

  makeTheme("Netflix", "Special", "dark", "0 100% 50%", { background: "0 0% 3%", card: "0 0% 8%", muted: "0 0% 13%" }),
  makeTheme("Netflix Light", "Special", "light", "0 100% 45%", { background: "0 0% 98%", muted: "0 10% 92%" }),
  makeTheme("Cyberpunk", "Special", "dark", "323 100% 50%", { background: "257 45% 7%", card: "257 38% 11%", muted: "257 30% 16%" }),
  makeTheme("Cyberpunk Light", "Special", "light", "323 100% 48%", { background: "58 100% 95%", card: "0 0% 100%", muted: "58 50% 87%" }),
  makeTheme("Halloween", "Special", "dark", "30 100% 50%", { background: "275 35% 6%", card: "275 28% 10%", muted: "275 24% 15%" }),
  makeTheme("Jhayne", "Special", "dark", "181 82% 52%", { background: "220 36% 7%", card: "220 30% 11%", muted: "220 24% 16%" }),
  makeTheme("Thundersnow", "Special", "dark", "221 70% 50%", { background: "218 42% 7%", card: "218 34% 11%", muted: "218 28% 16%" }),
  makeTheme("Mario", "Special", "dark", "0 85% 48%", { background: "220 38% 7%", card: "220 30% 11%", muted: "220 24% 16%" }),
  makeTheme("Vaporwave", "Special", "dark", "300 100% 70%", { background: "260 45% 7%", card: "260 38% 11%", muted: "260 30% 16%" }),
  makeTheme("Synthwave", "Special", "dark", "262 100% 65%", { background: "250 42% 7%", card: "250 36% 11%", muted: "250 28% 16%" }),
  makeTheme("Retro Sunset", "Special", "dark", "16 90% 60%", { background: "264 32% 8%", card: "264 26% 12%", muted: "264 22% 17%" }),
  makeTheme("Neon Nights", "Special", "dark", "320 100% 60%", { background: "230 34% 7%", card: "230 28% 11%", muted: "230 24% 16%" }),
  makeTheme("Velvet", "Special", "dark", "340 60% 50%", { background: "342 32% 7%", card: "342 26% 11%", muted: "342 22% 16%" }),
  makeTheme("Starlight", "Special", "dark", "47 90% 55%", { background: "230 28% 7%", card: "230 24% 11%", muted: "230 20% 16%" }),
  makeTheme("Winner", "Special", "dark", "45 95% 55%", { background: "38 28% 7%", card: "38 24% 11%", muted: "38 20% 16%" })
];

export function getThemeById(id: string | undefined) {
  return themes.find((theme) => theme.id === id) ?? themes[0]!;
}

function normalizeSettings(value: Partial<AppearanceSettings> | null): AppearanceSettings {
  const theme = getThemeById(value?.themeId);
  const layout = value?.layout === "modern" ? "modern" : defaultAppearanceSettings.layout;
  const legacyFontMap: Record<string, FontChoice> = { inter: "Inter", system: "Inter", serif: "Inter", mono: "Inter" };
  const rawFont = typeof value?.font === "string" ? value.font : undefined;
  const font = rawFont && rawFont in fontOptions ? rawFont as FontChoice : rawFont && legacyFontMap[rawFont] ? legacyFontMap[rawFont] : defaultAppearanceSettings.font;
  const radius = value?.radius && value.radius in radiusOptions ? value.radius : defaultAppearanceSettings.radius;
  return { themeId: theme.id, layout, font, radius, customFontUrl: value?.customFontUrl ?? "", customFontFamily: value?.customFontFamily ?? "" };
}

export function loadAppearanceSettings(): AppearanceSettings {
  if (!isBrowser()) return defaultAppearanceSettings;
  try {
    return normalizeSettings(JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Partial<AppearanceSettings> | null);
  } catch {
    return defaultAppearanceSettings;
  }
}

export function applyAppearanceSettings(settings = loadAppearanceSettings()) {
  if (!isBrowser()) return;
  const normalized = normalizeSettings(settings);
  const theme = getThemeById(normalized.themeId);
  const root = document.documentElement;
  const browserThemeColor = `hsl(${theme.colors.background})`;

  root.dataset.theme = theme.id;
  root.classList.toggle("dark", theme.dark);
  root.style.colorScheme = theme.dark ? "dark" : "light";
  root.style.setProperty("--background", theme.colors.background);
  root.style.setProperty("--foreground", theme.colors.foreground);
  root.style.setProperty("--card", theme.colors.card);
  root.style.setProperty("--muted", theme.colors.muted);
  root.style.setProperty("--muted-foreground", theme.colors.mutedForeground);
  root.style.setProperty("--accent", theme.colors.muted);
  root.style.setProperty("--accent-foreground", theme.colors.foreground);
  root.style.setProperty("--border", theme.colors.border);
  root.style.setProperty("--input", theme.colors.border);
  root.style.setProperty("--ring", theme.colors.primary);
  root.style.setProperty("--secondary", theme.colors.muted);
  root.style.setProperty("--secondary-foreground", theme.colors.foreground);
  root.style.setProperty("--primary", theme.colors.primary);
  root.style.setProperty("--primary-foreground", theme.colors.primaryForeground);
  root.style.setProperty("--success", theme.colors.success);
  root.style.setProperty("--warning", theme.colors.warning);
  root.style.setProperty("--danger", theme.colors.danger);
  const customFontCss = normalized.customFontFamily?.trim()
    ? `${normalized.customFontFamily.trim()}, Inter, system-ui, sans-serif`
    : fontOptions.Inter.css;
  root.style.setProperty("--font-sans", normalized.font === "Custom" ? customFontCss : fontOptions[normalized.font].css);
  root.style.setProperty("--radius", radiusOptions[normalized.radius].css);
  root.style.setProperty("--logo-filter", theme.logoFilter);
  root.style.setProperty("--logo-surface", `hsl(${theme.colors.primary} / ${theme.dark ? "0.12" : "0.10"})`);
  root.style.setProperty("--logo-glow", `hsl(${theme.colors.primary} / ${theme.dark ? "0.28" : "0.18"})`);
  root.style.setProperty("--sidebar-surface", theme.dark
    ? `color-mix(in oklab, hsl(${theme.colors.background}) 35%, hsl(${theme.colors.card}) 65%)`
    : `color-mix(in oklab, hsl(${theme.colors.background}) 90%, hsl(${theme.colors.card}) 10%)`);
  root.style.setProperty("--sidebar-border", theme.dark
    ? `color-mix(in oklab, hsl(${theme.colors.border}) 60%, hsl(${theme.colors.background}) 40%)`
    : `hsl(${theme.colors.border} / 0.52)`);

  const themeColorMeta = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  if (themeColorMeta.length === 0) {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = browserThemeColor;
    document.head.appendChild(meta);
  } else {
    themeColorMeta.forEach((meta) => {
      meta.content = browserThemeColor;
      meta.removeAttribute("media");
    });
  }

  let colorSchemeMeta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (!colorSchemeMeta) {
    colorSchemeMeta = document.createElement("meta");
    colorSchemeMeta.name = "color-scheme";
    document.head.appendChild(colorSchemeMeta);
  }
  colorSchemeMeta.content = theme.dark ? "dark" : "light";
}

export function saveAppearanceSettings(settings: AppearanceSettings) {
  if (!isBrowser()) return;
  const normalized = normalizeSettings(settings);
  window.localStorage.setItem(storageKey, JSON.stringify(normalized));
  applyAppearanceSettings(normalized);
  window.dispatchEvent(new Event(APPEARANCE_SETTINGS_CHANGED));
}
