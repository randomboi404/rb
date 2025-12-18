import fs from "fs";

// allowed DNS record types
const ALLOWED_TYPES = [
    "A",
    "AAAA",
    "CNAME",
    "TXT",
    "URL",
    "MX",
    "SRV",
    "CAA",
    "NS", // Added NS
    "DS",
    "TLSA",
];

const RESERVED_JSON_PATH = "./reserved-subdomains.json";
let RESERVED_SUBDOMAINS = [];

try {
    const reservedData = JSON.parse(fs.readFileSync(RESERVED_JSON_PATH, "utf8"));
    // Flatten all categories into one flat array of strings
    RESERVED_SUBDOMAINS = Object.values(reservedData)
        .filter(val => Array.isArray(val))
        .flat();
} catch (err) {
    console.error("⚠️ Warning: Could not load reserved-subdomains.json. Skipping reserved check.");
}

// required and allowed top-level keys
const REQUIRED_TOP_KEYS = ["user", "subdomain", "records"];
const ALLOWED_TOP_KEYS = ["user", "description", "subdomain", "records"];

// required user keys
const REQUIRED_USER_KEYS = ["username"];

// allowed keys inside each DNS record
const ALLOWED_RECORD_KEYS = [
    "type",
    "name",
    "value",
    "proxied",

    // MX
    "priority",
    "target",

    // SRV
    "weight",
    "port",

    // CAA
    "flags",
    "tag",

    // DS
    "key_tag",
    "algorithm",
    "digest_type",
    "digest",

    // TLSA
    "usage",
    "selector",
    "matching_type",
    "certificate",
];

// IPv4 validation regex
const IPV4_REGEX =
    /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

// IPv6 validation regex
const IPV6_REGEX =
    /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(::)|(([0-9a-fA-F]{1,4}:){1,7}:)|(:([0-9a-fA-F]{1,4}:){1,7})|(([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}))$/;

// Don't set any max dns records limit
const MAX_RECORDS = 0;

// exit helper
function fail(msg) {
    console.error("❌", msg);
    process.exit(1);
}

// read changed files
const files = fs
    .readFileSync("changes.txt", "utf8")
    .split("\n")
    .filter((f) => f.startsWith("domains/") && f.endsWith(".json"));

// no domain changes
if (files.length === 0) {
    process.exit(0);
}

