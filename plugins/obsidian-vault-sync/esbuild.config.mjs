import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

esbuild
  .build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: [
      "obsidian",
      "electron",
      "@codemirror/autocomplete",
      "@codemirror/collab",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
    ],
    platform: "browser",
    format: "cjs",
    target: "es2018",
    outfile: "main.js",
    sourcemap: prod ? false : "inline",
    minify: prod,
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        prod ? "production" : "development",
      ),
    },
  })
  .catch(() => process.exit(1));
