#!/usr/bin/env node

/**
 * JIRA Configuration Comparator
 *
 * A comprehensive Node.js script to compare configurations between source and target JIRA Cloud instances.
 * This script verifies differences in issue types, link types, priority schemes, issue hierarchy,
 * sprint configuration, and time tracking settings.
 *
 * Usage:
 *   node jira-config-comparator.js --source https://source-instance.atlassian.net \
 *                                   --target https://target-instance.atlassian.net \
 *                                   --email your.email@company.com \
 *                                   --token your-api-token
 *
 * Requirements:
 *   npm install node-fetch
 */

// Use native https module instead of fetch for better control
const https = require("https");
const { program } = require("commander");
const fs = require("fs").promises;
const path = require("path");

// Every list-shaped configuration area: one table drives the report sections, the
// critical summary and the closing summary, so they always describe the same diff.
const LIST_SECTIONS = [
  { configKey: "issueTypes", title: "ISSUE TYPES", summaryName: "Issue Types", itemType: "issueType", group: "core", summaryOrder: 1 },
  { configKey: "issueTypeSchemes", title: "ISSUE TYPE SCHEMES", summaryName: "Issue Type Schemes", itemType: "scheme", group: "core", summaryOrder: 2 },
  { configKey: "issueLinkTypes", title: "ISSUE LINK TYPES", summaryName: "Issue Link Types", itemType: "linkType", group: "core", summaryOrder: 3 },
  { configKey: "prioritySchemes", title: "PRIORITY SCHEMES", summaryName: "Priority Schemes", itemType: "priorityScheme", group: "core", summaryOrder: 4 },
  { configKey: "priorities", title: "PRIORITIES", summaryName: "Priorities", itemType: "priority", group: "core", summaryOrder: 5 },
  { configKey: "workflows", title: "WORKFLOWS", summaryName: "Workflows", itemType: "workflow", group: "comprehensive", summaryOrder: 7 },
  { configKey: "workflowSchemes", title: "WORKFLOW SCHEMES", summaryName: "Workflow Schemes", itemType: "workflowScheme", group: "comprehensive", summaryOrder: 8 },
  { configKey: "customFields", title: "CUSTOM FIELDS", summaryName: "Custom Fields", itemType: "customField", group: "comprehensive", summaryOrder: 9 },
  { configKey: "fieldConfigurations", title: "FIELD CONFIGURATIONS", summaryName: "Field Configurations", itemType: "fieldConfiguration", group: "comprehensive", summaryOrder: 10 },
  { configKey: "screenSchemes", title: "SCREEN SCHEMES", summaryName: "Screen Schemes", itemType: "screenScheme", group: "comprehensive", summaryOrder: 11 },
  { configKey: "permissionSchemes", title: "PERMISSION SCHEMES", summaryName: "Permission Schemes", itemType: "permissionScheme", group: "comprehensive", summaryOrder: 12 },
  { configKey: "notificationSchemes", title: "NOTIFICATION SCHEMES", summaryName: "Notification Schemes", itemType: "notificationScheme", group: "comprehensive", summaryOrder: 13 },
  { configKey: "issueSecuritySchemes", title: "ISSUE SECURITY SCHEMES", summaryName: "Issue Security Schemes", itemType: "securityScheme", group: "comprehensive", summaryOrder: 14 },
  { configKey: "projectCategories", title: "PROJECT CATEGORIES", summaryName: "Project Categories", itemType: "category", group: "comprehensive", summaryOrder: 15 },
  { configKey: "resolutions", title: "RESOLUTIONS", summaryName: "Resolutions", itemType: "resolution", group: "comprehensive", summaryOrder: 16 },
  { configKey: "statuses", title: "STATUSES", summaryName: "Statuses", itemType: "status", group: "comprehensive", summaryOrder: 17 },
];
const TIME_TRACKING_SUMMARY_ORDER = 6;

