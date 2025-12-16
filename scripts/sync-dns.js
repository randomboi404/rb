import fs from "fs";

// Constants
const CF_API = "https://api.cloudflare.com/client/v4";
const { CF_API_TOKEN, CF_ZONE_ID, CF_DOMAIN } = process.env;

const headers = {
  Authorization: `Bearer ${CF_API_TOKEN}`,
  "Content-Type": "application/json"
};

// Get changes from file
const changes = fs.readFileSync("changes.txt", "utf8")
  .split("\n")
  .filter(Boolean)
  .map(l => {
    const [status, file] = l.split(/\s+/);
    return { status, file };
  })
  .filter(c => c.file.startsWith("domains/") && c.file.endsWith(".json"));

async function cf(path, options = {}) {
  const r = await fetch(`${CF_API}${path}`, {
    ...options,
    headers
  });
  const j = await r.json();
  if (!j.success) {
      console.error("Cloudflare API Error:", JSON.stringify(j.errors, null, 2));
      throw new Error(`Cloudflare API call failed for path: ${path}`);
  }
  return j.result;
}

// Fetch all existing records for the entire zone
async function listAllRecords() {
  const allRecords = [];
  let page = 1;
  while(true) {
      const result = await cf(`/zones/${CF_ZONE_ID}/dns_records?per_page=500&page=${page}`);
      const records = Array.isArray(result) ? result : [];
      allRecords.push(...records);
      if (records.length < 500) break;
      page++;
  }
  return allRecords;
}

async function getRecordsForSubdomain(sub, allRecords) {
    const subdomainSuffix = `${sub}.${CF_DOMAIN}`;
    // Filter records belonging to the target subdomain
    return (allRecords || []).filter(r => (r.name === subdomainSuffix || r.name.endsWith(`.${subdomainSuffix}`)) && r.type !== "NS");
}


async function deleteSubdomainRecords(sub) {
  console.log(`Deleting all records for subdomain: ${sub}`);
  const allRecords = await listAllRecords();
  const recordsToDelete = await getRecordsForSubdomain(sub, allRecords);

  for (const r of recordsToDelete) {
    console.log(`   - Deleting ${r.type} record: ${r.name}`);
    await cf(`/zones/${CF_ZONE_ID}/dns_records/${r.id}`, {
      method: "DELETE"
    });
  }
}

async function applyFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  const subdomain = data.subdomain;
  
  const allExistingRecords = await listAllRecords();
  const existingRecordsForSubdomain = await getRecordsForSubdomain(subdomain, allExistingRecords);

  // Identify records to keep, update, or create
  const recordsToKeep = new Set();

  for (const r of data.records) {
    const cfName = r.name.endsWith(CF_DOMAIN) ? r.name : `${r.name}.${CF_DOMAIN}`;
    const cfType = r.type;
    const isComplex = ["SRV", "CAA", "PTR"].includes(cfType);
    
    // Construct the payload using all optional fields (priority, ttl, data)
    const basePayload = {
      type: cfType,
      name: cfName,
      // Use 'content' for standard records, and 'data' for SRV, CAA and PTR records
      content: isComplex ? undefined : r.value,
      data: isComplex ? r.data : undefined, 
      proxied: r.proxied ?? false,
      ttl: r.ttl ?? 1,
      ...(r.priority !== undefined ? { priority: r.priority } : {}) // For MX, SRV
    };
    
    // Clean up undefined fields for a cleaner API request
    Object.keys(basePayload).forEach(key => basePayload[key] === undefined && delete basePayload[key]);

    // Check if a matching record already exists
    const match = existingRecordsForSubdomain.find(e => e.type === cfType && e.name === cfName);

    if (match) {
        recordsToKeep.add(match.id);
        
        // Only update on change
        const requiresUpdate = 
            match.content !== basePayload.content ||
            match.proxied !== basePayload.proxied ||
            match.ttl !== basePayload.ttl ||
            (match.priority !== basePayload.priority && (cfType === "MX" || cfType === "SRV")) ||
            JSON.stringify(match.data) !== JSON.stringify(basePayload.data);

        if (requiresUpdate) {
            console.log(`   - Updating existing ${cfType} record: ${cfName}`);
            await cf(`/zones/${CF_ZONE_ID}/dns_records/${match.id}`, {
                method: "PUT",
                body: JSON.stringify(basePayload)
            });
        }
    } else {
        console.log(`   - Creating new ${cfType} record: ${cfName}`);
        await cf(`/zones/${CF_ZONE_ID}/dns_records`, {
            method: "POST",
            body: JSON.stringify(basePayload)
        });
    }
  }
  
  // Delete records that are not in the new JSON
  const recordsToDelete = existingRecordsForSubdomain.filter(r => !recordsToKeep.has(r.id));

  for (const r of recordsToDelete) {
      console.log(`   - Deleting old ${r.type} record (drift cleanup): ${r.name}`);
      await cf(`/zones/${CF_ZONE_ID}/dns_records/${r.id}`, {
          method: "DELETE"
      });
  }
}

// Main Loop
for (const c of changes) {
  if (c.file.startsWith("domains/")) {
      const sub = c.file.replace("domains/", "").replace(".json", "");
      
      if (c.status === "D") {
          // File deleted: Delete all corresponding DNS records
          await deleteSubdomainRecords(sub);
      } else if (c.status === "A" || c.status === "M") {
          // File added/modified: Synchronization of records for this subdomain
          console.log(`Applying changes for subdomain: ${sub}`);
          await applyFile(c.file);
      }
  }
}
