/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      screens: { nav: "900px" },
      colors: {
        paper: "var(--paper)",
        surface: "var(--surface)",
        panel: "var(--panel)",
        ink: "var(--ink)",
        slate: "var(--slate)",
        line: "var(--line)",
        go: "var(--go)",
        "go-soft": "var(--go-soft)",
        wait: "var(--wait)",
        "wait-soft": "var(--wait-soft)",
        stop: "var(--stop)",
        "stop-soft": "var(--stop-soft)",
        accent: "var(--accent)",
        "accent-soft": "var(--accent-soft)",
      },
      fontFamily: {
        serif: ['Newsreader', 'Newsreader Fallback', 'Georgia', 'serif'],
        sans: ['IBM Plex Sans', 'Plex Fallback', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        "2xs": ["11px", "1.35"],
        xs: ["12px", "1.4"],
        sm: ["13px", "1.45"],
        base: ["14px", "1.55"],
        md: ["16px", "1.55"],
        lg: ["20px", "1.35"],
        xl: ["26px", "1.2"],
        "2xl": ["34px", "1.1"],
      },
      borderRadius: { DEFAULT: "6px", md: "6px", lg: "8px" },
      maxWidth: { content: "1200px" },
    },
  },
  plugins: [],
};
