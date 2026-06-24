import { visibleWidth } from '@earendil-works/pi-tui';
import type { EditorTheme, MarkdownTheme } from '@earendil-works/pi-tui';

function applyBackgroundToLine(line: string, width: number, bgFn: (s: string) => string): string {
  const visibleLen = visibleWidth(line);
  const padding = ' '.repeat(Math.max(0, width - visibleLen));
  return bgFn(line + padding);
}

export const R = '\x1b[0m';
const RF = '\x1b[39m\x1b[22m\x1b[23m\x1b[29m';

export function fg(r: number, g: number, b: number) {
  return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}${R}`;
}
export function bg(r: number, g: number, b: number) {
  return (s: string) => `\x1b[48;2;${r};${g};${b}m${s}${R}`;
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
  dimK: fgK(110, 118, 129),
  dimItalic: (s: string) => italic(fg(110, 118, 129)(s)),
  divider: fg(48, 54, 61),
  toolName: fg(110, 118, 129),
  toolArg: fgK(88, 166, 255),
  ok: fgK(63, 185, 80),
  err: fgK(248, 81, 73),
  pending: fgK(110, 118, 129),

  stateLocate: (s: string) => bold(fg(57, 211, 83)(s)),
  stateModify: (s: string) => bold(fg(210, 153, 34)(s)),
  stateVerify: (s: string) => bold(fg(63, 185, 80)(s)),
  stateDone: (s: string) => bold(fg(63, 185, 80)(s)),
  stateReason: (s: string) => bold(fg(88, 166, 255)(s)),
  stateClarify: (s: string) => bold(fg(255, 166, 77)(s)),
  stateAnswer: (s: string) => bold(fg(139, 233, 253)(s)),
  stateDiagnose: (s: string) => bold(fg(255, 121, 198)(s)),
  stateReview: (s: string) => bold(fg(189, 147, 249)(s)),
  stateTestWrite: (s: string) => bold(fg(80, 200, 180)(s)),
  stateRefactorPlan: (s: string) => bold(fg(241, 196, 15)(s)),
  stateRollback: (s: string) => bold(fg(248, 81, 73)(s)),
  stateResearch: (s: string) => bold(fg(98, 209, 255)(s)),
  stateSetup: (s: string) => bold(fg(160, 214, 102)(s)),
  stateWrite: (s: string) => bold(fg(255, 145, 164)(s)),
  statePlan: (s: string) => bold(fg(147, 197, 253)(s)),
  stateSampling: (s: string) => bold(fg(255, 184, 108)(s)),
  stateIdle: fg(110, 118, 129),
  headerCwd: fg(110, 118, 129),
  headerBranch: fg(63, 185, 80),
  headerModel: fg(88, 166, 255),
  headerSep: fg(48, 54, 61),
  headerTokenUp: fg(88, 166, 255),
  headerTokenDown: fg(63, 185, 80),
  headerCtxWarn: fg(210, 153, 34),
  headerCtxCrit: fg(248, 81, 73),
  headerTier: fg(139, 148, 158),
  headerProvider: fg(110, 118, 129),
  userMsgBg: bg(52, 53, 65),
  toolPendingBg: bg(40, 40, 50),
  toolSuccessBg: bg(40, 50, 40),
  toolErrorBg: bg(60, 40, 40),
  toolOutput: fgK(128, 128, 128),
  toolTitle: fgK(230, 237, 243),
  successText: fg(63, 185, 80),
  hintKey: fg(139, 148, 158),
};

export const STATE_FN: Record<string, (s: string) => string> = {
  LOCATE: C.stateLocate,
  MODIFY: C.stateModify,
  VERIFY: C.stateVerify,
  DONE: C.stateDone,
  REASON: C.stateReason,
  CLARIFY: C.stateClarify,
  ANSWER: C.stateAnswer,
  DIAGNOSE: C.stateDiagnose,
  REVIEW: C.stateReview,
  TEST_WRITE: C.stateTestWrite,
  REFACTOR_PLAN: C.stateRefactorPlan,
  ROLLBACK: C.stateRollback,
  RESEARCH: C.stateResearch,
  SETUP: C.stateSetup,
  WRITE: C.stateWrite,
  PLAN: C.statePlan,
  IDLE: C.stateIdle,
  SAMPLING: C.stateSampling,
};

export function stateColor(s: string): (t: string) => string {
  return STATE_FN[s] ?? C.dim;
}

export function fillLine(content: string, width: number, _visibleWidthFn: (s: string) => number): string {
  return applyBackgroundToLine(content, width, (s) => BG_DARK + s);
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
