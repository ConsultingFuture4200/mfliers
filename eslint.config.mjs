import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import eslintConfigPrettier from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  eslintConfigPrettier,
  // Tenant-isolation import boundary (Liotta batch-2 review;
  // docs/decisions/0001-tenant-isolation-enforcement.md). That ADR says
  // "lib/db/dal/* are the ONLY modules permitted to query the four scoped
  // tables," but until now that was enforced only by convention plus the
  // isolation suite's closed-world check over the DAL's own modules —
  // neither can catch a stray `db.select().from(targets)` written
  // directly in a future route handler or a new lib module. This makes
  // the boundary structural: only lib/db/dal/** (and lib/db/** internals
  // like client.ts/migrate.ts themselves) may import the raw db client or
  // schema modules; every other route handler / lib module must go
  // through a DAL function.
  {
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
    ignores: ["lib/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/db/client",
                "@/lib/db/schema",
                "@/lib/db/schema/*",
                "@/lib/db/schema/**",
              ],
              message:
                "Only lib/db/dal/** may import the raw db client or schema modules directly (docs/decisions/0001-tenant-isolation-enforcement.md). Add or extend a function in lib/db/dal/* instead.",
            },
          ],
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
    // Hand-authored spec/prototype artifacts, not app source.
    "docs/**",
  ]),
]);

export default eslintConfig;
