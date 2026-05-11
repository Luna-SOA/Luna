import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import { AppShell } from "@/components/layout/app-shell";
import { fontImportUrl, fontOptions, radiusOptions, themes } from "@/services/theme-settings";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

function safeJson(value: unknown) {
  return (JSON.stringify(value) ?? "null").replace(/</g, "\\u003c");
}

const themeBootstrapThemes = Object.fromEntries(
  themes.map((theme) => [theme.id, { id: theme.id, dark: theme.dark, colors: theme.colors, logoFilter: theme.logoFilter }])
);
const themeBootstrapFonts = Object.fromEntries(Object.entries(fontOptions).map(([key, value]) => [key, value.css]));
const themeBootstrapRadii = Object.fromEntries(Object.entries(radiusOptions).map(([key, value]) => [key, value.css]));
const themeBootstrapCode = `(() => {
  try {
    const themes = ${safeJson(themeBootstrapThemes)};
    const fonts = ${safeJson(themeBootstrapFonts)};
    const radii = ${safeJson(themeBootstrapRadii)};
    const raw = window.localStorage.getItem("luna_appearance_settings");
    const settings = raw ? JSON.parse(raw) : {};
    const theme = themes[settings.themeId] || themes.dark || themes[Object.keys(themes)[0]];
    const legacyFonts = { inter: "Inter", system: "Inter", serif: "Inter", mono: "Inter" };
    const selectedFont = fonts[settings.font] ? settings.font : legacyFonts[settings.font] || "Inter";
    const font = selectedFont === "Custom" && settings.customFontFamily ? settings.customFontFamily + ", Inter, system-ui, sans-serif" : fonts[selectedFont] || fonts.Inter;
    const radius = radii[settings.radius] || radii.medium;
    const root = document.documentElement;
    const colors = theme.colors;

    root.dataset.theme = theme.id;
    root.classList.toggle("dark", Boolean(theme.dark));
    root.style.colorScheme = theme.dark ? "dark" : "light";
    root.style.setProperty("--background", colors.background);
    root.style.setProperty("--foreground", colors.foreground);
    root.style.setProperty("--card", colors.card);
    root.style.setProperty("--muted", colors.muted);
    root.style.setProperty("--muted-foreground", colors.mutedForeground);
    root.style.setProperty("--accent", colors.muted);
    root.style.setProperty("--accent-foreground", colors.foreground);
    root.style.setProperty("--border", colors.border);
    root.style.setProperty("--input", colors.border);
    root.style.setProperty("--ring", colors.primary);
    root.style.setProperty("--secondary", colors.muted);
    root.style.setProperty("--secondary-foreground", colors.foreground);
    root.style.setProperty("--primary", colors.primary);
    root.style.setProperty("--primary-foreground", colors.primaryForeground);
    root.style.setProperty("--success", colors.success);
    root.style.setProperty("--warning", colors.warning);
    root.style.setProperty("--danger", colors.danger);
    root.style.setProperty("--font-sans", font);
    root.style.setProperty("--radius", radius);
    root.style.setProperty("--logo-filter", theme.logoFilter || "none");
    root.style.setProperty("--logo-surface", "hsl(" + colors.primary + " / " + (theme.dark ? "0.12" : "0.10") + ")");
    root.style.setProperty("--logo-glow", "hsl(" + colors.primary + " / " + (theme.dark ? "0.28" : "0.18") + ")");
    root.style.setProperty("--sidebar-surface", theme.dark
      ? "color-mix(in oklab, hsl(" + colors.background + ") 35%, hsl(" + colors.card + ") 65%)"
      : "color-mix(in oklab, hsl(" + colors.background + ") 90%, hsl(" + colors.card + ") 10%)");
    root.style.setProperty("--sidebar-border", theme.dark
      ? "color-mix(in oklab, hsl(" + colors.border + ") 60%, hsl(" + colors.background + ") 40%)"
      : "hsl(" + colors.border + " / 0.52)");

    const themeColor = "hsl(" + colors.background + ")";
    let themeMeta = document.querySelector('meta[name="theme-color"]');
    if (!themeMeta) {
      themeMeta = document.createElement("meta");
      themeMeta.name = "theme-color";
      document.head.appendChild(themeMeta);
    }
    themeMeta.content = themeColor;
    themeMeta.removeAttribute("media");

    let schemeMeta = document.querySelector('meta[name="color-scheme"]');
    if (!schemeMeta) {
      schemeMeta = document.createElement("meta");
      schemeMeta.name = "color-scheme";
      document.head.appendChild(schemeMeta);
    }
    schemeMeta.content = theme.dark ? "dark" : "light";
  } catch {}
})();`;

export const metadata: Metadata = {
  title: "Luna",
  description: "Luna microservices chat platform with logs dashboard"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" className={`dark ${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href={fontImportUrl} rel="stylesheet" />
      </head>
      <body className="bg-background text-foreground antialiased">
        <Script id="luna-theme-bootstrap" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: themeBootstrapCode }} />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
