import type { ITheme } from '@xterm/xterm';

// Claude warm palette (see styles/claude-theme.css): the terminal background
// matches the canvas, the cursor is clay, and the ANSI colours are warm-shifted
// so CLI output sits in the same family as the chrome around it.

export const darkTerminalTheme: ITheme = {
  background: '#262624',
  foreground: '#faf9f5',
  cursor: '#d97757',
  selectionBackground: '#d9775740',
  black: '#262624',
  red: '#d4604f',
  green: '#8fa864',
  yellow: '#d9a441',
  blue: '#6a9bcc',
  magenta: '#b77ba8',
  cyan: '#6fa5a0',
  white: '#e8e6dc',
  brightBlack: '#77756e',
  brightRed: '#e5806e',
  brightGreen: '#a6bf7a',
  brightYellow: '#e8bb63',
  brightBlue: '#8cb4dc',
  brightMagenta: '#c998bd',
  brightCyan: '#8cbdb8',
  brightWhite: '#faf9f5',
};

export const lightTerminalTheme: ITheme = {
  background: '#faf9f5',
  foreground: '#141413',
  cursor: '#c15f3c',
  selectionBackground: '#c15f3c33',
  black: '#141413',
  red: '#b8432f',
  green: '#5f7d3f',
  yellow: '#9a6b12',
  blue: '#3f6f9e',
  magenta: '#8a4f7d',
  cyan: '#3f7a74',
  white: '#6b6a64',
  brightBlack: '#87867f',
  brightRed: '#c85a45',
  brightGreen: '#6f8f4a',
  brightYellow: '#a8781c',
  brightBlue: '#4f82b3',
  brightMagenta: '#9c5f8e',
  brightCyan: '#4d8c85',
  brightWhite: '#2b2a27',
};

export function getTerminalTheme(theme: 'dark' | 'light'): ITheme {
  return theme === 'light' ? lightTerminalTheme : darkTerminalTheme;
}
