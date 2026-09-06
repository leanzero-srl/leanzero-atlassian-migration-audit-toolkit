const https = require("https");
const http = require("http");
const { URL } = require("url");

class JiraDcClient {
  constructor(baseUrl, auth) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.protocol = parsed.protocol === "https:" ? https : http;
    this.hostname = parsed.hostname;
    this.port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    this.basePath = parsed.pathname.replace(/\/$/, "");

    if (auth.token) {
      this.authHeader = `Bearer ${auth.token}`;
    } else if (auth.username && auth.password) {
      this.authHeader = "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
    } else {
      throw new Error("JiraDcClient: provide either auth.token (PAT) or auth.username + auth.password");
    }
  }

  makeRequest(path, retryState = null) {
    const state = retryState || { rateLimit: 0, serverError: 0 };
    const maxRateLimitRetries = 5;
    const maxServerRetries = 8;

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

      const req = this.protocol.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 429 && state.rateLimit < maxRateLimitRetries) {
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.min(5000 * Math.pow(2, state.rateLimit), 60000);
            console.log(`  [DC] 429, retrying in ${delay / 1000}s`);
            setTimeout(() => retry({ ...state, rateLimit: state.rateLimit + 1 }), delay);
            return;
          }
          if (res.statusCode >= 500 && state.serverError < maxServerRetries) {
            const delay = Math.min(2000 * Math.pow(2, state.serverError), 60000);
            console.log(`  [DC] ${res.statusCode}, retrying in ${delay / 1000}s (attempt ${state.serverError + 1}/${maxServerRetries})`);
            setTimeout(() => retry({ ...state, serverError: state.serverError + 1 }), delay);
            return;
          }
          if (res.statusCode >= 400) {
            const err = new Error(`DC GET ${path} → ${res.statusCode}: ${data.substring(0, 300)}`);
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
          console.log(`  [DC] ${err.message}, retrying in ${delay / 1000}s`);
          setTimeout(() => retry({ ...state, serverError: state.serverError + 1 }), delay);
          return;
        }
        reject(err);
      });
      req.on("timeout", () => { req.destroy(); reject(new Error(`DC timeout: ${path}`)); });
      req.end();
    });
  }

  async getAllProjects() {
    return this.makeRequest("/rest/api/2/project");
  }

  // Streaming paginated search. Yields one issue at a time so the caller never
  // has to hold the full project array in memory (some projects have 100k+ issues
  // with inline comment/attachment data, which OOMs V8 if buffered).
  async *iterateProjectIssues(projectKey) {
    const jql = encodeURIComponent(`project = "${projectKey}" ORDER BY created ASC`);
    const fields = "summary,issuetype,status,comment,attachment";
    const pageSize = 100;
    let startAt = 0;
    let yielded = 0;
    while (true) {
      const path = `/rest/api/2/search?jql=${jql}&fields=${fields}&startAt=${startAt}&maxResults=${pageSize}`;
      const page = await this.makeRequest(path);
      const issues = page?.issues || [];
      for (const issue of issues) {
        yield issue;
        yielded++;
        if (yielded > 500000) {
          console.warn(`  [DC] safety cap 500k hit for ${projectKey}`);
          return;
        }
      }
      const total = typeof page?.total === "number" ? page.total : null;
      if (issues.length < pageSize) return;
      if (total !== null && startAt + issues.length >= total) return;
      startAt += pageSize;
    }
  }

  // Lightweight key-only listing: fields=*none + maxResults=1000 (DC allows this),
  // so we never download comment/attachment payloads during the diff phase.
  // createdBefore (e.g. "2026-05-11") restricts to issues that existed at migration time.
  // Returns { keys: Set<string>, total: number }.
  async getProjectKeys(projectKey, createdBefore) {
    let jqlStr = `project = "${projectKey}"`;
    if (createdBefore) jqlStr += ` AND created < "${createdBefore}"`;
    jqlStr += " ORDER BY created ASC";
    const jql = encodeURIComponent(jqlStr);
    const pageSize = 1000;
    const keys = new Set();
    let startAt = 0;
    let total = null;
    while (true) {
      const path = `/rest/api/2/search?jql=${jql}&fields=*none&startAt=${startAt}&maxResults=${pageSize}`;
      const page = await this.makeRequest(path);
      const issues = page?.issues || [];
      for (const i of issues) if (i.key) keys.add(i.key);
      if (typeof page?.total === "number") total = page.total;
      if (issues.length < pageSize) break;
      if (total !== null && startAt + issues.length >= total) break;
      if (keys.size > 1000000) { console.warn(`  [DC] safety cap 1M hit for ${projectKey}`); break; }
      startAt += pageSize;
    }
    return { keys, total: total !== null ? total : keys.size };
  }

  // Fetch display fields for a specific set of keys (used to enrich the small
  // truly-missing subset). Batches of 100 via `key in (...)`.
  async getIssuesByKeys(keys) {
    const fields = "summary,issuetype,status,comment,attachment";
    const out = [];
    for (let i = 0; i < keys.length; i += 100) {
      const batch = keys.slice(i, i + 100);
      const jql = encodeURIComponent(`key in (${batch.map((k) => `"${k}"`).join(",")})`);
      const path = `/rest/api/2/search?jql=${jql}&fields=${fields}&startAt=0&maxResults=100`;
      const page = await this.makeRequest(path);
      for (const issue of page?.issues || []) out.push(issue);
    }
    return out;
  }
}

module.exports = JiraDcClient;
