// Minimal ANSI styling. Semantic names only; components never pick raw colors.
const sgr = (open: string, close: string) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;

export const style = {
  accent: sgr("38;5;111", "39"),
  muted: sgr("38;5;245", "39"),
  faint: sgr("38;5;240", "39"),
  success: sgr("38;5;114", "39"),
  danger: sgr("38;5;203", "39"),
  bold: sgr("1", "22"),
};

export const editorTheme = {
  borderColor: style.faint,
  selectList: {
    selectedPrefix: style.accent,
    selectedText: style.accent,
    description: style.muted,
    scrollInfo: style.faint,
    noMatch: style.muted,
  },
};
