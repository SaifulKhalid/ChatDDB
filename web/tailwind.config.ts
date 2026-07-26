import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
    "./stores/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "var(--border-subtle)",
        input: "var(--border-default)",
        ring: "var(--accent-primary)",
        background: "var(--bg-primary)",
        foreground: "var(--text-primary)",
        secondary: {
          DEFAULT: "var(--bg-secondary)",
          foreground: "var(--text-secondary)",
        },
        sidebar: {
          DEFAULT: "var(--bg-sidebar)",
          foreground: "var(--text-secondary)",
          active: "var(--text-primary)",
        },
        card: {
          DEFAULT: "var(--bg-card)",
          foreground: "var(--text-primary)",
        },
        accent: {
          DEFAULT: "var(--accent-primary)",
          foreground: "#FFFFFF",
          secondary: "var(--accent-secondary)",
        },
        muted: {
          DEFAULT: "var(--bg-card)",
          foreground: "var(--text-muted)",
        },
        success: "var(--accent-success)",
        warning: "var(--accent-warning)",
        danger: "var(--accent-danger)",
        message: {
          user: "var(--bg-card)",
          assistant: "transparent",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ["JetBrains Mono", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        display: ["2rem", { lineHeight: "1.2", fontWeight: "600" }],
        heading: ["1.5rem", { lineHeight: "1.3", fontWeight: "600" }],
        subheading: ["1.125rem", { lineHeight: "1.4", fontWeight: "500" }],
      },
      spacing: {
        18: "4.5rem",
        88: "22rem",
        100: "25rem",
      },
      maxWidth: {
        chat: "780px",
        content: "900px",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(16px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in": {
          from: { opacity: "0", transform: "translateX(-16px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "pulse-dot": {
          "0%, 80%, 100%": { transform: "scale(0)" },
          "40%": { transform: "scale(1)" },
        },
        "cursor-blink": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.3s ease-out forwards",
        "fade-in-up": "fade-in-up 0.4s ease-out forwards",
        "slide-in": "slide-in 0.3s ease-out forwards",
        shimmer: "shimmer 2s linear infinite",
        "pulse-dot": "pulse-dot 1.4s ease-in-out infinite",
        "cursor-blink": "cursor-blink 1s step-end infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;