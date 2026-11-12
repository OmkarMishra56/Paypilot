import { fileURLToPath } from "url";

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  webpack(config) {
    config.resolve.alias["@"] = fileURLToPath(new URL(".", import.meta.url));
    return config;
  },
};
