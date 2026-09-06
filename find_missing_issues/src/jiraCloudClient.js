const https = require("https");
const { URL } = require("url");

class JiraCloudClient {
  constructor(baseUrl, apiToken) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.hostname = parsed.hostname;
    this.port = parsed.port ? Number(parsed.port) : 443;
    this.basePath = parsed.pathname.replace(/\/$/, "");
    this.authHeader = `Basic ${apiToken}`;
  }

  makeRequest(path, retryState = null) {
    const state = retryState || { rateLimit: 0, serverError: 0 };
    const maxRateLimitRetries = 5;
    const maxServerRetries = 6;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: this.port,
        path: this.basePath + path,
        method: "GET",
        headers: { Authorization: this.authHeader, Accept: "application/json" },
        timeout: 60000,
      };

      const retry = (newState) => this.makeRequest(path, newState).then(resolve).catch(reject);

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 429 && state.rateLimit < maxRateLimitRetries) {
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.min(5000 * Math.pow(2, state.rateLimit), 60000);
            console.log(`  [Cloud] 429, retrying in ${delay / 1000}s`);
            setTimeout(() => retry({ ...state, rateLimit: state.rateLimit + 1 }), delay);
            return;
          }
          if (res.statusCode >= 500 && state.serverError < maxServerRetries) {
            const delay = Math.min(2000 * Math.pow(2, state.serverError), 30000);
            console.log(`  [Cloud] ${res.statusCode}, retrying in ${delay / 1000}s (attempt ${state.serverError + 1}/${maxServerRetries})`);
            setTimeout(() => retry({ ...state, serverError: state.serverError + 1 }), delay);
            return;
          }
          if (res.statusCode >= 400) {
            const err = new Error(`Cloud GET ${path} → ${res.statusCode}: ${data.substring(0, 300)}`);
            err.statusCode = res.statusCode;
            err.responseBody = data;
            return reject(err);
          }
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      });

      req.on("error", (err) => {
        if (state.serverError < maxServerRetries) {
          const delay = 2000 * (state.serverError + 1);
          console.log(`  [Cloud] ${err.message}, retrying in ${delay / 1000}s`);
          setTimeout(() => retry({ ...state, serverError: state.serverError + 1 }), delay);
          return;
        }
        reject(err);
      });
      req.on("timeout", () => { req.destroy(); reject(new Error(`Cloud timeout: ${path}`)); });
      req.end();
    });
  }

  // Paginated search via /search/jql with nextPageToken. Returns Set of issue keys.
  // Note: the new endpoint omits `key` from the response unless at least one field
  // is requested — we ask for `summary` (smallest) purely to trigger `key` inclusion.
  async getProjectIssueKeys(projectKey) {
    const jql = encodeURIComponent(`project = "${projectKey}" ORDER BY created ASC`);
    const pageSize = 1000;
    const keys = new Set();
    let nextPageToken = null;
    while (true) {
      let path = `/rest/api/3/search/jql?jql=${jql}&fields=summary&maxResults=${pageSize}`;
      if (nextPageToken) path += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
      const page = await this.makeRequest(path);
      const issues = page?.issues || [];
      for (const i of issues) if (i.key) keys.add(i.key);
      if (page?.isLast === true || !page?.nextPageToken || issues.length === 0) break;
      nextPageToken = page.nextPageToken;
      if (keys.size > 1000000) { console.warn(`  [Cloud] safety cap 1M hit for ${projectKey}`); break; }
    }
    return keys;
  }

  // Verify whether candidate DC keys were re-created in Cloud under a NEW key with
  // the original key preserved as a Jira label (the documented backfill pattern,
  // e.g. DC ENG-90021 -> cloud ENG-96914 with label "ENG-90021").
  // Returns Map<dcKey, cloudKey> for those found. Batched via `labels in (...)`.
  async findRemappedKeys(candidateKeys) {
    const found = new Map();
    const candidateSet = new Set(candidateKeys);
    for (let i = 0; i < candidateKeys.length; i += 100) {
      const batch = candidateKeys.slice(i, i + 100);
      const jqlStr = `labels in (${batch.map((k) => `"${k}"`).join(",")})`;
      const jql = encodeURIComponent(jqlStr);
      let nextPageToken = null;
      while (true) {
        let path = `/rest/api/3/search/jql?jql=${jql}&fields=labels&maxResults=100`;
        if (nextPageToken) path += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
        const page = await this.makeRequest(path);
        const issues = page?.issues || [];
        for (const issue of issues) {
          const labels = issue.fields?.labels || [];
          for (const lb of labels) {
            if (candidateSet.has(lb) && !found.has(lb)) found.set(lb, issue.key);
          }
        }
        if (page?.isLast === true || !page?.nextPageToken || issues.length === 0) break;
        nextPageToken = page.nextPageToken;
      }
    }
    return found;
  }
}

module.exports = JiraCloudClient;
