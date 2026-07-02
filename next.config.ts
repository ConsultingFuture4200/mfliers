import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `sharp` (used server-side in lib/fraud/dedupe.ts for the perceptual hash)
  // is a native module. Without this, Next/Turbopack tries to bundle it and
  // its platform binaries don't make it into the serverless function ("Failed
  // to load external module sharp" → 500 on the submit/sign routes). Marking
  // it external makes Next require it from node_modules at runtime and trace
  // its binaries into the deployment.
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
