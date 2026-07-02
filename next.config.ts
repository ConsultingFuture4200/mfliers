import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `sharp` (used server-side in lib/fraud/dedupe.ts for the perceptual hash)
  // is a native module. Without this, Next/Turbopack tries to bundle it and
  // its platform binaries don't make it into the serverless function ("Failed
  // to load external module sharp" → 500 on the submit/sign routes). Marking
  // it external makes Next require it from node_modules at runtime and trace
  // its binaries into the deployment.
  serverExternalPackages: ["sharp"],
  // pnpm keeps the real sharp/@img native files under node_modules/.pnpm/
  // behind symlinks that Next's output-file tracing doesn't follow, so the
  // libvips shared object (libvips-cpp.so, from @img/sharp-libvips-linux-x64)
  // was missing from the serverless function ("ERR_DLOPEN_FAILED"). Force
  // those real binary paths into any /api function that uses sharp.
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/.pnpm/@img+sharp-linux-x64@*/node_modules/@img/sharp-linux-x64/**",
      "./node_modules/.pnpm/@img+sharp-libvips-linux-x64@*/node_modules/@img/sharp-libvips-linux-x64/**",
    ],
  },
};

export default nextConfig;
