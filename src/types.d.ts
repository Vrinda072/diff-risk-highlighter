// Shared shapes for the JSDoc annotations, checked by `npm run typecheck`.
// Nothing here ships: the extension is plain JavaScript with no build step.

declare namespace Driskh {
  type Level = 'low' | 'medium' | 'high';

  /** What one detector reports. */
  interface Finding {
    severity: Level;
    reason: string;
  }

  /** The changed lines of one hunk, without +/- prefixes. */
  interface Hunk {
    filePath?: string;
    addedLines?: string[];
    removedLines?: string[];
  }

  /** What every detector is given. */
  interface HunkContext {
    filePath: string;
    addedLines: string[];
    removedLines: string[];
    isDocumentation: boolean;
    rename: Rename | null;
  }

  interface Language {
    ext: string;
    layout: 'free' | 'python' | 'lines' | 'indented';
    sameQuotes: boolean;
    slash: boolean;
    block: boolean;
    hash: boolean;
    dash: boolean;
    markup: boolean;
    unknown: boolean;
  }

  interface Token {
    type: string;
    value: string;
    line: number;
    /** Offset in the lexed text. */
    at?: number;
  }

  interface Assessment {
    level: Level;
    reason: string;
  }

  /** A hunk found on the page, with the elements the badge attaches to. */
  interface PageHunk {
    filePath: string;
    headerRow: HTMLElement;
    hunkCell: HTMLElement;
    rows: Element[];
    addedLines: string[];
    removedLines: string[];
  }

  /** What Explain returns: a sentence, or why there isn't one. */
  interface ExplainResult {
    explanation?: string;
    error?: string;
    message?: string;
    detail?: string;
  }

  interface ExplainSettings {
    provider: string;
    ollamaUrl: string;
    ollamaModel: string;
    geminiModel: string;
    anthropicModel: string;
    geminiKey?: string;
    anthropicKey?: string;
  }

  interface Rename {
    /** Every swapped name is also declared on a changed line. */
    proven: boolean;
    renames: [string, string][];
  }
}

/** Where each engine file registers itself when there is no require(). */
declare var DriskhParts: any;
declare var DiffRiskEngine: typeof import('./risk-engine.js');
declare var DriskhExplain: typeof import('./explain.js');
/** Service-worker global. */
declare function importScripts(...urls: string[]): void;
