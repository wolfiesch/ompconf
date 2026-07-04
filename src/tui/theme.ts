export type TuiTone = "good" | "bad" | "warn" | "info" | "muted" | "accent";

export interface TuiStyle {
  fg: string;
  bg?: string;
  bold?: boolean;
}

interface TuiThemeStyles extends Record<string, TuiStyle> {
  base: TuiStyle;
  title: TuiStyle;
  heading: TuiStyle;
  label: TuiStyle;
  value: TuiStyle;
  border: TuiStyle;
  selected: TuiStyle;
  key: TuiStyle;
  dim: TuiStyle;
}

interface TuiTheme {
  styles: TuiThemeStyles;
  tones: Record<TuiTone, TuiStyle>;
}

export const tuiTheme: TuiTheme = {
  styles: {
    base: { fg: "white", bg: "black" },
    title: { fg: "cyan", bold: true },
    heading: { fg: "white", bold: true },
    label: { fg: "white" },
    value: { fg: "cyan" },
    border: { fg: "blue" },
    selected: { fg: "black", bg: "cyan", bold: true },
    key: { fg: "yellow", bold: true },
    dim: { fg: "gray" },
  },
  tones: {
    good: { fg: "green", bold: true },
    bad: { fg: "red", bold: true },
    warn: { fg: "yellow", bold: true },
    info: { fg: "cyan" },
    muted: { fg: "gray" },
    accent: { fg: "magenta", bold: true },
  },
};

const STATUS_TONES: Record<string, TuiTone> = {
  enabled: "good",
  valid: "good",
  saved: "good",
  package: "info",
  lock: "info",
  disabled: "bad",
  invalid: "bad",
  error: "bad",
  warning: "warn",
};

const STATUS_MARKERS: Record<TuiTone, string> = {
  good: "✓",
  bad: "✕",
  warn: "!",
  info: "i",
  muted: "·",
  accent: "•",
};

export function statusTone(status: string): TuiTone {
  return STATUS_TONES[status.trim().toLowerCase()] ?? "muted";
}

export function statusMarker(status: string): string {
  return STATUS_MARKERS[statusTone(status)];
}

export function blessedToneTag(tone: TuiTone): string {
  return `${tuiTheme.tones[tone].fg}-fg`;
}
