/** @type {import('next').NextConfig} */
const isStaticExport = process.env.STATIC_EXPORT === "true";

const nextConfig = {
  reactStrictMode: true,
  output: isStaticExport ? "export" : "standalone",
  trailingSlash: isStaticExport ? true : false,
  images: {
    unoptimized: true,
  },
  ...(isStaticExport
    ? {}
    : {
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
          ];
        },
      }),
};

export default nextConfig;
