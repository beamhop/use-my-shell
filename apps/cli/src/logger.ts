/** Minimal colored logger for the CLI. No dependencies. */

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const paint = (code: string, s: string): string =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const color = {
  dim: (s: string) => paint("2", s),
  bold: (s: string) => paint("1", s),
  cyan: (s: string) => paint("36", s),
  green: (s: string) => paint("32", s),
  yellow: (s: string) => paint("33", s),
  red: (s: string) => paint("31", s),
};

export const log = {
  info: (msg: string) => console.error(`${color.cyan("›")} ${msg}`),
  success: (msg: string) => console.error(`${color.green("✓")} ${msg}`),
  warn: (msg: string) => console.error(`${color.yellow("!")} ${msg}`),
  error: (msg: string) => console.error(`${color.red("✗")} ${msg}`),
  plain: (msg = "") => console.error(msg),
};
