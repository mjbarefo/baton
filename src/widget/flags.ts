export interface WidgetFlags {
  color: boolean;
  maxWidth: number | undefined;
}

export function parseWidgetFlags(argv: string[]): WidgetFlags {
  let color = false;
  let maxWidth: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--color") {
      color = true;
    } else if (arg === "--max-width") {
      const raw = argv[i + 1];
      const n = Number.parseInt(raw ?? "", 10);
      if (Number.isInteger(n) && n > 0 && String(n) === raw) {
        maxWidth = n;
        i++;
      } else {
        process.stderr.write(`baton widget: invalid --max-width "${raw ?? ""}" — ignored\n`);
      }
    } else {
      process.stderr.write(`baton widget: unknown flag "${arg}" — ignored\n`);
    }
  }
  return { color, maxWidth };
}
