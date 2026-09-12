import type { NextConfig } from "next";

// Production is a static export that the FastAPI backend serves at /app, on the
// same origin as the API, so the app always calls relative paths such as
// /text-command and /events and CORS never needs to be opened.
//
// `npm run dev` serves the app at http://localhost:3000/app/ instead, so in
// development only the API paths are proxied to the backend. A static export
// has no server, so these rewrites never exist in the built app.
const isDev = process.env.NODE_ENV === "development";
const apiOrigin = process.env.IMPERIUM_API_ORIGIN ?? "http://127.0.0.1:8000";

const API_PATHS = [
  "/",
  "/text-command",
  "/confirm/:pendingId",
  "/pending",
  "/pending/:pendingId",
  "/audit",
  "/stats",
  "/events",
];

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/app",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  ...(isDev && {
    rewrites: async () =>
      API_PATHS.map((source) => ({
        source,
        destination: `${apiOrigin}${source}`,
        basePath: false as const,
      })),
  }),
};

export default nextConfig;