class JIRAConfigComparator {
  constructor(sourceUrl, targetUrl, email, apiToken, options = {}) {
    this.sourceUrl = sourceUrl.replace(/\/$/, "");
    this.targetUrl = targetUrl.replace(/\/$/, "");
    this.outputDir = options.outputDir || ".";
    this.options = {
      severityThreshold: options.severity || "low",
      ignoreDescriptions: options.ignoreDescriptions || false,
      businessCriticalOnly: options.businessCriticalOnly || false,
      summary: options.summary || false,
    };
    this.auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
    this.headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${this.auth}`,
    };
    this.sourceConfig = {};
    this.targetConfig = {};
  }

  // Helper method for paginated API calls
  async makePaginatedApiCall(baseUrl, endpoint, params = {}) {
    const maxResults = params.maxResults || 50;
    let startAt = params.startAt || 0;
    let allResults = [];
    let hasMore = true;

    while (hasMore) {
      // Build endpoint URL with query parameters
      let paginatedEndpoint = endpoint;
      const queryParams = {
        ...params,
        startAt,
        maxResults,
      };

      // Remove pagination params from the params object copy
      delete queryParams.startAt;
      delete queryParams.maxResults;

      // Build query string
      const queryParts = [`startAt=${startAt}`, `maxResults=${maxResults}`];
      Object.keys(queryParams).forEach((key) => {
        queryParts.push(
          `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`,
        );
      });

      // Add query string to endpoint
      const separator = endpoint.includes("?") ? "&" : "?";
      paginatedEndpoint = `${endpoint}${separator}${queryParts.join("&")}`;

      const response = await this.makeApiCall(baseUrl, paginatedEndpoint);

      if (!response) {
        break;
      }

      // Handle different response structures
      let values = [];
      let isPaginated = false;

      if (response.values && Array.isArray(response.values)) {
        values = response.values;
        isPaginated = true;
      } else if (response.issues && Array.isArray(response.issues)) {
        values = response.issues;
        isPaginated = true;
      } else if (response.views && Array.isArray(response.views)) {
        values = response.views;
        isPaginated = true;
      } else if (Array.isArray(response)) {
        // Direct array response - not paginated
        allResults = response;

        break; // Don't paginate further
      } else {
        console.warn(
          `Unexpected response structure for ${endpoint}:`,
          typeof response,
        );
        break;
      }

      allResults = allResults.concat(values);

      // Check if there are more pages (only for paginated responses)
      if (!isPaginated) {
        console.log(`Non-paginated response, ending pagination`);
        hasMore = false;
      } else if (
        response.isLast === true ||
        (response.total &&
          response.startAt + response.maxResults >= response.total) ||
        (!response.isLast && !response.total && values.length < maxResults)
      ) {
        hasMore = false;
      } else {
        startAt += maxResults;
      }

      // Safety check to prevent infinite loops
      if (startAt > 1000 || allResults.length > 1000) {
        console.warn(
          `Pagination safety limit reached for endpoint: ${endpoint}`,
        );
        break;
      }
    }

    return allResults;
  }

  async makeApiCall(
    baseUrl,
    endpoint,
    method = "GET",
    body = null,
    retryCount = 0,
    maxRetries = 5,
  ) {
    return new Promise((resolve, reject) => {
      // Parse the base URL to get hostname
      const hostname = baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");

      const options = {
        hostname: hostname,
        port: 443,
        path: endpoint,
        method: method,
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      };

      const req = https.request(options, async (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", async () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            // Handle 204 No Content
            if (res.statusCode === 204) {
              resolve({ success: true });
              return;
            }

            try {
              const parsed = data ? JSON.parse(data) : {};
              resolve(parsed);
            } catch (e) {
              resolve({ success: true });
            }
          } else if (res.statusCode === 429 && retryCount < maxRetries) {
            // Rate limited - implement exponential backoff
            const backoffTime = Math.min(1000 * Math.pow(2, retryCount), 32000);
            console.log(
              `   ⏳ Rate limited, retrying in ${backoffTime / 1000}s (attempt ${retryCount + 1}/${maxRetries})...`,
            );
            await new Promise((r) => setTimeout(r, backoffTime));

            try {
              const result = await this.makeApiCall(
                baseUrl,
                endpoint,
                method,
                body,
                retryCount + 1,
                maxRetries,
              );
              resolve(result);
            } catch (retryError) {
              reject(retryError);
            }
          } else {
            const errorText = data.substring(0, 500);
            reject(new Error(`HTTP ${res.statusCode}: ${errorText}`));
          }
        });
      });

      req.on("error", (error) => {
        reject(error);
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  // Get all issue types
  async getIssueTypes(baseUrl) {
    return await this.makeApiCall(baseUrl, "/rest/api/3/issuetype");
  }

  // Get all issue type schemes (handles both Classic and Next-Gen projects)
  async getIssueTypeSchemes(baseUrl) {
    try {
      console.log(`🔍 Fetching Issue Type Schemes from ${baseUrl}`);

      // Try Classic projects first
      const classicData = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/issuetypescheme",
      );
      const classicSchemes = classicData?.values || classicData || [];

      console.log(
        `✅ Classic Issue Type Schemes: Found ${classicSchemes.length} schemes`,
      );

      // Also try Next-Gen (Team-managed) projects approach
      const nextGenSchemes = await this.getNextGenIssueTypeSchemes(baseUrl);

      const allSchemes = [
        ...(Array.isArray(classicSchemes) ? classicSchemes : []),
        ...(nextGenSchemes || []),
      ];
      console.log(
        `✅ Total Issue Type Schemes: Found ${allSchemes.length} schemes (Classic + Next-Gen)`,
      );

      return allSchemes;
    } catch (error) {
      console.error(`❌ Error fetching Issue Type Schemes: ${error.message}`);
      console.log(`🔄 Trying alternative approach via project details...`);

      // Alternative: Extract scheme information from project details
      return await this.getIssueTypeSchemesFromProjects(baseUrl);
    }
  }

  // Get Next-Gen (Team-managed) issue type schemes
  async getNextGenIssueTypeSchemes(baseUrl) {
    try {
      console.log(`🔍 Fetching Next-Gen Issue Type Schemes from ${baseUrl}`);

      // Get all projects and filter for Next-Gen projects
      const projects = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/project/search",
      );
      const projectList = Array.isArray(projects)
        ? projects
        : projects?.values || [];
      console.log(`🔍 DEBUG: Project list length: ${projectList.length}`);

      const nextGenProjects = projectList.filter(
        (project) =>
          project.style === "next-gen" ||
          (project.projectTypeKey === "software" && !project.simplified),
      );

      console.log(`🔍 Found ${nextGenProjects.length} Next-Gen projects`);

      // For Next-Gen projects, issue types are configured at the project level
      const schemeMap = new Map();

      for (const project of nextGenProjects) {
        try {
          // Get project's issue types using correct endpoint
          const issueTypes = await this.makeApiCall(
            baseUrl,
            `/rest/api/3/issuetype/project?projectId=${project.id}`,
          );

          if (issueTypes && issueTypes.length > 0) {
            const schemeKey = `next-gen-${project.id}`;
            schemeMap.set(schemeKey, {
              id: schemeKey,
              name: `${project.name} - Next-Gen Scheme`,
              description: `Next-Gen project issue type scheme for ${project.name}`,
              isDefault: false,
              projectId: project.id,
              projectName: project.name,
              projectKey: project.key,
              issueTypes: issueTypes,
              style: "next-gen",
            });
          }
        } catch (issueTypeError) {
          console.log(
            `⚠️  Could not get issue types for Next-Gen project ${project.key}: ${issueTypeError.message}`,
          );
        }
      }

      const result = Array.from(schemeMap.values());
      console.log(
        `✅ Next-Gen Issue Type Schemes: Found ${result.length} schemes`,
      );

      return result;
    } catch (error) {
      console.error(
        `❌ Error fetching Next-Gen Issue Type Schemes: ${error.message}`,
      );
      return [];
    }
  }

  // Alternative method to get issue type schemes from project details
  async getIssueTypeSchemesFromProjects(baseUrl) {
    try {
      console.log(`🔍 Extracting Issue Type Schemes from project details`);

      // Get all projects first
      const projects = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/project/search",
      );
      const projectList = Array.isArray(projects)
        ? projects
        : projects?.values || [];

      const schemeMap = new Map();

      for (const project of projectList) {
        if (project.issueTypeScheme) {
          const schemeId = project.issueTypeScheme.id;
          if (!schemeMap.has(schemeId)) {
            // Get detailed scheme information
            try {
              const schemeDetails = await this.makeApiCall(
                baseUrl,
                `/rest/api/3/issuetypescheme/${schemeId}`,
              );
              schemeMap.set(schemeId, schemeDetails);
            } catch (schemeError) {
              // Create minimal scheme info from project data
              schemeMap.set(schemeId, {
                id: schemeId,
                name: project.issueTypeScheme.name || `Scheme ${schemeId}`,
                description: project.issueTypeScheme.description || "",
                isDefault: project.issueTypeScheme.isDefault || false,
              });
            }
          }
        }
      }

      const result = Array.from(schemeMap.values());
      console.log(
        `✅ Alternative method: Found ${result.length} issue type schemes`,
      );
      return result;
    } catch (error) {
      console.error(`❌ Alternative method also failed: ${error.message}`);
      return [];
    }
  }

  // Get all issue link types
  async getIssueLinkTypes(baseUrl) {
    const data = await this.makeApiCall(baseUrl, "/rest/api/3/issueLinkType");
    return data?.issueLinkTypes || data || [];
  }

  // Get all workflows
  async getWorkflows(baseUrl) {
    const data = await this.makeApiCall(baseUrl, "/rest/api/3/workflow");
    return data?.workflows || data || [];
  }

  // Get all workflow schemes
  async getWorkflowSchemes(baseUrl) {
    const data = await this.makePaginatedApiCall(
      baseUrl,
      "/rest/api/3/workflowscheme",
    );
    return data?.values || data || [];
  }

  // Get all custom fields
  async getCustomFields(baseUrl) {
    const data = await this.makePaginatedApiCall(baseUrl, "/rest/api/3/field");
    return data || [];
  }

  // Get all field configurations (handles both Classic and Next-Gen projects)
  async getFieldConfigurations(baseUrl) {
    try {
      console.log(`🔍 Fetching Field Configurations from ${baseUrl}`);

      // Try Classic projects first
      const classicData = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/fieldconfiguration",
      );
      const classicConfigs = classicData?.values || classicData || [];

      console.log(
        `✅ Classic Field Configurations: Found ${classicConfigs.length} configs`,
      );

      // Also try Next-Gen (Team-managed) projects approach
      const nextGenConfigs = await this.getNextGenFieldConfigurations(baseUrl);

      const allConfigs = [
        ...(Array.isArray(classicConfigs) ? classicConfigs : []),
        ...(nextGenConfigs || []),
      ];
      console.log(
        `✅ Total Field Configurations: Found ${allConfigs.length} configs (Classic + Next-Gen)`,
      );

      return allConfigs;
    } catch (error) {
      console.error(`❌ Error fetching Field Configurations: ${error.message}`);
      return [];
    }
  }

  // Get Next-Gen (Team-managed) field configurations
  async getNextGenFieldConfigurations(baseUrl) {
    try {
      console.log(`🔍 Fetching Next-Gen Field Configurations from ${baseUrl}`);

      // Get all projects and filter for Next-Gen projects
      const projects = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/project/search",
      );
      const projectList = Array.isArray(projects)
        ? projects
        : projects?.values || [];

      const nextGenProjects = projectList.filter(
        (project) =>
          project.style === "next-gen" ||
          (project.projectTypeKey === "software" && !project.simplified),
      );

      console.log(`🔍 Found ${nextGenProjects.length} Next-Gen projects`);

      // For Next-Gen projects, field configurations are simplified
      const configMap = new Map();

      for (const project of nextGenProjects) {
        try {
          // For Next-Gen projects, fields are global and not scheme-specific
          // Create a placeholder field configuration since Next-Gen doesn't use traditional field configs
          const configKey = `next-gen-fields-${project.id}`;
          configMap.set(configKey, {
            id: configKey,
            name: `${project.name} - Next-Gen Field Configuration`,
            description: `Next-Gen project uses global field configuration for ${project.name}`,
            isDefault: false,
            projectId: project.id,
            projectName: project.name,
            projectKey: project.key,
            style: "next-gen",
            note: "Next-Gen projects use global field configuration instead of scheme-based configuration",
          });
        } catch (fieldError) {
          console.log(
            `⚠️  Could not create field config for Next-Gen project ${project.key}: ${fieldError.message}`,
          );
        }
      }

      const result = Array.from(configMap.values());
      console.log(
        `✅ Next-Gen Field Configurations: Found ${result.length} configs`,
      );

      return result;
    } catch (error) {
      console.error(
        `❌ Error fetching Next-Gen Field Configurations: ${error.message}`,
      );
      return [];
    }
  }

  // Get all screen schemes (handles both Classic and Next-Gen projects)
  async getScreenSchemes(baseUrl) {
    try {
      console.log(`🔍 Fetching Screen Schemes from ${baseUrl}`);

      // Try Classic projects first
      const classicData = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/screenscheme",
      );
      const classicSchemes = classicData?.values || classicData || [];

      console.log(
        `✅ Classic Screen Schemes: Found ${classicSchemes.length} schemes`,
      );

      // Also try Next-Gen (Team-managed) projects approach
      const nextGenSchemes = await this.getNextGenScreenSchemes(baseUrl);

      const allSchemes = [
        ...(Array.isArray(classicSchemes) ? classicSchemes : []),
        ...(nextGenSchemes || []),
      ];
      console.log(
        `✅ Total Screen Schemes: Found ${allSchemes.length} schemes (Classic + Next-Gen)`,
      );

      return allSchemes;
    } catch (error) {
      console.error(`❌ Error fetching Screen Schemes: ${error.message}`);
      return [];
    }
  }

  // Get Next-Gen (Team-managed) screen schemes
  async getNextGenScreenSchemes(baseUrl) {
    try {
      console.log(`🔍 Fetching Next-Gen Screen Schemes from ${baseUrl}`);

      // Get all projects and filter for Next-Gen projects
      const projects = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/project/search",
      );
      const projectList = Array.isArray(projects)
        ? projects
        : projects?.values || [];

      const nextGenProjects = projectList.filter(
        (project) =>
          project.style === "next-gen" ||
          (project.projectTypeKey === "software" && !project.simplified),
      );

      console.log(`🔍 Found ${nextGenProjects.length} Next-Gen projects`);

      // For Next-Gen projects, screens are configured at the project level
      const schemeMap = new Map();

      for (const project of nextGenProjects) {
        try {
          // Get project's screens (this might not be directly available for Next-Gen)
          // Next-Gen projects use a different screen model, so we'll create a placeholder
          const schemeKey = `next-gen-screen-${project.id}`;
          schemeMap.set(schemeKey, {
            id: schemeKey,
            name: `${project.name} - Next-Gen Screen Configuration`,
            description: `Next-Gen project screen configuration for ${project.name}`,
            isDefault: false,
            projectId: project.id,
            projectName: project.name,
            projectKey: project.key,
            style: "next-gen",
            note: "Next-Gen projects use simplified screen configuration",
          });
        } catch (screenError) {
          console.log(
            `⚠️  Could not get screens for Next-Gen project ${project.key}: ${screenError.message}`,
          );
        }
      }

      const result = Array.from(schemeMap.values());
      console.log(`✅ Next-Gen Screen Schemes: Found ${result.length} schemes`);

      return result;
    } catch (error) {
      console.error(
        `❌ Error fetching Next-Gen Screen Schemes: ${error.message}`,
      );
      return [];
    }
  }

  // Get all permission schemes
  async getPermissionSchemes(baseUrl) {
    const data = await this.makeApiCall(
      baseUrl,
      "/rest/api/3/permissionscheme",
    );
    return data?.permissionSchemes || data || [];
  }

  // Get all notification schemes
  async getNotificationSchemes(baseUrl) {
    const data = await this.makeApiCall(
      baseUrl,
      "/rest/api/3/notificationscheme",
    );
    return data?.values || data || [];
  }

  // Get all issue security schemes
  async getIssueSecuritySchemes(baseUrl) {
    const data = await this.makeApiCall(
      baseUrl,
      "/rest/api/3/issuesecurityschemes",
    );
    return data?.issueSecuritySchemes || data || [];
  }

  // Get all project categories
  async getProjectCategories(baseUrl) {
    const data = await this.makeApiCall(baseUrl, "/rest/api/3/projectCategory");
    return data || [];
  }

  // Get all resolutions
  async getResolutions(baseUrl) {
    const data = await this.makeApiCall(baseUrl, "/rest/api/3/resolution");
    return data || [];
  }

  // Get all statuses
  async getStatuses(baseUrl) {
    const data = await this.makeApiCall(baseUrl, "/rest/api/3/status");
    return data || [];
  }

  // Get all priority schemes (handles both Classic and Next-Gen projects)
  async getPrioritySchemes(baseUrl) {
    try {
      console.log(`🔍 Fetching Priority Schemes from ${baseUrl}`);

      // Try Classic projects first
      const classicData = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/priorityscheme",
      );
      const classicSchemes = classicData?.values || classicData || [];

      console.log(
        `✅ Classic Priority Schemes: Found ${classicSchemes.length} schemes`,
      );

      // Also try Next-Gen (Team-managed) projects approach
      const nextGenSchemes = await this.getNextGenPrioritySchemes(baseUrl);

      const allSchemes = [
        ...(Array.isArray(classicSchemes) ? classicSchemes : []),
        ...(nextGenSchemes || []),
      ];
      console.log(
        `✅ Total Priority Schemes: Found ${allSchemes.length} schemes (Classic + Next-Gen)`,
      );

      return allSchemes;
    } catch (error) {
      console.error(`❌ Error fetching Priority Schemes: ${error.message}`);
      console.log(`🔄 Trying alternative approach via project details...`);

      // Alternative: Extract scheme information from project details
      return await this.getPrioritySchemesFromProjects(baseUrl);
    }
  }

  // Get Next-Gen (Team-managed) priority schemes
  async getNextGenPrioritySchemes(baseUrl) {
    try {
      console.log(`🔍 Fetching Next-Gen Priority Schemes from ${baseUrl}`);

      // Get all projects and filter for Next-Gen projects
      const projects = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/project/search",
      );
      const projectList = Array.isArray(projects)
        ? projects
        : projects?.values || [];

      const nextGenProjects = projectList.filter(
        (project) =>
          project.style === "next-gen" ||
          (project.projectTypeKey === "software" && !project.simplified),
      );

      console.log(`🔍 Found ${nextGenProjects.length} Next-Gen projects`);

      // For Next-Gen projects, priorities are configured at the project level
      const schemeMap = new Map();

      for (const project of nextGenProjects) {
        try {
          // For Next-Gen projects, priorities are global and not scheme-specific
          // Get global priorities once and reuse
          const globalPriorities = await this.makeApiCall(
            baseUrl,
            `/rest/api/3/priority`,
          );

          if (globalPriorities && globalPriorities.length > 0) {
            const schemeKey = `next-gen-priority-${project.id}`;
            schemeMap.set(schemeKey, {
              id: schemeKey,
              name: `${project.name} - Next-Gen Priority Scheme`,
              description: `Next-Gen project uses global priority scheme for ${project.name}`,
              isDefault: false,
              projectId: project.id,
              projectName: project.name,
              projectKey: project.key,
              priorities: globalPriorities,
              style: "next-gen",
              note: "Next-Gen projects use global priority configuration instead of scheme-based configuration",
            });
          }
        } catch (priorityError) {
          console.log(
            `⚠️  Could not get priorities for Next-Gen project ${project.key}: ${priorityError.message}`,
          );
        }
      }

      const result = Array.from(schemeMap.values());
      console.log(
        `✅ Next-Gen Priority Schemes: Found ${result.length} schemes`,
      );

      return result;
    } catch (error) {
      console.error(
        `❌ Error fetching Next-Gen Priority Schemes: ${error.message}`,
      );
      return [];
    }
  }

  // Alternative method to get priority schemes from project details
  async getPrioritySchemesFromProjects(baseUrl) {
    try {
      console.log(`🔍 Extracting Priority Schemes from project details`);

      // Get all projects first
      const projects = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/project/search",
      );
      const projectList = Array.isArray(projects)
        ? projects
        : projects?.values || [];

      const schemeMap = new Map();

      for (const project of projectList) {
        if (project.priorityScheme) {
          const schemeId = project.priorityScheme.id;
          if (!schemeMap.has(schemeId)) {
            // Get detailed scheme information
            try {
              const schemeDetails = await this.makeApiCall(
                baseUrl,
                `/rest/api/3/priorityscheme/${schemeId}`,
              );
              schemeMap.set(schemeId, schemeDetails);
            } catch (schemeError) {
              // Create minimal scheme info from project data
              schemeMap.set(schemeId, {
                id: schemeId,
                name:
                  project.priorityScheme.name || `Priority Scheme ${schemeId}`,
                description: project.priorityScheme.description || "",
                isDefault: project.priorityScheme.isDefault || false,
              });
            }
          }
        }
      }

      const result = Array.from(schemeMap.values());
      console.log(
        `✅ Alternative method: Found ${result.length} priority schemes`,
      );
      return result;
    } catch (error) {
      console.error(`❌ Alternative method also failed: ${error.message}`);
      return [];
    }
  }

  // Get priorities
  async getPriorities(baseUrl) {
    return await this.makeApiCall(baseUrl, "/rest/api/3/priority");
  }

  // Get issue hierarchy (project configurations)
  // onlyKeys: analyse just these project keys (the target side passes the source's
  // keys, so both sides look at the same projects even past the 100-project cap).
  async getIssueHierarchy(baseUrl, onlyKeys = null) {
    // Get all projects (this endpoint returns a direct array, not paginated)
    const projects = await this.makeApiCall(baseUrl, "/rest/api/3/project");
    if (!projects) return null;

    console.log(`Found ${projects.length} total projects`);

    // Filter for active projects only and add safety limit
    const activeProjects = projects
      .filter(
        (project) =>
          project &&
          project.key &&
          project.name &&
          !project.archived &&
          project.projectTypeKey !== "template" &&
          (!onlyKeys || onlyKeys.has(project.key)),
      )
      .slice(0, 100); // Reasonable limit for comparison

    console.log(`Analyzing ${activeProjects.length} active projects`);

    // Get all issue type schemes with project mappings
    const issueTypeSchemes = await this.makePaginatedApiCall(
      baseUrl,
      "/rest/api/3/issuetypescheme/mapping",
    );

    // Get all priority schemes
    const prioritySchemes = await this.makePaginatedApiCall(
      baseUrl,
      "/rest/api/3/priorityscheme",
    );

    const hierarchyData = [];

    // Use filtered active projects
    const projectsToAnalyze = activeProjects;
    console.log(`Analyzing ${projectsToAnalyze.length} active projects`);

    for (const project of projectsToAnalyze) {
      const projectId = project.id;
      const projectKey = project.key;

      // Get project's issue type scheme using project ID
      let issueTypes = null;
      try {
        issueTypes = await this.makePaginatedApiCall(
          baseUrl,
          `/rest/api/3/issuetypescheme/project?projectId=${projectId}`,
        );
      } catch (error) {
        // Silent fail - some projects may not have accessible issue type schemes
      }

      // Find project's priority scheme from the list
      let priorityScheme = null;
      if (prioritySchemes && Array.isArray(prioritySchemes)) {
        priorityScheme = prioritySchemes.find(
          (scheme) =>
            scheme.projects &&
            (scheme.projects.values || scheme.projects) &&
            (scheme.projects.values || scheme.projects).some(
              (proj) => proj.id === projectId,
            ),
        );
      }

      hierarchyData.push({
        projectKey,
        projectName: project.name,
        projectType: project.projectTypeKey,
        issueTypes: issueTypes || [],
        priorityScheme: priorityScheme || null,
      });
    }

    return hierarchyData;
  }

  // Get sprint configuration (JIRA Software/Agile)
  async getSprintConfiguration(baseUrl) {
    // Get all boards using modern Agile API with pagination
    const boards = await this.makePaginatedApiCall(
      baseUrl,
      "/rest/agile/1.0/board",
    );
    if (!boards) return null;

    console.log(`Found ${boards.length} boards`);

    // Every board is listed (name and type are compared for all of them); the
    // per-board configuration is fetched for the first 20 only to keep calls down.
    // Listing only the first 20 boards made two sites with >20 boards look
    // different whenever their board order differed.
    const sprintConfigs = boards.map((board) => ({
      boardId: board.id,
      boardName: board.name,
      boardType: board.type,
      sprintConfig: null,
    }));
    const boardsToAnalyze = sprintConfigs.slice(0, 20);
    console.log(`Analyzing ${boardsToAnalyze.length} board configurations`);

    for (const entry of boardsToAnalyze) {
      try {
        entry.sprintConfig = await this.makeApiCall(
          baseUrl,
          `/rest/agile/1.0/board/${entry.boardId}/configuration`,
        );
      } catch (error) {
        console.warn(
          `Could not get configuration for board ${entry.boardName} (${entry.boardId}):`,
          error.message,
        );
      }
    }

    return sprintConfigs;
  }

  // Get time tracking configuration (Time Booking settings)
  async getTimeTrackingConfiguration(baseUrl) {
    // Get main time tracking configuration
    const timeTrackingConfig = await this.makeApiCall(
      baseUrl,
      "/rest/api/3/configuration/timetracking",
    );

    // Get time tracking options
    const timeTrackingOptions = await this.makeApiCall(
      baseUrl,
      "/rest/api/3/configuration/timetracking/options",
    );

    // Get time tracking list configuration
    const timeTrackingList = await this.makeApiCall(
      baseUrl,
      "/rest/api/3/configuration/timetracking/list",
    );

    return {
      configuration: timeTrackingConfig,
      options: timeTrackingOptions,
      list: timeTrackingList,
    };
  }

  // ============================================================================
  // DATA MIGRATION VERIFICATION METHODS
  // ============================================================================

  // Helper method for paginated JQL search using nextPageToken (new endpoint)
  async makeJqlSearchWithToken(baseUrl, jql, fields = null, maxResults = 1000) {
    let allIssues = [];
    let nextPageToken = null;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore) {
      // Build endpoint with proper URL encoding
      let endpoint = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}`;

      if (fields) {
        endpoint += `&fields=${encodeURIComponent(fields)}`;
      }

      if (nextPageToken) {
        endpoint += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
      }

      try {
        const response = await this.makeApiCall(baseUrl, endpoint);

        // Check if response is valid
        if (!response) {
          console.warn(`No response received for JQL: ${jql}`);
          break;
        }

        // Check if issues array exists
        if (!response.issues || !Array.isArray(response.issues)) {
          console.warn(
            `Invalid or missing issues array in response for JQL: ${jql}`,
          );
          break;
        }

        // If we got an empty page, stop
        if (response.issues.length === 0) {
          break;
        }

        allIssues = allIssues.concat(response.issues);
        pageCount++;

        // Check if there are more pages
        if (response.nextPageToken) {
          nextPageToken = response.nextPageToken;
        } else {
          hasMore = false;
        }

        // Safety check to prevent infinite loops (max 100k issues)
        if (allIssues.length > 100000) {
          console.warn(
            `⚠️  Safety limit reached for JQL: ${jql}. Stopping at ${allIssues.length} issues after ${pageCount} pages.`,
          );
          break;
        }

        // Additional safety: max 1000 pages
        if (pageCount > 1000) {
          console.warn(
            `⚠️  Page limit reached for JQL: ${jql}. Stopping after ${pageCount} pages with ${allIssues.length} issues.`,
          );
          break;
        }
      } catch (error) {
        console.error(`❌ Error in JQL search for "${jql}": ${error.message}`);
        // Don't throw - return what we have so far to allow script to continue
        console.warn(
          `⚠️  Returning ${allIssues.length} issues collected before error`,
        );
        break;
      }
    }

