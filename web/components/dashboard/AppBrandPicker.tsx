"use client";

import type { PhoneAppBrand } from "@/lib/agent-client";

export const APP_ICON_PRESETS: Array<{ id: NonNullable<PhoneAppBrand["icon"]>; label: string; glyph: string }> = [
  { id: "spark", label: "Spark", glyph: "✦" },
  { id: "check", label: "Check", glyph: "✓" },
  { id: "note", label: "Notes", glyph: "▤" },
  { id: "grid", label: "Grid", glyph: "▦" },
  { id: "heart", label: "Heart", glyph: "♥" },
  { id: "bolt", label: "Bolt", glyph: "ϟ" },
  { id: "leaf", label: "Leaf", glyph: "◒" },
  { id: "rocket", label: "Launch", glyph: "↑" },
];

export const APP_PALETTES = [
  { id: "indigo", label: "Indigo", primaryColor: "#6C5CE7", secondaryColor: "#A29BFE" },
  { id: "ocean", label: "Ocean", primaryColor: "#0066FF", secondaryColor: "#00CEC9" },
  { id: "forest", label: "Forest", primaryColor: "#00B894", secondaryColor: "#55EFC4" },
  { id: "sunset", label: "Sunset", primaryColor: "#E17055", secondaryColor: "#FDCB6E" },
  { id: "berry", label: "Berry", primaryColor: "#E84393", secondaryColor: "#FD79A8" },
  { id: "slate", label: "Slate", primaryColor: "#2D3436", secondaryColor: "#636E72" },
] as const;

export const DEFAULT_APP_BRAND: PhoneAppBrand = {
  icon: "spark",
  palette: "indigo",
  primaryColor: "#6C5CE7",
  secondaryColor: "#A29BFE",
};

export function brandWithName(brand: PhoneAppBrand, name: string): PhoneAppBrand {
  return { ...DEFAULT_APP_BRAND, ...brand, displayName: name.trim() || "My app" };
}

export default function AppBrandPicker({
  name,
  value,
  onChange,
}: {
  name: string;
  value: PhoneAppBrand;
  onChange: (value: PhoneAppBrand) => void;
}) {
  const brand = brandWithName(value, name);
  const icon = APP_ICON_PRESETS.find((item) => item.id === brand.icon) ?? APP_ICON_PRESETS[0];
  return (
    <div className="mt-4 rounded-xl border border-surface-800 bg-surface-950/70 p-4">
      <div className="flex items-center gap-4">
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[18px] text-3xl font-bold text-white shadow-lg"
          style={{ background: `linear-gradient(160deg, ${brand.primaryColor}, ${brand.secondaryColor})` }}
          aria-label={`${icon.label} app icon preview`}
        >
          {icon.glyph}
        </div>
        <div>
          <div className="text-sm font-semibold text-surface-100">{brand.displayName}</div>
          <div className="mt-1 text-xs leading-5 text-surface-400">
            This is how the project will look on an iPhone or Android Home Screen. The name can still be edited when adding it.
          </div>
        </div>
      </div>

      <div className="mt-4 text-xs uppercase tracking-wide text-surface-400">Choose an icon</div>
      <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-8">
        {APP_ICON_PRESETS.map((item) => {
          const active = item.id === brand.icon;
          return (
            <button
              type="button"
              key={item.id}
              onClick={() => onChange({ ...brand, icon: item.id })}
              title={item.label}
              aria-label={item.label}
              aria-pressed={active}
              className={`aspect-square rounded-xl border text-xl transition ${active ? "border-indigo-400 bg-indigo-500/15 text-white" : "border-surface-800 bg-surface-900 text-surface-300 hover:border-surface-600"}`}
            >
              {item.glyph}
            </button>
          );
        })}
      </div>

      <div className="mt-4 text-xs uppercase tracking-wide text-surface-400">Color palette</div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {APP_PALETTES.map((palette) => {
          const active = palette.id === brand.palette;
          return (
            <button
              type="button"
              key={palette.id}
              onClick={() => onChange({
                ...brand,
                palette: palette.id,
                primaryColor: palette.primaryColor,
                secondaryColor: palette.secondaryColor,
              })}
              aria-pressed={active}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs ${active ? "border-indigo-400 bg-indigo-500/10 text-white" : "border-surface-800 text-surface-300 hover:border-surface-600"}`}
            >
              <span className="h-5 w-5 rounded-md" style={{ backgroundColor: palette.primaryColor }} />
              <span className="h-5 w-5 rounded-md" style={{ backgroundColor: palette.secondaryColor }} />
              <span className="truncate">{palette.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
