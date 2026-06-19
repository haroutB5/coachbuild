import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    // Single source of truth: package.json version. Inlined at build, shown in
    // the footer and used to version the service-worker cache (PWA).
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

export default nextConfig;