// validate each changed domain file
for (const file of files) {
    let data;

    // First, check if the file exists
    if (!fs.existsSync(file)) {
        continue;
    }

    // parse JSON
    try {
        data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        fail(`${file}: invalid JSON`);
    }

    // validate top-level keys
    for (const key of Object.keys(data)) {
        if (!ALLOWED_TOP_KEYS.includes(key)) {
            fail(`${file}: extra top-level key "${key}"`);
        }
    }

    for (const key of REQUIRED_TOP_KEYS) {
        if (!(key in data)) {
            fail(`${file}: missing required key "${key}"`);
        }
    }

    // validate user
    if (typeof data.user !== "object" || data.user === null) {
        fail(`${file}: user must be an object`);
    }

    for (const key of REQUIRED_USER_KEYS) {
        if (!data.user[key]) {
            fail(`${file}: user.${key} is required`);
        }
    }

    // Validate subdomain
    if (!/^[a-z0-9-]+$/.test(data.subdomain)) {
        fail(`${file}: invalid subdomain format`);
    }

    // Check if subdomain is not reserved
    if (RESERVED_SUBDOMAINS.includes(data.subdomain.toLowerCase())) {
        fail(`${file}: the subdomain "${data.subdomain}" is reserved and cannot be registered`);
    }

    // filename must match subdomain
    const expectedFile = `domains/${data.subdomain}.json`;
    if (file !== expectedFile) {
        fail(`${file}: filename must match subdomain (${expectedFile})`);
    }

    // validate records
    if (!Array.isArray(data.records)) {
        fail(`${file}: records must be an array`);
    }

    if (data.records.length === 0) {
        fail(`${file}: at least one DNS record is required`);
    }

    if (MAX_RECORDS && data.records.length > MAX_RECORDS) {
        fail(`${file}: maximum ${MAX_RECORDS} DNS records allowed`);
    }

    let hasNS = false; // Track NS records
    let hasDS = false; // Track DS records

    // validate each record
    for (const r of data.records) {
        // record must be object
        if (typeof r !== "object" || r === null) {
            fail(`${file}: record must be an object`);
        }

        const type = String(r.type).toUpperCase();

        // Verify proxy
        if ("proxied" in r) {
            if (typeof r.proxied !== "boolean") fail(`${file}: 'proxied' must be a boolean`);
            if (!["A", "AAAA", "CNAME"].includes(type)) {
                fail(`${file}: 'proxied' is only allowed for A, AAAA, and CNAME records`);
            }
        }

        // NS and DS specific checks: must be at root of subdomain and cannot be proxied
        if (type === "NS" || type === "DS") {
            if (r.name !== data.subdomain) {
                fail(`${file}: ${type} records must be set on the subdomain exactly, not a child`);
            }
        }

        // validate record keys
        for (const key of Object.keys(r)) {
            if (!ALLOWED_RECORD_KEYS.includes(key)) {
                fail(`${file}: invalid record key "${key}"`);
            }
        }

        // validate record type
        if (!ALLOWED_TYPES.includes(type)) {
            fail(`${file}: unsupported record type "${r.type}"`);
        }

        // validate record name
        if (typeof r.name !== "string") {
            fail(`${file}: record name must be a string`);
        }

        if (r.name.includes("*")) {
            fail(`${file}: wildcard records are not allowed`);
        }

        if (
            r.name !== data.subdomain &&
            !r.name.endsWith(`.${data.subdomain}`)
        ) {
            fail(`${file}: record outside assigned subdomain`);
        }

        // A record
        if (type === "A") {
            if (typeof r.value !== "string") {
                fail(`${file}: A record requires string 'value'`);
            }
            if (!IPV4_REGEX.test(r.value)) {
                fail(`${file}: invalid IPv4 address`);
            }
        }

        // AAAA record
        else if (type === "AAAA") {
            if (typeof r.value !== "string") {
                fail(`${file}: AAAA record requires string 'value'`);
            }
            if (!IPV6_REGEX.test(r.value)) {
                fail(`${file}: invalid IPv6 address`);
            }
        }

        // CNAME record
        else if (type === "CNAME") {
            if (typeof r.value !== "string") {
                fail(`${file}: CNAME record requires string 'value'`);
            }
        }

        // TXT record
        else if (type === "TXT") {
            if (typeof r.value !== "string") {
                fail(`${file}: TXT record requires string 'value'`);
            }
        }

        // URL record
        else if (type === "URL") {
            if (typeof r.value !== "string") {
                fail(`${file}: URL record requires string 'value'`);
            }
        }

        // MX record
        else if (type === "MX") {
            if (typeof r.target !== "string") {
                fail(`${file}: MX record requires string 'target'`);
            }
            if (typeof r.priority !== "number" || r.priority < 0) {
                fail(`${file}: MX record requires non-negative 'priority'`);
            }
        }

        // SRV record
        else if (type === "SRV") {
            if (typeof r.priority !== "number" || r.priority < 0) {
                fail(`${file}: SRV record requires non-negative 'priority'`);
            }
            if (typeof r.weight !== "number" || r.weight < 0) {
                fail(`${file}: SRV record requires non-negative 'weight'`);
            }
            if (typeof r.port !== "number" || r.port <= 0) {
                fail(`${file}: SRV record requires positive 'port'`);
            }
            if (typeof r.target !== "string") {
                fail(`${file}: SRV record requires string 'target'`);
            }
        }

        // CAA record
        else if (type === "CAA") {
            if (typeof r.flags !== "number") {
                fail(`${file}: CAA record requires numeric 'flags'`);
            }
            if (typeof r.tag !== "string") {
                fail(`${file}: CAA record requires string 'tag'`);
            }
            if (typeof r.value !== "string") {
                fail(`${file}: CAA record requires string 'value'`);
            }
        }

        // NS record
        else if (type === "NS") {
            if (typeof r.value !== "string") {
                fail(`${file}: NS record requires string 'value'`);
            }
            hasNS = true;
        }

        // DS record
        else if (type === "DS") {
            if (typeof r.key_tag !== "number") {
                fail(`${file}: DS record requires numeric 'key_tag'`);
            }
            if (typeof r.algorithm !== "number") {
                fail(`${file}: DS record requires numeric 'algorithm'`);
            }
            if (typeof r.digest_type !== "number") {
                fail(`${file}: DS record requires numeric 'digest_type'`);
            }
            if (typeof r.digest !== "string") {
                fail(`${file}: DS record requires string 'digest'`);
            }
            hasDS = true;
        }

        // TLSA record
        else if (type === "TLSA") {
            if (typeof r.usage !== "number") {
                fail(`${file}: TLSA record requires numeric 'usage'`);
            }
            if (typeof r.selector !== "number") {
                fail(`${file}: TLSA record requires numeric 'selector'`);
            }
            if (typeof r.matching_type !== "number") {
                fail(`${file}: TLSA record requires numeric 'matching_type'`);
            }
            if (typeof r.certificate !== "string") {
                fail(`${file}: TLSA record requires string 'certificate'`);
            }
        }

        // fallback
        else {
            fail(`${file}: unreachable record type "${type}"`);
        }
    }

    if (hasDS && !hasNS) {
        fail(`${file}: DS records are useless without NS records.`);
    }
}

// success
console.log("✅ DNS JSON validation passed");
