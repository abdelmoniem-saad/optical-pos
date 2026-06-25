// Design tokens mirrored from app/ui/components/ui_tokens.py, for use in
// TypeScript where a CSS class isn't convenient. Prefer Tailwind utility
// classes (bg-brand, text-danger, ...) defined in index.css @theme; reach
// for these constants only when computing styles in JS.

export const color = {
  brand: '#1976d2',
  brandLight: '#2196f3',
  brandFaint: '#bbdefb',
  brandBg: '#e3f2fd',
  brandDark: '#0d47a1',
  danger: '#d32f2f',
  success: '#388e3c',
  successBg: '#e8f5e9',
  warning: '#f57c00',
  warningBg: '#fff3e0',
  surface: '#f5f5f7',
  muted: '#757575',
  faint: '#9e9e9e',
  line: '#bdbdbd',
  onPrimary: '#ffffff',
} as const

export const space = { xs: 6, sm: 10, md: 16, lg: 22, xl: 30 } as const

export const size = {
  inputHeight: 52,
  buttonHeight: 56,
  topbarHeight: 64,
  titleSize: 24,
  subtitleSize: 16,
  bodySize: 14,
} as const
