type Painter = (text: string) => string;

function ansi(open: string, close: string, text: string): string {
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

function rgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace(/^#/, "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

const bold: Painter & { red: Painter; greenBright: Painter } = Object.assign(
  (text: string) => ansi("1", "22", text),
  {
    red: (text: string) => ansi("1;31", "39;22", text),
    greenBright: (text: string) => ansi("1;92", "39;22", text),
  },
);

export const color = {
  dim: (text: string) => ansi("2", "22", text),
  green: (text: string) => ansi("32", "39", text),
  yellow: (text: string) => ansi("33", "39", text),
  red: (text: string) => ansi("31", "39", text),
  bold,
  hex:
    (hex: string): Painter =>
    (text: string) => {
      const { r, g, b } = rgb(hex);
      return ansi(`38;2;${r};${g};${b}`, "39", text);
    },
  blue: {
    dim: (text: string) => ansi("34;2", "39;22", text),
  },
  cyan: {
    bold: (text: string) => ansi("36;1", "39;22", text),
  },
  greenBright: (text: string) => ansi("92", "39", text),
  magenta: {
    dim: (text: string) => ansi("35;2", "39;22", text),
  },
  white: {
    dim: (text: string) => ansi("37;2", "39;22", text),
  },
};
