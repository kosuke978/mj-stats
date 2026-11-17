import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Confirmation URLs contain one-time credentials. Do not log request URLs.
  logging: { incomingRequests: false },
  turbopack: { root: path.resolve(process.cwd()) },
};

export default nextConfig;
