/** @type {import('next').NextConfig} */
const isStaticExport = process.env.STATIC_EXPORT === "true";

const nextConfig = {
  reactStrictMode: true,
  // Apply the browser target to native plugins and chart dependencies too.
  transpilePackages: [
    "tailwind-merge", "recharts", "@capacitor/core", "@capacitor/app",
    "@capacitor/camera", "@capacitor/network", "@capacitor/share",
    "@capacitor/splash-screen", "@capacitor/status-bar",
  ],
  output: isStaticExport ? "export" : "standalone",
  // For output: "export", distDir is the final export directory consumed by Capacitor.
  distDir: isStaticExport ? ".next-android" : ".next",
  trailingSlash: isStaticExport ? true : false,
  images: {
    unoptimized: true,
  },
  ...(isStaticExport
    ? {}
    : {
        // Downloads send headers only after the stored object is verified.
        // Allow bounded large/slow transfers rather than Next's 30s default.
        experimental: { proxyTimeout: 300_000 },
        async rewrites() {
          const backendUrl =
            process.env.INTERNAL_BACKEND_URL ||
            process.env.NEXT_PUBLIC_API_URL ||
            "http://127.0.0.1:8000";
          return [
            {
              source: "/api/:path*",
              destination: `${backendUrl}/api/:path*`,
            },
            {
              source: "/health",
              destination: `${backendUrl}/health`,
            },
            {
              source: "/health/ready",
              destination: `${backendUrl}/health/ready`,
            },
          ];
        },
      }),
};

export default nextConfig;
