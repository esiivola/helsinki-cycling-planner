import { defineConfig } from "vite";

// A project page lives under /<repo>/, so the base path has to be baked in at build
// time; override it when deploying somewhere else.
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/helsinki-cycling-planner/",
  build: { target: "es2022" },
});