    return allIssues;
  }

  // Helper to escape JQL values
  escapeJqlValue(value) {
    // Escape quotes and backslashes in JQL string values
    if (typeof value !== "string") {
      return value;
    }
    // Replace backslashes first, then quotes
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // Get issue counts per project
  async getProjectIssueCounts(baseUrl, projectKeys) {
    console.log(
      `🔍 Fetching issue counts for ${projectKeys.length} projects from ${baseUrl}`,
    );
    const counts = {};

    for (const key of projectKeys) {
      try {
        const escapedKey = this.escapeJqlValue(key);
        // Use bounded query for approximate count endpoint
        const jql = `project = "${escapedKey}" ORDER BY created DESC`;
        // Use approximate-count endpoint (POST with JSON body)
        const endpoint = `/rest/api/3/search/approximate-count`;
        const body = { jql };
        const result = await this.makeApiCall(baseUrl, endpoint, "POST", body);
        counts[key] = result?.count || 0;
        console.log(`   ✓ ${key}: ${counts[key]} issues`);
      } catch (error) {
        console.error(
          `   ✗ ${key}: Error fetching issue count - ${error.message}`,
        );
        counts[key] = -1; // Mark as error
      }
    }

    return counts;
  }

  // Get comment counts per project
  async getProjectCommentCounts(baseUrl, projectKeys) {
    console.log(
      `🔍 Fetching comment counts for ${projectKeys.length} projects from ${baseUrl}`,
    );
    const counts = {};

    for (const key of projectKeys) {
      try {
        const escapedKey = this.escapeJqlValue(key);
        // /search/jql requires bounded query - add ORDER BY
        const jql = `project = "${escapedKey}" ORDER BY created DESC`;
        // Use new /search/jql endpoint with nextPageToken for unlimited pagination
        const issues = await this.makeJqlSearchWithToken(
          baseUrl,
          jql,
          "comment",
          1000,
        );

        // Ensure issues is an array
        if (!Array.isArray(issues)) {
          console.warn(
            `   ⚠️  ${key}: Unexpected response format for comments`,
          );
          counts[key] = 0;
          continue;
        }

        let totalComments = 0;
        for (const issue of issues) {
          if (issue.fields && issue.fields.comment) {
            // Use the total field which is more accurate
            totalComments += issue.fields.comment.total || 0;
          }
        }

        counts[key] = totalComments;
        console.log(
          `   ✓ ${key}: ${totalComments} comments (from ${issues.length} issues)`,
        );
      } catch (error) {
        console.error(
          `   ✗ ${key}: Error fetching comment count - ${error.message}`,
        );
        counts[key] = -1; // Mark as error
      }
    }

    return counts;
  }

  // Get attachment counts per project
  async getProjectAttachmentCounts(baseUrl, projectKeys) {
    console.log(
      `🔍 Fetching attachment counts for ${projectKeys.length} projects from ${baseUrl}`,
    );
    const counts = {};

    for (const key of projectKeys) {
      try {
        const escapedKey = this.escapeJqlValue(key);
        // /search/jql requires bounded query - add ORDER BY
        const jql = `project = "${escapedKey}" ORDER BY created DESC`;
        // Use new /search/jql endpoint with nextPageToken for unlimited pagination
        const issues = await this.makeJqlSearchWithToken(
          baseUrl,
          jql,
          "attachment",
          1000,
        );

        // Ensure issues is an array
        if (!Array.isArray(issues)) {
          console.warn(
            `   ⚠️  ${key}: Unexpected response format for attachments`,
          );
          counts[key] = 0;
          continue;
        }

        let totalAttachments = 0;
        for (const issue of issues) {
          if (
            issue.fields &&
            issue.fields.attachment &&
            Array.isArray(issue.fields.attachment)
          ) {
            totalAttachments += issue.fields.attachment.length;
          }
        }

        counts[key] = totalAttachments;
        console.log(
          `   ✓ ${key}: ${totalAttachments} attachments (from ${issues.length} issues)`,
        );
      } catch (error) {
        console.error(
          `   ✗ ${key}: Error fetching attachment count - ${error.message}`,
        );
        counts[key] = -1; // Mark as error
      }
    }

    return counts;
  }

  // Get issue link counts per project
  async getProjectIssueLinkCounts(baseUrl, projectKeys) {
    console.log(
      `🔍 Fetching issue link counts for ${projectKeys.length} projects from ${baseUrl}`,
    );
    const counts = {};

    for (const key of projectKeys) {
      try {
        const escapedKey = this.escapeJqlValue(key);
        // /search/jql requires bounded query - add ORDER BY
        const jql = `project = "${escapedKey}" ORDER BY created DESC`;
        // Use new /search/jql endpoint with nextPageToken for unlimited pagination
        const issues = await this.makeJqlSearchWithToken(
          baseUrl,
          jql,
          "issuelinks",
          1000,
        );

        // Ensure issues is an array
        if (!Array.isArray(issues)) {
          console.warn(
            `   ⚠️  ${key}: Unexpected response format for issue links`,
          );
          counts[key] = 0;
          continue;
        }

        let totalLinks = 0;
        for (const issue of issues) {
          if (
            issue.fields &&
            issue.fields.issuelinks &&
            Array.isArray(issue.fields.issuelinks)
          ) {
            totalLinks += issue.fields.issuelinks.length;
          }
        }

        counts[key] = totalLinks;
        console.log(
          `   ✓ ${key}: ${totalLinks} issue links (from ${issues.length} issues)`,
        );
      } catch (error) {
        console.error(
          `   ✗ ${key}: Error fetching issue link count - ${error.message}`,
        );
        counts[key] = -1; // Mark as error
      }
    }

    return counts;
  }

  // Get comprehensive project data stats
  async getProjectDataStats(baseUrl, projectKeys) {
    console.log(
      `\n📊 Fetching comprehensive data stats for projects from ${baseUrl}`,
    );

    const stats = {
      issueCounts: await this.getProjectIssueCounts(baseUrl, projectKeys),
      commentCounts: await this.getProjectCommentCounts(baseUrl, projectKeys),
      attachmentCounts: await this.getProjectAttachmentCounts(
        baseUrl,
        projectKeys,
      ),
      issueLinkCounts: await this.getProjectIssueLinkCounts(
        baseUrl,
        projectKeys,
      ),
    };

    return stats;
  }

  async fetchAllConfigurations() {
    console.log("Fetching configurations from source instance...");

    this.sourceConfig = {
      issueTypes: await this.getIssueTypes(this.sourceUrl),
      issueTypeSchemes: await this.getIssueTypeSchemes(this.sourceUrl),
      issueLinkTypes: await this.getIssueLinkTypes(this.sourceUrl),
      prioritySchemes: await this.getPrioritySchemes(this.sourceUrl),
      priorities: await this.getPriorities(this.sourceUrl),
      issueHierarchy: await this.getIssueHierarchy(this.sourceUrl),
      sprintConfig: await this.getSprintConfiguration(this.sourceUrl),
      timeTrackingConfig: await this.getTimeTrackingConfiguration(
        this.sourceUrl,
      ),
      // Comprehensive configuration areas
      workflows: await this.getWorkflows(this.sourceUrl),
      workflowSchemes: await this.getWorkflowSchemes(this.sourceUrl),
      customFields: await this.getCustomFields(this.sourceUrl),
      fieldConfigurations: await this.getFieldConfigurations(this.sourceUrl),
      screenSchemes: await this.getScreenSchemes(this.sourceUrl),
      permissionSchemes: await this.getPermissionSchemes(this.sourceUrl),
      notificationSchemes: await this.getNotificationSchemes(this.sourceUrl),
      issueSecuritySchemes: await this.getIssueSecuritySchemes(this.sourceUrl),
      projectCategories: await this.getProjectCategories(this.sourceUrl),
      resolutions: await this.getResolutions(this.sourceUrl),
      statuses: await this.getStatuses(this.sourceUrl),
    };

    console.log("Fetching configurations from target instance...");

    this.targetConfig = {
      issueTypes: await this.getIssueTypes(this.targetUrl),
      issueTypeSchemes: await this.getIssueTypeSchemes(this.targetUrl),
      issueLinkTypes: await this.getIssueLinkTypes(this.targetUrl),
      prioritySchemes: await this.getPrioritySchemes(this.targetUrl),
      priorities: await this.getPriorities(this.targetUrl),
      issueHierarchy: await this.getIssueHierarchy(
        this.targetUrl,
        this.sourceConfig.issueHierarchy
          ? new Set(this.sourceConfig.issueHierarchy.map((p) => p.projectKey))
          : null,
      ),
      sprintConfig: await this.getSprintConfiguration(this.targetUrl),
      timeTrackingConfig: await this.getTimeTrackingConfiguration(
        this.targetUrl,
      ),
      // Comprehensive configuration areas
      workflows: await this.getWorkflows(this.targetUrl),
      workflowSchemes: await this.getWorkflowSchemes(this.targetUrl),
      customFields: await this.getCustomFields(this.targetUrl),
      fieldConfigurations: await this.getFieldConfigurations(this.targetUrl),
      screenSchemes: await this.getScreenSchemes(this.targetUrl),
      permissionSchemes: await this.getPermissionSchemes(this.targetUrl),
      notificationSchemes: await this.getNotificationSchemes(this.targetUrl),
      issueSecuritySchemes: await this.getIssueSecuritySchemes(this.targetUrl),
      projectCategories: await this.getProjectCategories(this.targetUrl),
      resolutions: await this.getResolutions(this.targetUrl),
      statuses: await this.getStatuses(this.targetUrl),
    };

    // Get project keys from source (only compare projects that came from source)
    const sourceProjectKeys = this.sourceConfig.issueHierarchy
      ? this.sourceConfig.issueHierarchy.map((p) => p.projectKey)
      : [];

    if (sourceProjectKeys.length > 0) {
      console.log(
        `\n📊 Fetching project data statistics for ${sourceProjectKeys.length} source projects...`,
      );

      // Fetch data stats for source projects
      this.sourceConfig.projectDataStats = await this.getProjectDataStats(
        this.sourceUrl,
        sourceProjectKeys,
      );

      // Fetch data stats for same projects on target (filtering out pre-existing target data)
      this.targetConfig.projectDataStats = await this.getProjectDataStats(
        this.targetUrl,
        sourceProjectKeys,
      );
    } else {
      console.log("\n⚠️  No projects found to analyze for data statistics");
    }
  }

  compareLists(sourceList, targetList, keyField, nameField, itemType = "") {
    const sourceItems = new Map();
    const targetItems = new Map();

    // Ensure we have arrays, handle cases where API returns null or objects
    const sourceArray = Array.isArray(sourceList)
      ? sourceList
      : sourceList && sourceList.values
        ? sourceList.values
        : [];
    const targetArray = Array.isArray(targetList)
      ? targetList
      : targetList && targetList.values
        ? targetList.values
        : [];

    // Enhanced logic to handle duplicate names and missing names
    (sourceArray || []).forEach((item) => {
      const key = this.getComparisonKey(item, keyField, nameField);
      if (key) {
        // If key already exists, store as array to handle duplicates
        if (sourceItems.has(key)) {
          const existing = sourceItems.get(key);
          if (Array.isArray(existing)) {
            existing.push(item);
          } else {
            sourceItems.set(key, [existing, item]);
          }
        } else {
          sourceItems.set(key, item);
        }
      }
    });

    (targetArray || []).forEach((item) => {
      const key = this.getComparisonKey(item, keyField, nameField);
      if (key) {
        // If key already exists, store as array to handle duplicates
        if (targetItems.has(key)) {
          const existing = targetItems.get(key);
          if (Array.isArray(existing)) {
            existing.push(item);
          } else {
            targetItems.set(key, [existing, item]);
          }
        } else {
          targetItems.set(key, item);
        }
      }
    });

    const sourceKeys = new Set(sourceItems.keys());
    const targetKeys = new Set(targetItems.keys());

    const asGroup = (entry) => (Array.isArray(entry) ? entry : [entry]);
    const missingInTarget = [];
    const extraInTarget = [];
    const differences = [];

    for (const key of sourceKeys) {
      if (!targetKeys.has(key)) missingInTarget.push(...asGroup(sourceItems.get(key)));
    }
    for (const key of targetKeys) {
      if (!sourceKeys.has(key)) extraInTarget.push(...asGroup(targetItems.get(key)));
    }

    const commonKeys = [...sourceKeys].filter((key) => targetKeys.has(key));

    for (const key of commonKeys) {
      // Several items can share a name (team-managed projects each carry their own
      // "Bug", "In Review", ...). Pair each source item with ONE target item instead
      // of comparing every source item with every target item, which reported
      // same-named siblings as differences even when a site was compared with itself.
      const { pairs, unmatchedSource, unmatchedTarget } = this.pairItems(
        asGroup(sourceItems.get(key)),
        asGroup(targetItems.get(key)),
        itemType,
      );
      missingInTarget.push(...unmatchedSource);
      extraInTarget.push(...unmatchedTarget);

      for (const [sItem, tItem] of pairs) {
        // Check for meaningful differences with severity scoring
        const diffResult = this.hasMeaningfulDifferencesWithSeverity(
          sItem,
          tItem,
          keyField,
          itemType,
        );

        if (diffResult.hasDifferences) {
          // Filter by severity threshold if specified
          if (this.options.severityThreshold) {
            const thresholdOrder = {
              low: 1,
              medium: 2,
              high: 3,
              critical: 4,
            };
            const diffOrder = thresholdOrder[diffResult.severity] || 0;
            const thresholdOrderVal =
              thresholdOrder[this.options.severityThreshold] || 0;

            if (diffOrder < thresholdOrderVal) {
              continue; // Skip this difference as it's below threshold
            }
          }

          differences.push({
            key,
            name: sItem[nameField] || key,
            sourceId: sItem.id,
            targetId: tItem.id,
            source: this.cleanItemEnhanced(sItem, itemType),
            target: this.cleanItemEnhanced(tItem, itemType),
            severity: diffResult.severity,
            reason: diffResult.reason,
            importance: this.categorizeItemImportance(sItem, itemType),
          });
        }
      }
    }

    return {
      missingInTarget,
      extraInTarget,
      differences,
      sourceCount: sourceArray.length,
      targetCount: targetArray.length,
    };
  }

  // Pair the items that share one comparison key (name). Identical items pair first
  // (so a site compared with itself, or an unchanged migration, yields no
  // difference); the rest pair by fewest differing fields; whatever is left over is
  // genuinely missing in target (source side) or extra in target (target side).
  pairItems(sourceGroup, targetGroup, itemType = "") {
    const signature = (item) =>
      this.stableStringify(this.cleanItemEnhanced(item, itemType));
    const targetSigs = targetGroup.map(signature);
    const usedTarget = new Set();
    const pairs = [];
    const leftoverSource = [];

    sourceGroup.forEach((sItem) => {
      const sig = signature(sItem);
      const j = targetSigs.findIndex(
        (tSig, idx) => !usedTarget.has(idx) && tSig === sig,
      );
      if (j >= 0) {
        usedTarget.add(j);
        pairs.push([sItem, targetGroup[j]]);
      } else {
        leftoverSource.push(sItem);
      }
    });

    // Closest remaining pairs first; ties keep the API order (stable sort).
    const candidates = [];
    leftoverSource.forEach((sItem, si) => {
      targetGroup.forEach((tItem, ti) => {
        if (usedTarget.has(ti)) return;
        candidates.push({
          si,
          ti,
          score: this.countDifferingFields(sItem, tItem, itemType),
        });
      });
    });
    candidates.sort((a, b) => a.score - b.score);
    const usedSource = new Set();
    for (const { si, ti } of candidates) {
      if (usedSource.has(si) || usedTarget.has(ti)) continue;
      usedSource.add(si);
      usedTarget.add(ti);
      pairs.push([leftoverSource[si], targetGroup[ti]]);
    }

    return {
      pairs,
      unmatchedSource: leftoverSource.filter((_, si) => !usedSource.has(si)),
      unmatchedTarget: targetGroup.filter((_, ti) => !usedTarget.has(ti)),
    };
  }

  countDifferingFields(sourceItem, targetItem, itemType = "") {
    const s = this.cleanItemEnhanced(sourceItem, itemType);
    const t = this.cleanItemEnhanced(targetItem, itemType);
    let count = 0;
    for (const field of new Set([...Object.keys(s), ...Object.keys(t)])) {
      if (this.stableStringify(s[field]) !== this.stableStringify(t[field])) {
        count++;
      }
    }
    return count;
  }

  // JSON with sorted object keys, so the order in which an API returns fields never
  // counts as a difference.
  stableStringify(value) {
    if (value === undefined) return "undefined";
    if (Array.isArray(value)) {
      return `[${value.map((v) => this.stableStringify(v)).join(",")}]`;
    }
    if (value && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${this.stableStringify(value[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  // Nested objects carry site-specific links too (statusCategory.self, avatar URLs):
  // drop "self" keys and URL strings at every depth. Nested ids are kept.
  cleanNested(value) {
    if (Array.isArray(value)) return value.map((v) => this.cleanNested(v));
    if (value && typeof value === "object") {
      const out = {};
      for (const k of Object.keys(value)) {
        const v = value[k];
        if (k === "self") continue;
        if (typeof v === "string" && /https?:\/\//.test(v)) continue;
        out[k] = this.cleanNested(v);
      }
      return out;
    }
    return value;
  }

  getComparisonKey(item, keyField, nameField) {
    // Try the primary key field first
    let key = item[keyField];

    // If key is missing or empty, try the name field
    if (!key && nameField && item[nameField]) {
      key = item[nameField];
    }

    // If still no key, try ID as fallback
    if (!key && item.id) {
      key = item.id;
    }

    // Normalize key for consistent comparison (trim whitespace, lowercase for names)
    if (typeof key === "string") {
      key = key.trim();
      // Only lowercase if we're comparing by name (not ID)
      if (keyField === "name" || nameField === "name") {
        key = key.toLowerCase();
      }
    }

    return key;
  }

  hasMeaningfulDifferences(sourceItem, targetItem, keyField) {
    // Since cleanItem already removes problematic fields, just compare the cleaned items
    return JSON.stringify(sourceItem) !== JSON.stringify(targetItem);
  }

  // Enhanced cleaning method to remove migration artifacts
  cleanItemEnhanced(item, itemType = "") {
    if (!item || typeof item !== "object") return item;

    const cleaned = {};
    Object.keys(item).forEach((key) => {
      // Remove fields that cause false differences between instances
      const fieldsToIgnore = [
        "self",
        "expand",
        "id",
        "iconUrl",
        "avatarId",
        "untranslatedName",
        "scope", // Contains project-specific IDs that will differ
        // Workflow metadata that always changes during migration
        "lastModifiedDate",
        "lastModifiedUser",
        "lastModifiedUserAccountId",
        "createdDate",
        "createdUser",
        "createdUserAccountId",
      ];

      if (!fieldsToIgnore.includes(key)) {
        let value = item[key];

        // Handle different data types
        if (typeof value === "string") {
          // Remove migration timestamp patterns
          value = value.replace(
            /\s*\(Migrated on \d{1,2} [A-Za-z]{3} \d{4} \d{1,2}:\d{2}:\d{2} [A-Z]{3,4}\)\s*/g,
            "",
          );

          // Remove any URLs
          if (value.includes("http")) {
            return; // Skip URL fields entirely
          }

          // Normalize whitespace
          value = value.trim().replace(/\s+/g, " ");

          // For custom field names, normalize ID patterns
          if (key === "name" && itemType === "customField") {
            value = value.replace(/\s*\(ID:\s*[^)]+\)\s*/g, "");
          }
        }

        // For custom field IDs, normalize to generic pattern
        if (
          key === "key" &&
          typeof value === "string" &&
          value.includes("customfield_")
        ) {
          value = "customfield_[ID]";
        }

        if (value && typeof value === "object") {
          value = this.cleanNested(value);
        }

        cleaned[key] = value;
      }
    });
    return cleaned;
  }

  // Check if differences are benign (expected migration artifacts)
  isBenignDifference(sourceValue, targetValue, field) {
    // Workflow metadata that always changes during migration
    if (
      [
        "lastModifiedDate",
        "lastModifiedUser",
        "lastModifiedUserAccountId",
        "createdDate",
        "createdUser",
        "createdUserAccountId",
      ].includes(field)
    ) {
      return true;
    }

    if (typeof sourceValue !== "string" || typeof targetValue !== "string") {
      return false;
    }

    // Check for migration timestamp additions
    const sourceClean = sourceValue
      .replace(/\s*\(Migrated on [^)]+\)\s*/g, "")
      .trim();
    const targetClean = targetValue
      .replace(/\s*\(Migrated on [^)]+\)\s*/g, "")
      .trim();

    if (sourceClean === targetClean) {
      return true; // Only difference is migration timestamp
    }

    // Check for custom field ID differences
    if (
      field === "key" &&
      sourceValue.match(/customfield_\d+/) &&
      targetValue.match(/customfield_\d+/)
    ) {
      return true; // Custom field ID reassignment is expected
    }

    // Check for user account ID differences (expected in migration)
    if (
      field.includes("AccountId") &&
      sourceValue.match(/712020:[a-f0-9-]{36}/) &&
      targetValue.match(/712020:[a-f0-9-]{36}/)
    ) {
      return true;
    }

    return false;
  }

  // Categorize item importance for severity scoring
  categorizeItemImportance(item, itemType) {
    if (!item || !item.name) return "low";
    const name = item.name.toLowerCase();

    switch (itemType) {
      case "project":
        // LOW priority projects
        if (
          name.includes("test") ||
          name.includes("demo") ||
          name.includes("archive") ||
          name.includes("old") ||
          name.includes("sandbox") ||
          name.includes("sample") ||
          name.includes("example") ||
          // Personal projects - look for single person names in parentheses
          (/^[^(]+\([^)]*\)$/.test(item.name) &&
            (name.includes("garnett") ||
              name.includes("dan") ||
              /^[a-z]+\s+[a-z]+$/i.test(item.name.split("(")[0].trim()))) ||
          // Internal tools and utilities
          name.includes("toolbox") ||
          name.includes("utility") ||
          name.includes("internal") ||
          name.includes("productivity") ||
          // Vendor/partner projects
          name.includes("expleo") ||
          name.includes("forvia") ||
          name.includes("vendor")
        ) {
          return "low";
        }
        // CRITICAL projects - core business functions
        if (
          name.includes("security") ||
          name.includes("control") ||
          name.includes("system") ||
          name.includes("software") ||
          name.includes("hardware") ||
          name.includes("customer") ||
          name.includes("electric") ||
          name.includes("electronic") ||
          name.includes("diagnostic") ||
          name.includes("validation") ||
          name.includes("durability") ||
          name.includes("emissions") ||
          name.includes("safety")
        ) {
          return "critical";
        }
        // HIGH priority projects - important but not core business
        if (
          name.includes("development") ||
          name.includes("engineering") ||
          name.includes("procurement") ||
          name.includes("marketing") ||
          name.includes("product") ||
          name.includes("integration") ||
          name.includes("architecture") ||
          name.includes("network")
        ) {
          return "high";
        }
        return "medium";

      case "issueType":
        // Critical system issue types
        if (
          name.includes("incident") ||
          name.includes("service request") ||
          name.includes("approval") ||
          name.includes("bug") ||
          name.includes("fault") ||
          name.includes("epic")
        ) {
          return "critical";
        }
        if (
          name.includes("subtask") ||
          name.includes("task") ||
          name.includes("story")
        ) {
          return "high";
        }
        return "medium";

      case "customField":
        // Business-critical custom fields
        if (
          name.includes("product area") ||
          name.includes("roadmap") ||
          name.includes("impact") ||
          name.includes("value") ||
          name.includes("customer") ||
          name.includes("project") ||
          name.includes("uuid") ||
          name.includes("approval")
        ) {
          return "critical";
        }
        if (
          name.includes("tooltip") ||
          name.includes("message") ||
          name.includes("note")
        ) {
          return "low";
        }
        return "medium";

      case "workflow":
        // Critical workflows
        if (name.includes("simplified workflow")) {
          return "low"; // Auto-generated workflows
        }
        if (
          name.includes("copy of") ||
          name.includes("backup") ||
          name.includes("test")
        ) {
          return "low";
        }
        if (
          name.includes("approval") ||
          name.includes("security") ||
          name.includes("incident")
        ) {
          return "critical";
        }
        return "high";

      default:
        return "medium";
    }
  }

  // Enhanced comparison with severity scoring
  hasMeaningfulDifferencesWithSeverity(
    sourceItem,
    targetItem,
    keyField,
    itemType = "",
  ) {
    const sourceClean = this.cleanItemEnhanced(sourceItem, itemType);
    const targetClean = this.cleanItemEnhanced(targetItem, itemType);

    // Check for differences (key order of the API response is not a difference)
    const sourceStr = this.stableStringify(sourceClean);
    const targetStr = this.stableStringify(targetClean);

    if (sourceStr === targetStr) {
      return {
        hasDifferences: false,
        severity: "none",
        reason: "No meaningful differences",
      };
    }

    // Analyze what fields differ
    const sourceFields = new Set(Object.keys(sourceClean));
    const targetFields = new Set(Object.keys(targetClean));
    const allFields = new Set([...sourceFields, ...targetFields]);

    let maxSeverity = "low";
    const reasons = [];

    allFields.forEach((field) => {
      const sourceValue = sourceClean[field];
      const targetValue = targetClean[field];

      if (
        this.stableStringify(sourceValue) !== this.stableStringify(targetValue)
      ) {
        // Check if this is a benign difference
        if (this.isBenignDifference(sourceValue, targetValue, field)) {
          reasons.push(`${field}: benign difference (migration artifact)`);
        } else {
          // Determine severity based on field and item type
          let fieldSeverity = "medium";

          if (field === "description" && this.options.ignoreDescriptions) {
            return; // Skip description differences if requested
          }

          if (field === "description") {
            fieldSeverity = "low";
          } else if (field === "key" && itemType === "customField") {
            fieldSeverity = "low"; // Custom field ID changes are expected
          } else if (["name", "fieldType", "type"].includes(field)) {
            fieldSeverity = "high";
          } else if (["scope", "required", "default"].includes(field)) {
            fieldSeverity = "medium";
          } else if (
            [
              "lastModifiedDate",
              "lastModifiedUser",
              "lastModifiedUserAccountId",
              "createdDate",
              "createdUser",
              "createdUserAccountId",
            ].includes(field)
          ) {
            fieldSeverity = "low"; // Workflow metadata changes are expected during migration
          }

          // Upgrade severity based on item importance
          const itemImportance = this.categorizeItemImportance(
            sourceItem,
            itemType,
          );
          if (itemImportance === "critical") {
            fieldSeverity = "critical";
          } else if (
            itemImportance === "high" &&
            fieldSeverity !== "critical"
          ) {
            fieldSeverity = "high";
          }

          reasons.push(`${field}: ${fieldSeverity} severity`);
          maxSeverity = this.getHigherSeverity(maxSeverity, fieldSeverity);
        }
      }
    });

    if (reasons.length === 0) {
      // Every differing field was skipped (e.g. --ignore-descriptions)
      return {
        hasDifferences: false,
        severity: "none",
        reason: "No meaningful differences",
      };
    }

    return {
      hasDifferences: true,
      severity: maxSeverity,
      reason: reasons.join("; "),
    };
  }

  // Helper to get higher severity
  getHigherSeverity(sev1, sev2) {
    const severityOrder = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
    return severityOrder[sev1] >= severityOrder[sev2] ? sev1 : sev2;
  }

  cleanItem(item) {
    if (!item || typeof item !== "object") return item;

    const cleaned = {};
    Object.keys(item).forEach((key) => {
      // Remove fields that cause false differences between instances
      const fieldsToIgnore = [
        "self",
        "expand",
        "id",
        "iconUrl",
        "avatarId",
        "untranslatedName",
        "scope", // Contains project-specific IDs that will differ
      ];

      if (!fieldsToIgnore.includes(key)) {
        // Also remove any URL fields (they will always be different between instances)
        if (typeof item[key] === "string" && item[key].includes("http")) {
          return; // Skip URL fields
        }
        cleaned[key] = item[key];
      }
    });
    return cleaned;
  }

  formatConfigSection(
    title,
    comparisonResult,
    itemType = this.getItemTypeFromTitle(title),
  ) {
    const output = [
      `\n${"=".repeat(60)}`,
      title,
      "=".repeat(60),
      `Source: ${comparisonResult.sourceCount} items`,
      `Target: ${comparisonResult.targetCount} items`,
    ];

    // Group missing items by importance
    const missingCritical = [];
    const missingHigh = [];
    const missingMedium = [];
    const missingLow = [];

    comparisonResult.missingInTarget.forEach((item) => {
      const importance = this.categorizeItemImportance(item, itemType);
      const name = item.name || item.id || "Unknown";
      const itemWithImportance = { name, id: item.id || "N/A", importance };

      // Debug output for project categorization
      if (itemType === "project") {
        console.log(
          `🔍 DEBUG: Project "${name}" categorized as ${importance} priority`,
        );
      }

      switch (importance) {
        case "critical":
          missingCritical.push(itemWithImportance);
          break;
        case "high":
          missingHigh.push(itemWithImportance);
          break;
        case "medium":
          missingMedium.push(itemWithImportance);
          break;
        case "low":
          missingLow.push(itemWithImportance);
          break;
      }
    });

    // Display missing items by severity
    if (missingCritical.length > 0) {
      output.push(
        `\n🚨 CRITICAL MISSING IN TARGET (${missingCritical.length} items):`,
      );
      missingCritical.forEach((item) => {
        output.push(`   - ${item.name} (ID: ${item.id})`);
      });
    }

    if (missingHigh.length > 0 && !this.options.businessCriticalOnly) {
      output.push(
        `\n❌ HIGH PRIORITY MISSING IN TARGET (${missingHigh.length} items):`,
      );
      missingHigh.forEach((item) => {
        output.push(`   - ${item.name} (ID: ${item.id})`);
      });
    }

    if (missingMedium.length > 0 && !this.options.businessCriticalOnly) {
      output.push(
        `\n⚠️  MEDIUM PRIORITY MISSING IN TARGET (${missingMedium.length} items):`,
      );
      missingMedium.forEach((item) => {
        output.push(`   - ${item.name} (ID: ${item.id})`);
      });
    }

    if (missingLow.length > 0 && !this.options.businessCriticalOnly) {
      output.push(
        `\n📝 LOW PRIORITY MISSING IN TARGET (${missingLow.length} items):`,
      );
      missingLow.forEach((item) => {
        output.push(`   - ${item.name} (ID: ${item.id})`);
      });
    }

    // Group differences by severity
    const criticalDiffs = comparisonResult.differences.filter(
      (d) => d.severity === "critical",
    );
    const highDiffs = comparisonResult.differences.filter(
      (d) => d.severity === "high",
    );
    const mediumDiffs = comparisonResult.differences.filter(
      (d) => d.severity === "medium",
    );
    const lowDiffs = comparisonResult.differences.filter(
      (d) => d.severity === "low",
    );

    // Display differences by severity
    if (criticalDiffs.length > 0) {
      output.push(`\n🚨 CRITICAL DIFFERENCES (${criticalDiffs.length} items):`);
      this.formatDifferences(criticalDiffs, output);
    }

    if (highDiffs.length > 0 && !this.options.businessCriticalOnly) {
      output.push(
        `\n❌ HIGH PRIORITY DIFFERENCES (${highDiffs.length} items):`,
      );
      this.formatDifferences(highDiffs, output);
    }

    if (mediumDiffs.length > 0 && !this.options.businessCriticalOnly) {
      output.push(
        `\n⚠️  MEDIUM PRIORITY DIFFERENCES (${mediumDiffs.length} items):`,
      );
      this.formatDifferences(mediumDiffs, output);
    }

    if (lowDiffs.length > 0 && !this.options.businessCriticalOnly) {
      output.push(`\n📝 LOW PRIORITY DIFFERENCES (${lowDiffs.length} items):`);
      this.formatDifferences(lowDiffs, output);
    }

    if (
      comparisonResult.missingInTarget.length === 0 &&
      comparisonResult.extraInTarget.length === 0 &&
      comparisonResult.differences.length === 0
    ) {
      output.push("\n✅ Configurations are identical");
    }

    return output.join("\n");
  }

  // Helper method to format individual differences
  formatDifferences(differences, output) {
    differences.forEach((diff) => {
      output.push(
        `\n   📋 ${diff.name} (ID: ${this.formatDiffIds(diff)}) [${diff.severity.toUpperCase()}]`,
      );
      if (diff.reason && !this.options.summary) {
        output.push(`      Reason: ${diff.reason}`);
      }

      if (!this.options.summary) {
        const sourceFields = new Set(Object.keys(diff.source));
        const targetFields = new Set(Object.keys(diff.target));

        const missingFields = [...sourceFields].filter(
          (f) => !targetFields.has(f),
        );
        const extraFields = [...targetFields].filter(
          (f) => !sourceFields.has(f),
        );
        const commonFields = [...sourceFields].filter((f) =>
          targetFields.has(f),
        );

        if (missingFields.length > 0) {
          output.push(`      Missing in target: ${missingFields.join(", ")}`);
        }
        if (extraFields.length > 0) {
          output.push(`      Extra in target: ${extraFields.join(", ")}`);
        }

        commonFields.forEach((field) => {
          if (
            JSON.stringify(diff.source[field]) !==
            JSON.stringify(diff.target[field])
          ) {
            output.push(`      ${field}:`);
            output.push(
              `        Source: ${JSON.stringify(diff.source[field])}`,
            );
            output.push(
              `        Target: ${JSON.stringify(diff.target[field])}`,
            );
          }
        });
      }
    });
  }

  // Several items can share a name, so show which source and target item were paired.
  formatDiffIds(diff) {
    const plain = (v) => typeof v === "string" || typeof v === "number";
    if (!plain(diff.sourceId)) return diff.key;
    if (!plain(diff.targetId) || String(diff.targetId) === String(diff.sourceId)) {
      return String(diff.sourceId);
    }
    return `${diff.sourceId} -> ${diff.targetId}`;
  }

  // Helper to determine item type from section title
  getItemTypeFromTitle(title) {
    const titleLower = title.toLowerCase();
    if (titleLower.includes("project")) return "project";
    if (titleLower.includes("issue type")) return "issueType";
    if (titleLower.includes("custom field")) return "customField";
    if (titleLower.includes("workflow")) return "workflow";
    if (titleLower.includes("priority")) return "priority";
    if (titleLower.includes("scheme")) return "scheme";
    return "unknown";
  }

  formatHierarchySection() {
    const output = [
      "\n" + "=".repeat(60),
      "ISSUE HIERARCHY (PROJECTS)",
      "=".repeat(60),
    ];

    const sourceProjects = this.sourceConfig.issueHierarchy || [];
    const targetProjects = this.targetConfig.issueHierarchy || [];

    output.push(`Source projects: ${sourceProjects.length}`);
    output.push(`Target projects: ${targetProjects.length}`);

    // Debug: Check for duplicate project keys
    const sourceProjectKeysList = sourceProjects.map((p) => p.projectKey);
    const targetProjectKeysList = targetProjects.map((p) => p.projectKey);
    const sourceKeyDuplicates = sourceProjectKeysList.filter(
      (key, index) => sourceProjectKeysList.indexOf(key) !== index,
    );
    const targetKeyDuplicates = targetProjectKeysList.filter(
      (key, index) => targetProjectKeysList.indexOf(key) !== index,
    );

    if (sourceKeyDuplicates.length > 0) {
      output.push(
        `\n🔍 DEBUG: Source duplicate project keys: ${sourceKeyDuplicates.join(", ")}`,
      );
    }
    if (targetKeyDuplicates.length > 0) {
      output.push(
        `🔍 DEBUG: Target duplicate project keys: ${targetKeyDuplicates.join(", ")}`,
      );
    }

    const sourceProjectKeys = new Set(sourceProjects.map((p) => p.projectKey));
    const targetProjectKeys = new Set(targetProjects.map((p) => p.projectKey));

    // Debug: Show actual unique counts
    output.push(
      `🔍 DEBUG: Unique source project keys: ${sourceProjectKeys.size}`,
    );
    output.push(
      `🔍 DEBUG: Unique target project keys: ${targetProjectKeys.size}`,
    );

    const missingInTarget = [...sourceProjectKeys].filter(
      (key) => !targetProjectKeys.has(key),
    );
    const extraInTarget = [...targetProjectKeys].filter(
      (key) => !sourceProjectKeys.has(key),
    );
    const commonProjects = [...sourceProjectKeys].filter((key) =>
      targetProjectKeys.has(key),
    );

    // Debug: Verify the math
    output.push(`🔍 DEBUG: Missing in target: ${missingInTarget.length}`);
    output.push(`🔍 DEBUG: Extra in target: ${extraInTarget.length}`);
    output.push(`🔍 DEBUG: Common projects: ${commonProjects.length}`);
    output.push(
      `🔍 DEBUG: Math check: ${missingInTarget.length} + ${extraInTarget.length} + ${commonProjects.length} = ${missingInTarget.length + extraInTarget.length + commonProjects.length}`,
    );

    if (missingInTarget.length > 0) {
      output.push(
        `\n❌ PROJECTS MISSING IN TARGET (${missingInTarget.length}):`,
      );
      missingInTarget.forEach((key) => {
        const project = sourceProjects.find((p) => p.projectKey === key);
        output.push(`   - ${project.projectName} (${key})`);
      });
    }

    // Extra projects in target are ignored - we only care about source projects missing in target
    // This is intentional as target having more projects is not a problem

    // Compare common projects
    let projectDifferences = 0;
    commonProjects.forEach((key) => {
      const sourceProject = sourceProjects.find((p) => p.projectKey === key);
      const targetProject = targetProjects.find((p) => p.projectKey === key);

      if (sourceProject.projectType !== targetProject.projectType) {
        projectDifferences++;
        output.push(`\n⚠️  Project ${key} type differs:`);
        output.push(`    Source: ${sourceProject.projectType}`);
        output.push(`    Target: ${targetProject.projectType}`);
      }
    });

    if (
      projectDifferences === 0 &&
      missingInTarget.length === 0 &&
      extraInTarget.length === 0
    ) {
      output.push("\n✅ Project hierarchies are identical");
    }

    return output.join("\n");
  }

  formatSprintSection() {
    const output = [
      "\n" + "=".repeat(60),
      "SPRINT CONFIGURATION",
      "=".repeat(60),
    ];

    const sourceBoards = this.sourceConfig.sprintConfig || [];
    const targetBoards = this.targetConfig.sprintConfig || [];

    output.push(`Source boards: ${sourceBoards.length}`);
    output.push(`Target boards: ${targetBoards.length}`);

    if (sourceBoards.length === 0 && targetBoards.length === 0) {
      output.push(
        "⚠️  No sprint boards found on either instance (JIRA Software may not be installed)",
      );
    } else {
      // Match boards by name AND type, counting duplicates: board names are not
      // unique ("ABC board" for a scrum and a kanban board), so a plain name lookup
      // hid a missing board whenever another board shared its name.
      const label = (b) => `${b.boardName} (${b.boardType})`;
      const remaining = new Map();
      targetBoards.forEach((b) => {
        const k = label(b).toLowerCase();
        remaining.set(k, [...(remaining.get(k) || []), b]);
      });
      const missingBoards = [];
      sourceBoards.forEach((b) => {
        const list = remaining.get(label(b).toLowerCase());
        if (list && list.length > 0) list.shift();
        else missingBoards.push(label(b));
      });
      const extraBoards = [...remaining.values()].flat().map(label);

      if (sourceBoards.length !== targetBoards.length) {
        output.push(`⚠️  Different number of sprint boards`);
      }

      if (missingBoards.length > 0) {
        output.push(`\n❌ BOARDS MISSING IN TARGET:`);
        missingBoards.forEach((name) => output.push(`   - ${name}`));
      }

      if (extraBoards.length > 0) {
        output.push(`\n➕ EXTRA BOARDS IN TARGET:`);
        extraBoards.forEach((name) => output.push(`   - ${name}`));
      }

      if (missingBoards.length === 0 && extraBoards.length === 0) {
        output.push("✅ Same sprint boards (name and type) found");
      }
    }

    return output.join("\n");
  }

  // Key time tracking fields that differ, as "section.field" paths.
  getTimeTrackingDifferences() {
    const src = this.sourceConfig.timeTrackingConfig;
    const tgt = this.targetConfig.timeTrackingConfig;
    if (!src || !tgt) return src || tgt ? ["timeTrackingConfig"] : [];
    const checks = {
      configuration: ["workingDaysPerWeek", "workingHoursPerDay", "timeTrackingEnabled"],
      options: ["defaultUnit", "timeFormat"],
      list: ["fieldConfigurationId", "fieldId"],
    };
    const diffs = [];
    for (const [part, fields] of Object.entries(checks)) {
      if (!src[part] || !tgt[part]) continue;
      fields.forEach((f) => {
        if (src[part][f] !== tgt[part][f]) diffs.push(`${part}.${f}`);
      });
    }
    return diffs;
  }

  formatTimeTrackingSection() {
    const output = [
      "\n" + "=".repeat(60),
      "TIME TRACKING CONFIGURATION",
      "=".repeat(60),
    ];

    const sourceTimeTracking = this.sourceConfig.timeTrackingConfig;
    const targetTimeTracking = this.targetConfig.timeTrackingConfig;

    if (!sourceTimeTracking && !targetTimeTracking) {
      output.push(
        "⚠️  Time tracking configuration not available on either instance",
      );
      return output.join("\n");
    }

    if (!sourceTimeTracking && targetTimeTracking) {
      output.push(
        "❌ Time tracking configuration available on target but NOT on source",
      );
      return output.join("\n");
    }

    if (sourceTimeTracking && !targetTimeTracking) {
      output.push(
        "➕ Time tracking configuration available on source but NOT on target",
      );
      return output.join("\n");
    }

    // Compare main configuration
    output.push("\n📋 Main Configuration:");
    if (sourceTimeTracking.configuration && targetTimeTracking.configuration) {
      const sourceConfig = sourceTimeTracking.configuration;
      const targetConfig = targetTimeTracking.configuration;

      // Compare key settings
      const keyFields = [
        "workingDaysPerWeek",
        "workingHoursPerDay",
        "timeTrackingEnabled",
      ];

      keyFields.forEach((field) => {
        if (sourceConfig[field] !== targetConfig[field]) {
          output.push(`   ⚠️  ${field}:`);
          output.push(`     Source: ${JSON.stringify(sourceConfig[field])}`);
          output.push(`     Target: ${JSON.stringify(targetConfig[field])}`);
        }
      });

      if (
        keyFields.every((field) => sourceConfig[field] === targetConfig[field])
      ) {
        output.push("   ✅ Main time tracking settings are identical");
      }
    }

    // Compare options
    output.push("\n📋 Time Tracking Options:");
    if (sourceTimeTracking.options && targetTimeTracking.options) {
      const sourceOptions = sourceTimeTracking.options;
      const targetOptions = targetTimeTracking.options;

      // Compare option settings
      const optionFields = ["defaultUnit", "timeFormat"];

      optionFields.forEach((field) => {
        if (sourceOptions[field] !== targetOptions[field]) {
          output.push(`   ⚠️  ${field}:`);
          output.push(`     Source: ${JSON.stringify(sourceOptions[field])}`);
          output.push(`     Target: ${JSON.stringify(targetOptions[field])}`);
        }
      });

      if (
        optionFields.every(
          (field) => sourceOptions[field] === targetOptions[field],
        )
      ) {
        output.push("   ✅ Time tracking options are identical");
      }
    }

    // Compare list configuration
    output.push("\n📋 List Configuration:");
    if (sourceTimeTracking.list && targetTimeTracking.list) {
      const sourceList = sourceTimeTracking.list;
      const targetList = targetTimeTracking.list;

      // Compare list settings
      const listFields = ["fieldConfigurationId", "fieldId"];

      listFields.forEach((field) => {
        if (sourceList[field] !== targetList[field]) {
          output.push(`   ⚠️  ${field}:`);
          output.push(`     Source: ${JSON.stringify(sourceList[field])}`);
          output.push(`     Target: ${JSON.stringify(targetList[field])}`);
        }
      });

      if (
        listFields.every((field) => sourceList[field] === targetList[field])
      ) {
        output.push("   ✅ Time tracking list configuration is identical");
      }
    }

    return output.join("\n");
  }

  // Format project data statistics section
  formatProjectDataSection() {
    const output = [
      "\n" + "=".repeat(80),
      "PROJECT DATA MIGRATION VERIFICATION",
      "=".repeat(80),
    ];

    if (
      !this.sourceConfig.projectDataStats ||
      !this.targetConfig.projectDataStats
    ) {
      output.push("⚠️  Project data statistics not available");
      return output.join("\n");
    }

    const sourceStats = this.sourceConfig.projectDataStats;
    const targetStats = this.targetConfig.projectDataStats;

    // Verify stats structure
    if (!sourceStats.issueCounts || !targetStats.issueCounts) {
      output.push("⚠️  Issue count data not available");
      return output.join("\n");
    }

    // Get all project keys from source
    const projectKeys = Object.keys(sourceStats.issueCounts);

    if (projectKeys.length === 0) {
      output.push("\n⚠️  No projects found to analyze");
      return output.join("\n");
    }

    output.push(
      `\nAnalyzing ${projectKeys.length} projects from source instance`,
    );
    output.push("");

    let criticalMismatches = 0;
    let minorMismatches = 0;
    let perfectMatches = 0;

    // Detailed per-project comparison
    projectKeys.forEach((key) => {
      const sourceIssues = sourceStats.issueCounts[key];
      const targetIssues = targetStats.issueCounts[key];
      const sourceComments = sourceStats.commentCounts[key];
      const targetComments = targetStats.commentCounts[key];
      const sourceAttachments = sourceStats.attachmentCounts[key];
      const targetAttachments = targetStats.attachmentCounts[key];
      const sourceLinks = sourceStats.issueLinkCounts[key];
      const targetLinks = targetStats.issueLinkCounts[key];

      // Check for errors
      if (sourceIssues === -1 || targetIssues === -1) {
        output.push(`\n❌ ${key}: ERROR fetching data`);
        criticalMismatches++;
        return;
      }

      // Check if project doesn't exist on target (undefined means project not found)
      if (targetIssues === undefined) {
        output.push(`\n🚨 ${key}: PROJECT NOT FOUND ON TARGET`);
        output.push(
          `   Source has ${sourceIssues} issues but project missing on target!`,
        );
        criticalMismatches++;
        return;
      }

      // Default undefined values to 0 for safe math operations
      const safeSourceComments = sourceComments || 0;
      const safeTargetComments = targetComments || 0;
      const safeSourceAttachments = sourceAttachments || 0;
      const safeTargetAttachments = targetAttachments || 0;
      const safeSourceLinks = sourceLinks || 0;
      const safeTargetLinks = targetLinks || 0;

      // Calculate differences
      const issueDiff = sourceIssues - targetIssues;
      const commentDiff = safeSourceComments - safeTargetComments;
      const attachmentDiff = safeSourceAttachments - safeTargetAttachments;
      const linkDiff = safeSourceLinks - safeTargetLinks;

      // Categorize by severity
      const hasCriticalMismatch = issueDiff !== 0;
      const hasMinorMismatch =
        commentDiff !== 0 || attachmentDiff !== 0 || linkDiff !== 0;

      if (hasCriticalMismatch) {
        criticalMismatches++;
        output.push(`\n🚨 ${key}: CRITICAL MISMATCH`);
        output.push(
          `   Issues:      ${sourceIssues} (source) → ${targetIssues} (target) [Δ ${issueDiff}]`,
        );
        output.push(
          `   Comments:    ${safeSourceComments} (source) → ${safeTargetComments} (target) [Δ ${commentDiff}]`,
        );
        output.push(
          `   Attachments: ${safeSourceAttachments} (source) → ${safeTargetAttachments} (target) [Δ ${attachmentDiff}]`,
        );
        output.push(
          `   Links:       ${safeSourceLinks} (source) → ${safeTargetLinks} (target) [Δ ${linkDiff}]`,
        );
      } else if (hasMinorMismatch) {
        minorMismatches++;
        output.push(`\n⚠️  ${key}: Minor data mismatch`);
        output.push(`   Issues:      ${sourceIssues} ✓`);
        if (commentDiff !== 0) {
          output.push(
            `   Comments:    ${safeSourceComments} (source) → ${safeTargetComments} (target) [Δ ${commentDiff}]`,
          );
        }
        if (attachmentDiff !== 0) {
          output.push(
            `   Attachments: ${safeSourceAttachments} (source) → ${safeTargetAttachments} (target) [Δ ${attachmentDiff}]`,
          );
        }
        if (linkDiff !== 0) {
          output.push(
            `   Links:       ${safeSourceLinks} (source) → ${safeTargetLinks} (target) [Δ ${linkDiff}]`,
          );
        }
      } else {
        perfectMatches++;
        output.push(`\n✅ ${key}: Perfect match`);
        output.push(
          `   Issues: ${sourceIssues}, Comments: ${safeSourceComments}, Attachments: ${safeSourceAttachments}, Links: ${safeSourceLinks}`,
        );
      }
    });

    // Summary
    output.push("\n" + "=".repeat(80));
    output.push("PROJECT DATA SUMMARY");
    output.push("=".repeat(80));
    output.push(`Total projects analyzed: ${projectKeys.length}`);
    output.push(`✅ Perfect matches: ${perfectMatches}`);
    output.push(`⚠️  Minor mismatches: ${minorMismatches}`);
    output.push(`🚨 Critical mismatches: ${criticalMismatches}`);

    if (criticalMismatches > 0) {
      output.push(
        "\n⚠️  RECOMMENDATION: Investigate critical mismatches immediately - issue counts don't match!",
      );
    } else if (minorMismatches > 0) {
      output.push(
        "\n📝 Note: Minor mismatches in comments/attachments/links may be acceptable depending on migration scope",
      );
    } else {
      output.push("\n🎉 All project data migrated successfully!");
    }

    return output.join("\n");
  }

  // Generate critical summary for quick overview
  generateCriticalSummary() {
    const summary = [];
    const criticalIssues = [];

    // Check projects
    if (this.sourceConfig.issueHierarchy && this.targetConfig.issueHierarchy) {
      const sourceProjects = new Set(
        this.sourceConfig.issueHierarchy.map((p) => p.projectKey),
      );
      const targetProjects = new Set(
        this.targetConfig.issueHierarchy.map((p) => p.projectKey),
      );
      const missingProjects = [...sourceProjects].filter(
        (key) => !targetProjects.has(key),
      );

      if (missingProjects.length > 0) {
        // Filter missing projects by importance
        const criticalMissingProjects = missingProjects.filter((key) => {
          const project = this.sourceConfig.issueHierarchy.find(
            (p) => p.projectKey === key,
          );
          return (
            project &&
            this.categorizeItemImportance(project, "project") === "critical"
          );
        });

        if (criticalMissingProjects.length > 0) {
          criticalIssues.push(
            `🚨 ${criticalMissingProjects.length} CRITICAL projects missing in target`,
          );
        }
      }
    }

    const comparisons = this.getListSectionComparisons();

    // Critical items missing in target (issue types, custom fields, workflows)
    const missingLabels = {
      issueTypes: "issue types",
      customFields: "custom fields",
      workflows: "workflows",
    };
    for (const { section, comparison } of comparisons) {
      const label = missingLabels[section.configKey];
      if (!label) continue;
      const criticalMissing = comparison.missingInTarget.filter(
        (item) =>
          this.categorizeItemImportance(item, section.itemType) === "critical",
      );
      if (criticalMissing.length > 0) {
        criticalIssues.push(
          `🚨 ${criticalMissing.length} CRITICAL ${label} missing: ${criticalMissing.map((i) => i.name).join(", ")}`,
        );
      }
    }

    // Critical differences in any section: the summary must agree with the
    // "CRITICAL DIFFERENCES" blocks printed further down the report.
    for (const { section, comparison } of comparisons) {
      const criticalDiffs = comparison.differences.filter(
        (d) => d.severity === "critical",
      );
      if (criticalDiffs.length > 0) {
        criticalIssues.push(
          `🚨 ${criticalDiffs.length} CRITICAL difference${criticalDiffs.length === 1 ? "" : "s"} in ${section.summaryName}: ${criticalDiffs.map((d) => d.name).join(", ")}`,
        );
      }
    }

    if (criticalIssues.length > 0) {
      summary.push(
        `Found ${criticalIssues.length} CRITICAL issues requiring immediate attention:`,
      );
      summary.push("");
      criticalIssues.forEach((issue) => summary.push(issue));
      summary.push("");
      summary.push(
        "🔍 RECOMMENDATION: Address these issues before completing migration.",
      );
    } else {
      summary.push(
        "✅ No critical issues detected - migration appears to be in good shape.",
      );
    }

    return summary;
  }

  generateComparisonReport() {
    const report = [];

    // Header
    report.push("=".repeat(80));
    report.push("JIRA CONFIGURATION COMPARISON REPORT");
    report.push("=".repeat(80));
    report.push(
      `Generated: ${new Date().toISOString().replace("T", " ").substring(0, 19)}`,
    );
    report.push(`Source: ${this.sourceUrl}`);
    report.push(`Target: ${this.targetUrl}`);
    report.push(
      `Filter: ${this.options.severityThreshold}+ severity${this.options.businessCriticalOnly ? ", business critical only" : ""}${this.options.ignoreDescriptions ? ", ignoring descriptions" : ""}`,
    );
    report.push("=".repeat(80));

    // Critical Summary (if any critical issues found)
    const criticalSummary = this.generateCriticalSummary();
    if (criticalSummary.length > 0) {
      report.push("\n🚨 CRITICAL ISSUES SUMMARY 🚨");
      report.push("=".repeat(80));
      report.push(...criticalSummary);
      report.push("=".repeat(80));
    }

    const comparisons = this.getListSectionComparisons();
    const pushSection = ({ section, comparison }) => {
      report.push(
        this.formatConfigSection(section.title, comparison, section.itemType),
      );
      if (section.configKey === "issueLinkTypes") {
        // Debug: Show why no differences are reported
        report.push(`\n🔍 DEBUG: Issue Link Types Analysis:`);
        report.push(`   Source items: ${comparison.sourceCount}`);
        report.push(`   Target items: ${comparison.targetCount}`);
        report.push(`   Missing in target: ${comparison.missingInTarget.length}`);
        report.push(`   Extra in target: ${comparison.extraInTarget.length}`);
        report.push(`   Differences: ${comparison.differences.length}`);

        if (comparison.missingInTarget.length > 0) {
          report.push(
            `   Missing items: ${comparison.missingInTarget.map((item) => item.name).join(", ")}`,
          );
        }
      }
    };

    // Core list sections (issue types, schemes, link types, priorities)
    comparisons
      .filter(({ section }) => section.group === "core")
      .forEach(pushSection);

    // Issue Hierarchy Comparison
    if (this.sourceConfig.issueHierarchy || this.targetConfig.issueHierarchy) {
      report.push(this.formatHierarchySection());
    }

    // Sprint Configuration Comparison
    if (this.sourceConfig.sprintConfig || this.targetConfig.sprintConfig) {
      report.push(this.formatSprintSection());
    }

    // Time Tracking Configuration Comparison
    if (
      this.sourceConfig.timeTrackingConfig ||
      this.targetConfig.timeTrackingConfig
    ) {
      report.push(this.formatTimeTrackingSection());
    }

    // Project Data Migration Verification
    if (
      this.sourceConfig.projectDataStats ||
      this.targetConfig.projectDataStats
    ) {
      report.push(this.formatProjectDataSection());
    }

    // Comprehensive Configuration Areas
    report.push("\n" + "=".repeat(80));
    report.push("COMPREHENSIVE CONFIGURATION VALIDATION");
    report.push("=".repeat(80));

    comparisons
      .filter(({ section }) => section.group === "comprehensive")
      .forEach(pushSection);

    // Summary
    report.push("\n" + "=".repeat(80));
    report.push("SUMMARY");
    report.push("=".repeat(80));

    let totalSections = 0;
    let identicalSections = 0;
    let differentSections = 0;

    const thresholdOrder = { low: 1, medium: 2, high: 3, critical: 4 };
    const summaryRows = comparisons.map(({ section, comparison }) => {
      const itemType = section.itemType;
      const relevantMissing = comparison.missingInTarget.filter(
        (item) =>
          !this.options.businessCriticalOnly ||
          this.categorizeItemImportance(item, itemType) === "critical",
      );
      const relevantDifferences = comparison.differences.filter((diff) => {
        if (this.options.businessCriticalOnly && diff.importance !== "critical") {
          return false;
        }
        if (this.options.severityThreshold) {
          const diffOrder = thresholdOrder[diff.severity] || 0;
          const thresholdOrderVal =
            thresholdOrder[this.options.severityThreshold] || 0;
          if (diffOrder < thresholdOrderVal) return false;
        }
        return true;
      });
      return {
        name: section.summaryName,
        order: section.summaryOrder,
        hasRelevantDifferences:
          relevantMissing.length > 0 || relevantDifferences.length > 0,
        hasExtra: comparison.extraInTarget.length > 0,
      };
    });

    // Time tracking is one settings object, not a list: compare its key fields.
    if (this.sourceConfig.timeTrackingConfig && this.targetConfig.timeTrackingConfig) {
      summaryRows.push({
        name: "Time Tracking Configuration",
        order: TIME_TRACKING_SUMMARY_ORDER,
        hasRelevantDifferences: this.getTimeTrackingDifferences().length > 0,
        hasExtra: false,
      });
    }

    summaryRows
      .sort((x, y) => x.order - y.order)
      .forEach((row) => {
        totalSections++;
        if (!row.hasRelevantDifferences && !row.hasExtra) {
          identicalSections++;
        } else if (row.hasRelevantDifferences) {
          differentSections++;
          report.push(`⚠️  ${row.name}: Differences found`);
        }
      });

    if (totalSections > 0) {
      report.push(`\nConfigurations compared: ${totalSections}`);
      report.push(`Identical configurations: ${identicalSections}`);
      report.push(`Different configurations: ${differentSections}`);
    }

    report.push("\n" + "=".repeat(80));
    report.push("END OF REPORT");
    report.push("=".repeat(80));

    return report.join("\n");
  }

  // Every list-shaped configuration area, compared once per report.
  getListSectionComparisons() {
    return LIST_SECTIONS.filter(
      (section) =>
        this.sourceConfig[section.configKey] &&
        this.targetConfig[section.configKey],
    ).map((section) => ({
      section,
      comparison: this.compareLists(
        this.sourceConfig[section.configKey],
        this.targetConfig[section.configKey],
        "name",
        "name",
        section.itemType,
      ),
    }));
  }

  async run() {
    try {
      await this.fetchAllConfigurations();
      const report = this.generateComparisonReport();

      // Output to console
      console.log(report);

      // Save to file
      await this.saveReportToFile(report);
    } catch (error) {
      console.error("Error during comparison:", error.message);
      process.exit(1);
    }
  }

  // Save report to file with timestamp
  async saveReportToFile(report) {
    // Create filename with timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .substring(0, 19);
    const filename = `jira-comparison-report-${timestamp}.txt`;
    const filepath = path.resolve(this.outputDir, filename);

    try {
      // Ensure output directory exists
      await fs.mkdir(path.dirname(filepath), { recursive: true });

      await fs.writeFile(filepath, report, "utf8");
      console.log(`\n📄 Report saved to: ${filename}`);
      console.log(`📁 Full path: ${filepath}`);
    } catch (error) {
      console.error(`❌ Failed to save report to file: ${error.message}`);
    }
  }
}

module.exports = { JIRAConfigComparator };

// Command line interface (only when run directly, so tests can require the class)
if (require.main === module) {
  program
    .name("jira-config-comparator")
    .description(
      "Compare JIRA configurations between source and target instances",
    )
    .requiredOption("--source <url>", "Source JIRA instance URL")
    .requiredOption("--target <url>", "Target JIRA instance URL")
    .requiredOption("--email <email>", "Email address for authentication")
    .requiredOption("--token <token>", "API token for authentication")
    .option(
      "--output <dir>",
      "Output directory for report (default: current directory)",
      ".",
    )
    .option(
      "--severity <level>",
      "Minimum severity level to report (critical|high|medium|low)",
      "low",
    )
    .option(
      "--ignore-descriptions",
      "Ignore differences in description fields",
      false,
    )
    .option(
      "--business-critical-only",
      "Only show business-critical differences",
      false,
    )
    .option("--summary", "Show brief summary instead of full details", false)
    .addHelpText(
      "after",
      `
  Examples:
    $ node jira-config-comparator.js \\
      --source https://source.atlassian.net \\
      --target https://target.atlassian.net \\
      --email user@company.com \\
      --token your-api-token

    $ node jira-config-comparator.js \\
      --source https://source.atlassian.net \\
      --target https://target.atlassian.net \\
      --email user@company.com \\
      --token your-api-token \\
      --output ./reports

    $ node jira-config-comparator.js \\
      --source https://source.atlassian.net \\
      --target https://target.atlassian.net \\
      --email user@company.com \\
      --token your-api-token \\
      --severity critical \\
      --business-critical-only

    $ node jira-config-comparator.js \\
      --source https://source.atlassian.net \\
      --target https://target.atlassian.net \\
      --email user@company.com \\
      --token your-api-token \\
      --ignore-descriptions \\
      --summary

  Note: Generate API token from: https://id.atlassian.com/manage-profile/security/api-tokens
      `,
    );

  program.parse();

  const options = program.opts();

  const comparator = new JIRAConfigComparator(
    options.source,
    options.target,
    options.email,
    options.token,
    {
      outputDir: options.output,
      severity: options.severity,
      ignoreDescriptions: options.ignoreDescriptions,
      businessCriticalOnly: options.businessCriticalOnly,
      summary: options.summary,
    },
  );

  comparator.run().catch((error) => {
    console.error("Fatal error:", error.message);
    process.exit(1);
  });
}
