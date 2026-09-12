import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// The backend serves the static export with a strict Content-Security-Policy:
// script-src allows only 'self' and the hashes of the inline scripts Next emits,
// with no 'unsafe-inline' or 'unsafe-eval'. Anything that injects markup or
// evaluates strings would either be blocked at runtime or open an XSS hole, so
// it is a lint error here rather than a review comment.
const MARKUP_INJECTION = [
  {
    selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]",
    message: "Render with React instead of assigning HTML strings.",
  },
  {
    selector: "CallExpression[callee.property.name=/^(insertAdjacentHTML|createContextualFragment)$/]",
    message: "Render with React instead of parsing HTML strings.",
  },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^write(ln)?$/]",
    message: "document.write injects markup outside React.",
  },
  {
    selector: "JSXOpeningElement[name.name='script']",
    message: "Inline scripts are blocked by the CSP; ship code through the bundle.",
  },
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "react/no-danger": "error",
      "react/no-danger-with-children": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-restricted-syntax": ["error", ...MARKUP_INJECTION],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/script",
              message: "Inline and third-party scripts are blocked by the CSP; ship code through the bundle.",
            },
            {
              name: "next/font/google",
              message: "No runtime or build-time font downloads; use the system stacks in globals.css.",
            },
          ],
        },
      ],
      // The pairing token must never reach console output.
      "no-console": "error",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts"]),
]);
