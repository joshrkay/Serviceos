export type ColorToken =
  | 'background'
  | 'foreground'
  | 'card'
  | 'cardForeground'
  | 'popover'
  | 'popoverForeground'
  | 'primary'
  | 'primaryForeground'
  | 'secondary'
  | 'secondaryForeground'
  | 'muted'
  | 'mutedForeground'
  | 'accent'
  | 'accentForeground'
  | 'destructive'
  | 'destructiveForeground'
  | 'border'
  | 'input'
  | 'ring'
  | 'chart1'
  | 'chart2'
  | 'chart3'
  | 'chart4'
  | 'chart5'
  | 'success'
  | 'warning';

export type Palette = Record<ColorToken, string>;

export interface Radii {
  sm: number;
  md: number;
  lg: number;
  xl: number;
}

export const light: Palette;
export const dark: Palette;
export const colors: { light: Palette; dark: Palette };
export const radii: Radii;
export const tapTarget: number;

/** CSS custom-property declarations for a palette (`{ '--background': '#fff', … }`). */
export function cssVars(palette: Palette): Record<string, string>;
/** Tailwind color map pointing at the CSS variables (`{ background: 'var(--background)', … }`). */
export function colorVars(palette: Palette): Record<ColorToken, string>;
