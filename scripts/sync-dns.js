import fs from "fs";

const CF_API = "https://api.cloudflare.com/client/v4";
const { CF_API_TOKEN, CF_ZONE_ID, CF_DOMAIN } = process.env;

const headers = {
  Authorization: `Bearer ${CF_API_TOKEN}`,
  "Content-Type": "application/json"
};

const changes = fs.readFileSync("changes.txt", "utf8")
  .split("\n")
  .filter(Boolean)
  .map(l => {
    const [status, file] = l.split(/\s+/);
    return { status, file };
  })
  .filter(c => c.file.startsWith("domains/") && c.file.endsWith(".json"));

async function cf(path, options = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  return j.result;
}

async function listRecords() {
  return cf(`/zones/${CF_ZONE_ID}/dns_records?per_page=500`);
}

async function deleteSubdomain(sub) {
  const records = await listRecords();
  for (const r of records) {
    if (r.name.endsWith(`.${sub}.${CF_DOMAIN}`)) {
      await cf(`/zones/${CF_ZONE_ID}/dns_records/${r.id}`, {
        method: "DELETE"
      });
    }
  }
}

async function applyFile(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const existing = await listRecords();

  for (const r of data.records) {
    const name = `${r.name}.${CF_DOMAIN}`;
    const match = existing.find(e => e.type === r.type && e.name === name);

    const payload = {
      type: r.type === "URL" ? "A" : r.type,
      name,
      content: r.value,
      proxied: r.proxied ?? false,
      ...(r.priority ? { priority: r.priority } : {})
    };

    if (match) {
      await cf(`/zones/${CF_ZONE_ID}/dns_records/${match.id}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
    } else {
      await cf(`/zones/${CF_ZONE_ID}/dns_records`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
    }
  }
}

for (const c of changes) {
  if (c.status === "D") {
    const sub = c.file.replace("domains/", "").replace(".json", "");
    await deleteSubdomain(sub);
  }

  if (c.status === "A" || c.status === "M") {
    await applyFile(c.file);
  }
}

