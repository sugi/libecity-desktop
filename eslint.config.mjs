import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "out/"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["src/main.ts", "src/preload.ts"],
    languageOptions: {
      globals: {
        __dirname: "readonly",
        console: "readonly",
        process: "readonly",
      },
    },
  }
);
