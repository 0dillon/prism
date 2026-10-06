import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the project root so a stray lockfile in a parent folder is not mistaken for it.
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
  experimental: {
    // Lets a lesson page return a real 403 with forbidden() (PRD P3-07).
    authInterrupts: true,
  },
};

export default nextConfig;
