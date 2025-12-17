import fs from "fs";

const CF_API = "https://api.cloudflare.com/client/v4";
const { CF_API_TOKEN, CF_ZONE_ID } = process.env;

const headers = {
    Authorization: `Bearer ${CF_API_TOKEN}`,
    "Content-Type": "application/json",
};

// Helpers

async function cf(path, options = {}) {
    const res = await fetch(`${CF_API}${path}`, {
        ...options,
        headers,
    });

    const json = await res.json();

    if (!json.success) {
        console.error("❌ Cloudflare API error:", JSON.stringify(json.errors, null, 2));
        throw new Error(`Cloudflare API failed: ${path}`);
    }

    return json.result;
}

// Helper to manage Redirect Rules
async function syncRedirects(sub, urlRecords, domain) {
    const hostname = `${sub}.${domain}`;
    
    // Get or Create the Redirect Ruleset
    const sets = await cf(`/zones/${CF_ZONE_ID}/rulesets`);
    let ruleset = sets.find(s => s.phase === "http_request_dynamic_redirect" && s.kind === "zone");
    
    if (!ruleset) {
        ruleset = await cf(`/zones/${CF_ZONE_ID}/rulesets`, {
            method: "POST",
            body: JSON.stringify({ name: "GitOps Redirects", kind: "zone", phase: "http_request_dynamic_redirect", rules: [] })
        });
    }

    // Fetch current rules and filter out existing ones for this hostname
    const currentRules = (await cf(`/zones/${CF_ZONE_ID}/rulesets/${ruleset.id}`)).rules || [];
    const otherRules = currentRules.filter(r => !r.expression.includes(`"${hostname}"`)); // strict quote match

    // Build new rules for this specific subdomain
    const newRules = urlRecords.map(r => ({
        description: `Redirect: ${hostname}`,
        expression: `(http.host eq "${hostname}")`,
        action: "redirect",
        action_parameters: {
            from_value: { status_code: 301, target_url: { value: r.value }, preserve_query_string: true }
        }
    }));

    // Update if changes detected
    if (otherRules.length + newRules.length !== currentRules.length || newRules.length > 0) {
        console.log(`   🔀 Syncing ${newRules.length} redirect rules`);
        await cf(`/zones/${CF_ZONE_ID}/rulesets/${ruleset.id}`, {
            method: "PUT",
            body: JSON.stringify({ rules: [...otherRules, ...newRules] })
        });
    }
}

async function listAllRecords() {
    const records = [];
    let page = 1;

    while (true) {
        const batch = await cf(
            `/zones/${CF_ZONE_ID}/dns_records?per_page=500&page=${page}`
        );
        records.push(...batch);
        if (batch.length < 500) break;
        page++;
    }

    return records;
}

function recordsForSubdomain(sub, all, domain) {
    const suffix = `${sub}.${domain}`;
    return all.filter(
        r =>
            (r.name === suffix || r.name.endsWith(`.${suffix}`)) &&
            r.type !== "NS"
    );
}

// Payload Builder

function buildPayload(r) {
    const type = r.type;

    // Intercept URL type to create dummy AAAA
    if (type === "URL") {
        return {
            type: "AAAA",
            name: r.name,
            content: "100::",
            ttl: 1,
            proxied: true
        };
    }

    const payload = {
        type,
        name: r.name,
        ttl: 1,
    };

    if (["A", "AAAA", "CNAME"].includes(type)) {
        payload.proxied = r.proxied ?? false;
    }

    if (["A", "AAAA", "CNAME", "TXT", "URL"].includes(type)) {
        payload.content = r.value;
    }

    if (type === "MX") {
        payload.content = r.target;
        payload.priority = r.priority;
    }

    if (type === "SRV") {
        payload.data = {
            service: r.name.split(".")[0],
            proto: r.name.split(".")[1],
            name: r.name.split(".").slice(2).join("."),
            priority: r.priority,
            weight: r.weight,
            port: r.port,
            target: r.target,
        };
    }

    if (type === "CAA") {
        payload.data = {
            flags: r.flags,
            tag: r.tag,
            value: r.value,
        };
    }

    if (type === "DS") {
        payload.data = {
            key_tag: r.key_tag,
            algorithm: r.algorithm,
            digest_type: r.digest_type,
            digest: r.digest,
        };
    }

    if (type === "TLSA") {
        payload.data = {
            usage: r.usage,
            selector: r.selector,
            matching_type: r.matching_type,
            certificate: r.certificate,
        };
    }

    return payload;
}

function sameRecord(existing, payload) {
    // Only compare keys present in the generated payload
    return Object.keys(payload).every(key => {
        if (key === 'data') return JSON.stringify(existing.data) === JSON.stringify(payload.data);
        return existing[key] === payload[key];
    });
}

// Sync
async function applyFile(file, domain) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const sub = data.subdomain;

    console.log(`🔄 Syncing ${sub}`);

    const all = await listAllRecords();
    const existing = recordsForSubdomain(sub, all, domain);

    const keep = new Set();

    for (const r of data.records) {
        const payload = buildPayload(r); // URL becomes AAAA here

        const match = existing.find(
            e => e.type === payload.type && e.name === payload.name
        );

        if (match) {
            keep.add(match.id);

            if (!sameRecord(match, payload)) {
                console.log(`   ✏️ Updating ${payload.type} ${payload.name}`);
                await cf(`/zones/${CF_ZONE_ID}/dns_records/${match.id}`, {
                    method: "PUT",
                    body: JSON.stringify(payload),
                });
            }
        } else {
            console.log(`   ➕ Creating ${payload.type} ${payload.name}`);
            await cf(`/zones/${CF_ZONE_ID}/dns_records`, {
                method: "POST",
                body: JSON.stringify(payload),
            });
        }
    }

    // Sync Redirect Rules after DNS is settled
    const urlRecords = data.records.filter(r => r.type === "URL");
    if (urlRecords.length > 0) {
        await syncRedirects(sub, urlRecords, domain);
    }

    // Cleanup
    for (const r of existing) {
        if (!keep.has(r.id)) {
            console.log(`   🗑️ Deleting ${r.type} ${r.name}`);
            await cf(`/zones/${CF_ZONE_ID}/dns_records/${r.id}`, {
                method: "DELETE",
            });
        }
    }
}

// Main

const { CF_DOMAIN } = process.env;

const changes = fs
    .readFileSync("changes.txt", "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => {
        const [status, file] = line.split(/\s+/);
        return { status, file };
    })
    .filter(c => c.file.startsWith("domains/") && c.file.endsWith(".json"));

for (const c of changes) {
    const sub = c.file.replace("domains/", "").replace(".json", "");

    if (c.status === "D") {
        console.log(`🔥 Removing ${sub}`);
        const all = await listAllRecords();
        const records = recordsForSubdomain(sub, all, CF_DOMAIN);

        for (const r of records) {
            await cf(`/zones/${CF_ZONE_ID}/dns_records/${r.id}`, {
                method: "DELETE",
            });
        }
        
        // Clean up redirect rules on delete
        await syncRedirects(sub, [], CF_DOMAIN);
        
    } else {
        await applyFile(c.file, CF_DOMAIN);
    }
}

console.log("✅ Cloudflare DNS sync complete");
