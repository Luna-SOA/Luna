"use client";

import { useEffect, useState } from "react";

export interface LunaVisualizationTheme {
  dark: boolean;
  fontFamily: string;
  background: string;
  backgroundSoft: string;
  surface: string;
  surfaceStrong: string;
  border: string;
  borderStrong: string;
  foreground: string;
  foregroundMuted: string;
  foregroundSubtle: string;
  primary: string;
  primarySoft: string;
  success: string;
  warning: string;
  danger: string;
  grid: string;
  shadow: string;
  palette: string[];
}

const fallbackTheme: LunaVisualizationTheme = {
  dark: true,
  fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  background: "hsl(0 0% 4%)",
  backgroundSoft: "hsl(0 0% 4% / 0.72)",
  surface: "hsl(0 0% 10% / 0.74)",
  surfaceStrong: "hsl(0 0% 10% / 0.94)",
  border: "hsl(0 0% 22% / 0.5)",
  borderStrong: "hsl(0 0% 22% / 0.72)",
  foreground: "hsl(0 0% 98%)",
  foregroundMuted: "hsl(0 0% 98% / 0.68)",
  foregroundSubtle: "hsl(0 0% 98% / 0.42)",
  primary: "hsl(0 0% 98%)",
  primarySoft: "hsl(0 0% 98% / 0.14)",
  success: "hsl(142 72% 47%)",
  warning: "hsl(38 92% 50%)",
  danger: "hsl(0 84% 60%)",
  grid: "hsl(0 0% 98% / 0.1)",
  shadow: "hsl(0 0% 0% / 0.28)",
  palette: ["hsl(0 0% 98%)", "hsl(142 72% 47%)", "hsl(38 92% 50%)", "hsl(0 84% 60%)", "hsl(210 90% 62%)", "hsl(270 80% 68%)"],
};

type HslParts = { h: number; s: number; l: number };

function cssVar(style: CSSStyleDeclaration, name: string) {
  return style.getPropertyValue(name).trim();
}

function parseHsl(value: string): HslParts | null {
  const match = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) };
}

function hsl(value: string, fallback: string, alpha?: number) {
  if (!value) return fallback;
  return alpha === undefined ? `hsl(${value})` : `hsl(${value} / ${alpha})`;
}

function shiftedHsl(parts: HslParts, hueShift: number, saturationShift = 0, lightnessShift = 0) {
  const hue = ((parts.h + hueShift) % 360 + 360) % 360;
  const saturation = Math.min(96, Math.max(18, parts.s + saturationShift));
  const lightness = Math.min(78, Math.max(36, parts.l + lightnessShift));
  return `hsl(${Math.round(hue)} ${Math.round(saturation)}% ${Math.round(lightness)}%)`;
}

function paletteFromTheme(primaryRaw: string, foreground: string, success: string, warning: string, danger: string) {
  const primary = parseHsl(primaryRaw);
  if (!primary || primary.s < 10) {
    return [foreground, success, warning, danger, "hsl(210 85% 62%)", "hsl(274 78% 68%)"];
  }

  return [
    hsl(primaryRaw, fallbackTheme.primary),
    shiftedHsl(primary, 36, 4, 1),
    shiftedHsl(primary, 148, 2, -2),
    shiftedHsl(primary, 222, 5, 3),
    warning,
    danger,
  ];
}

export function readLunaVisualizationTheme(): LunaVisualizationTheme {
  if (typeof document === "undefined") return fallbackTheme;

  const root = document.documentElement;
  const style = window.getComputedStyle(root);
  const background = cssVar(style, "--background");
  const foreground = cssVar(style, "--foreground");
  const card = cssVar(style, "--card");
  const mutedForeground = cssVar(style, "--muted-foreground");
  const border = cssVar(style, "--border");
  const primary = cssVar(style, "--primary");
  const success = cssVar(style, "--success");
  const warning = cssVar(style, "--warning");
  const danger = cssVar(style, "--danger");
  const fontFamily = cssVar(style, "--font-sans") || fallbackTheme.fontFamily;
  const dark = root.classList.contains("dark") || style.colorScheme.includes("dark");

  const foregroundColor = hsl(foreground, fallbackTheme.foreground);
  const successColor = hsl(success, fallbackTheme.success);
  const warningColor = hsl(warning, fallbackTheme.warning);
  const dangerColor = hsl(danger, fallbackTheme.danger);

  return {
    dark,
    fontFamily,
    background: hsl(background, fallbackTheme.background),
    backgroundSoft: hsl(background, fallbackTheme.backgroundSoft, dark ? 0.72 : 0.82),
    surface: hsl(card, fallbackTheme.surface, dark ? 0.72 : 0.88),
    surfaceStrong: hsl(card, fallbackTheme.surfaceStrong, dark ? 0.94 : 0.98),
    border: hsl(border, fallbackTheme.border, dark ? 0.5 : 0.62),
    borderStrong: hsl(border, fallbackTheme.borderStrong, dark ? 0.72 : 0.82),
    foreground: foregroundColor,
    foregroundMuted: hsl(mutedForeground, fallbackTheme.foregroundMuted),
    foregroundSubtle: hsl(foreground, fallbackTheme.foregroundSubtle, dark ? 0.42 : 0.5),
    primary: hsl(primary, fallbackTheme.primary),
    primarySoft: hsl(primary, fallbackTheme.primarySoft, dark ? 0.14 : 0.12),
    success: successColor,
    warning: warningColor,
    danger: dangerColor,
    grid: hsl(foreground, fallbackTheme.grid, dark ? 0.1 : 0.14),
    shadow: dark ? "hsl(0 0% 0% / 0.28)" : "hsl(220 18% 20% / 0.12)",
    palette: paletteFromTheme(primary, foregroundColor, successColor, warningColor, dangerColor),
  };
}

export function useLunaVisualizationTheme() {
  const [theme, setTheme] = useState<LunaVisualizationTheme>(fallbackTheme);

  useEffect(() => {
    const update = () => setTheme(readLunaVisualizationTheme());
    update();

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    window.addEventListener("luna:appearance-settings-changed", update);
    window.addEventListener("storage", update);

    return () => {
      observer.disconnect();
      window.removeEventListener("luna:appearance-settings-changed", update);
      window.removeEventListener("storage", update);
    };
  }, []);

  return theme;
}
