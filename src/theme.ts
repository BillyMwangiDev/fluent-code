export type ThemeMode = 'dark' | 'light';

export type Theme = {
  mode: ThemeMode;
  ground: string;
  surface: string;
  raised: string;
  ink: string;
  muted: string;
  border: string;
  coral: string;
  coralTint: string;
  success: string;
  warning: string;
};

export const fluentDark: Theme = {
  mode: 'dark',
  ground: '#1f1e1d',
  surface: '#292827',
  raised: '#34322f',
  ink: '#f5f4ee',
  muted: '#a7a496',
  border: '#4a4843',
  coral: '#d97757',
  coralTint: '#3b2924',
  success: '#81b29a',
  warning: '#e8b05d'
};

export const fluentLight: Theme = {
  mode: 'light',
  ground: '#f5f4ee',
  surface: '#faf9f5',
  raised: '#ffffff',
  ink: '#1f1e1d',
  muted: '#7a7869',
  border: '#e3e1d9',
  coral: '#d97757',
  coralTint: '#f6e6de',
  success: '#4f8067',
  warning: '#a86e11'
};
