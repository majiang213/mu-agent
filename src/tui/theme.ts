import type { EditorTheme, MarkdownTheme } from '@mariozechner/pi-tui';

export const R = '\x1b[0m';
const RF = '\x1b[39m\x1b[22m\x1b[23m\x1b[29m';

export function fg(r: number, g: number, b: number) {
  return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}${R}`;
}
export function fgK(r: number, g: number, b: number) {
  return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}${RF}`;
}
export function bold(s: string) {
  return `\x1b[1m${s}\x1b[22m`;
}
export function dim(s: string) {
  return `\x1b[2m${s}\x1b[22m`;
}
export function italic(s: string) {
  return `\x1b[3m${s}\x1b[23m`;
}

export const BG_DARK = '\x1b[48;2;22;27;34m';

export const C = {
  userBar: fgK(56, 139, 253),
  userText: fgK(230, 237, 243),
  dim: fg(110, 118, 129),
  dimItalic: (s: string) => italic(fg(110, 118, 129)(s)),
  divider: fg(48, 54, 61),
  toolName: fg(110, 118, 129),
  toolArg: fg(88, 166, 255),
  ok: fg(63, 185, 80),
  err: fg(248, 81, 73),
  pending: fg(110, 118, 129),

  stateLocate: (s: string) => bold(fg(57, 211, 83)(s)),
  stateModify: (s: string) => bold(fg(210, 153, 34)(s)),
  stateVerify: (s: string) => bold(fg(63, 185, 80)(s)),
  stateDone: (s: string) => bold(fg(63, 185, 80)(s)),
  stateIdle: fg(110, 118, 129),
  headerCwd: fg(110, 118, 129),
  headerBranch: fg(63, 185, 80),
  headerModel: fg(88, 166, 255),
  headerSep: fg(48, 54, 61),
  successText: fg(63, 185, 80),
  hintKey: fg(139, 148, 158),
};

export const STATE_FN: Record<string, (s: string) => string> = {
  LOCATE: C.stateLocate,
  MODIFY: C.stateModify,
  VERIFY: C.stateVerify,
  DONE: C.stateDone,
  IDLE: C.stateIdle,
};

export function stateColor(s: string): (t: string) => string {
  return STATE_FN[s] ?? C.dim;
}

export function fillLine(content: string, width: number, visibleWidthFn: (s: string) => number): string {
  const vw = visibleWidthFn(content);
  const pad = Math.max(0, width - vw);
  return BG_DARK + content + BG_DARK + ' '.repeat(pad) + R;
}

export const markdownTheme: MarkdownTheme = {
  heading: (s) => bold(fgK(230, 237, 243)(s)),
  link: fgK(88, 166, 255),
  linkUrl: (s) => `\x1b[2m${s}\x1b[22m`,
  code: fgK(227, 179, 65),
  codeBlock: fgK(201, 209, 217),
  codeBlockBorder: (s) => `\x1b[2m${s}\x1b[22m`,
  quote: (s) => `\x1b[2m\x1b[3m${s}\x1b[23m\x1b[22m`,
  quoteBorder: (s) => `\x1b[2m${s}\x1b[22m`,
  hr: (s) => `\x1b[2m${s}\x1b[22m`,
  listBullet: (s) => `\x1b[2m${s}\x1b[22m`,
  bold: (s) => bold(s),
  italic: (s) => italic(s),
  strikethrough: (s) => `\x1b[9m${s}\x1b[29m`,
  underline: (s) => `\x1b[4m${s}\x1b[24m`,
};

export const editorTheme: EditorTheme = {
  borderColor: (s) => `\x1b[97m${s}\x1b[0m`,
  selectList: {
    selectedPrefix: fg(88, 166, 255),
    selectedText: (s) => bold(s),
    description: C.dim,
    scrollInfo: C.dim,
    noMatch: C.dim,
  },
};
