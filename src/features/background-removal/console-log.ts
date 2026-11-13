// The Studio console is a flat terminal: every line is printed in arrival order,
// newest at the bottom, with a prompt glyph and a severity colour. Lines are not
// filed into categories and there are no collapsible groups. The classification
// is kept pure (no DOM) so the severity rules stay unit-testable.

export type ConsoleLevel = 'info' | 'warn' | 'error';

export interface ClassifiedLogLine {
  level: ConsoleLevel;
  text: string;
}

export function classifyLogLine(line: string): ClassifiedLogLine {
  const level: ConsoleLevel = /\bERROR\b/i.test(line)
    ? 'error'
    : /\bWARNING\b/i.test(line)
      ? 'warn'
      : 'info';
  return { level, text: line };
}
