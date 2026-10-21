import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Oct 21 2026 (audit H12): white text on the accent orange (`bg-brand`,
  // about 3.35:1) fails WCAG AA. Filled buttons and chips with white text use
  // `bg-brand-action` (5:1+ in every theme), or the <Button> primitive.
  // The same for green and amber (Oct 21 2026, W2C): white on `bg-success` /
  // `bg-warning` is about 1.9:1 / 1.7:1; use `bg-success-action` /
  // `bg-warning-action`. Dots, bars and fills with no text keep the plain tokens.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/(^|\\s)bg-brand(\\s|$)/][value=/(^|\\s)text-(white|brand-fg)(\\s|$)/]",
          message: "White text on bg-brand fails contrast. Use bg-brand-action (or <Button>).",
        },
        {
          selector: "TemplateElement[value.raw=/(^|\\s)bg-brand(\\s|$)/][value.raw=/(^|\\s)text-(white|brand-fg)(\\s|$)/]",
          message: "White text on bg-brand fails contrast. Use bg-brand-action (or <Button>).",
        },
        {
          selector: "Literal[value=/(^|\\s)bg-(success|warning)(\\s|$)/][value=/(^|\\s)text-(white|brand-fg)(\\s|$)/]",
          message: "White text on bg-success / bg-warning fails contrast. Use bg-success-action / bg-warning-action.",
        },
        {
          selector: "TemplateElement[value.raw=/(^|\\s)bg-(success|warning)(\\s|$)/][value.raw=/(^|\\s)text-(white|brand-fg)(\\s|$)/]",
          message: "White text on bg-success / bg-warning fails contrast. Use bg-success-action / bg-warning-action.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
