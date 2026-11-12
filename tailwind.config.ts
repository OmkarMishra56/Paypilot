import type { Config } from "tailwindcss";
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: { extend: { colors: { paper: "#F3F6FA", ink: "#10243E", mist: "#5B6E86", rule: "#D5DEE9", pay: "#0B6BDB", good: "#12805C", warn: "#B45309" } } },
  plugins: [],
} satisfies Config;
