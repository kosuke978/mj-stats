import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Keep QA's build-time public Auth URL separate from the local stack.
  distDir: process.env.MJSTATS_QA_BUILD === "1" ? ".next-qa" : ".next",
  // Confirmation URLs contain one-time credentials. Do not log request URLs.
  logging: { incomingRequests: false },
  turbopack: { root: path.resolve(process.cwd()) },
};

export default nextConfig;
