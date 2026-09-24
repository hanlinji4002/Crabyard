/** Window background behind the renderer — matches --bg-primary in styles/claude-theme.css. */
export function windowBackground(theme: 'dark' | 'light'): string {
  return theme === 'light' ? '#faf9f5' : '#262624';
}
