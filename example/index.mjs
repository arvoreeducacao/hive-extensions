const firstLine = (text) => String(text || "").split("\n").map((line) => line.trim()).find(Boolean) || "";

export function mentions(mission, word) {
  const needle = String(word || "").trim().toLowerCase();
  return !!needle && firstLine(mission).toLowerCase().includes(needle);
}

export function marked(title, mark, count, loud) {
  const clean = String(title || "").trim();
  const head = `${mark} `;
  const bare = clean.startsWith(head) ? clean.slice(head.length) : clean;
  return loud ? `${head}${bare} (${count})` : `${head}${bare}`;
}

export default function example(hive) {
  hive.on("seat.title", ({ title, mission, settings }) => {
    if (settings.where !== "title" || !mentions(mission, settings.word)) return title;
    const seen = (hive.storage.get("seen") || 0) + 1;
    hive.storage.set("seen", seen);
    return marked(title, settings.mark, seen, settings.loud);
  });

  hive.on("seat.opening", async ({ body, prompt, settings }) => {
    if (settings.where !== "mission" || !mentions(prompt, settings.word)) return undefined;
    return { body: { ...body, errand: body.errand || `${settings.mark} ${firstLine(prompt)}`.slice(0, 60) }, prompt };
  });

  hive.on("routes", (on) => {
    on("GET", "/api/ext/example/seen", async () => ({ seen: hive.storage.get("seen") || 0 }));
    on("POST", "/api/ext/example/reset", async ({ body }) => {
      if (body.really !== true) throw hive.refuse(400, "send { really: true } to reset the count");
      hive.storage.remove("seen");
      return { seen: 0 };
    });
  });
}
