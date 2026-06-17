import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Pin the workspace root to this folder so the bundler ignores the stray
  // package-lock.json that lives in the home directory.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
