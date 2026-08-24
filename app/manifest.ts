import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AiPX Agent",
    short_name: "AiPX",
    description: "AiPX Agent — voice and chat assistant powered by Eva",
    start_url: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#f4f6fb",
    theme_color: "#18181b",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
