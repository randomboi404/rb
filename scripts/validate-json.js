import fs from "fs";

// Constants
const ALLOWED_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA", "PTR"];
const REQUIRED_TOP_KEYS = ["user", "subdomain", "records"];
const ALLOWED_TOP_KEYS = ["user", "subdomain", "records"];
const REQUIRED_USER_KEYS = ["username"];

const files = fs.readFileSync("changes.txt", "utf8")
  .split("\n")
  .filter(f => f.startsWith("domains/") && f.endsWith(".json"));

if (files.length === 0) process.exit(0);

function fail(msg) {
  console.error("❌", msg);
  process.exit(1);
}

for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    fail(`${file}: invalid JSON`);
  }

  // top-level keys
  for (const key of Object.keys(data)) {
    if (!ALLOWED_TOP_KEYS.includes(key)) {
      fail(`${file}: extra top-level key "${key}"`);
    }
  }

  for (const key of REQUIRED_TOP_KEYS) {
    if (!(key in data)) fail(`${file}: missing "${key}"`);
  }

  // user
  if (typeof data.user !== "object") {
    fail(`${file}: user must be object`);
  }

  for (const k of REQUIRED_USER_KEYS) {
    if (!data.user[k]) fail(`${file}: user.${k} required`);
  }

  // subdomain
  if (!/^[a-z0-9-]+$/.test(data.subdomain)) {
    fail(`${file}: invalid subdomain`);
  }

  // records
  if (!Array.isArray(data.records)) {
    fail(`${file}: records must be array`);
  }

  for (const r of data.records) {
    const allowedKeys = ["type", "name", "value", "proxied", "priority", "data"];
    for (const k of Object.keys(r)) {
      if (!allowedKeys.includes(k)) {
        fail(`${file}: invalid record key "${k}"`);
      }
    }

    if (!ALLOWED_TYPES.includes(r.type)) {
      fail(`${file}: unsupported type ${r.type}`);
    }

    if (r.name.includes("*")) {
      fail(`${file}: wildcards not allowed`);
    }

    if (
      r.name !== data.subdomain &&
      !r.name.endsWith(`.${data.subdomain}`)
    ) {
      fail(`${file}: record outside subdomain`);
    }

    if ((r.type === "MX" || r.type === "SRV") && (typeof r.priority !== "number" || r.priority < 0)) {
      fail(`${file}: ${r.type} record requires a non-negative 'priority' number.`);
    }

    if (r.type === "SRV" || r.type === "CAA" || r.type === "PTR") {
      if (typeof r.data !== "object" || r.data === null) {
        fail(`${file}: ${r.type} record requires a 'data' object.`);
      }
    } else if (typeof r.value !== "string") {
      fail(`${file}: record value must be string for type ${r.type}`);
    }
  }
}

console.log("✅ JSON validation passed");
