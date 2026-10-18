export interface Style {
  bold(text: string): string; dim(text: string): string;
}

/** Bold and dim text only for terminals that want colour; plain text everywhere else. */
export function terminalStyle(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): Style {
  const color = stream.isTTY === true && env.NO_COLOR === undefined && env.TERM !== 'dumb';
  const paint = (code: string, text: string): string => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  return { bold: text => paint('1', text), dim: text => paint('2', text) };
}
