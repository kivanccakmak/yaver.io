import type { DogfoodUiColors } from './DogfoodSessionUi';

/** High-contrast colors for shared Dogfood controls inside the light SDK sheet. */
export const FEEDBACK_DOGFOOD_LIGHT_COLORS: DogfoodUiColors = {
  background: '#ffffff',
  border: '#c9c9d5',
  text: '#222229',
  muted: '#5f5f6b',
  accent: '#5645d8',
  accentSoft: '#e7e5ff',
  ready: '#137a3f',
  attention: '#9a5700',
  blocked: '#b42318',
  console: '#ffffff',
};

/** The log surface stays dark, but its foregrounds are explicit and readable. */
export const FEEDBACK_DOGFOOD_CONSOLE_COLORS: DogfoodUiColors = {
  ...FEEDBACK_DOGFOOD_LIGHT_COLORS,
  background: '#15151b',
  border: '#454552',
  text: '#f8fafc',
  muted: '#cbd5e1',
  accent: '#a5b4fc',
  ready: '#4ade80',
  attention: '#fbbf24',
  blocked: '#fca5a5',
  console: '#15151b',
};
