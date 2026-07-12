import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // bench/compare is a separate workspace member (cross-library harness) with its own toolchain;
  // it uses intentional `any` for the untyped rival ECS APIs and is not part of strata's lint.
  // examples/ are separate workspace members (browser apps with their own tsconfig/toolchain).
  { ignores: ["dist/", "coverage/", "node_modules/", "bench/compare/", "examples/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // scripts/ are repo tooling run under plain Node (no TS toolchain). Unlike bench/compare
  // they guard CI behavior, so they stay linted — they just need the Node globals declared.
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The runtime deliberately uses bitwise ops on packed handles and bitsets.
      "no-bitwise": "off",
    },
  },
);
