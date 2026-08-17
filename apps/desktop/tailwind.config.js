/** @type {import('tailwindcss').Config} */

// Colors reference the CSS custom properties defined in src/styles/globals.css.
// The `<alpha-value>` placeholder lets opacity modifiers work (e.g. `bg-accent/10`).
const withVar = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ink: {
          950: withVar("--ink-950"),
          900: withVar("--ink-900"),
          850: withVar("--ink-850"),
          800: withVar("--ink-800"),
          700: withVar("--ink-700"),
          600: withVar("--ink-600"),
        },
        fg: {
          DEFAULT: withVar("--fg"),
          muted: withVar("--fg-muted"),
          dim: withVar("--fg-dim"),
        },
        accent: {
          DEFAULT: withVar("--accent"),
          hover: withVar("--accent-hover"),
        },
        action: {
          DEFAULT: withVar("--action"),
          hover: withVar("--action-hover"),
        },
        "on-action": withVar("--on-action"),
        success: withVar("--success"),
        warning: withVar("--warning"),
        danger: withVar("--danger"),
      },
      // Same stacks as Hightower, so the suite renders in one typeface.
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "Segoe UI Variable",
          "Segoe UI",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SF Mono",
          "Menlo",
          "Geist Mono",
          "Consolas",
          "monospace",
        ],
      },
      keyframes: {
        appear: {
          "0%": { opacity: "0", transform: "translateY(8px) scale(0.995)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // Streaming caret on the in-flight assistant message.
        caret: {
          "0%, 45%": { opacity: "1" },
          "50%, 95%": { opacity: "0.15" },
          "100%": { opacity: "1" },
        },
        // Soft pulse for the "running" status dot.
        "dot-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        appear: "appear 420ms cubic-bezier(0.16, 1, 0.3, 1)",
        caret: "caret 1.1s ease-in-out infinite",
        "dot-pulse": "dot-pulse 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
