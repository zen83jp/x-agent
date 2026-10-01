import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // prompts/*.md を実行時に fs で読むため、サーバー関数のバンドルに含める
  outputFileTracingIncludes: {
    "/api/**/*": ["./prompts/**/*"],
  },
};

export default nextConfig;
