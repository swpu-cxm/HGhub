export const meta = {
  id: "fixture.cache.enqueue",
  name: "Cache enqueue fixture",
  version: "1.0.0",
  protocol: 1,
  allowInsecureHttp: true,
  settings: [{ key: "baseUrl", type: "text", label: "Fixture HTTP base", default: "" }],
};
export default function (hg) {
  const episodes = [
    { id: "ep1", index: 1, label: "1" },
    { id: "ep2", index: 2, label: "2" },
    { id: "fail", index: 3, label: "fail" },
    { id: "ep4", index: 4, label: "4" },
  ];
  return {
    media: {
      getDetail() {
        return {
          id: "work",
          title: "Fixture work",
          type: "short",
          episodeCount: episodes.length,
          playlists: [{ id: "main", episodes }],
        };
      },
      resolvePlayback(args, ctx) {
        if (args.episodeId === "fail") {
          throw new hg.PluginError("NETWORK", "simulated resolve failure");
        }
        const base = hg.settings.get("baseUrl");
        if (typeof base !== "string" || !base) {
          throw new hg.PluginError("INVALID_ARGUMENT", "missing baseUrl setting");
        }
        return {
          streams: [
            {
              url: `${base}/movie.mp4?ep=${encodeURIComponent(args.episodeId || "")}`,
              format: "progressive",
              headers: { "X-Fixture-Request-Id": ctx.requestId },
            },
          ],
        };
      },
    },
  };
}